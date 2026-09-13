#!/usr/bin/env bash
set -euo pipefail
adapter_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

python_supports_adapter() {
  "$1" - <<'PY'
import sys
import tarfile

if sys.version_info < (3, 11):
    raise SystemExit("rotom Eva+ adapter requires Python 3.11+")
if "filter" not in __import__("inspect").signature(tarfile.TarFile.extractall).parameters:
    raise SystemExit("rotom Eva+ adapter requires traversal-safe tar extraction support")
PY
}

install_python() {
  if command -v apt-get >/dev/null 2>&1; then
    local -a apt_env=(env DEBIAN_FRONTEND=noninteractive DEBCONF_NONINTERACTIVE_SEEN=true TZ=Etc/UTC)
    run_package_manager "${apt_env[@]}" apt-get update -qq
    if ! run_package_manager "${apt_env[@]}" apt-get install -y -qq python3; then
      # Some sandboxes bind-mount /etc/localtime. tzdata then fails its final
      # atomic rename even though Python and its stdlib were fully unpacked.
      if command -v python3 >/dev/null 2>&1 && python_supports_adapter "$(command -v python3)"; then
        printf '%s\n' 'rotom Eva+ adapter: apt returned nonzero after Python became usable; continuing' >&2
        return 0
      fi
      # Minimal benchmark images can contain unpacked but unconfigured packages.
      # Give dpkg one bounded repair pass with a fixed timezone, then retry.
      run_package_manager "${apt_env[@]}" dpkg --configure -a
      run_package_manager "${apt_env[@]}" apt-get install -f -y -qq
      run_package_manager "${apt_env[@]}" apt-get install -y -qq python3
    fi
  elif command -v apk >/dev/null 2>&1; then
    run_package_manager apk add --no-cache python3
  elif command -v dnf >/dev/null 2>&1; then
    run_package_manager dnf install -y python3
  elif command -v microdnf >/dev/null 2>&1; then
    run_package_manager microdnf install -y python3
  elif command -v yum >/dev/null 2>&1; then
    run_package_manager yum install -y python3
  else
    printf '%s\n' 'rotom Eva+ adapter requires Python 3.11+; no supported package manager was found' >&2
    return 1
  fi
}

run_package_manager() {
  if [[ $(id -u) == 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -- "$@"
  else
    printf '%s\n' 'rotom Eva+ adapter cannot install Python without root or sudo' >&2
    return 1
  fi
}

if ! command -v python3 >/dev/null 2>&1; then
  install_python
fi

python_bin=$(command -v python3)
python_supports_adapter "$python_bin"

exec "$python_bin" "$adapter_dir/adapter.py" install
