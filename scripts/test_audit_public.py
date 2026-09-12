import io
import json
from pathlib import Path
import runpy
import subprocess
import tarfile
import tempfile
import unittest

MODULE = runpy.run_path(str(Path(__file__).with_name('audit-public.py')))
Audit = MODULE['Audit']


class PrivacyAuditTests(unittest.TestCase):
    def test_credential_is_reported_without_echoing_value(self):
        value = 'ghp_' + 'a' * 36
        audit = Audit()
        audit.scan('fixture.txt', ('key=' + value).encode())
        self.assertEqual(audit.findings[0]['rule'], 'credential-shape')
        self.assertNotIn(value, json.dumps(audit.findings))

    def test_key_header_alone_and_public_fixtures_are_not_credentials(self):
        audit = Audit()
        audit.scan('example.txt', b'-----BEGIN PRIVATE KEY-----\nhttps://example.test/\n/Users/name/example.txt\n127.0.0.1')
        self.assertEqual(audit.findings, [])

    def test_public_upstream_example_exception_is_exact(self):
        archive = Path(__file__).resolve().parents[1] / 'rotom/extensions/third-party/vendor/pi-subagents-0.52.1-dev-agent-followthrough.2.tgz'
        with tarfile.open(archive) as tar:
            data = tar.extractfile('package/docs/configuration.md').read()
        labels = ['vendor.tgz::package/docs/configuration.md',
                  'packages/rotom-subagents/docs/configuration.md',
                  'fixture.tgz::workspace/packages/rotom-subagents/docs/configuration.md']
        maintained = Path(__file__).resolve().parents[1] / 'packages/rotom-subagents/docs/configuration.md'
        public_lines = [line for line in data.decode().splitlines()
                        if MODULE['is_public_example']('vendor.tgz::package/docs/configuration.md', line)]
        self.assertEqual(len(public_lines), 1)
        self.assertIn(public_lines[0], maintained.read_text().splitlines())
        for label in labels:
            audit = Audit(); audit.scan(label, data)
            self.assertEqual(audit.findings, [])
            self.assertEqual(audit.public_examples, 1)
            changed = MODULE['HOME_PATH'].sub('/Users/' + 'changed-user', data.decode())
            audit = Audit(); audit.scan(label, changed.encode())
            self.assertTrue(any(f['rule'] == 'personal-home-path' for f in audit.findings))
        audit = Audit(); audit.scan('packages/rotom-subagents/elsewhere.md', data)
        self.assertTrue(any(f['rule'] == 'personal-home-path' for f in audit.findings))

    def test_public_network_example_exception_is_path_and_line_bound(self):
        line = '.'.join(map(str, [10, 23, 45, 67]))
        digest = MODULE['hashlib'].sha256(line.encode()).hexdigest()
        examples = MODULE['PUBLIC_EXAMPLE_LINES']
        examples[digest] = ('/public-fixture.js',)
        try:
            audit = Audit(); audit.scan('package/public-fixture.js', line.encode())
            self.assertEqual(audit.findings, [])
            self.assertEqual(audit.public_examples, 1)
            for path, data in [('package/elsewhere.js', line), ('package/public-fixture.js', line + ' changed')]:
                audit = Audit(); audit.scan(path, data.encode())
                self.assertTrue(audit.findings)
        finally:
            examples.pop(digest)

    def test_pi_public_host_example_never_exempts_credentials(self):
        path = 'packages/rotom-pi/packages/coding-agent/docs/containerization.md'
        data = (Path(__file__).resolve().parents[1] / path).read_bytes()
        audit = Audit(); audit.scan(path, data)
        self.assertEqual(audit.findings, [])
        self.assertEqual(audit.public_examples, 1)
        audit = Audit(); audit.scan('unrelated.md', data)
        self.assertTrue(any(f['rule'] == 'internal-host' for f in audit.findings))
        audit = Audit(); audit.scan(path, data + ('\n' + 'ghp_' + 'z' * 36).encode())
        self.assertTrue(any(f['rule'] == 'credential-shape' for f in audit.findings))
        audit = Audit(); audit.scan(path, data.replace(b'inference.', b'changed.'))
        self.assertTrue(any(f['rule'] == 'internal-host' for f in audit.findings))

    def test_pi_dependency_examples_are_pinned_and_credential_exception_is_exact(self):
        root = Path(__file__).resolve().parents[1]
        lock = json.loads((root / 'rotom/runtime/pi/package-lock.json').read_text())
        examples = MODULE['PI_PUBLIC_EXAMPLES']
        for name, identity in examples['packages'].items():
            actual = lock['packages']['node_modules/' + name]
            self.assertEqual(identity, {key: actual[key] for key in identity})
        path = 'release.tgz::package' + next(iter(examples['credentialExamples'].values()))[0]
        line = ' *     AccessKeyId: "' + 'AKIA' + 'IOSFODNN7EXAMPLE' + '",'
        audit = Audit(); audit.scan(path, line.encode())
        self.assertEqual(audit.findings, [])
        self.assertEqual(audit.public_examples, 1)
        for changed_path, changed_line in [('elsewhere.ts', line), (path, line + ' changed'), (path, line.replace('EXAMPLE', 'CHANGED'))]:
            audit = Audit(); audit.scan(changed_path, changed_line.encode())
            self.assertTrue(any(f['rule'] == 'credential-shape' for f in audit.findings))

    def test_private_home_and_explicit_marker(self):
        audit = Audit(['private-marker'])
        home = str(Path('/', 'Users', 'private-user', 'file.txt'))
        audit.scan('example.txt', (home + '\nprivate-marker').encode())
        self.assertEqual({f['rule'] for f in audit.findings}, {'personal-home-path', 'private-marker'})

    def test_private_network_and_internal_host(self):
        address = '.'.join(map(str, [10, 23, 45, 67]))
        hostname = 'https://service.' + 'internal'
        audit = Audit()
        audit.scan('example.txt', (address + '\n' + hostname).encode())
        self.assertEqual({f['rule'] for f in audit.findings}, {'private-network-address', 'internal-host'})

    def archive(self, name, data, kind=tarfile.REGTYPE):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz') as tar:
            item = tarfile.TarInfo(name); item.type = kind
            if kind == tarfile.REGTYPE:
                item.size = len(data); tar.addfile(item, io.BytesIO(data))
            else:
                item.linkname = '/outside'; tar.addfile(item)
        return stream.getvalue()

    def test_nested_archives_are_scanned_without_extraction(self):
        private = 'sk-proj-' + 'b' * 40
        inner = self.archive('package/config.txt', private.encode())
        outer = self.archive('package/vendor/inner.tgz', inner)
        audit = Audit(); audit.scan('release.tgz', outer)
        self.assertEqual(audit.files, 3)
        self.assertTrue(any(f['rule'] == 'credential-shape' for f in audit.findings))
        self.assertNotIn(private, json.dumps(audit.findings))

    def test_archive_paths_links_and_state_are_blocked(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('package/link', tarfile.SYMTYPE), ('package/.pi/state', tarfile.REGTYPE)]:
            with self.subTest(name=name):
                audit = Audit(); audit.scan('release.tgz', self.archive(name, b'x', kind))
                self.assertTrue(audit.findings)

    def test_original_history_and_commit_email_are_not_hidden_by_deletion(self):
        with tempfile.TemporaryDirectory(prefix='rotom-audit-test-') as work:
            root = Path(work).resolve()
            def git(*args):
                return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', str(root), *args], stderr=subprocess.DEVNULL)
            git('init', '-q', '--initial-branch=main')
            with self.assertRaises(ValueError):
                MODULE['audit_history'](root, Audit())
            git('config', 'user.name', 'Fixture')
            git('config', 'user.email', 'fixture@example.invalid')
            (root / 'old.txt').write_text('private-marker')
            git('add', 'old.txt'); git('commit', '-qm', 'private-marker')
            git('rm', '-q', 'old.txt'); git('commit', '-qm', 'remove fixture')
            git('tag', '-a', 'fixture-tag', '-m', 'private-marker')
            audit = Audit(['private-marker']); MODULE['audit_tree'](root, audit)
            self.assertEqual(audit.findings, [])
            MODULE['audit_history'](root, audit)
            self.assertEqual(audit.commits, 2)
            self.assertTrue(any(f['rule'] == 'private-marker' for f in audit.findings))
            self.assertTrue(any(f['rule'] == 'private-marker' and f['path'].endswith('::commit-message') for f in audit.findings))
            self.assertTrue(any(f['rule'] == 'non-noreply-author' for f in audit.findings))
            self.assertTrue(any(f['rule'] == 'non-noreply-tagger' for f in audit.findings))
            self.assertNotIn('fixture@example.invalid', json.dumps(audit.findings))

    def test_archive_input_budget_does_not_relax_regular_file_limit(self):
        with self.assertRaises(ValueError):
            Audit().scan('fixture.txt', b'x' * (MODULE['MAX_FILE'] + 1))
        with self.assertRaises(ValueError):
            Audit().scan('fixture.tgz', b'x' * (MODULE['MAX_ARCHIVE'] + 1))

    def test_budget_exhaustion_is_not_reported_as_clean(self):
        audit = Audit(); audit.expanded = MODULE['MAX_EXPANDED']
        with self.assertRaises(ValueError):
            audit.scan('fixture.txt', b'x')


if __name__ == '__main__':
    unittest.main()
