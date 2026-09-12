// Maintenance-only preload, shared across serial probe processes. Pi's jiti
// realm can retain its own fetch reference, so replacing globalThis.fetch is
// NOT an effective dispatch boundary. Observe Node's process-wide Undici
// request construction channel instead, before a request reaches the wire.
import { constants, openSync, fstatSync, readFileSync, writeSync, ftruncateSync, fsyncSync, closeSync, realpathSync, lstatSync } from 'node:fs';
import { isAbsolute, dirname, basename } from 'node:path';
import { channel } from 'node:diagnostics_channel';
const path = process.env.ROTOM_QODER_PROBE_LEDGER;
// Explicit maintenance self-limit; changing it is not user authorization and
// never permits resetting/reusing another investigation's ledger.
const limitText = process.env.ROTOM_QODER_PROBE_LIMIT ?? '30';
if (!/^[1-9][0-9]{0,4}$/.test(limitText) || Number(limitText) > 10000) reject();
const limit = Number(limitText);
const catalog = process.env.ROTOM_QODER_PROBE_CATALOG;
if (catalog !== undefined && !['0', '1'].includes(catalog)) reject();
const legacy = process.env.ROTOM_QODER_PROBE_LEGACY;
if (legacy !== undefined && !['0', '1'].includes(legacy)) reject();
const credit = process.env.ROTOM_QODER_PROBE_CREDIT;
if (credit !== undefined && !['0', '1'].includes(credit)) reject();
const noModels = process.env.ROTOM_QODER_PROBE_NO_MODELS;
if (noModels !== undefined && !['0', '1'].includes(noModels)) reject();
const oauth = process.env.ROTOM_QODER_PROBE_OAUTH;
if (oauth !== undefined && !['0', '1'].includes(oauth)) reject();
function reject() { process.stderr.write('Qoder probe dispatch blocked by ledger/scope.\n'); process.exit(86); }
try {
  if (!path || !isAbsolute(path) || realpathSync(path) !== path) reject();
  if (oauth === '1') {
    const dir = process.env.ROTOM_QODER_PROBE_ISOLATED_AUTH_DIR;
    if (!dir || dirname(dir) !== dirname(path) || !/^isolated-auth(?:-[1-9][0-9]?)?$/.test(basename(dir)) || realpathSync(dir) !== dir) reject();
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077) reject();
  }
} catch { reject(); }
channel('undici:request:create').subscribe(({request}) => {
  let file;
  try {
    const chat = noModels !== '1' && String(request.origin) === 'https://api2-v2.qoder.sh' && request.path === '/model/v1/chat/completions' && request.method === 'POST';
    const list = catalog === '1' && String(request.origin) === 'https://api2.qoder.sh' && request.path === '/algo/api/v2/model/list?Encode=1' && request.method === 'GET';
    const oldInference = noModels !== '1' && legacy === '1' && String(request.origin) === 'https://api2.qoder.sh' && request.path === '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1' && request.method === 'POST';
    let auth = false;
    if (oauth === '1' && String(request.origin) === 'https://openapi.qoder.sh') {
      auth = request.method === 'GET' && request.path === '/api/v1/userinfo' || request.method === 'POST' && request.path === '/api/v1/deviceToken/refresh';
      if (request.method === 'GET' && request.path.startsWith('/api/v1/deviceToken/poll?')) {
        const u = new URL(request.path, 'https://openapi.qoder.sh'), q = u.searchParams;
        auth = [...q.keys()].sort().join(',') === 'challenge_method,nonce,verifier' && q.get('challenge_method') === 'S256' && /^[a-f0-9-]{36}$/.test(q.get('nonce')) && /^[A-Za-z0-9_-]{43}$/.test(q.get('verifier'));
      }
    }
    const quota = credit === '1' && String(request.origin) === 'https://openapi.qoder.sh' && request.path === '/api/v2/quota/usage' && request.method === 'GET';
    if (!chat && !list && !oldInference && !auth && !quota) reject();
    file = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > 64 || stat.mode & 0o077 || stat.uid !== process.getuid()) reject();
    const value = readFileSync(file, 'utf8');
    const count = Number(value);
    if (!/^(0|[1-9][0-9]{0,4})$/.test(value) || !Number.isSafeInteger(count) || count < 0 || count >= limit) reject();
    const bytes = Buffer.from(String(count + 1));
    writeSync(file, bytes, 0, bytes.length, 0); ftruncateSync(file, bytes.length); fsyncSync(file);
  } catch { reject(); }
  finally { if (file !== undefined) closeSync(file); }
});
