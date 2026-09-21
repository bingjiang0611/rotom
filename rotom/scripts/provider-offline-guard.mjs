// Maintenance-only guard for the reviewed Node test/smoke commands. This is not
// an OS sandbox: native addons, arbitrary executables and hostile code are out of scope.
// Block below fetch so SDKs and Pi loader realms cannot bypass a fetch monkeypatch.
import { channel } from 'node:diagnostics_channel';
import { Socket } from 'node:net';

function blocked() {
  process.stderr.write('ROTOM_PROVIDER_NETWORK_BLOCKED\n');
  process.exit(86);
}
channel('undici:request:create').subscribe(blocked);
channel('http.client.request.start').subscribe(blocked);
Socket.prototype.connect = blocked;
