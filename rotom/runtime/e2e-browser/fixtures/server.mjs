#!/usr/bin/env node

// Local fixture site for the browser e2e harness. Two listeners so iframe tests
// are genuinely cross-origin without touching the network. Every request is
// logged (method, path, headers) so suites can assert negative behaviour such as
// "the extension never sent this request".

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
	const listeners = [];

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
	for (const [path, page] of defaultPages({ frameOrigin })) pageMap.set(path, page);

	return {
		origin,
		frameOrigin,
		requests,
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
