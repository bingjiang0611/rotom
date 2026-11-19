from __future__ import annotations

import os
import re
import shlex
import tempfile
from pathlib import Path
from typing import override

from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.installed.pi import Pi, PiOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from benchmark_adapters.product_bundle import stage_product_bundle


REMOTE_PRODUCT_DIR = "/opt/dev-agent"
REMOTE_FORK_DIR = REMOTE_PRODUCT_DIR + "/runtime/pi"
# rotom's launcher gates Pi on @earendil-works/pi-coding-agent plus the
# createCodemodeExtension and ModelRuntime capabilities; 0.84.3 fails that gate.
# The product pins its own fork (1.4.0-rotom.X), so this is the closest published version.
DEFAULT_PI_VERSION = "1.4.0"


# Runs after the fork is installed and `pi` is shimmed. It records what the launcher
# actually loads, so a trial that silently fell back to another Pi is visible in the run
# directory instead of only showing up as a suspicious score.
PI_RUNTIME_READBACK = """const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const run = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const record = {
  arm: "rotom-fork",
  launcherVersion: run("/opt/dev-agent/bin/rotom", ["--version"]),
  resolvedPi: run("node", ["/opt/dev-agent/runtime/resolve-installed-pi.mjs", "/opt/dev-agent"]),
};
try { record.buildInfo = readJson("/opt/dev-agent/build-info.json"); }
catch { record.buildInfo = null; }
const bundle = readJson("/opt/dev-agent/dev-agent-benchmark-manifest.json");
record.bundle = { sha256: bundle.bundleSha256, fileCount: bundle.fileCount, git: bundle.git };
fs.mkdirSync("/logs/agent", { recursive: true });
fs.writeFileSync("/logs/agent/pi-runtime.json", JSON.stringify(record, null, 2) + "\\n");
console.log(record.launcherVersion);
console.log(record.resolvedPi);
"""


class DevAgentPiOptions(PiOptions):
    """Pi options plus the product bundle this adapter uploads into the task."""

    product_agent_dir: str | None = None


def prompt_argument(instruction: str) -> str:
    """Make an instruction safe as Harbor's bare positional argument.

    Harbor's Pi agent appends the instruction to `pi --print ...` without an option
    terminator, so an instruction starting with "-" parses as an unknown option and the
    trial dies before the model reads it (FrontierHarness `pytorch-model-recovery`).
    Leading whitespace is insignificant to the model and keeps the text intact.
    """

    return f" {instruction}" if instruction.startswith("-") else instruction


class NativePi(Pi):
    """Unmodified Pi behavior with the same installer/version as the product arm."""

    def __init__(self, *args, version: str = DEFAULT_PI_VERSION, **kwargs):
        if not isinstance(version, str) or not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?", version):
            raise ValueError("An exact Pi version is required")
        super().__init__(*args, version=version, **kwargs)

    @staticmethod
    @override
    def name() -> str:
        return "native-pi"

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await super().run(prompt_argument(instruction), environment, context)

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl",))
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet(24)} && "
                f"npm install -g --ignore-scripts {shlex.quote(self._package_name() + '@' + self._version)} && "
                "node --version && pi --version"
            ),
        )


class DevAgentPi(NativePi):
    """Harbor's Pi agent with the selected dev-agent product bundle loaded."""

    options_model = DevAgentPiOptions
    # The upstream-Pi arm keeps the official Pi binary and hands it to the launcher.
    shim_name = "harbor-pi-shim"

    def __init__(
        self,
        *args,
        product_agent_dir: str | None = None,
        version: str | None = DEFAULT_PI_VERSION,
        **kwargs,
    ):
        selected_product = product_agent_dir or os.environ.get("ROTOM_PRODUCT_AGENT_DIR")
        if not selected_product:
            raise ValueError("product_agent_dir is required")
        product_path = Path(selected_product).expanduser()
        if not product_path.is_absolute():
            raise ValueError("product_agent_dir must be absolute")
        self._product_agent_dir = product_path.resolve(strict=True)
        super().__init__(*args, version=version, **kwargs)

    @staticmethod
    @override
    def name() -> str:
        return "dev-agent-pi"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        await self.stage_bundle(environment)
        await self.install_third_party(environment)
        await self.install_pi_shim(environment)

    async def stage_bundle(self, environment: BaseEnvironment) -> None:
        with tempfile.TemporaryDirectory(prefix="dev-agent-harbor-bundle-") as temp_dir:
            staging = Path(temp_dir) / "dev-agent"
            stage_product_bundle(self._product_agent_dir, staging)
            await environment.upload_dir(staging, REMOTE_PRODUCT_DIR)

        if environment.default_user is not None:
            owner = shlex.quote(str(environment.default_user))
            await self.exec_as_root(
                environment,
                command=f"chown -R {owner} {shlex.quote(REMOTE_PRODUCT_DIR)}",
            )

    async def install_third_party(self, environment: BaseEnvironment) -> None:
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; . ~/.nvm/nvm.sh; "
                f"cd {shlex.quote(REMOTE_PRODUCT_DIR + '/extensions/third-party')}; "
                "npm ci --ignore-scripts --omit=optional --legacy-peer-deps --replace-registry-host=never --no-audit --no-fund; "
                f"cp {shlex.quote(REMOTE_PRODUCT_DIR + '/dev-agent-benchmark-manifest.json')} "
                "/logs/agent/dev-agent-manifest.json"
            ),
        )

    async def install_pi_shim(self, environment: BaseEnvironment) -> None:
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; . ~/.nvm/nvm.sh; "
                "pi_path=$(command -v pi); "
                'test -n "$pi_path"; '
                'rm -f "$pi_path.upstream"; '
                'mv "$pi_path" "$pi_path.upstream"; '
                f"cp {shlex.quote(REMOTE_PRODUCT_DIR + '/bin/' + self.shim_name)} \"$pi_path\"; "
                'chmod 755 "$pi_path"; '
                '"$pi_path" --version'
            ),
        )


class RotomForkPi(DevAgentPi):
    """The same bundle, but Pi comes from the checked-in fork instead of the registry.

    The launcher resolves `runtime/pi/node_modules` on its own, so this arm exports no
    ROTOM_PI and installs the fork the way a release does: `npm ci` against the
    lockfile, with the vendored tarballs carried inside the uploaded bundle.
    """

    # The fork shim execs the launcher without telling it where Pi is.
    shim_name = "harbor-rotom-shim"

    @staticmethod
    @override
    def name() -> str:
        return "rotom-fork-pi"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await NativePi.install(self, environment)
        await self.stage_bundle(environment)
        await self.install_third_party(environment)
        await self.install_fork_runtime(environment)
        await self.install_pi_shim(environment)
        await self.record_pi_runtime(environment)

    async def install_fork_runtime(self, environment: BaseEnvironment) -> None:
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; . ~/.nvm/nvm.sh; "
                f"cd {shlex.quote(REMOTE_FORK_DIR)}; "
                "npm ci --ignore-scripts --omit=optional --replace-registry-host=never --no-audit --no-fund"
            ),
        )

    async def record_pi_runtime(self, environment: BaseEnvironment) -> None:
        """Prove which Pi actually ran, not just that the install exited zero."""

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; . ~/.nvm/nvm.sh; "
                f"node -e {shlex.quote(PI_RUNTIME_READBACK)}"
            ),
        )
