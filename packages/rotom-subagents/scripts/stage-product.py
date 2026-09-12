"""Prepare a fresh product source snapshot, never update the maintained install."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

PACKAGE = Path(__file__).resolve().parent.parent
REPO = PACKAGE.parent.parent


def run(args, cwd=REPO):
    return subprocess.check_output(args, cwd=cwd, timeout=120, env={
        'PATH': os.environ['PATH'], 'HOME': str(PACKAGE),
        'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1',
    })


def stage(archive, output, revision, product_version):
    if not re.fullmatch(r'0\.1\.0-rotom-subagents\.\d+', product_version):
        raise ValueError('Require a unique private product version: 0.1.0-rotom-subagents.N')
    archive = Path(archive)
    if not archive.is_absolute() or archive.is_symlink() or not archive.is_file():
        raise ValueError('Require an absolute regular archive')
    if archive.stat().st_size > 64 * 1024 * 1024:
        raise ValueError('Unbounded archive')
    receipt_path = Path(str(archive) + '.json')
    if receipt_path.is_symlink() or receipt_path.stat().st_size > 1024 * 1024:
        raise ValueError('Unbounded/linked pack receipt')
    raw = archive.read_bytes()
    receipt = json.loads(receipt_path.read_text())
    if hashlib.sha256(raw).hexdigest() != receipt['sha256']:
        raise ValueError('Pack receipt/archive mismatch')
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode()
    if receipt['integrity'] != integrity or receipt['published'] is not False:
        raise ValueError('Unverified archive identity')
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        if len(members) > 5000 or sum(m.size for m in members) > 128 * 1024 * 1024 or any(m.size > 16 * 1024 * 1024 for m in members):
            raise ValueError('Unbounded archive')
        seen = set()
        for member in members:
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != 'package' or '..' in parts or member.name in seen or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe archive member')
            seen.add(member.name)
        digest = hashlib.sha256()
        source_members = sorted((m for m in members if m.isfile() and (m.name == 'package/index.ts' or m.name.startswith('package/src/') and m.name.endswith('.ts'))), key=lambda m: m.name)
        for member in source_members:
            digest.update(member.name.removeprefix('package/').encode())
            digest.update(b'\0')
            digest.update(tar.extractfile(member).read())
            digest.update(b'\0')
        if len(source_members) != receipt['tsFiles'] or digest.hexdigest() != receipt['sourceDigest']:
            raise ValueError('Source receipt/archive mismatch')
        pkg = json.loads(tar.extractfile('package/package.json').read())
        if pkg['name'] != 'pi-subagents' or pkg.get('private') is not True or not re.fullmatch(r'0\.52\.1-rotom\.\d+', pkg['version']):
            raise ValueError('Unsupported component identity')
        if pkg['version'] != receipt['version'] or 'package/LICENSE' not in seen:
            raise ValueError('Incomplete component provenance')
    audit = json.loads(run(['python3', '-I', str(REPO/'scripts/audit-public.py'), '--root', str(REPO), '--artifact', str(archive)]))
    if audit['status'] != 'PASS':
        raise ValueError('Artifact audit failed')
    output = Path(output)
    if not output.is_absolute() or output.exists() or output.is_symlink():
        raise ValueError('Require a new absolute stage path')
    parent = output.parent.resolve(strict=True)
    if parent != output.parent or parent.stat().st_uid != os.getuid() or parent.stat().st_mode & 0o077 or output.is_relative_to(REPO) or 'node_modules' in output.parts:
        raise ValueError('Require a canonical private parent outside repository/install')
    revision = run(['git', 'rev-parse', '--verify', revision+'^{commit}']).decode().strip()

    def read(name):
        mode = run(['git', 'ls-tree', revision, '--', name]).decode().split(' ', 1)[0]
        if mode not in ('100644', '100755'):
            raise ValueError('Non-regular committed product input: '+name)
        return run(['git', 'show', revision+':'+name]), mode

    product = json.loads(read('rotom/package.json')[0])
    third = json.loads(read('rotom/extensions/third-party/package.json')[0])
    lock = json.loads(read('rotom/extensions/third-party/package-lock.json')[0])
    old, new = third['dependencies']['pi-subagents'], pkg['version']
    entry = lock['packages']['node_modules/pi-subagents']
    if entry['version'] != old or product.get('private') is not True:
        raise ValueError('Inconsistent baseline identity')
    old_archive = 'extensions/third-party/vendor/pi-subagents-'+old+'.tgz'
    new_archive = 'extensions/third-party/vendor/pi-subagents-'+new+'.tgz'
    inputs = {name: read(name) for name in ['rotom/package.json', 'rotom/scripts/pack-release.mjs', 'scripts/audit-public.py']}
    for name in product['files']:
        if name not in ('extensions/third-party/node_modules', old_archive):
            inputs['rotom/'+name] = read('rotom/'+name)
    config = inputs['rotom/runtime/product-config.mjs'][0].decode()
    if config.count(old) != 3 or config.count(entry['integrity']) != 1 or old_archive not in product['files']:
        raise ValueError('Unsupported product config layout; review the identity seam')
    if product['dependencies']['@earendil-works/pi-coding-agent'] != '0.85.1':
        raise ValueError('Pi compatibility needs separate validation')
    output.mkdir(mode=0o700)
    for name, (data, mode) in inputs.items():
        target = output/name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        target.write_bytes(data)
        target.chmod(0o700 if mode == '100755' else 0o600)

    def put_json(name, value):
        (output/'rotom'/name).write_text(json.dumps(value, indent=2)+'\n')

    product['version'] = product_version
    product['files'] = [new_archive if f == old_archive else f for f in product['files']]
    put_json('package.json', product)
    shrink = json.loads((output/'rotom/npm-shrinkwrap.json').read_text())
    shrink['version'] = shrink['packages']['']['version'] = product_version
    put_json('npm-shrinkwrap.json', shrink)
    third['dependencies']['pi-subagents'] = new
    put_json('extensions/third-party/package.json', third)
    old_integrity = entry['integrity']
    lock['packages']['']['dependencies']['pi-subagents'] = new
    entry.update(version=new, resolved='file:vendor/pi-subagents-'+new+'.tgz', integrity=integrity)
    put_json('extensions/third-party/package-lock.json', lock)
    (output/'rotom/runtime/product-config.mjs').write_text(config.replace(old, new).replace(old_integrity, integrity))
    target = output/'rotom'/new_archive
    target.write_bytes(raw)
    target.chmod(0o600)
    note = '\n\n## Rotom-maintained Subagent\n\nPrivate source component: packages/rotom-subagents. This install does not enable or migrate execution scope. For a fresh opt-in session, read extensions/third-party/node_modules/pi-subagents/docs/owned-execution.md. Initialization and capacity release do not authorize replay of unknown work.\n'
    for name in ['README.md', 'skills/pi-subagents/SKILL.md']:
        target = output/'rotom'/name
        target.write_text(target.read_text()+note)
    run(['git', '-c', 'init.templateDir=', 'init', '-q', str(output)])
    run(['git', 'add', '--', 'rotom', 'scripts'], cwd=output)
    result = {'stage': str(output), 'productVersion': product_version, 'sourceCommit': revision,
              'componentVersion': new, 'integrity': integrity, 'sourceDigest': receipt['sourceDigest'],
              'scopeDefaultChanged': False, 'maintainedInstallChanged': False, 'published': False}
    (output/'STAGE.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--product-version', required=True)
    args = parser.parse_args()
    stage(args.archive, args.output, args.revision, args.product_version)
