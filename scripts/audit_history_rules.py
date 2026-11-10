"""History, range and replayed-archive audits. `audit-public.py` is the command; this walks git."""
import json
from pathlib import Path
import re
import subprocess

from audit_rules import AUDITED_ARCHIVE_SHARDS, AUDITED_ARCHIVES, LEDGER_ARCHIVE, MAX_FILE


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


def read_archive_ledger(path):
    if not path.exists():
        return {}
    ledger = json.loads(path.read_text())
    if ledger.get("schema") != 1 or not isinstance(ledger.get("archives"), list):
        raise ValueError("audited archive ledger is invalid")
    return {entry["oid"]: entry["path"] for entry in ledger["archives"]}


def load_archived_entries(path=AUDITED_ARCHIVES, shards=AUDITED_ARCHIVE_SHARDS):
    """Every recorded archive: the original single file plus every shard beside it.

    The record only grows — one entry per reviewed fork archive — and the repository's staged-file
    budget is per file, so the growth lives in shards while the original file keeps the first batch.
    """
    entries = read_archive_ledger(path)
    if shards.exists():
        for shard in sorted(shards.glob("*.json")):
            for oid, archive_path in read_archive_ledger(shard).items():
                entries.setdefault(oid, archive_path)
    return entries


def load_audited_archives(path=AUDITED_ARCHIVES, shards=AUDITED_ARCHIVE_SHARDS):
    return set(load_archived_entries(path, shards))


# GitHub creates web merges with its service noreply committer, and the maintainer decided to
# exempt twenty-three historical commits authored by Anthropic's agent noreply address. Both
# exceptions are exact addresses: a lookalike on either domain is still a finding.
GITHUB_SERVICE = "noreply@github.com"
ANTHROPIC_EXEMPT = "noreply@anthropic.com"


def publishable_identity(kind, email):
    if email.endswith("@users.noreply.github.com"):
        return True
    if kind == "committer" and email == GITHUB_SERVICE:
        return True
    return email == ANTHROPIC_EXEMPT


def clean_archives(audit):
    """Archives whose own scan produced no finding, so recording one is a statement about it alone."""
    scanned = set(audit.ledger_archives)
    for finding in audit.findings:
        prefix = finding.get("path", "")
        if not prefix.startswith("history:"):
            continue
        scanned.discard(next((oid for oid in scanned if oid[:12] == prefix[8:20]), None))
    return {oid: audit.ledger_archives[oid] for oid in scanned}


def write_audited_archives(archives, path=AUDITED_ARCHIVES, shards=AUDITED_ARCHIVE_SHARDS):
    """Merge into the record, then spread the sharded part over files of bounded size.

    Recording is additive across runs: a range push records the archives it proved clean and must
    not drop what an earlier run recorded. Entries already in the original file stay there; the rest
    is written to `<shards>/NNN.json`, sorted by oid so the same set always produces the same files.
    """
    entries = load_archived_entries(path, shards)
    entries.update(archives)
    original = read_archive_ledger(path)
    sharded = {oid: archive_path for oid, archive_path in sorted(entries.items()) if oid not in original}
    shards.mkdir(exist_ok=True)
    for stale in shards.glob("*.json"):
        stale.unlink()
    per_file = 120
    for index in range(0, len(sharded), per_file):
        batch = [{"oid": oid, "path": archive_path} for oid, archive_path in list(sharded.items())[index:index + per_file]]
        (shards / f"{index // per_file:03}.json").write_text(json.dumps({"schema": 1, "archives": batch}, indent=1) + "\n")


def audit_objects(root, audit, objects, audited_archives=frozenset()):
    """Scan each object once: blobs, commit headers/messages and tag signers."""
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
            if header[1] == b"blob" and LEDGER_ARCHIVE.match(path):
                audit.ledger_archives[oid] = path
                if oid in audited_archives:
                    audit.skipped_audited_archives += 1
                    continue
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


def audit_identities(commits, audit):
    for row in commits:
        oid, author, committer = row.split("\t")
        for kind, email in (("author", author), ("committer", committer)):
            if publishable_identity(kind, email):
                continue
            audit.add("commit:" + oid[:12], "non-noreply-" + kind, email)


def history_objects(root, revision_args):
    """Objects introduced by `revision_args`, mapped to a path label for the report."""
    objects = {}
    for row in git(root, "rev-list", "--objects", *revision_args).decode().splitlines():
        oid, _, path = row.partition(" ")
        objects[oid] = path or objects.get(oid, "git-object")
    return objects


def audit_history(root, audit, audited_archives=frozenset()):
    commits = git(root, "log", "--all", "--format=%H%x09%ae%x09%ce").decode().splitlines()
    if not commits:
        raise ValueError("history audit requires at least one commit")
    audit.commits = len(commits)
    objects = history_objects(root, ["--all"])
    # Commit messages/headers are publishable data too, not just tracked blobs. `rev-list --objects`
    # labels a commit with an empty path, so the label is set here rather than left as "git-object".
    for row in commits:
        objects[row.split("\t")[0]] = "commit-message"
    audit_objects(root, audit, objects, audited_archives)
    audit_identities(commits, audit)


def parse_history_range(text):
    """`<base>..<head>` with both ends required; a bare `--all`-style range would hide the budget."""
    base, separator, head = text.partition("..")
    if separator != ".." or not base or not head or head.startswith("."):
        raise ValueError("--history-range must be <base>..<head> with both ends explicit")
    return base, head


def audit_history_range(root, audit, text, audited_archives=frozenset()):
    """Audit only what a push adds: the commits in the range, their blobs and their identities."""
    base, head = parse_history_range(text)
    for revision in (base, head):
        try:
            git(root, "rev-parse", "--verify", "--quiet", revision + "^{commit}")
        except subprocess.CalledProcessError:
            raise ValueError("--history-range revision is not a commit in this repository") from None
    commits = git(root, "log", f"{base}..{head}", "--format=%H%x09%ae%x09%ce").decode().splitlines()
    if not commits:
        raise ValueError("--history-range contains no commits")
    audit.commits = len(commits)
    objects = history_objects(root, [f"{base}..{head}"])
    for row in commits:
        objects[row.split("\t")[0]] = "commit-message"
    audit_objects(root, audit, objects, audited_archives)
    audit_identities(commits, audit)
