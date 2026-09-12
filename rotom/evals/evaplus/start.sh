#!/usr/bin/env bash
set -euo pipefail
# Resolve the adapter without changing the case working directory.
adapter_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec python3 "$adapter_dir/adapter.py" run
