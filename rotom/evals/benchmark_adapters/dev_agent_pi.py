from __future__ import annotations

import os
import re
import shlex
import tempfile
from pathlib import Path
from typing import override

from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment

from benchmark_adapters.product_bundle import stage_product_bundle


REMOTE_PRODUCT_DIR = "/opt/dev-agent"
DEFAULT_PI_VERSION = "0.84.3"


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

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; . ~/.nvm/nvm.sh; "
                f"cd {shlex.quote(REMOTE_PRODUCT_DIR + '/extensions/third-party')}; "
                "npm ci --ignore-scripts --omit=optional --legacy-peer-deps --replace-registry-host=never --no-audit --no-fund; "
                "pi_path=$(command -v pi); "
                'test -n "$pi_path"; '
                'rm -f "$pi_path.upstream"; '
                'mv "$pi_path" "$pi_path.upstream"; '
                f"cp {shlex.quote(REMOTE_PRODUCT_DIR + '/bin/harbor-pi-shim')} \"$pi_path\"; "
                'chmod 755 "$pi_path"; '
                f"cp {shlex.quote(REMOTE_PRODUCT_DIR + '/dev-agent-benchmark-manifest.json')} "
                "/logs/agent/dev-agent-manifest.json; "
                '"$pi_path" --version'
            ),
        )
