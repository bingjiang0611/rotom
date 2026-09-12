from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from pathlib import Path

from harbor.agents.installed.pi import Pi

from benchmark_adapters.dev_agent_pi import DevAgentPi, NativePi
from benchmark_adapters.harbor_environment import with_amd64_rosetta_args
from benchmark_adapters.product_bundle import (
    REQUIRED_PRODUCT_FILES,
    build_pi_shim,
    stage_product_bundle,
)


class ProductBundleTest(unittest.TestCase):
    def create_product(self, root: Path) -> Path:
        product = root / "rotom"
        for relative in REQUIRED_PRODUCT_FILES:
            path = product / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"fixture:{relative}\n", encoding="utf-8")
        (product / "extensions/third-party/node_modules/secret").mkdir(parents=True)
        (product / "extensions/third-party/node_modules/secret/token.txt").write_text("excluded")
        return product

    def test_stages_a_digest_and_excludes_installed_dependencies(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            product = self.create_product(root)
            # A stale source checkout must not reintroduce retired platform roots.
            for retired in ("legacy-tracker", "legacy-platform"):
                path = product / "extensions" / retired
                path.mkdir()
                (path / "index.ts").write_text("retired fixture\n", encoding="utf-8")
            destination = root / "bundle"
            manifest = stage_product_bundle(product, destination)

            self.assertEqual(manifest["schemaVersion"], 1)
            self.assertEqual(len(manifest["bundleSha256"]), 64)
            self.assertFalse((destination / "extensions/third-party/node_modules").exists())
            self.assertTrue((destination / "extensions/observability/index.ts").is_file())
            self.assertTrue((destination / "extensions/coding-policy/index.ts").is_file())
            self.assertTrue((destination / "skills/pi-subagents/SKILL.md").is_file())
            archive = "extensions/third-party/vendor/pi-subagents-0.52.1-dev-agent-followthrough.2.tgz"
            self.assertEqual((destination / archive).read_bytes(), (product / archive).read_bytes())
            self.assertEqual(
                {path.name for path in (destination / "extensions").iterdir()},
                {"observability", "browser", "coding-policy", "third-party"},
            )
            persisted = json.loads((destination / "dev-agent-benchmark-manifest.json").read_text())
            self.assertEqual(persisted["bundleSha256"], manifest["bundleSha256"])
            self.assertNotIn("ROTOM_COMPACT_POLICY", (destination / "bin/harbor-pi-shim").read_text())

    def test_rejects_an_incomplete_product(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            product = self.create_product(root)
            (product / REQUIRED_PRODUCT_FILES[0]).unlink()
            with self.assertRaises(FileNotFoundError):
                stage_product_bundle(product, root / "bundle")

    def test_shim_only_pins_the_verified_pi_executable(self):
        shim = build_pi_shim()
        self.assertIn("ROTOM_PI", shim)
        self.assertNotIn("ROTOM_COMPACT_POLICY", shim)


class HarborAdapterTest(unittest.TestCase):
    def test_native_arm_rejects_unpinned_versions_before_installation(self):
        for version in (None, "latest", "^0.85.1", "0.85.1; touch /tmp/bad"):
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, "exact Pi version"):
                NativePi(version=version)

    def test_native_arm_uses_pi_behavior_and_both_arms_share_installation(self):
        self.assertTrue(issubclass(DevAgentPi, NativePi))
        self.assertEqual(NativePi.name(), "native-pi")
        self.assertIs(NativePi.run, Pi.run)
        self.assertIs(DevAgentPi.run, Pi.run)
        fake = SimpleNamespace(
            _version="0.85.1",
            _package_name=lambda: "@earendil-works/pi-coding-agent",
            ensure_system_dependencies=AsyncMock(),
            exec_as_agent=AsyncMock(),
        )
        asyncio.run(NativePi.install(fake, object()))
        command = fake.exec_as_agent.call_args.kwargs["command"]
        self.assertIn("@earendil-works/pi-coding-agent@0.85.1", command)
        self.assertIn("--ignore-scripts", command)
        self.assertIn("24", command)
        self.assertNotIn("@latest", command)
        self.assertNotIn("dev-agent", command)
        self.assertNotIn("harbor-pi-shim", command)

    def test_product_install_keeps_the_relative_archive_and_disables_registry_rewriting(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            product = ProductBundleTest().create_product(root)
            agent = DevAgentPi(product_agent_dir=str(product), logs_dir=root / "logs", model_name="unresolved/luna", version="0.85.1")
            agent.ensure_system_dependencies = AsyncMock()
            agent.exec_as_agent = AsyncMock()
            environment = SimpleNamespace(default_user=None, upload_dir=AsyncMock())
            asyncio.run(agent.install(environment))
            commands = [call.kwargs["command"] for call in agent.exec_as_agent.call_args_list]
            self.assertEqual(len(commands), 2)
            self.assertIn("@earendil-works/pi-coding-agent@0.85.1", commands[0])
            self.assertIn("npm ci --ignore-scripts --omit=optional --legacy-peer-deps --replace-registry-host=never", commands[1])
            self.assertNotIn("--replace-registry-host=always", commands[1])
            environment.upload_dir.assert_awaited_once()

    def test_native_thinking_flag_is_forwarded_without_model_calls(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            agent = NativePi(logs_dir=Path(temp_dir), model_name="unresolved/luna", version="0.85.1", thinking="high")
            self.assertEqual(agent.build_cli_flags(), "--thinking high")

    def test_dev_agent_is_a_harbor_pi_agent(self):
        self.assertTrue(issubclass(DevAgentPi, Pi))
        self.assertEqual(DevAgentPi.name(), "dev-agent-pi")

    def test_adds_amd64_rosetta_only_to_relevant_container_commands(self):
        self.assertEqual(
            with_amd64_rosetta_args(["run", "-d", "image"]),
            ["run", "--platform", "linux/amd64", "--rosetta", "-d", "image"],
        )
        self.assertEqual(
            with_amd64_rosetta_args(["build", "-t", "image", "."]),
            ["build", "--platform", "linux/amd64", "-t", "image", "."],
        )
        self.assertEqual(with_amd64_rosetta_args(["stop", "name"]), ["stop", "name"])


if __name__ == "__main__":
    unittest.main()
