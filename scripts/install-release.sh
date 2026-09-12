#!/bin/sh
set -eu

# Reproducible rotom release install (maintenance standard).
#
# Installs a packed `rotom-<version>.tgz` (produced by `npm run pack:release`)
# into a per-version directory and repoints the active `rotom` command at it.
# This codifies the layout the previous alpha releases already use, so every
# install is identical and switching versions is a single symlink swap:
#
#   ~/.local/share/rotom/releases/<version>/
#     rotom-<version>.tgz          the packed product artifact
#     package.json                 { "dependencies": { "rotom": "file:<tgz>" } }
#     node_modules/rotom           the installed product (+ the pinned Pi runtime)
#   <node-bin>/rotom -> releases/<version>/node_modules/rotom/bin/rotom
#
# The tgz bundles the product, its verified Pi fork and third-party packages.
# Installation does not resolve Pi from the public npm registry or a checkout.
#
# Usage:
#   scripts/install-release.sh /absolute/path/to/rotom-<version>.tgz [--force]
#
# --force replaces an existing release directory of the same version. Without it
# the script refuses to clobber a version that may already be in use.

usage() { echo "usage: $0 /absolute/path/to/rotom-<version>.tgz [--force]" >&2; exit 2; }

tgz=""
force=0
for arg in "$@"; do
	case "$arg" in
		--force) force=1 ;;
		-*) usage ;;
		*) if [ -n "$tgz" ]; then usage; fi; tgz=$arg ;;
	esac
done
[ -n "$tgz" ] || usage

command -v node >/dev/null 2>&1 || { echo "install-release: node not found on PATH" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "install-release: npm not found on PATH" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "install-release: tar not found on PATH" >&2; exit 1; }

# Resolve the artifact to an absolute regular file (reject symlinks).
case "$tgz" in /*) : ;; *) tgz="$(pwd)/$tgz" ;; esac
[ -f "$tgz" ] || { echo "install-release: not a file: $tgz" >&2; exit 1; }
[ -L "$tgz" ] && { echo "install-release: refusing symlinked artifact: $tgz" >&2; exit 1; }

# The packed package.json is the authoritative version, never the file name.
version=$(tar -xzOf "$tgz" package/package.json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);if(v.name!=="@bingjiang0611/rotom")throw 0;process.stdout.write(String(v.version))}catch{process.exit(3)}})') || {
	echo "install-release: artifact is not @bingjiang0611/rotom" >&2; exit 1;
}
case "$version" in
	[0-9]*.[0-9]*.[0-9]*) : ;;
	*) echo "install-release: unexpected version '$version'" >&2; exit 1 ;;
esac

releases_root="$HOME/.local/share/rotom/releases"
dest="$releases_root/$version"

if [ -e "$dest" ]; then
	if [ "$force" -eq 1 ]; then
		echo "install-release: replacing existing $dest"
		rm -rf "$dest"
	else
		echo "install-release: $dest already exists (use --force to replace)" >&2
		exit 1
	fi
fi

mkdir -p "$dest"
cp "$tgz" "$dest/rotom-$version.tgz"
cat > "$dest/package.json" <<EOF
{
  "dependencies": {
    "rotom": "file:rotom-$version.tgz"
  }
}
EOF

# Local install of the artifact; no lifecycle scripts (the product declares none).
( cd "$dest" && npm install --ignore-scripts --no-audit --no-fund )

rotom_bin="$dest/node_modules/rotom/bin/rotom"
[ -f "$rotom_bin" ] || { echo "install-release: installed launcher missing: $rotom_bin" >&2; exit 1; }

# Verify the installed package version matches the artifact before switching.
installed=$(node -e "process.stdout.write(require('$dest/node_modules/rotom/package.json').version)")
[ "$installed" = "$version" ] || { echo "install-release: installed version $installed != $version" >&2; exit 1; }

# Switch the active command: repoint the rotom symlink in the current node bin
# dir (this is the only 'current version' selector) without following the old
# link target.
bindir="$(dirname "$(command -v node)")"
ln -sfn "$rotom_bin" "$bindir/rotom"

# Readback: prove the command now resolves to the version we just installed.
linked=$(readlink "$bindir/rotom" || true)
echo "installed: rotom $version"
echo "  release dir: $dest"
echo "  command:     $bindir/rotom -> $linked"
[ "$linked" = "$rotom_bin" ] || { echo "install-release: symlink readback mismatch" >&2; exit 1; }
