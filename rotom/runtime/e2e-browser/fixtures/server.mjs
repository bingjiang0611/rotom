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

function htmlDocument(title, body) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

export function defaultPages({ frameOrigin }) {
	return new Map([
		["/baseline", htmlDocument("M7 relay smoke", BASELINE_BODY.replace("__FRAME__", `${frameOrigin}/frame`))],
		["/frame", htmlDocument("M7 frame", FRAME_BODY)],
		["/popup", htmlDocument("Popup", "<h2>Spawned context</h2>")],
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
