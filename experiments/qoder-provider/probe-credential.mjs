// Maintenance-only, read-only access to the explicitly selected Pi credential.
// Never use ModelRuntime.getAuth here: it is allowed to refresh/write credentials.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createOAuthEnvelope } from '../../rotom/extensions/qoder/oauth.mjs';
import { QoderError } from '../../rotom/extensions/qoder/auth.mjs';

export async function readProbeCredential(file = process.env.ROTOM_QODER_PROBE_AUTH_FILE) {
  try {
    if (!file || !isAbsolute(file) || resolve(file) !== file || await realpath(file) !== file) throw new Error();
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.mode & 0o077 || before.uid !== process.getuid()) throw new Error();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content;
    try {
      const stat = await handle.stat();
      if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size > 1024 * 1024 || stat.mode & 0o077 || stat.uid !== process.getuid()) throw new Error();
      const bytes = Buffer.alloc(1024 * 1024 + 1); let size = 0;
      for (;;) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size);
        size += bytesRead;
        if (size > 1024 * 1024) throw new Error();
        if (!bytesRead) break;
      }
      content = JSON.parse(bytes.subarray(0, size).toString('utf8'));
      bytes.fill(0);
    } finally { await handle.close(); }
    const c = content['qoder-experimental'];
    await createOAuthEnvelope().toAuth(c);
    return { accessToken: c.access, fingerprint: c.fingerprint, expiresAt: c.expires, uid: c.uid, org: c.org, machineId: c.machineId, oauthCredential: c };
  } catch { throw new QoderError('probe_credential_unavailable_or_expired'); }
}
