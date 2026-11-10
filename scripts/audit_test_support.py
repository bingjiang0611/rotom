"""Shared fixtures for the audit tests: the modules under test and tgz construction.

The audit is split by responsibility (CLI, scanning rules, git walk), so the tests reach into a
name -> value view of all of them rather than of one file's globals.
"""

import importlib.util
import io
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import audit_history_rules  # noqa: E402
import audit_rules  # noqa: E402


def _load_cli():
    name = 'audit_public_cli'
    spec = importlib.util.spec_from_file_location(name, HERE / 'audit-public.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# One instance of each module, so a test that edits a rule table is seen by the code that reads it.
MODULE = {**vars(audit_rules), **vars(audit_history_rules), **vars(_load_cli())}
Audit = MODULE['Audit']


def archive(name, data, kind=tarfile.REGTYPE):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as tar:
        item = tarfile.TarInfo(name); item.type = kind
        if kind == tarfile.REGTYPE:
            item.size = len(data); tar.addfile(item, io.BytesIO(data))
        else:
            item.linkname = '/outside'; tar.addfile(item)
    return stream.getvalue()

