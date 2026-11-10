import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import audit_test_support
from audit_test_support import Audit, MODULE


class HistoryAuditTests(unittest.TestCase):
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

    def test_github_service_noreply_exception_is_exact_and_committer_only(self):
        cases = [
            ('fixture@users.noreply.github.com', 'noreply@github.com', set()),
            ('noreply@github.com', 'fixture@users.noreply.github.com', {'non-noreply-author'}),
            ('fixture@users.noreply.github.com', 'other@github.com', {'non-noreply-committer'}),
            ('fixture@users.noreply.github.com', 'noreply@github.com.example.invalid', {'non-noreply-committer'}),
        ]
        for author, committer, expected in cases:
            with self.subTest(author=author, committer=committer), tempfile.TemporaryDirectory(prefix='rotom-audit-identity-') as work:
                root = Path(work).resolve()
                def git(*args):
                    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
                                                    '-C', str(root), *args], stderr=subprocess.DEVNULL)
                git('init', '-q', '--initial-branch=main')
                git('config', 'user.name', 'Fixture')
                git('config', 'user.email', committer)
                git('commit', '--allow-empty', '--author', 'Fixture <' + author + '>', '-qm', 'identity fixture')
                audit = Audit()
                MODULE['audit_history'](root, audit)
                self.assertEqual({item['rule'] for item in audit.findings}, expected)
                git('-c', 'user.email=noreply@github.com', 'tag', '-a', 'service-tag', '-m', 'tag fixture')
                tagged = Audit()
                MODULE['audit_history'](root, tagged)
                self.assertEqual({item['rule'] for item in tagged.findings}, expected | {'non-noreply-tagger'})

    def test_anthropic_noreply_exemption_is_exact_and_symmetric(self):
        noreply = 'fixture@users.noreply.github.com'
        cases = [
            ('noreply@anthropic.com', noreply, set()),
            (noreply, 'noreply@anthropic.com', set()),
            ('someone@anthropic.com', noreply, {'non-noreply-author'}),
            ('Noreply@anthropic.com', noreply, {'non-noreply-author'}),
            (noreply, 'someone@anthropic.com', {'non-noreply-committer'}),
            ('noreply@anthropic.com.example.invalid', noreply, {'non-noreply-author'}),
        ]
        for author, committer, expected in cases:
            with self.subTest(author=author, committer=committer), tempfile.TemporaryDirectory(prefix='rotom-audit-anthropic-') as work:
                root = Path(work).resolve()
                def git(*args):
                    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
                                                    '-C', str(root), *args], stderr=subprocess.DEVNULL)
                git('init', '-q', '--initial-branch=main')
                git('config', 'user.name', 'Fixture')
                git('config', 'user.email', committer)
                git('commit', '--allow-empty', '--author', 'Fixture <' + author + '>', '-qm', 'identity fixture')
                audit = Audit()
                MODULE['audit_history'](root, audit)
                self.assertEqual({item['rule'] for item in audit.findings}, expected)
                self.assertNotIn('anthropic', json.dumps(audit.findings))

    def test_history_skips_only_fork_archives_recorded_by_a_passing_audit(self):
        with tempfile.TemporaryDirectory(prefix='rotom-audit-test-') as work:
            root = Path(work).resolve()
            def git(*args):
                return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', str(root), *args], stderr=subprocess.DEVNULL)
            git('init', '-q', '--initial-branch=main')
            git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@users.noreply.github.com')
            vendor = root / 'rotom/runtime/pi/vendor'; vendor.mkdir(parents=True)
            archive = vendor / 'pi-1.0.0.tgz'
            archive.write_bytes(audit_test_support.archive('package/clean.txt', b'clean'))
            git('add', '.'); git('commit', '-qm', 'clean fork archive')
            clean_oid = git('rev-parse', 'HEAD:rotom/runtime/pi/vendor/pi-1.0.0.tgz').decode().strip()
            archive.write_bytes(audit_test_support.archive('package/leak.txt', b'private-marker'))
            git('add', '.'); git('commit', '-qm', 'replaced fork archive')
            archive.write_bytes(audit_test_support.archive('package/clean.txt', b'clean again'))
            git('add', '.'); git('commit', '-qm', 'replaced again')

            # Recording covers every fork archive blob in history, scanned or already audited.
            first = Audit(); MODULE['audit_history'](root, first)
            self.assertEqual(len(first.ledger_archives), 3)
            self.assertEqual(first.skipped_audited_archives, 0)

            # Only the exact recorded oid is skipped; the replaced, unrecorded archive is still scanned.
            audit = Audit(['private-marker']); MODULE['audit_history'](root, audit, {clean_oid})
            self.assertEqual(audit.skipped_audited_archives, 1)
            self.assertTrue(any(f['rule'] == 'private-marker' and 'leak.txt' in f['path'] for f in audit.findings))
            self.assertFalse(any(clean_oid[:12] in f['path'] for f in audit.findings))
            self.assertLess(audit.expanded, first.expanded)

            ledger = root / 'ledger.json'
            shards = root / 'ledger.d'
            MODULE['write_audited_archives']({clean_oid: 'rotom/runtime/pi/vendor/pi-1.0.0.tgz'}, ledger, shards)
            self.assertEqual(MODULE['load_audited_archives'](ledger, shards), {clean_oid})
            ledger.write_text('{"schema": 2, "archives": []}')
            with self.assertRaises(ValueError):
                MODULE['load_audited_archives'](ledger, shards)

    def test_recording_is_additive_and_bounded_by_shards(self):
        with tempfile.TemporaryDirectory(prefix='rotom-audit-records-') as work:
            root = Path(work)
            ledger = root / 'archives.json'
            shards = root / 'archives.d'
            first = {'1' * 40: 'rotom/runtime/pi/vendor/a.tgz', '2' * 40: 'rotom/runtime/pi/vendor/b.tgz'}
            MODULE['write_audited_archives'](first, ledger, shards)
            self.assertEqual(sorted(p.name for p in shards.glob('*.json')), ['000.json'])
            # A later run that proved a different archive clean must not drop the earlier two.
            second = {'3' * 40: 'rotom/runtime/pi/vendor/c.tgz'}
            MODULE['write_audited_archives'](second, ledger, shards)
            self.assertEqual(MODULE['load_audited_archives'](ledger, shards), set(first) | set(second))
            # Entries stay sorted by oid, and a large set spreads over several bounded files.
            many = {f'{index:040x}': f'rotom/runtime/pi/vendor/{index}.tgz' for index in range(251)}
            MODULE['write_audited_archives'](many, ledger, shards)
            files = sorted(shards.glob('*.json'))
            self.assertEqual(len(files), 3)
            for shard in files:
                self.assertLess(len(shard.read_bytes()), 20000)
            recorded = MODULE['load_audited_archives'](ledger, shards)
            self.assertEqual(recorded, set(many) | set(first) | set(second))
            # The same set always produces the same files, so a re-run is not a diff.
            before = {shard.name: shard.read_text() for shard in files}
            MODULE['write_audited_archives'](many, ledger, shards)
            self.assertEqual({shard.name: shard.read_text() for shard in sorted(shards.glob('*.json'))}, before)

    def test_recording_names_only_archives_that_themselves_scanned_clean(self):
        with tempfile.TemporaryDirectory(prefix='rotom-audit-records-') as work:
            root = Path(work).resolve()
            def git(*args):
                return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', str(root), *args], stderr=subprocess.DEVNULL)
            git('init', '-q', '--initial-branch=main')
            git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@users.noreply.github.com')
            vendor = root / 'rotom/runtime/pi/vendor'; vendor.mkdir(parents=True)
            (vendor / 'clean.tgz').write_bytes(audit_test_support.archive('package/clean.txt', b'clean'))
            (vendor / 'leaky.tgz').write_bytes(audit_test_support.archive('package/leak.txt', b'private-marker'))
            git('add', '.'); git('commit', '-qm', 'two fork archives')
            audit = Audit(['private-marker'])
            MODULE['audit_history'](root, audit)
            clean = MODULE['clean_archives'](audit)
            self.assertEqual([entry.split('/')[-1] for entry in clean.values()], ['clean.tgz'])

    def test_history_range_scans_only_what_the_push_adds(self):
        with tempfile.TemporaryDirectory(prefix='rotom-audit-range-') as work:
            root = Path(work).resolve()
            def git(*args):
                return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', str(root), *args],
                                               stderr=subprocess.DEVNULL, env=dict(os.environ, GIT_AUTHOR_EMAIL='fixture@users.noreply.github.com',
                                                                                 GIT_COMMITTER_EMAIL='fixture@users.noreply.github.com'))
            git('init', '-q', '--initial-branch=main')
            git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@users.noreply.github.com')
            (root / 'old.txt').write_text('private-marker')
            git('add', '.'); git('commit', '-qm', 'old private commit')
            base = git('rev-parse', 'HEAD').decode().strip()
            (root / 'old.txt').write_text('clean now')
            git('add', '.'); git('commit', '-qm', 'clean up')
            (root / 'new.txt').write_text('fresh private-marker')
            git('add', '.'); git('commit', '-qm', 'new private commit')

            # The marker that only exists in the base commit is outside the push and is not rescanned.
            audit = Audit(['private-marker'])
            MODULE['audit_history_range'](root, audit, base + '..HEAD')
            self.assertEqual(audit.commits, 2)
            self.assertEqual([f['path'] for f in audit.findings], ['history:' + git('rev-parse', 'HEAD:new.txt').decode().strip()[:12] + '::new.txt'])

            # Identity in the range is judged on the range only.
            git('commit', '--allow-empty', '--author', 'Fixture <fixture@example.invalid>', '-qm', 'leaky identity')
            range_audit = Audit()
            MODULE['audit_history_range'](root, range_audit, base + '..HEAD')
            self.assertEqual({item['rule'] for item in range_audit.findings}, {'non-noreply-author'})
            self.assertEqual(range_audit.commits, 3)
            self.assertNotIn('fixture@example.invalid', json.dumps(range_audit.findings))

    def test_history_range_rejects_vague_or_unknown_bounds(self):
        with tempfile.TemporaryDirectory(prefix='rotom-audit-range-') as work:
            root = Path(work).resolve()
            def git(*args):
                return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', str(root), *args], stderr=subprocess.DEVNULL)
            git('init', '-q', '--initial-branch=main')
            git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@users.noreply.github.com')
            git('commit', '--allow-empty', '-qm', 'only commit')
            head = git('rev-parse', 'HEAD').decode().strip()
            for spec in ['HEAD', '...HEAD', '..HEAD', head + '..', 'unknown..' + head, head + '...HEAD', head + '..' + head]:
                with self.subTest(spec=spec), self.assertRaises(ValueError):
                    MODULE['audit_history_range'](root, Audit(), spec)

    def test_history_modes_are_mutually_exclusive_and_range_records_only_scanned_archives(self):
        with tempfile.TemporaryDirectory(prefix='rotom-audit-range-') as work:
            root = Path(work).resolve()
            def git(*args):
                return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', str(root), *args], stderr=subprocess.DEVNULL)
            git('init', '-q', '--initial-branch=main')
            git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@users.noreply.github.com')
            vendor = root / 'rotom/runtime/pi/vendor'; vendor.mkdir(parents=True)
            (root / 'notes.txt').write_text('clean')
            git('add', '.'); git('commit', '-qm', 'base')
            base = git('rev-parse', 'HEAD').decode().strip()
            (vendor / 'pi-1.0.0.tgz').write_bytes(audit_test_support.archive('package/clean.txt', b'clean'))
            git('add', '.'); git('commit', '-qm', 'fork archive')
            audit = Audit()
            MODULE['audit_history_range'](root, audit, base + '..HEAD')
            self.assertEqual(list(audit.ledger_archives), [git('rev-parse', 'HEAD:rotom/runtime/pi/vendor/pi-1.0.0.tgz').decode().strip()])

            tool = str(Path(__file__).with_name('audit-public.py'))
            both = subprocess.run([sys.executable, tool, '--root', str(root), '--history', '--history-range', base + '..HEAD'],
                                  capture_output=True, text=True)
            self.assertEqual(both.returncode, 2)
            self.assertIn('not allowed with', both.stderr)
            record_only_tree = subprocess.run([sys.executable, tool, '--root', str(root), '--record-audited-archives'],
                                              capture_output=True, text=True)
            self.assertEqual(record_only_tree.returncode, 2)
            self.assertEqual(json.loads(record_only_tree.stdout)['reason'], 'ValueError')


if __name__ == '__main__':
    unittest.main()
