from __future__ import annotations

from typing import override

from harbor.environments.apple_container import AppleContainerEnvironment
from harbor.environments.base import ExecResult


def with_amd64_rosetta_args(args: list[str]) -> list[str]:
    if not args:
        return []
    if args[0] == "run" and "--platform" not in args:
        return ["run", "--platform", "linux/amd64", "--rosetta", *args[1:]]
    if args[0] == "build" and "--platform" not in args:
        return ["build", "--platform", "linux/amd64", *args[1:]]
    if len(args) >= 2 and args[:2] == ["image", "pull"] and "--platform" not in args:
        return ["image", "pull", "--platform", "linux/amd64", *args[2:]]
    return list(args)


class Amd64AppleContainerEnvironment(AppleContainerEnvironment):
    """Apple container backend for the amd64 images published by coding benchmarks."""

    @override
    async def _run_container_command(
        self,
        args: list[str],
        check: bool = True,
        timeout_sec: int | None = None,
        stdin_data: bytes | None = None,
    ) -> ExecResult:
        return await super()._run_container_command(
            with_amd64_rosetta_args(args),
            check=check,
            timeout_sec=timeout_sec,
            stdin_data=stdin_data,
        )
