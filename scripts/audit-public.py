#!/usr/bin/env python3
"""Local-only release audit. Reports coordinates/digests, never matched values.

Heuristic review aid, not a guarantee that arbitrary secrets or proprietary code
are absent. No network, no extraction, no file edits, and no history rewriting.
"""
import argparse
import hashlib
import io
import ipaddress
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
from urllib.parse import urlsplit

MAX_FILE = 32 * 1024 * 1024
# The product now embeds Pi's CLI + SDK dependency closure (about 51 MiB tgz).
# Increase only archive input/aggregate coverage; ordinary members stay bounded.
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_EXPANDED = 384 * 1024 * 1024
CREDENTIAL = re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{25,}|AKIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{20,})\b")
PRIVATE_KEY = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[A-Za-z0-9+/=\s]{64,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")
HOME_PATH = re.compile(r"(?:/Users/|/home/|[A-Z]:\\Users\\)([A-Za-z0-9_.-]+)")
EXAMPLE_USERS = {"name", "user", "me", "example", "test", "username", "your-user", "your-username", "..."}
# Exact public examples verified against upstream tags, not broad path skips.
# Keep integrity-pinned dependencies unchanged. Credential examples have a
# separate exact allowlist only for AWS's documented non-secret example key.
ROUTEROS_PUBLIC_PATHS = ("/highlight.js/es/languages/routeros.js", "/highlight.js/lib/languages/routeros.js")
PUBLIC_EXAMPLE_LINES = {
    # pi-subagents v0.52.1, docs/configuration.md
    "779a0301e59aa5687dd4285b7825a67db5c03dc7d2c71907f817a43dca3845dd": ("::package/docs/configuration.md", "/pi-subagents/docs/configuration.md", "packages/rotom-subagents/docs/configuration.md"),
    # Pi da840b6216578c2a571d0374ac6a2091a83f9d91: exact public docs/test/build examples.
    '37e0fefc8c656caea60a2f8af312b00b07f916f84038eca7ff4b4c438f0f520a': ('packages/rotom-pi/packages/coding-agent/CHANGELOG.md', '::package/CHANGELOG.md', '/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md'),
    'b0d8b8db94e94e91faa9c9543496353b1e63047789f2bed961997a8538b39709': ('packages/rotom-pi/packages/coding-agent/docs/containerization.md', '::package/docs/containerization.md', '/node_modules/@earendil-works/pi-coding-agent/docs/containerization.md'),
    'a3306e3593a4c88ada448ce349eda0dbf01f610722835b59966547c6d657f4b0': ('packages/rotom-pi/packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.js', '::package/examples/extensions/doom-overlay/doom/build/doom.js', '/node_modules/@earendil-works/pi-coding-agent/examples/extensions/doom-overlay/doom/build/doom.js'),
    '688c3a36296727b52e735886ffd0e8a3b19ea623adc485cf67cce1ae6725efdc': ('packages/rotom-pi/packages/coding-agent/examples/extensions/overlay-qa-tests.ts', '::package/examples/extensions/overlay-qa-tests.ts', '/node_modules/@earendil-works/pi-coding-agent/examples/extensions/overlay-qa-tests.ts'),
    '2f205688f7b2b94909400bc843d6933f8bc7e07b6c732dfd8b30180193073cdb': ('packages/rotom-pi/packages/coding-agent/examples/extensions/overlay-qa-tests.ts', '::package/examples/extensions/overlay-qa-tests.ts', '/node_modules/@earendil-works/pi-coding-agent/examples/extensions/overlay-qa-tests.ts'),
    'a2c465a3a23c33b16a1c93cb8fcf2f6990fad31bb5d7acfbfd0978ef77936808': ('packages/rotom-pi/packages/coding-agent/test/footer-width.test.ts',),
    '113bfc3e5f654d1e18c52fe455c0824161396c55b41ff6cd0665c65bb6a6b9a8': ('packages/rotom-pi/packages/tui/test/terminal.test.ts',),
    '3547aa874fa468dcf24a7a330d1525f6ccbe4e47c647135f61e56e31b4c20ea2': ('packages/rotom-pi/test.sh',),
    '2a4e41bc55351125f9dd0e7e2628b607d3e2a6b779853bf37e9602445b5086de': ('packages/rotom-pi/test.sh',),
    # highlight.js 11.12.0, src/languages/routeros.js
    "fbb6ac264a5eb158e5e8b293c95fc236c9dfbccd50297bbe012e4f8cde6d6514": ROUTEROS_PUBLIC_PATHS,
    "baedd93454523f52e6564baf2c2c0831858aa23008718399536b7894688a1969": ROUTEROS_PUBLIC_PATHS,
    "5bbbf02a9a3751025094c466dbfe5b4cd7348de1bf73442120c8939d735e33c8": ROUTEROS_PUBLIC_PATHS,
}


PI_PUBLIC_EXAMPLES = json.loads(Path(__file__).with_name('pi-public-examples.json').read_text())
PUBLIC_EXAMPLE_LINES.update({key: tuple(paths) for key, paths in PI_PUBLIC_EXAMPLES['examples'].items()})


def is_public_example(path, line):
    return path.endswith(PUBLIC_EXAMPLE_LINES.get(hashlib.sha256(line.encode()).hexdigest(), ()))
URL = re.compile(r"https?://[^\s\"'<>`]+")
IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
PRIVATE_NETWORKS = [ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]


class Audit:
    def __init__(self, deny_terms=()):
        self.deny_terms = tuple(term for term in deny_terms if term)
        self.findings = []
        self.files = 0
        self.expanded = 0
        self.public_examples = 0
        self.commits = 0

    def add(self, path, rule, value="", line=None):
        self.findings.append({"path": path, "rule": rule, "line": line,
                              "digest": hashlib.sha256(value.encode()).hexdigest()[:12] if value else None})

    def scan(self, path, data, depth=0):
        self.files += 1
        self.expanded += len(data)
        archive_input = path.endswith((".tgz", ".tar.gz"))
        if len(data) > (MAX_ARCHIVE if archive_input else MAX_FILE) or self.expanded > MAX_EXPANDED:
            raise ValueError("audit size budget exceeded; coverage incomplete")
        parts = PurePosixPath(path.split("::")[-1]).parts
        if any(part in {".git", ".pi", ".eval", ".DS_Store"} for part in parts):
            self.add(path, "private-state-path")
        basename = parts[-1] if parts else ""
        if basename in {"auth.json", "credentials.json", ".npmrc", ".env"} or (basename.startswith(".env.") and basename != ".env.example") or basename.endswith((".jsonl", ".log")):
            self.add(path, "private-data-file")
        if archive_input:
            if depth >= 3:
                raise ValueError("archive nesting budget exceeded; coverage incomplete")
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                for member in archive:
                    name = PurePosixPath(member.name)
                    if name.is_absolute() or ".." in name.parts or not (member.isfile() or member.isdir()):
                        self.add(path, "unsafe-archive-entry")
                        continue
                    if member.isfile():
                        if member.size > MAX_FILE:
                            raise ValueError("archive member exceeds audit budget")
                        self.scan(path + "::" + member.name, archive.extractfile(member).read(MAX_FILE + 1), depth + 1)
            return
        try:
            text = data.decode("utf8")
        except UnicodeDecodeError:
            return  # Binary inventory is checked, but this is not OCR/binary secret detection.
        for rule, pattern in (("credential-shape", CREDENTIAL), ("private-key-block", PRIVATE_KEY)):
            for match in pattern.finditer(text):
                number = text.count("\n", 0, match.start()) + 1
                line = text.splitlines()[number - 1]
                paths = PI_PUBLIC_EXAMPLES['credentialExamples'].get(hashlib.sha256(line.encode()).hexdigest(), [])
                if rule == 'credential-shape' and path.endswith(tuple(paths)):
                    self.public_examples += 1
                else:
                    self.add(path, rule, match[0], number)
        for match in HOME_PATH.finditer(text):
            number = text.count("\n", 0, match.start()) + 1
            line = text.splitlines()[number - 1]
            if is_public_example(path, line):
                self.public_examples += 1
            elif match[1].lower() not in EXAMPLE_USERS:
                self.add(path, "personal-home-path", match[0], number)
        for number, line in enumerate(text.splitlines(), 1):
            for term in self.deny_terms:
                if term.casefold() in line.casefold():
                    self.add(path, "private-marker", term, number)
            for match in URL.finditer(line):
                try:
                    url = urlsplit(match[0]); host = url.hostname or ""
                except ValueError:
                    continue
                if re.search(r"\.(?:corp|internal|intranet|local)$", host, re.I):
                    if is_public_example(path, line):
                        self.public_examples += 1
                    else:
                        self.add(path, "internal-host", host, number)
                if url.username or url.password:
                    if host not in {"example.com", "example.invalid", "example.test"}:
                        if is_public_example(path, line):
                            self.public_examples += 1
                        else:
                            self.add(path, "url-credentials", match[0], number)
            for match in IPV4.finditer(line):
                try:
                    address = ipaddress.ip_address(match[0])
                except ValueError:
                    continue
                if not any(address in network for network in PRIVATE_NETWORKS):
                    continue
                if is_public_example(path, line):
                    self.public_examples += 1
                    continue
                # RFC1918 range declarations are public notation, not host data.
                if any(line[match.start():].startswith(str(network)) for network in PRIVATE_NETWORKS):
                    continue
                self.add(path, "private-network-address", match[0], number)


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def audit_tree(root, audit):
    for name in git(root, "ls-files", "-z").decode().split("\0"):
        if not name:
            continue
        path = root / name
        if path.is_symlink() or path.resolve() != path:
            audit.add(name, "symlink-or-canonical-drift")
            continue
        if not path.is_file():
            audit.add(name, "missing-tracked-file")
            continue
        with path.open("rb") as stream:
            audit.scan(name, stream.read(MAX_FILE + 1))


def audit_history(root, audit):
    commits = git(root, "log", "--all", "--format=%H%x09%ae%x09%ce").decode().splitlines()
    if not commits:
        raise ValueError("history audit requires at least one commit")
    audit.commits = len(commits)
    # Commit messages/headers are publishable data too, not just tracked blobs.
    objects = {row.split("\t")[0]: "commit-message" for row in commits}
    for row in git(root, "rev-list", "--objects", "--all").decode().splitlines():
        oid, _, path = row.partition(" ")
        objects[oid] = path or objects.get(oid, "git-object")
    proc = subprocess.Popen(["git", "-C", str(root), "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        for oid, path in objects.items():
            proc.stdin.write((oid + "\n").encode()); proc.stdin.flush()
            header = proc.stdout.readline().split(); size = int(header[2])
            if size > MAX_FILE:
                raise ValueError("history object exceeds audit budget")
            data = proc.stdout.read(size)
            if len(data) != size or proc.stdout.read(1) != b"\n":
                raise ValueError("incomplete git object read")
            if header[1] in {b"blob", b"commit", b"tag"}:
                audit.scan("history:" + oid[:12] + "::" + path, data)
            if header[1] == b"tag":
                tagger = re.search(rb"^tagger .* <([^>]+)>", data, re.M)
                if tagger and not tagger[1].endswith(b"@users.noreply.github.com"):
                    audit.add("tag:" + oid[:12], "non-noreply-tagger", tagger[1].decode())
    finally:
        proc.stdin.close(); proc.stdout.close()
        if proc.poll() is None:
            proc.terminate()
        proc.wait()
    for row in commits:
        oid, author, committer = row.split("\t")
        for kind, email in (("author", author), ("committer", committer)):
            if not email.endswith("@users.noreply.github.com"):
                audit.add("commit:" + oid[:12], "non-noreply-" + kind, email)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--artifact", type=Path)
    mode.add_argument("--history", action="store_true")
    parser.add_argument("--deny-term", action="append", default=[])
    args = parser.parse_args()
    audit = Audit(args.deny_term)
    try:
        if args.artifact:
            with args.artifact.open("rb") as stream:
                audit.scan(args.artifact.name, stream.read(MAX_ARCHIVE + 1))
        else:
            root = args.root.resolve(strict=True)
            if Path(git(root, "rev-parse", "--show-toplevel").decode().strip()).resolve() != root:
                raise ValueError("root must be the exact Git repository root")
            audit_tree(root, audit)
            if args.history:
                audit_history(root, audit)
        print(json.dumps({"status": "BLOCKED" if audit.findings else "PASS", "scope": "artifact" if args.artifact else "tree+history" if args.history else "tracked-tree",
                          "filesChecked": audit.files, "bytesChecked": audit.expanded, "commitsChecked": audit.commits, "verifiedPublicExamples": audit.public_examples, "findingCount": len(audit.findings),
                          "findings": audit.findings[:200], "omittedFindings": max(0, len(audit.findings)-200),
                          "limitations": "Heuristic text scan; no OCR, arbitrary secret guarantee, or IP ownership review."}, ensure_ascii=False))
        return 1 if audit.findings else 0
    except Exception as error:
        print(json.dumps({"status": "BLOCKED", "reason": type(error).__name__, "coverageComplete": False}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
