"""Eva+ shell adapter. The platform's independent verifier owns the task score."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import selectors
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
MAX_LINE = 8 * 1024 * 1024


class PreflightError(Exception):
    pass


class RunCancelled(Exception):
    pass


def require(condition, message):
    if not condition:
        raise PreflightError(message)


def regular(path):
    require(path.is_file() and not path.is_symlink(), "Expected a regular file")
    require(path.absolute() == path.resolve(), "File path contains a symlink")
    return path


def digest(path):
    with regular(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def release(root):
    config = json.loads(regular(root / "release.json").read_text())
    require(config.get("ready") is True, "Release pending: no final rotom artifact selected")
    require(re.fullmatch(r"[0-9a-f]{64}", config.get("productSha256") or ""), "Missing product SHA256")
    require(re.fullmatch(r"[0-9a-f]{40}", config.get("sourceCommit") or ""), "Missing source commit")
    require(re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", config.get("productVersion") or ""), "Missing exact product version")
    require(re.fullmatch(r"24\.\d+\.\d+", config.get("nodeVersion") or ""), "Expected exact Node 24 version")
    return config


def clean_env(home, node_bin):
    # Only named networking/locale settings cross into the disposable agent HOME.
    env = {key: value for key, value in os.environ.items() if key in (
        "LANG", "LC_ALL", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
        "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
    )}
    env.update(HOME=str(home), PATH=f"{node_bin}:/usr/local/bin:/usr/bin:/bin",
               XDG_CACHE_HOME=str(home / ".cache"), NODE_USE_ENV_PROXY="1")
    return env


def install(root):
    config = release(root)  # Fail before creating files or using the network.
    artifact = root / "release" / "rotom.tgz"
    require(digest(artifact) == config["productSha256"], "Product SHA256 mismatch")
    require(platform.system() == "Linux", "Installer requires Linux")
    arch = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())
    require(arch is not None, "Unsupported Linux architecture")
    node_hash = config["nodeSha256"].get(arch, "")
    require(re.fullmatch(r"[0-9a-f]{64}", node_hash), "Missing Node SHA256")
    runtime = root / ".runtime"
    runtime.mkdir(mode=0o700)  # Never overwrite a previous or uncertain installation.
    home = runtime / "install-home"
    home.mkdir(mode=0o700)
    filename = f'node-v{config["nodeVersion"]}-linux-{arch}'
    archive = runtime / "node.tar.xz"
    with urllib.request.urlopen(f'https://nodejs.org/dist/v{config["nodeVersion"]}/{filename}.tar.xz', timeout=60) as response:
        with archive.open("xb") as target:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                require(total <= 100 * 1024 * 1024, "Node archive too large")
                target.write(chunk)
    require(digest(archive) == node_hash, "Node SHA256 mismatch")
    with tarfile.open(archive) as bundle:
        # Ubuntu 24.04 provides Python 3.12's traversal-safe extraction filter.
        bundle.extractall(runtime, filter="data")
    node_bin = runtime / filename / "bin"
    env = clean_env(home, node_bin)
    prefix = runtime / "product"
    subprocess.run([str(node_bin / "npm"), "install", "--prefix", str(prefix),
                    "--ignore-scripts", "--no-audit", "--no-fund", str(artifact)],
                   env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   check=True, timeout=600)
    product = prefix / "node_modules" / "rotom"
    package = json.loads(regular(product / "package.json").read_text())
    require(package.get("name") == "rotom" and package.get("version") == config["productVersion"], "Installed product identity mismatch")
    command = regular(product / "bin" / "rotom")
    subprocess.run([str(command), "--version"], env=env, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    state = {"releaseSha256": digest(root / "release.json"), "nodeBin": str(node_bin),
             "command": str(command)}
    (runtime / "installed.json").write_text(json.dumps(state))
    print(json.dumps({"status": "installed", "productVersion": config["productVersion"]}))


def model_config(env):
    # Dedicated Code Agent settings are explicit; no host auth or implicit model fallback.
    for key in ("API_KEY", "BASE_URL", "MODEL_NAME", "CONTEXT_WINDOW", "MAX_TOKENS"):
        require(bool(env.get(key)), f"Missing {key}")
    url = urlsplit(env["BASE_URL"])
    require(url.scheme == "https" and bool(url.hostname) and not url.username and not url.password
            and not url.query and not url.fragment, "Expected HTTPS API root without credentials or query")
    base = env["BASE_URL"].rstrip("/")
    if base.endswith("/chat/completions"):
        base = base[:-len("/chat/completions")]
    model = env["MODEL_NAME"]
    require(not any(c.isspace() for c in model) and not any(c in model for c in "*?:"), "Expected exact model ID")
    context, tokens = int(env["CONTEXT_WINDOW"]), int(env["MAX_TOKENS"])
    require(0 < tokens <= context, "Invalid model token limits")
    thinking = env.get("THINKING", "off")
    require(thinking in ("off", "minimal", "low", "medium", "high", "xhigh"), "Invalid THINKING")
    return {"providers": {"evaplus": {"baseUrl": base, "api": "openai-completions",
        "apiKey": "$ROTOM_EVAL_API_KEY", "models": [{"id": model, "input": ["text"],
        "reasoning": thinking != "off", "contextWindow": context, "maxTokens": tokens}]}}}


def execute(command, env, prompt, timeout):
    """Consume bounded NDJSON in memory. Never persist prompt, stream, or errors."""
    started = time.monotonic()
    ended, stop, overflow, usage = False, None, False, None
    usage_complete = True
    child = subprocess.Popen(command, stdin=prompt, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, env=env, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    buffer = b""
    dropping = False
    timed_out = False
    cancelled = False
    def cancel(_signum, _frame):
        raise RunCancelled()
    handlers = {sig: signal.signal(sig, cancel) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        while selector.get_map():
            if time.monotonic() - started >= timeout:
                timed_out = True
                break
            for key, _ in selector.select(0.1):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                for index, part in enumerate(chunk.split(b"\n")):
                    if index:
                        if not dropping and buffer:
                            try:
                                event = json.loads(buffer)
                                if event.get("type") == "agent_end":
                                    ended = True
                                message = event.get("message", {})
                                if event.get("type") == "message_end" and message.get("role") == "assistant":
                                    stop = message.get("stopReason")
                                    current = message.get("usage")
                                    fields = ("input", "output", "cacheRead", "cacheWrite", "totalTokens")
                                    if isinstance(current, dict) and all(type(current.get(k)) in (int, float) and math.isfinite(current[k]) and current[k] >= 0 for k in fields):
                                        if usage is None:
                                            usage = dict.fromkeys(fields, 0)
                                        for field in fields:
                                            usage[field] += current[field]
                                    else:
                                        usage_complete = False
                            except (ValueError, AttributeError, TypeError):
                                overflow = True
                        buffer, dropping = b"", False
                    if not dropping:
                        buffer += part
                        if len(buffer) > MAX_LINE:
                            buffer, dropping, overflow = b"", True, True
        if not timed_out:
            try:
                child.wait(timeout=max(0.01, timeout - (time.monotonic() - started)))
            except subprocess.TimeoutExpired:
                timed_out = True
    except RunCancelled:
        cancelled = True
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, signal.SIG_IGN)
        # Stop descendants even when the parent has already exited. No retry on unknown.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        selector.close()
        child.stdout.close()
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
    if buffer or dropping:
        overflow = True
    ok = child.returncode == 0 and ended and stop == "stop" and not timed_out and not overflow and not cancelled
    summary = {"status": "completed" if ok else "unknown" if cancelled or timed_out or overflow or not ended else "failed",
               "exitCode": child.returncode, "timedOut": timed_out, "cancelled": cancelled,
               "durationSeconds": round(time.monotonic() - started, 3),
               "usage": None if overflow or not usage_complete else usage, "cost": None, "score": None,
               "telemetryIncomplete": overflow}
    return summary, 0 if ok else 130 if cancelled else 124 if timed_out else 1


def run(root):
    config = release(root)
    state = json.loads(regular(root / ".runtime" / "installed.json").read_text())
    require(state["releaseSha256"] == digest(root / "release.json"), "Release changed after installation")
    runtime = (root / ".runtime").resolve()
    command, node_bin = Path(state["command"]), Path(state["nodeBin"])
    require(command.is_relative_to(runtime) and node_bin.is_relative_to(runtime), "Installation path escaped runtime")
    regular(command)
    regular(node_bin / "node")
    models = model_config(os.environ)
    timeout = int(os.environ.get("TIMEOUT_SEC", "900"))
    require(1 <= timeout <= 7200, "TIMEOUT_SEC must be between 1 and 7200")
    prompt_path = Path(os.environ.get("PROMPT_FILE", ""))
    require(prompt_path.is_absolute(), "PROMPT_FILE must be an absolute file path")
    regular(prompt_path)
    require(0 < prompt_path.stat().st_size <= 8 * 1024 * 1024, "Empty or oversized prompt")
    with tempfile.TemporaryDirectory(prefix="rotom-eval-") as temp:
        home = Path(temp)
        agent_dir = home / "agent"
        agent_dir.mkdir(mode=0o700)
        (agent_dir / "models.json").write_text(json.dumps(models))
        env = clean_env(home, node_bin)
        env.update(PI_CODING_AGENT_DIR=str(agent_dir), ROTOM_NODE=str(node_bin / "node"),
                   ROTOM_EVAL_API_KEY=os.environ["API_KEY"], ROTOM_OBSERVABILITY="0")
        argv = [str(command), "--print", "--mode", "json", "--no-session", "--no-approve",
                "--provider", "evaplus", "--model", os.environ["MODEL_NAME"],
                "--thinking", os.environ.get("THINKING", "off")]
        with prompt_path.open("rb") as prompt:
            summary, code = execute(argv, env, prompt, timeout)
        summary.update(productVersion=config["productVersion"], productSha256=config["productSha256"],
                       sourceCommit=config["sourceCommit"], model=os.environ["MODEL_NAME"])
        print(json.dumps(summary))
        return code


if __name__ == "__main__":
    os.umask(0o077)
    try:
        require(len(sys.argv) == 2 and sys.argv[1] in ("install", "run"), "Expected install or run")
        sys.exit(install(ROOT) if sys.argv[1] == "install" else run(ROOT))
    except Exception as error:
        # Dependency and provider exceptions can contain credentials or response bodies.
        print(json.dumps({"status": "blocked", "errorType": type(error).__name__,
                          "reason": str(error) if type(error) is PreflightError else "Adapter preflight or execution failed"}), file=sys.stderr)
        sys.exit(2)
