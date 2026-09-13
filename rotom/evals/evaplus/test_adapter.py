import base64
import json
import hashlib
import http.client
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import adapter


MODEL_ENV = {"API_KEY": "unit-test-only-secret", "BASE_URL": "https://example.test/v1/chat/completions",
             "MODEL_NAME": "test-model", "CONTEXT_WINDOW": "8192", "MAX_TOKENS": "1024"}
USAGE = {"input": 10, "output": 2, "cacheRead": 3, "cacheWrite": 0, "totalTokens": 15}


class AdapterTests(unittest.TestCase):
    def test_install_shell_accepts_usable_python_after_apt_postinstall_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            binary_dir = root / "bin"
            binary_dir.mkdir()
            for name, source in (("bash", "/bin/bash"), ("dirname", "/usr/bin/dirname"),
                                 ("env", "/usr/bin/env")):
                (binary_dir / name).symlink_to(source)
            marker = root / "python-invocation"
            package_log = root / "package-log"
            (binary_dir / "id").write_text("#!/bin/bash\nprintf '0\\n'\n")
            (binary_dir / "apt-get").write_text(
                "#!/bin/bash\n"
                "printf 'apt %s %s %s %s\\n' \"$DEBIAN_FRONTEND\" \"$DEBCONF_NONINTERACTIVE_SEEN\" \"$TZ\" \"$*\" >>\"$PACKAGE_LOG\"\n"
                "[[ $* == 'install -y -qq python3' ]] || exit 0\n"
                "/bin/cat >\"$FAKE_BIN/python3\" <<'PYTHON'\n"
                "#!/bin/bash\n"
                "if [[ ${1-} == - ]]; then\n"
                "  while IFS= read -r _; do :; done\n"
                "  exit 0\n"
                "fi\n"
                "printf '%s\\n' \"$*\" >\"$PYTHON_MARKER\"\n"
                "PYTHON\n"
                "/bin/chmod +x \"$FAKE_BIN/python3\"\n"
                "exit 42\n")
            for executable in (binary_dir / "id", binary_dir / "apt-get"):
                executable.chmod(0o755)
            shutil.copy(adapter.ROOT / "install.sh", root / "install.sh")
            (root / "adapter.py").write_text("raise SystemExit('fake python should not execute this')\n")
            environment = {"PATH": str(binary_dir), "FAKE_BIN": str(binary_dir),
                           "PACKAGE_LOG": str(package_log), "PYTHON_MARKER": str(marker)}
            result = subprocess.run([str(binary_dir / "bash"), str(root / "install.sh")], env=environment,
                                    text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(package_log.read_text().splitlines(),
                             ["apt noninteractive true Etc/UTC update -qq",
                              "apt noninteractive true Etc/UTC install -y -qq python3"])
            self.assertIn("apt returned nonzero after Python became usable", result.stderr)
            self.assertEqual(marker.read_text().strip(), f"{root / 'adapter.py'} install")

    def test_provider_error_classification_never_copies_body(self):
        for error, expected in [("401 secret payload", "authentication"), ("Connection error. secret", "connection"), ("arbitrary secret", "unknown")]:
            events = [{"type": "message_end", "message": {"role": "assistant", "stopReason": "error", "errorMessage": error, "usage": USAGE}}, {"type": "agent_end"}]
            source = "\n".join(f"print({json.dumps(event)!r})" for event in events)
            summary, code = self.execute(source)
            self.assertEqual(code, 1)
            self.assertEqual(summary["providerError"], expected)
            self.assertNotIn("secret", json.dumps(summary))
            self.assertEqual(summary["providerErrorFingerprint"]["bytes"], len(error.encode()))
            self.assertRegex(summary["providerErrorFingerprint"]["sha256"], r"^[0-9a-f]{64}$")

    def test_flat_text_parts_reconstruct_and_reject_invalid_encoding(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            payload = bytes(range(256))
            part = {"file": "rotom.tgz.part-000.b64", "encoding": "base64", "size": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest()}
            source = root / part["file"]
            source.write_bytes(base64.b64encode(payload))
            config = {"productParts": [part], "productSha256": part["sha256"]}
            with adapter.product_artifact(root, config) as artifact:
                self.assertEqual(artifact.read_bytes(), payload)
            source.write_bytes(b"!" * source.stat().st_size)
            with self.assertRaisesRegex(adapter.PreflightError, "Invalid product part base64"):
                with adapter.product_artifact(root, config):
                    self.fail("Invalid encoded bytes accepted")
            with self.assertRaisesRegex(adapter.PreflightError, "Invalid product part encoding"):
                with adapter.product_artifact(root, config | {"productParts": [part | {"encoding": "unknown"}]}):
                    self.fail("Unknown encoding accepted")

    def test_transport_parts_restore_exact_artifact_and_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            (root / "release").mkdir()
            payloads = [b"first archive bytes", b"last archive bytes"]
            parts = []
            for index, payload in enumerate(payloads):
                filename = f"rotom.tgz.part-{index:03d}"
                (root / "release" / filename).write_bytes(payload)
                parts.append({"file": filename, "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()})
            config = {"productParts": parts, "productSha256": hashlib.sha256(b"".join(payloads)).hexdigest()}
            with adapter.product_artifact(root, config) as artifact:
                self.assertEqual(artifact.read_bytes(), b"".join(payloads))
            self.assertFalse(artifact.exists())
            self.assertFalse((root / "release" / "rotom.tgz").exists())
            for corrupt in (b"x" * len(payloads[0]), b"short"):
                (root / "release" / parts[0]["file"]).write_bytes(corrupt)
                with self.assertRaises(adapter.PreflightError):
                    with adapter.product_artifact(root, config):
                        self.fail("Corrupt transport part accepted")

    def test_transport_parts_reject_paths_symlinks_and_wrong_release_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            (root / "release").mkdir()
            part = {"file": "rotom.tgz.part-000", "size": 1, "sha256": hashlib.sha256(b"x").hexdigest()}
            config = {"productParts": [part], "productSha256": "a" * 64}
            (root / "outside").write_bytes(b"x")
            source = root / "release" / part["file"]
            source.symlink_to(root / "outside")
            with self.assertRaises(adapter.PreflightError):
                with adapter.product_artifact(root, config):
                    self.fail("Symlink accepted")
            source.unlink()
            source.write_bytes(b"x")
            with self.assertRaisesRegex(adapter.PreflightError, "Product SHA256 mismatch"):
                with adapter.product_artifact(root, config):
                    self.fail("Wrong release accepted")
            for changes in ({"file": "../outside"}, {"file": "rotom.tgz.part-001"}, {"size": 4194305}):
                with self.subTest(changes=changes), self.assertRaises(adapter.PreflightError):
                    with adapter.product_artifact(root, config | {"productParts": [part | changes]}):
                        self.fail("Invalid transport manifest accepted")

    def test_pending_release_has_no_side_effects(self):
        for action in (adapter.install, adapter.run):
            with patch("adapter.urllib.request.urlopen") as network, patch("adapter.subprocess.Popen") as process:
                with self.assertRaisesRegex(adapter.PreflightError, "Release pending"):
                    action(adapter.ROOT)
                network.assert_not_called()
                process.assert_not_called()
        self.assertFalse((adapter.ROOT / ".runtime").exists())

    def test_model_config_keeps_key_in_environment_and_normalizes_endpoint(self):
        result = adapter.model_config(MODEL_ENV)
        provider = result["providers"]["evaplus"]
        self.assertEqual(provider["baseUrl"], "https://example.test/v1")
        self.assertEqual(provider["apiKey"], "$ROTOM_EVAL_API_KEY")
        self.assertNotIn("compat", provider["models"][0])
        self.assertNotIn(MODEL_ENV["API_KEY"], json.dumps(result))
        for change in ({"BASE_URL": "http://example.test"}, {"BASE_URL": "https://example.test/?key=secret"},
                       {"MODEL_NAME": "test*"}, {"MAX_TOKENS": "9000"}, {"THINKING": "max"}):
            with self.assertRaises(adapter.PreflightError):
                adapter.model_config(MODEL_ENV | change)

        deepseek = adapter.model_config(MODEL_ENV | {"MODEL_NAME": "bailian/deepseek-v4-flash"})["providers"]["evaplus"]["models"][0]
        self.assertEqual(deepseek["compat"], {"supportsStore": False, "supportsDeveloperRole": False,
                                               "supportsReasoningEffort": False, "maxTokensField": "max_tokens",
                                               "thinkingFormat": "deepseek"})
        self.assertTrue(deepseek["reasoning"], "DeepSeek must remain reasoning-capable so THINKING=off emits an explicit disabled parameter")

    def test_nonstream_completion_is_converted_to_bounded_sse(self):
        completion = {"id": "c1", "created": 7, "model": "test-model", "choices": [{"index": 0,
            "message": {"role": "assistant", "content": None, "tool_calls": [{"id": "t1", "type": "function",
                "function": {"name": "bash", "arguments": '{"command":"pwd"}'}}]}, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7}}
        frames = adapter.sse_from_completion(completion).decode().strip().split("\n\n")
        chunk = json.loads(frames[0].removeprefix("data: "))
        self.assertEqual(chunk["choices"][0]["finish_reason"], "tool_calls")
        self.assertEqual(chunk["choices"][0]["delta"]["tool_calls"][0]["function"]["name"], "bash")
        self.assertEqual(json.loads(frames[1].removeprefix("data: "))["usage"]["total_tokens"], 7)
        self.assertEqual(frames[2], "data: [DONE]")

    def test_completion_bridge_hides_upstream_key_and_disables_streaming(self):
        completion = {"id": "c1", "model": "test-model", "choices": [{"message": {
            "role": "assistant", "content": "done"}, "finish_reason": "stop"}]}

        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *_args): return None
            def read(self, _limit): return json.dumps(completion).encode()

        captured = {}
        def upstream(request, timeout):
            captured.update(url=request.full_url, authorization=request.headers.get("Authorization"),
                            body=json.loads(request.data), timeout=timeout)
            return Response()

        with patch("adapter.urllib.request.urlopen", side_effect=upstream):
            with adapter.completion_bridge("https://example.test/v1", "upstream-secret", "test-model") as (url, token):
                parsed = adapter.urlsplit(url)
                connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=5)
                request = {"model": "test-model", "stream": True, "stream_options": {"include_usage": True},
                           "messages": [{"role": "user", "content": "hello"}]}
                connection.request("POST", "/v1/chat/completions", json.dumps(request),
                                   {"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
                response = connection.getresponse()
                body = response.read().decode()
                connection.close()
        self.assertEqual(response.status, 200)
        self.assertIn("data: [DONE]", body)
        self.assertEqual(captured["authorization"], "Bearer upstream-secret")
        self.assertEqual(captured["url"], "https://example.test/v1/chat/completions")
        self.assertFalse(captured["body"]["stream"])
        self.assertNotIn("stream_options", captured["body"])

    def test_no_host_credentials_or_product_overrides_inherit(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "host-key", "ROTOM_PI": "/host/pi",
                                     "ROTOM_QODER": "1", "NODE_OPTIONS": "--import=bad"}):
            env = adapter.clean_env(Path("/tmp/isolated"), Path("/tmp/node/bin"))
        for key in ("OPENAI_API_KEY", "ROTOM_PI", "ROTOM_QODER", "NODE_OPTIONS"):
            self.assertNotIn(key, env)

    def test_artifact_hash_mismatch_does_not_start_install(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            config = json.loads((adapter.ROOT / "release.json").read_text())
            config.update(ready=True, productSha256="a" * 64, sourceCommit="b" * 40, productVersion="0.0.0-test")
            (root / "release.json").write_text(json.dumps(config))
            (root / "release").mkdir()
            (root / "release" / "rotom.tgz").write_bytes(b"wrong artifact")
            with patch("adapter.urllib.request.urlopen") as network:
                with self.assertRaisesRegex(adapter.PreflightError, "SHA256 mismatch"):
                    adapter.install(root)
                network.assert_not_called()
            self.assertFalse((root / ".runtime").exists())

    def test_symlink_prompt_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            (root / "original").write_text("test")
            (root / "alias").symlink_to(root / "original")
            with self.assertRaises(adapter.PreflightError):
                adapter.regular(root / "alias")

    def execute(self, source, timeout=5):
        with tempfile.TemporaryFile() as prompt:
            return adapter.execute([sys.executable, "-c", source], dict(os.environ), prompt, timeout)

    def test_completed_counts_only_final_usage_and_drops_content(self):
        events = [
            {"type": "message_update", "usage": USAGE, "content": "not-for-report"},
            {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop",
                                                   "content": "not-for-report", "usage": USAGE}},
            {"type": "agent_end", "messages": ["not-for-report"]},
        ]
        source = "import json\n" + "\n".join(f"print({json.dumps(event)!r})" for event in events)
        summary, code = self.execute(source)
        self.assertEqual(code, 0)
        self.assertEqual(summary["usage"], USAGE)
        self.assertIsNone(summary["score"])
        self.assertIsNone(summary["cost"])
        self.assertNotIn("not-for-report", json.dumps(summary))

    def test_no_agent_end_or_truncated_json_cannot_be_success(self):
        for source in ("print('{}')", "print('{', end='')", "print('x' * 100)"):
            with patch.object(adapter, "MAX_LINE", 64):
                summary, code = self.execute(source)
            self.assertNotEqual(code, 0)
            self.assertEqual(summary["status"], "unknown")

    def test_platform_owned_timeout_allows_agent_completion(self):
        source = ('import time\ntime.sleep(0.05)\n'
                  'print(\'{"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}\')\n'
                  'print(\'{"type":"agent_end"}\')')
        summary, code = self.execute(source, timeout=0)
        self.assertEqual(code, 0)
        self.assertFalse(summary["timedOut"])

    def test_provider_failure_is_not_completion(self):
        event = {"type": "message_end", "message": {"role": "assistant", "stopReason": "error"}}
        summary, code = self.execute(f"print({json.dumps(event)!r})\nprint('{{\"type\":\"agent_end\"}}')")
        self.assertEqual(code, 1)
        self.assertEqual(summary["status"], "failed")
        self.assertIsNone(summary["usage"])

    def test_sigterm_cancels_and_reaps_agent(self):
        with tempfile.TemporaryDirectory() as temp:
            marker = Path(temp).resolve() / "child.pid"
            child_source = f"import os,time\nfrom pathlib import Path\nPath({str(marker)!r}).write_text(str(os.getpid()))\ntime.sleep(30)"
            runner = ("import adapter,sys,os,json\n"
                      f"summary,code=adapter.execute([sys.executable,'-c',{child_source!r}],dict(os.environ),None,0)\n"
                      "print(json.dumps(summary));sys.exit(code)")
            process = subprocess.Popen([sys.executable, "-c", runner], cwd=adapter.ROOT,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(marker.exists())
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 130, stderr)
                self.assertTrue(json.loads(stdout)["cancelled"])
                with self.assertRaises(ProcessLookupError):
                    os.killpg(int(marker.read_text()), 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    def test_timeout_kills_process_group(self):
        with tempfile.TemporaryDirectory() as temp:
            marker = Path(temp) / "pid"
            source = f"import os, time\nfrom pathlib import Path\nPath({str(marker)!r}).write_text(str(os.getpid()))\ntime.sleep(20)"
            summary, code = self.execute(source, timeout=1)
            self.assertEqual(code, 124)
            self.assertTrue(summary["timedOut"])
            with self.assertRaises(ProcessLookupError):
                os.killpg(int(marker.read_text()), 0)

    def test_shell_start_preserves_case_cwd_and_prompt_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            case = root / "case with spaces"
            case.mkdir()
            runtime = root / ".runtime"
            node_bin = runtime / "node" / "bin"
            node_bin.mkdir(parents=True)
            node = node_bin / "node"
            node.write_text("test fixture")
            command = runtime / "rotom"
            command.write_text(f"#!{sys.executable}\nimport json, os, sys\nfrom pathlib import Path\n"
                               "Path('capture.json').write_text(json.dumps({'cwd':os.getcwd(),'argv':sys.argv[1:],'prompt':sys.stdin.read(),'home':os.environ['HOME']}))\n"
                               "print(json.dumps({'type':'message_end','message':{'role':'assistant','stopReason':'stop'}}))\n"
                               "print(json.dumps({'type':'agent_end'}))\n")
            command.chmod(0o700)
            config = json.loads((adapter.ROOT / "release.json").read_text())
            config.update(ready=True, productSha256="a" * 64, sourceCommit="b" * 40, productVersion="0.0.0-test")
            (root / "release.json").write_text(json.dumps(config))
            (runtime / "installed.json").write_text(json.dumps({"releaseSha256": adapter.digest(root / "release.json"),
                                                               "nodeBin": str(node_bin), "command": str(command)}))
            for name in ("start.sh", "adapter.py"):
                (root / name).write_bytes((adapter.ROOT / name).read_bytes())
            prompt = root / "prompt.txt"
            prompt_text = "--model evil\n$(touch SHOULD_NOT_EXIST)\n@another-file\n中文\n"
            prompt.write_text(prompt_text)
            result = subprocess.run(["bash", str(root / "start.sh")], cwd=case,
                                    env=dict(os.environ) | MODEL_ENV | {"PROMPT_FILE": str(prompt)},
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            capture = json.loads((case / "capture.json").read_text())
            self.assertEqual(capture["cwd"], str(case))
            self.assertEqual(capture["prompt"], prompt_text)
            self.assertEqual(capture["argv"], ["--print", "--mode", "json", "--no-session", "--no-approve",
                                                "--tools", "bash,read,write,edit",
                                                "--provider", "evaplus", "--model", "test-model", "--thinking", "off"])
            self.assertFalse(Path(capture["home"]).exists())
            self.assertFalse((case / "SHOULD_NOT_EXIST").exists())
            self.assertNotIn(MODEL_ENV["API_KEY"], result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
