#!/usr/bin/env node

// Local fixture site for the browser e2e harness. Two listeners so iframe tests
// are genuinely cross-origin without touching the network. Every request is
// logged (method, path, headers) so suites can assert negative behaviour such as
// "the extension never sent this request".

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const BASELINE_BODY = `
<main>
  <h1>Background relay ready</h1>
  <iframe title="Cross-origin fixture" src="__FRAME__"></iframe>
  <label>Draft <input aria-label="Draft title"></label>
  <label>Password <input type="password" autocomplete="current-password" aria-label="Account password"></label>
  <a href="/download" download="fixture.txt">Download fixture</a>
  <a href="/popup" target="_blank">Open another context</a>
  <button id="popup">Script popup</button>
  <label style="display:block;margin-top:120px">Mode
    <select aria-label="Mode"><option>Draft</option><option>Published</option></select>
  </label>
  <div role="status" id="mode">Mode: Draft</div>
  <button id="save" style="display:block;margin-top:120px;padding:0"><span style="display:block;padding:8px 12px">Save draft</span></button>
  <div role="status" id="status">Not saved</div>
  <div id="virtual-records" role="region" aria-label="Virtual records" style="height:100px;overflow-y:auto">
    <div style="height:700px">Virtualized table viewport</div>
  </div>
  <div role="status" id="virtual-status">Virtual rows 1-15</div>
  <div style="position:relative;width:max-content;margin-top:120px">
    <button id="covered">Covered action</button>
    <div aria-hidden="true" style="position:absolute;inset:0"></div>
  </div>
  <div style="height:1800px"></div>
  <button id="offscreen">Offscreen action</button>
  <div role="status" id="offscreen-status">Offscreen pending</div>
  <div role="status" id="scroll-status">Top</div>
</main>
<script>
document.querySelector('select').addEventListener('change', (event) => {
  document.querySelector('#mode').textContent = 'Mode: ' + event.target.value;
});
document.querySelector('#save').addEventListener('click', () => {
  document.querySelector('#status').textContent = 'Saved: ' + document.querySelector('input[aria-label="Draft title"]').value;
});
document.querySelector('#offscreen').addEventListener('click', () => {
  document.querySelector('#offscreen-status').textContent = 'Offscreen clicked';
});
document.querySelector('#virtual-records').addEventListener('scroll', () => {
  document.querySelector('#virtual-status').textContent = 'Virtual rows 16-30 loaded';
});
document.querySelector('#popup').addEventListener('click', () => window.open('/popup'));
addEventListener('scroll', () => { document.querySelector('#scroll-status').textContent = 'Scrolled'; });
</script>`;

const FRAME_BODY = `
<!doctype html><title>M7 frame</title>
<h2>Cross-origin frame ready</h2>
<div role="region" aria-label="Frame records" style="height:100px;overflow-y:auto">
  <div style="height:700px">Frame rows 1-15</div>
</div>
<div role="status" id="frame-status">Frame top</div>
<script>
document.querySelector('[role=region]').addEventListener('scroll', () => {
  document.querySelector('#frame-status').textContent = 'Frame rows 16-30 loaded';
});
</script>`;

// One form per agent tab for the parallel suite: the page echoes exactly what was
// typed and selected, so a mixed-up readback is visible instead of inferred.
const FORM_BODY = `
<main>
  <h2>Agent form</h2>
  <label>Name <input id="name" aria-label="Agent name"></label>
  <div style="margin-top:80px">
    <label>Plan
      <select id="plan" aria-label="Agent plan"><option>draft</option><option>active</option></select>
    </label>
  </div>
  <div style="margin-top:80px"><button id="submit">Submit form</button></div>
  <div role="status" id="result">idle</div>
</main>
<script>
document.querySelector('#submit').addEventListener('click', () => {
  document.querySelector('#result').textContent = 'name=' + document.querySelector('#name').value + ' plan=' + document.querySelector('#plan').value;
});
</script>`;

// Console fixture: one error log, one thrown exception with a real stack, and a button
// that floods the capture buffer so `dropped` becomes non-zero.
const CONSOLE_BODY = `
<main>
  <h2>Console fixture</h2>
  <div style="margin-top:80px"><button id="flood">Flood console</button></div>
  <div role="status" id="console-status">Console fixture loaded</div>
</main>
<script>
console.error('fixture console error: cannot read properties of undefined');
function explode() { throw new Error('fixture boom from explode'); }
function nested() { explode(); }
setTimeout(() => { try { nested(); } catch (error) { console.error('rethrown: ' + error.message); } }, 50);
document.querySelector('#flood').addEventListener('click', () => {
  for (let index = 1; index <= 620; index += 1) console.log('flood line ' + index);
  document.querySelector('#console-status').textContent = 'Console flooded';
});
// An uncaught exception, reported as Runtime.exceptionThrown with a stack.
setTimeout(() => { throw new Error('fixture uncaught exception'); }, 120);
</script>`;

// The "user" tab the harness starts with: never touched by an agent, so a suite can
// assert the operator's foreground tab is still the active one.
const USER_BODY = `
<main><h1>User tab</h1><div role="status" id="user-status">User tab stays foreground</div></main>`;

// Dialog fixture: each button opens one dialog kind and records the answer, so the
// suite can prove the page really received it (not just that a command was acked).
const DIALOG_BODY = `
<main>
  <h1>Dialog fixture</h1>
  <button id="alert">open alert</button>
  <button id="confirm">open confirm</button>
  <button id="prompt">open prompt</button>
  <a id="leave" href="/baseline">leave page</a>
  <div role="status" id="dialog-status">dialog-idle</div>
</main>
<script>
const status = document.querySelector('#dialog-status');
const record = (value) => { status.textContent = 'dialog-result|' + value; };
const safe = (fn) => { try { return fn(); } catch (error) { return 'blocked'; } };
document.querySelector('#alert').addEventListener('click', () => {
  safe(() => alert('alert message'));
  record('alert|returned');
});
document.querySelector('#confirm').addEventListener('click', () => {
  record('confirm|' + safe(() => confirm('confirm message')));
});
document.querySelector('#prompt').addEventListener('click', () => {
  record('prompt|' + safe(() => prompt('prompt message', 'default answer')));
});
window.addEventListener('beforeunload', (event) => {
  event.preventDefault();
  event.returnValue = 'unsaved changes';
  return 'unsaved changes';
});
</script>`;

// Upload fixture: a file input that immediately posts the chosen file to the server, so a
// suite can compare the received bytes with the local file instead of trusting the page.
const UPLOAD_BODY = `
<main>
  <h1>Upload fixture</h1>
  <input type="file" id="upload-input" aria-label="upload input">
  <div role="status" id="upload-status">upload-idle</div>
</main>
<script>
const input = document.querySelector('#upload-input');
const status = document.querySelector('#upload-status');
input.addEventListener('change', async () => {
  const file = input.files && input.files[0];
  if (!file) { status.textContent = 'upload-empty'; return; }
  const response = await fetch('/upload-echo', { method: 'POST', body: file });
  const body = await response.json();
  status.textContent = 'upload|' + file.name + '|' + file.size + '|' + body.sha256;
});
</script>`;

// Pointer fixture: a hover menu, a double-click counter, a context menu, and two drag
// lists (pointer-driven and HTML5 native). Every observable state is mirrored into one
// status line so a suite can prove the page changed, not just that events were dispatched.
const POINTER_BODY = `
<main>
  <h1>Pointer fixture</h1>
  <div id="hover-zone" tabindex="0" aria-label="hover zone">Hover here</div>
  <ul id="hover-menu" role="menu" hidden style="position:absolute;left:0;top:0">
    <li role="menuitem">Alpha item</li>
    <li role="menuitem">Beta item</li>
  </ul>
  <div id="dbl" tabindex="0" aria-label="double click pad">Double click pad</div>
  <div id="ctx" tabindex="0" aria-label="context pad">Right click pad</div>
  <ul id="ctx-menu" role="menu" hidden style="position:absolute;left:40px;top:40px">
    <li role="menuitem">Context delete</li>
  </ul>
  <ul id="pointer-list" role="listbox" aria-label="pointer list">
    <li role="option" data-item="1" tabindex="0">Pointer one</li>
    <li role="option" data-item="2" tabindex="0">Pointer two</li>
    <li role="option" data-item="3" tabindex="0">Pointer three</li>
  </ul>
  <ul id="html5-list" role="listbox" aria-label="html5 list">
    <li role="option" data-item="1" tabindex="0" draggable="true">Native one</li>
    <li role="option" data-item="2" tabindex="0" draggable="true">Native two</li>
    <li role="option" data-item="3" tabindex="0" draggable="true">Native three</li>
  </ul>
  <div role="status" id="pointer-status">pointer-idle</div>
</main>
<script>
const status = document.querySelector('#pointer-status');
const hoverMenu = document.querySelector('#hover-menu');
const ctxMenu = document.querySelector('#ctx-menu');
let dbl = 0, ctx = 0, pointerDrag = '', nativeDrag = '', starts = 0, drops = 0;
const order = (list) => Array.from(list.children).map((child) => child.dataset.item).join('');
const paint = (label) => { status.textContent = label + '|dbl=' + dbl + '|ctx=' + ctx + '|start=' + starts + '|drop=' + drops + '|pointer=' + order(document.querySelector('#pointer-list')) + '|native=' + order(document.querySelector('#html5-list')); };
document.querySelector('#hover-zone').addEventListener('mouseenter', () => { hoverMenu.hidden = false; paint('hover-open'); });
document.querySelector('#hover-zone').addEventListener('mouseleave', () => { hoverMenu.hidden = true; });
document.querySelector('#dbl').addEventListener('dblclick', () => { dbl += 1; paint('dblclick'); });
document.querySelector('#ctx').addEventListener('contextmenu', (event) => { event.preventDefault(); ctx += 1; ctxMenu.hidden = false; paint('contextmenu'); });
// Pointer-driven reordering: mousedown on an item, drop on the item under the pointer.
const pointerList = document.querySelector('#pointer-list');
pointerList.addEventListener('mousedown', (event) => { const item = event.target.closest('li'); if (item) pointerDrag = item.dataset.item; });
pointerList.addEventListener('mouseup', (event) => {
  const target = event.target.closest('li');
  if (!target || !pointerDrag) return;
  const dragged = pointerList.querySelector('[data-item="' + pointerDrag + '"]');
  pointerList.insertBefore(dragged, target.nextSibling);
  pointerDrag = '';
  paint('pointer-drag');
});
// Native HTML5 drag and drop.
const nativeList = document.querySelector('#html5-list');
nativeList.addEventListener('dragstart', (event) => { nativeDrag = event.target.dataset.item; starts += 1; paint('native-dragstart'); });
nativeList.addEventListener('dragover', (event) => event.preventDefault());
nativeList.addEventListener('drop', (event) => {
  event.preventDefault();
  const target = event.target.closest('li');
  drops += 1;
  paint('native-drop');
  // Spec-shaped drop: identify the source from dataTransfer, with the dragstart state as
  // a fallback. Chrome does not fire dragstart for relay-synthesized drags.
  const value = (event.dataTransfer && event.dataTransfer.getData('text/plain')) || nativeDrag;
  const dragged = Array.from(nativeList.children).find((child) => child.dataset.item === value || child.textContent.trim() === value);
  if (!target || !dragged) return;
  nativeList.insertBefore(dragged, target.nextSibling);
  nativeDrag = '';
  paint('native-drag');
});
paint('pointer-idle');
</script>`;

// Keys fixture: a textarea and an ARIA listbox that reports its own state, so a keypress
// suite can prove the page really changed instead of trusting the dispatch ack.
const KEYS_BODY = `
<main>
  <h1>Keys fixture</h1>
  <textarea id="keys-text" aria-label="keys textarea"></textarea>
  <ul id="keys-list" role="listbox" tabindex="0" aria-label="keys listbox">
    <li role="option" aria-selected="false">one</li>
    <li role="option" aria-selected="false">two</li>
    <li role="option" aria-selected="false">three</li>
    <li role="option" aria-selected="false">four</li>
  </ul>
  <div role="status" id="keys-status">keys-idle</div>
</main>
<script>
const text = document.querySelector('#keys-text');
const status = document.querySelector('#keys-status');
const options = Array.from(document.querySelectorAll('#keys-list [role=option]'));
let selected = 0;
// The status line carries the page's real state, so a keypress suite can prove effect
// instead of trusting the dispatch acknowledgement.
const paint = (label) => {
  options.forEach((option, index) => option.setAttribute('aria-selected', String(index === selected)));
  status.textContent = 'listbox|' + label + '|' + (selected + 1) + '|' + options[selected].textContent;
};
text.addEventListener('input', () => { status.textContent = 'textarea|' + text.value.length + '|' + text.value; });
document.querySelector('#keys-list').addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  selected = Math.min(options.length - 1, Math.max(0, selected + (event.key === 'ArrowDown' ? 1 : -1)));
  paint(event.key);
});
paint('init');
</script>`;

// Network fixture: sends a secret cookie and Authorization header on a request that
// fails with 500, plus two ordinary requests. A passing suite proves those two values
// reached the server but never reached the relay result.
const NETWORK_SECRET_COOKIE = "fixture-secret-cookie-value";
const NETWORK_SECRET_AUTH = "fixture-secret-auth-value";
const NETWORK_BODY = `
<main>
  <h1>Network fixture</h1>
  <div role="status" id="network-status">Network fixture loaded</div>
</main>
<script>
document.cookie = 'session=${NETWORK_SECRET_COOKIE}; path=/';
// Requests are issued after the document is ready: capture starts when the relay attaches
// to the new tab, and traffic from the initial document load can precede that moment.
// The bodies are read on purpose — Chrome reports loadingFinished only once the response
// is consumed, and durationMs comes from that event.
window.addEventListener('load', () => setTimeout(() => {
  fetch('/status-500', { headers: { Authorization: 'Bearer ${NETWORK_SECRET_AUTH}' }, cache: 'no-store' })
    .then((response) => response.text().then((body) => { document.querySelector('#network-status').textContent = 'Network 500 ' + response.status + ' ' + body.length; }))
    .catch(() => { document.querySelector('#network-status').textContent = 'Network 500 rejected'; });
  fetch('/slow?ms=60', { cache: 'no-store' }).then((response) => response.text());
  fetch('/baseline', { cache: 'no-store' }).then((response) => response.text());
}, 200));
</script>`;

function htmlDocument(title, body) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

// Large document for the chunked-response suite: enough text that one read_full
// response has to travel as several native messages.
const LARGE_PARAGRAPHS = 340;
const LARGE_BODY = `<main>
<h1>Large document</h1>
${Array.from({ length: LARGE_PARAGRAPHS }, (_, index) => `<p>Paragraph ${index + 1}: ${"lorem ipsum dolor sit amet ".repeat(28)}</p>`).join("\n")}
<div role="status" id="large-tail">Large document tail sentinel</div>
</main>`;

// Clicked marker for the redirect suite: proof that a refused write never ran.
const REDIRECT_TARGET_BODY = `<main>
<h1>Redirect target</h1>
<button id="redirect-target-click" onclick="document.getElementById('redirect-target-state').textContent = 'clicked'">Click me</button>
<div role="status" id="redirect-target-state">untouched</div>
</main>`;

export const NETWORK_FIXTURE_SECRETS = { cookie: NETWORK_SECRET_COOKIE, authorization: NETWORK_SECRET_AUTH };

export function defaultPages({ frameOrigin }) {
	return new Map([
		["/baseline", htmlDocument("M7 relay smoke", BASELINE_BODY.replace("__FRAME__", `${frameOrigin}/frame`))],
		["/frame", htmlDocument("M7 frame", FRAME_BODY)],
		["/popup", htmlDocument("Popup", "<h2>Spawned context</h2>")],
		["/large", htmlDocument("Large document", LARGE_BODY)],
		["/form", htmlDocument("Agent form", FORM_BODY)],
		["/user", htmlDocument("User tab", USER_BODY)],
		["/console", htmlDocument("Console fixture", CONSOLE_BODY)],
		["/network", htmlDocument("Network fixture", NETWORK_BODY)],
		["/keys", htmlDocument("Keys fixture", KEYS_BODY)],
		["/pointer", htmlDocument("Pointer fixture", POINTER_BODY)],
		["/upload", htmlDocument("Upload fixture", UPLOAD_BODY)],
		["/dialog", htmlDocument("Dialog fixture", DIALOG_BODY)],
		["/redirect-target", htmlDocument("Redirect target", REDIRECT_TARGET_BODY)],
	]);
}

/**
 * Start the fixture site.
 * @returns {Promise<{origin: string, frameOrigin: string, url(path: string): string,
 *   frameUrl(path: string): string, requests: Array<{method: string, path: string, headers: object}>,
 *   page(path: string, title: string, body: string): void, close(): Promise<void>}>}
 */
export async function createFixtureServer() {
	const pageMap = new Map();
	const requests = [];
	// Uploaded bodies: only the digest and size are kept, never the content.
	const uploads = [];
	const listeners = [];
	// Filled once both sites listen; the redirect handler needs the *other* site's port.
	const crossSite = { redirectTarget: "" };

	const handler = (response, role) => (request, reply) => {
		const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
		requests.push({ role, method: request.method ?? "GET", path, headers: { ...request.headers }, body: "" });
		if (path === "/download") {
			reply.writeHead(200, {
				"content-type": "text/plain; charset=utf-8",
				"content-disposition": "attachment; filename=\"fixture.txt\"",
				"cache-control": "no-store",
			});
			reply.end("fixture download body\n");
			return;
		}
		if (path === "/slow") {
			// Holds the response open so the tab stays `loading`: a deterministic
			// long-running relay operation for the concurrency suites.
			const waitMs = Math.min(10_000, Number(new URL(request.url ?? "/", "http://fixture.invalid").searchParams.get("ms") ?? 1_500) || 1_500);
			setTimeout(() => {
				try {
					reply.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
					reply.end(htmlDocument("Slow page", "<h2>Slow page ready</h2>"));
				} catch { /* client navigated away or closed */ }
			}, waitMs);
			return;
		}
		if (path === "/upload-echo") {
			const chunks = [];
			request.on("data", (chunk) => chunks.push(chunk));
			request.on("end", () => {
				const body = Buffer.concat(chunks);
				const sha256 = createHash("sha256").update(body).digest("hex");
				uploads.push({ sha256, size: body.length });
				try {
					reply.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
					reply.end(JSON.stringify({ sha256, size: body.length }));
				} catch { /* client went away */ }
			});
			return;
		}
		if (path === "/redirect-out") {
			// A server-side redirect to the other fixture site: the tab's origin changes
			// without any `navigate` call, which is exactly the case the relay re-checks
			// before dispatching a write.
			reply.writeHead(302, { location: crossSite.redirectTarget, "cache-control": "no-store" });
			reply.end();
			return;
		}
		if (path === "/status-500") {
			reply.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			reply.end(JSON.stringify({ error: "fixture server error" }));
			return;
		}
		const page = pageMap.get(path);
		if (!page) {
			reply.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			reply.end("fixture 404");
			return;
		}
		reply.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		reply.end(page);
	};

	const listen = async (role, host, publicHost) => {
		const server = createServer(handler(null, role));
		await new Promise((ready, reject) => { server.once("error", reject); server.listen(0, host, ready); });
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("fixture server address 无效");
		listeners.push(server);
		return `http://${publicHost}:${address.port}`;
	};

	const origin = await listen("main", "127.0.0.1", "127.0.0.1");
	// A different site name makes the iframe an out-of-process frame, which is what
	// the relay's child-session path handles; same-site frames never get a child target.
	const frameOrigin = await listen("frame", "::", "localhost");
	crossSite.redirectTarget = `${frameOrigin}/redirect-target`;
	for (const [path, page] of defaultPages({ frameOrigin })) pageMap.set(path, page);

	return {
		origin,
		frameOrigin,
		requests,
		uploads,
		url: (path) => `${origin}${path}`,
		frameUrl: (path) => `${frameOrigin}${path}`,
		page: (path, title, body) => pageMap.set(path, htmlDocument(title, body)),
		requestsTo: (path) => requests.filter((entry) => entry.path === path),
		close: async () => {
			await Promise.all(listeners.map((server) => new Promise((done) => {
				server.closeAllConnections();
				server.close(done);
			})));
		},
	};
}
