#!/usr/bin/env python3
"""Local-only release audit. Reports coordinates/digests, never matched values.

Heuristic review aid, not a guarantee that arbitrary secrets or proprietary
code are absent. No network, no extraction, no file edits, and no history
rewriting.
"""
import argparse
import json
from pathlib import Path
import sys

# `pack:release` and the subagent packer invoke this with `python3 -I`, which drops the
# script directory from sys.path, so the sibling modules are added explicitly.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from audit_history_rules import (  # noqa: E402
    audit_history,
    audit_history_range,
    audit_tree,
    clean_archives,
    git,
    load_audited_archives,
    write_audited_archives,
)
from audit_rules import MAX_ARCHIVE, Audit  # noqa: E402

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--artifact", type=Path)
    mode.add_argument("--history", action="store_true")
    mode.add_argument("--history-range", metavar="BASE..HEAD",
                      help="audit only the commits a push adds, plus the blobs they introduce")
    parser.add_argument("--record-audited-archives", action="store_true",
                        help="with --history or --history-range: after a PASS, record the fork archive blobs that were scanned")
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
            audited_archives = load_audited_archives() if (args.history or args.history_range) else frozenset()
            if args.history:
                audit_history(root, audit, audited_archives)
            elif args.history_range:
                audit_history_range(root, audit, args.history_range, audited_archives)
        if args.record_audited_archives:
            if not (args.history or args.history_range):
                raise ValueError("--record-audited-archives requires --history or --history-range")
            clean = clean_archives(audit)
            if clean:
                write_audited_archives(clean)
        print(json.dumps({"status": "BLOCKED" if audit.findings else "PASS", "scope": "artifact" if args.artifact else "tree+history" if args.history else "tree+history-range" if args.history_range else "tracked-tree",
                          "filesChecked": audit.files, "bytesChecked": audit.expanded, "commitsChecked": audit.commits, "skippedAuditedArchives": audit.skipped_audited_archives, "verifiedPublicExamples": audit.public_examples, "findingCount": len(audit.findings),
                          "findings": audit.findings[:200], "omittedFindings": max(0, len(audit.findings)-200),
                          "limitations": "Heuristic text scan; no OCR, arbitrary secret guarantee, or IP ownership review."}, ensure_ascii=False))
        return 1 if audit.findings else 0
    except Exception as error:
        print(json.dumps({"status": "BLOCKED", "reason": type(error).__name__, "coverageComplete": False}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
