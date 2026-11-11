import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, writeFile, chmod, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQoderDeviceIdentity } from './device-id.mjs';

async function temp(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rotom-qoder-device-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const file = dir => join(dir, 'qoder-device-id');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

test('mints one private installation id and reuses it across instances', async t => {
  const dir = await temp(t);
  const identity = createQoderDeviceIdentity(dir);
  const [first, concurrent] = await Promise.all([identity.get(), identity.get()]);
  assert.match(first, UUID);
  assert.equal(concurrent, first);
  assert.equal((await readFile(file(dir), 'utf8')).trim(), first);
  assert.equal((await stat(file(dir))).mode & 0o777, 0o600);
  assert.equal(await createQoderDeviceIdentity(dir).get(), first);
});

test('adopts the device id of a credential already in use instead of minting a new one', async t => {
  const dir = await temp(t);
  const existing = '1c7f0d68-2b4d-4a24-9f31-1b7b1c2d3e4f';
  await createQoderDeviceIdentity(dir).adoptExisting(existing);
  assert.equal((await readFile(file(dir), 'utf8')).trim(), existing);
  // A later fresh login keeps this id, so account bindings made before the
  // upgrade stay valid.
  assert.equal(await createQoderDeviceIdentity(dir).get(), existing);
});

test('never rotates an id that is already stored', async t => {
  const dir = await temp(t);
  const identity = createQoderDeviceIdentity(dir);
  const first = await identity.get();
  await identity.adoptExisting('1c7f0d68-2b4d-4a24-9f31-1b7b1c2d3e4f');
  assert.equal(await identity.get(), first);
  assert.equal((await readFile(file(dir), 'utf8')).trim(), first);
});

test('ignores an unusable candidate id without creating an identity', async t => {
  const dir = await temp(t);
  const identity = createQoderDeviceIdentity(dir);
  for (const candidate of [undefined, '', 'not-a-uuid', `${'a'.repeat(36)}\n`]) await identity.adoptExisting(candidate);
  await assert.rejects(readFile(file(dir), 'utf8'), { code: 'ENOENT' });
});

test('fails closed on a non-private, non-canonical or invalid identity file', async t => {
  const dir = await temp(t);
  await writeFile(file(dir), '1c7f0d68-2b4d-4a24-9f31-1b7b1c2d3e4f\n', { mode: 0o600 });
  await chmod(file(dir), 0o644);
  await assert.rejects(createQoderDeviceIdentity(dir).get(), { code: 'oauth_device_id_unavailable' });
  await chmod(file(dir), 0o600);
  await writeFile(file(dir), 'garbage\n');
  await assert.rejects(createQoderDeviceIdentity(dir).get(), { code: 'oauth_device_id_unavailable' });
  await writeFile(file(dir), '1c7f0d68-2b4d-4a24-9f31-1b7b1c2d3e4f\n');
  await rm(file(dir));
  await symlink(join(await temp(t), 'elsewhere'), file(dir));
  await assert.rejects(createQoderDeviceIdentity(dir).get(), { code: 'oauth_device_id_unavailable' });
  // A missing agent directory is never silently recreated in an unchecked place.
  await assert.rejects(createQoderDeviceIdentity(join(dir, 'missing')).get(), { code: 'oauth_device_id_unavailable' });
});

test('rejects a relative or non-canonical agent directory at construction', async t => {
  await assert.rejects(async () => createQoderDeviceIdentity('relative/agent'), { code: 'oauth_device_id_unavailable' });
  await assert.rejects(async () => createQoderDeviceIdentity(`${await temp(t)}/../agent`), { code: 'oauth_device_id_unavailable' });
});
