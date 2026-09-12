from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


BUNDLE_ROOTS = (
    "bin",
    "runtime",
    "skills",
    "extensions/observability",
    "extensions/browser",
    "extensions/coding-policy",
    "extensions/third-party",
)

REQUIRED_PRODUCT_FILES = (
    "bin/rotom-launcher",
    "runtime/product-config.mjs",
    "runtime/verify-pi-runtime.mjs",
    "extensions/observability/index.ts",
    "extensions/observability/dashboard.mjs",
    "extensions/browser/index.ts",
    "extensions/coding-policy/index.ts",
    "extensions/third-party/index.ts",
    "skills/pi-subagents/SKILL.md",
    "extensions/third-party/package.json",
    "extensions/third-party/package-lock.json",
    "extensions/third-party/vendor/pi-subagents-0.52.1-dev-agent-followthrough.2.tgz",
)


def _ignore_bundle_entries(_directory: str, names: list[str]) -> set[str]:
    ignored = {"node_modules", ".eval", "__pycache__"}
    return {name for name in names if name in ignored or name == ".DS_Store"}


def _run_git(product_dir: Path, *args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(product_dir), *args],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    return result.stdout.strip()


def snapshot_product_git(product_dir: Path) -> dict[str, Any]:
    git_root_text = _run_git(product_dir, "rev-parse", "--show-toplevel")
    git_head = _run_git(product_dir, "rev-parse", "HEAD")
    if not git_root_text:
        return {"head": git_head, "dirty": None}
    git_root = Path(git_root_text).resolve()
    try:
        scope = product_dir.relative_to(git_root).as_posix()
    except ValueError:
        return {"head": git_head, "dirty": None}
    status = _run_git(
        git_root,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        scope,
    )
    return {"head": git_head, "dirty": None if status is None else bool(status)}


def hash_bundle(directory: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    count = 0
    for path in sorted(directory.rglob("*"), key=lambda item: item.relative_to(directory).as_posix()):
        if path.is_symlink():
            raise ValueError(f"Product bundle must not contain symlinks: {path}")
        if not path.is_file():
            continue
        relative = path.relative_to(directory).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
        count += 1
    return digest.hexdigest(), count


def build_pi_shim() -> str:
    return """#!/bin/sh
set -eu
ROTOM_PI="${0}.upstream"
export ROTOM_PI
exec /opt/dev-agent/bin/rotom-launcher "$@"
"""


def stage_product_bundle(product_agent_dir: str | Path, destination: str | Path) -> dict[str, Any]:
    product_dir = Path(product_agent_dir).expanduser().resolve(strict=True)
    if not product_dir.is_dir():
        raise NotADirectoryError(f"Product agent directory is not a directory: {product_dir}")
    missing = [relative for relative in REQUIRED_PRODUCT_FILES if not (product_dir / relative).is_file()]
    if missing:
        raise FileNotFoundError(f"Product agent is missing required files: {', '.join(missing)}")

    target = Path(destination)
    target.mkdir(parents=True, exist_ok=True)
    for relative in BUNDLE_ROOTS:
        source = product_dir / relative
        staged = target / relative
        if source.is_dir():
            shutil.copytree(
                source,
                staged,
                dirs_exist_ok=True,
                ignore=_ignore_bundle_entries,
            )
        elif source.is_file():
            staged.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, staged)
        else:
            raise FileNotFoundError(f"Product bundle root is missing: {source}")

    shim = target / "bin" / "harbor-pi-shim"
    shim.write_text(build_pi_shim(), encoding="utf-8")
    shim.chmod(0o755)
    (target / "bin" / "rotom").chmod(0o755)
    bundle_digest, file_count = hash_bundle(target)
    manifest = {
        "schemaVersion": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "source": str(product_dir),
        "bundleSha256": bundle_digest,
        "fileCount": file_count,
        "git": snapshot_product_git(product_dir),
    }
    manifest_path = target / "dev-agent-benchmark-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(manifest_path, 0o644)
    return manifest
