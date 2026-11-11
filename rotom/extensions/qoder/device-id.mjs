import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { QoderError } from './auth.mjs';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

// The Qoder device id identifies this installation, not a login. The account
// binding digest is keyed by it, so minting a fresh one per login turns a
// re-login of the same account into an "account changed" error for every
// existing session. Persist it once and never rotate it:
//  - first use of a credential already in the store adopts its machine id, so
//    upgrading does not orphan sessions that are bound to it;
//  - otherwise the id is minted once on the first fresh login and reused.
// Deleting the file is the only way to rotate it, and that is exactly a new
// installation identity for Qoder: existing sessions then need a new session.
export function createQoderDeviceIdentity(agentDir) {
  if (typeof agentDir !== 'string' || !isAbsolute(agentDir) || resolve(agentDir) !== agentDir) throw new QoderError('oauth_device_id_unavailable');
  const file = join(agentDir, 'qoder-device-id');
  let pending;

  const checkDir = async () => {
    const before = await lstat(agentDir);
    if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o077) ||
        (process.getuid && before.uid !== process.getuid()) || await realpath(agentDir) !== agentDir) throw new QoderError('oauth_device_id_unavailable');
  };

  const read = async () => {
    let before, handle;
    try { before = await lstat(file); }
    catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw new QoderError('oauth_device_id_unavailable');
    }
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o077) || (process.getuid && before.uid !== process.getuid())) throw new QoderError('oauth_device_id_unavailable');
    if (await realpath(file) !== file) throw new QoderError('oauth_device_id_unavailable');
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()) || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > 64) throw new QoderError('oauth_device_id_unavailable');
      const value = (await handle.readFile('utf8')).trim();
      if (!UUID.test(value)) throw new QoderError('oauth_device_id_unavailable');
      return value;
    } catch (error) {
      if (error instanceof QoderError) throw error;
      throw new QoderError('oauth_device_id_unavailable');
    } finally { await handle?.close(); }
  };

  const create = async machineId => {
    let handle;
    try {
      await checkDir();
      handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (error instanceof QoderError) throw error;
      // A concurrent writer (another process) won the race; use its id instead
      // of overwriting an installation identity that a session may already use.
      if (error.code === 'EEXIST') {
        const existing = await read();
        if (existing) return existing;
      }
      throw new QoderError('oauth_device_id_unavailable');
    }
    try {
      await handle.writeFile(`${machineId}\n`);
      await handle.sync();
    } catch { throw new QoderError('oauth_device_id_unavailable'); }
    finally { await handle.close(); }
    return machineId;
  };

  const settle = resolveValue => {
    if (!pending) {
      pending = (async () => resolveValue(await read()))().catch(error => { pending = undefined; throw error; });
    }
    return pending;
  };

  return {
    // Stable installation id, minted once on first use.
    get: () => settle(existing => existing ?? create(randomUUID())),
    // A credential already in the store defines this installation's device id.
    // Never replaces an existing id, so a login cannot silently rotate it.
    adoptExisting: machineId => UUID.test(machineId ?? '') ? settle(existing => existing ?? create(machineId)) : Promise.resolve(),
  };
}
