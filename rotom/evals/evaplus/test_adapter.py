import json
import os
from pathlib import Path
import signal
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
        self.assertNotIn(MODEL_ENV["API_KEY"], json.dumps(result))
        for change in ({"BASE_URL": "http://example.test"}, {"BASE_URL": "https://example.test/?key=secret"},
                       {"MODEL_NAME": "test*"}, {"MAX_TOKENS": "9000"}, {"THINKING": "max"}):
            with self.assertRaises(adapter.PreflightError):
                adapter.model_config(MODEL_ENV | change)

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
                      f"summary,code=adapter.execute([sys.executable,'-c',{child_source!r}],dict(os.environ),None,20)\n"
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
                                                "--provider", "evaplus", "--model", "test-model", "--thinking", "off"])
            self.assertFalse(Path(capture["home"]).exists())
            self.assertFalse((case / "SHOULD_NOT_EXIST").exists())
            self.assertNotIn(MODEL_ENV["API_KEY"], result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
