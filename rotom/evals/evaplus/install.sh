#!/usr/bin/env bash
set -euo pipefail
adapter_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec python3 "$adapter_dir/adapter.py" install
