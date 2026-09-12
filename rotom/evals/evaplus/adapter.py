"""Eva+ shell adapter. The platform's independent verifier owns the task score."""
from __future__ import annotations

import base64
import binascii
import hashlib
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import platform
import re
import selectors
import secrets
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
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


@contextmanager
def product_artifact(root, config):
    # Eva+ uploads repository files individually; keep transport pieces small
    # while validating the exact original release before any installation.
    parts = config.get("productParts")
    if parts is None:
        yield root / "release" / "rotom.tgz"
        return
    require(isinstance(parts, list) and 0 < len(parts) <= 128, "Invalid product parts")
    total = 0
    for index, part in enumerate(parts):
        require(isinstance(part, dict), "Invalid product part")
        encoding = part.get("encoding", "binary")
        require(encoding in ("binary", "base64"), "Invalid product part encoding")
        suffix = ".b64" if encoding == "base64" else ""
        require(part.get("file") == f"rotom.tgz.part-{index:03d}{suffix}", "Invalid product part order or path")
        size = part.get("size")
        limit = 512 * 1024 if encoding == "base64" else 4 * 1024 * 1024
        require(type(size) is int and 0 < size <= limit, "Invalid product part size")
        require(re.fullmatch(r"[0-9a-f]{64}", part.get("sha256") or ""), "Missing product part SHA256")
        total += size
    require(total <= 64 * 1024 * 1024, "Product parts exceed archive limit")
    with tempfile.TemporaryDirectory(prefix="rotom-artifact-") as temp:
        artifact = Path(temp).resolve() / "rotom.tgz"
        with artifact.open("xb") as output:
            for part in parts:
                encoded = part.get("encoding") == "base64"
                # Text parts live at the repository root: do not depend on the
                # platform uploader supporting binary payloads or subdirectories.
                source = regular((root if encoded else root / "release") / part["file"])
                expected_size = ((part["size"] + 2) // 3) * 4 if encoded else part["size"]
                require(source.stat().st_size == expected_size, "Product part size mismatch")
                data = source.read_bytes()
                if encoded:
                    try:
                        data = base64.b64decode(data, validate=True)
                    except binascii.Error:
                        raise PreflightError("Invalid product part base64") from None
                require(len(data) == part["size"], "Decoded product part size mismatch")
                require(hashlib.sha256(data).hexdigest() == part["sha256"], "Product part SHA256 mismatch")
                output.write(data)
        require(digest(artifact) == config["productSha256"], "Product SHA256 mismatch")
        yield artifact


def install(root):
    config = release(root)  # Fail before creating files or using the network.
    with product_artifact(root, config) as artifact:
        install_artifact(root, config, artifact)


def install_artifact(root, config, artifact):
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
    is_deepseek = "deepseek" in model.lower()
    compat = ({"supportsStore": False, "supportsDeveloperRole": False,
               "supportsReasoningEffort": False, "maxTokensField": "max_tokens",
               "thinkingFormat": "deepseek"} if is_deepseek else {})
    return {"providers": {"evaplus": {"baseUrl": base, "api": "openai-completions",
        "apiKey": "$ROTOM_EVAL_API_KEY", "models": [{"id": model, "input": ["text"],
        "reasoning": is_deepseek or thinking != "off", "contextWindow": context, "maxTokens": tokens,
        **({"compat": compat} if compat else {})}]}}}


def sse_from_completion(payload):
    """Convert one bounded Chat Completions response to the SSE shape Pi consumes."""
    require(isinstance(payload, dict), "Invalid completion response")
    choices = payload.get("choices")
    require(isinstance(choices, list) and len(choices) == 1, "Expected one completion choice")
    choice = choices[0]
    message = choice.get("message")
    require(isinstance(message, dict), "Missing completion message")
    finish = choice.get("finish_reason")
    require(finish in ("stop", "tool_calls", "length", "content_filter"), "Invalid completion finish reason")
    delta = {"role": message.get("role", "assistant")}
    for field in ("content", "reasoning_content"):
        if message.get(field) is not None:
            require(isinstance(message[field], str), f"Invalid {field}")
            delta[field] = message[field]
    if message.get("tool_calls") is not None:
        require(isinstance(message["tool_calls"], list), "Invalid tool calls")
        delta["tool_calls"] = []
        for index, call in enumerate(message["tool_calls"]):
            require(isinstance(call, dict) and isinstance(call.get("function"), dict), "Invalid tool call")
            function = call["function"]
            require(isinstance(function.get("name"), str) and isinstance(function.get("arguments"), str), "Invalid tool function")
            delta["tool_calls"].append({"index": index, "id": call.get("id"),
                                        "type": call.get("type", "function"),
                                        "function": {"name": function["name"], "arguments": function["arguments"]}})
    chunk = {"id": payload.get("id", "chatcmpl-bridge"), "object": "chat.completion.chunk",
             "created": payload.get("created", int(time.time())), "model": payload.get("model", ""),
             "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    lines = [f"data: {json.dumps(chunk, separators=(',', ':'))}\n\n"]
    if isinstance(payload.get("usage"), dict):
        usage = {"id": chunk["id"], "object": chunk["object"], "created": chunk["created"],
                 "model": chunk["model"], "choices": [], "usage": payload["usage"]}
        lines.append(f"data: {json.dumps(usage, separators=(',', ':'))}\n\n")
    lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


@contextmanager
def completion_bridge(base_url, api_key, model_name):
    """Use a loopback SSE bridge when the sandbox truncates the provider stream."""
    local_token = secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format, *_args):
            return

        def do_POST(self):
            try:
                require(self.path == "/v1/chat/completions", "Unexpected bridge path")
                require(self.headers.get("Authorization") == f"Bearer {local_token}", "Bridge authentication failed")
                length = int(self.headers.get("Content-Length", "0"))
                require(0 < length <= 16 * 1024 * 1024, "Invalid bridge request size")
                request_body = json.loads(self.rfile.read(length))
                require(isinstance(request_body, dict) and request_body.get("model") == model_name,
                        "Unexpected bridge model")
                require(request_body.get("stream") is True, "Expected streaming bridge request")
                request_body["stream"] = False
                request_body.pop("stream_options", None)
                upstream = urllib.request.Request(f"{base_url.rstrip('/')}/chat/completions",
                    data=json.dumps(request_body).encode(), method="POST",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
                with urllib.request.urlopen(upstream, timeout=120) as response:
                    require(response.status == 200, "Upstream completion failed")
                    raw = response.read(16 * 1024 * 1024 + 1)
                require(len(raw) <= 16 * 1024 * 1024, "Upstream completion too large")
                body = sse_from_completion(json.loads(raw))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception:
                body = b'{"error":{"message":"Completion bridge failed"}}'
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", local_token
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def execute(command, env, prompt, timeout):
    """Consume bounded NDJSON in memory. Never persist prompt, stream, or errors."""
    started = time.monotonic()
    ended, stop, overflow, usage = False, None, False, None
    usage_complete = True
    provider_error = None
    provider_error_fingerprint = None
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
            if timeout and time.monotonic() - started >= timeout:
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
                                    if stop == "error":
                                        error_message = message.get("errorMessage")
                                        provider_error = classify_provider_error(error_message)
                                        provider_error_fingerprint = fingerprint_provider_error(error_message)
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
                child.wait(timeout=max(0.01, timeout - (time.monotonic() - started)) if timeout else None)
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
    if provider_error is not None:
        summary["providerError"] = provider_error
    if provider_error_fingerprint is not None:
        summary["providerErrorFingerprint"] = provider_error_fingerprint
    return summary, 0 if ok else 130 if cancelled else 124 if timed_out else 1


def classify_provider_error(value):
    # Classify in memory; never copy provider error bodies or arbitrary codes.
    text = value.lower() if isinstance(value, str) else ""
    categories = (
        ("authentication", ("401", "unauthorized", "invalid api key")),
        ("permission", ("403", "forbidden", "permission denied")),
        ("rate_limit", ("429", "rate limit")),
        ("model_unavailable", ("model not found", "model does not exist")),
        ("tls", ("certificate", "ssl", "tls")),
        ("timeout", ("timeout", "timed out")),
        ("connection", ("connection error", "fetch failed", "econn", "enotfound")),
        ("request_rejected", ("400", "bad request", "invalid request")),
        ("server_error", ("500", "502", "503", "504", "internal server error", "service unavailable")),
        ("provider_finish_error", ("finish_reason: error", "finish reason: error", "error stop reason")),
        ("incomplete_stream", ("stream ended without finish_reason", "unexpected end of json", "premature close")),
        ("context_limit", ("context length", "maximum context", "too many tokens")),
        ("tool_schema", ("tool schema", "invalid tool", "function schema")),
        ("aborted", ("request was aborted", "aborterror")),
    )
    return next((name for name, needles in categories if any(n in text for n in needles)), "unknown")


def fingerprint_provider_error(value):
    if not isinstance(value, str):
        return None
    encoded = value.encode("utf-8", errors="replace")
    return {"sha256": hashlib.sha256(encoded).hexdigest(), "bytes": len(encoded)}


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
    upstream_base = models["providers"]["evaplus"]["baseUrl"]
    timeout = int(os.environ.get("TIMEOUT_SEC", "900"))
    require(0 <= timeout <= 7200, "TIMEOUT_SEC must be between 0 and 7200 (0 delegates timeout to the platform)")
    prompt_path = Path(os.environ.get("PROMPT_FILE", ""))
    require(prompt_path.is_absolute(), "PROMPT_FILE must be an absolute file path")
    regular(prompt_path)
    require(0 < prompt_path.stat().st_size <= 8 * 1024 * 1024, "Empty or oversized prompt")
    with tempfile.TemporaryDirectory(prefix="rotom-eval-") as temp, completion_bridge(
            upstream_base, os.environ["API_KEY"], os.environ["MODEL_NAME"]) as (bridge_url, bridge_token):
        models["providers"]["evaplus"]["baseUrl"] = bridge_url
        home = Path(temp)
        agent_dir = home / "agent"
        agent_dir.mkdir(mode=0o700)
        (agent_dir / "models.json").write_text(json.dumps(models))
        env = clean_env(home, node_bin)
        env.update(PI_CODING_AGENT_DIR=str(agent_dir), ROTOM_NODE=str(node_bin / "node"),
                   ROTOM_EVAL_API_KEY=bridge_token, ROTOM_OBSERVABILITY="0")
        argv = [str(command), "--print", "--mode", "json", "--no-session", "--no-approve",
                "--tools", "bash,read,write,edit",
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
