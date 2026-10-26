import { COPY } from "./copy.mjs";
import { matchesSessionFilter } from "./service.mjs";
export const evalMarkup = '<section id="eval-workspace" hidden></section>';
export const evalStyles = `
[hidden]{display:none!important}
body.eval-active .signal-region,body.eval-active .workspace{display:none}
body.eval-active .app-shell{grid-template-rows:58px minmax(0,1fr) 28px}
#eval-workspace{min-height:0;display:grid;grid-template-columns:340px minmax(0,1fr);background:#101112}
.eval-sidebar{border-right:1px solid #424744;overflow:auto;padding:20px}
.eval-detail{min-width:0;overflow:auto;padding:32px 4vw}.eval-detail>section{margin:24px 0}
.eval-skeleton{display:block;min-height:86px;margin:8px 0;background:linear-gradient(90deg,#141716,#1b201d,#141716);background-size:200% 100%;animation:eval-shimmer 1.2s linear infinite;border-left-color:#3a423c}@keyframes eval-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}@media(prefers-reduced-motion:reduce){.eval-skeleton{animation:none}}.eval-session{display:block;width:100%;text-align:left;padding:16px 8px;margin:8px 0;background:transparent;color:inherit;border:0;border-left:4px solid #e6ba68;border-bottom:1px solid #424744;cursor:pointer;overflow-wrap:anywhere}
.eval-session[data-label=pass]{border-left-color:#9dcc84}.eval-session[data-label=fail]{border-left-color:#ef9d93}.eval-session[data-label=failSet]{border-left-color:#b6a1ed}.eval-session.selected{background:#242e24}
.eval-session strong,.eval-session small{display:block;margin:8px 0}.eval-muted,.eval-meta{color:#b6bdb8;font-size:12px;overflow-wrap:anywhere}.eval-text{white-space:pre-wrap;overflow-wrap:anywhere}
.eval-badge{display:inline-block;padding:3px 7px;margin:4px 6px 4px 0;border:1px solid #586556;border-radius:2px;font-size:12px}
.eval-form,.eval-judge{border:1px solid #586556;padding:18px}.eval-form button,.eval-judge button,.eval-next,.eval-dialog button{padding:10px 14px;margin:6px 8px 6px 0;background:transparent;border:1px solid #65745f;color:inherit;cursor:pointer}
.eval-form button[aria-pressed=true],.eval-primary{background:#58713f!important;color:#fff!important}.eval-form button:disabled,.eval-judge button:disabled{opacity:.5;cursor:not-allowed}
.eval-form>label{display:block;margin-top:12px}
.eval-form input[type=text],.eval-judge select,.eval-sidebar select{display:block;width:100%;padding:10px;margin:10px 0;background:#171d19;color:#eff3ef;border:1px solid #65745f;box-sizing:border-box}
.eval-event{padding:16px;border-left:2px solid #586556;margin:16px 0;min-width:0}.eval-event.failed{border-color:#ef9d93}.eval-event.focused{outline:2px solid #d7c079;outline-offset:3px}.eval-error{color:#ffad9f}
.eval-event details{margin:12px 0}.eval-event summary{cursor:pointer}.eval-event pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0b0e0b;padding:12px;max-height:360px;overflow:auto}
.eval-dialog{max-width:560px;background:#171d19;color:#eff3ef;border:1px solid #819779;padding:24px}.eval-dialog::backdrop{background:#000a}
.eval-notice{color:#e6cf98}button:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid #d7c079;outline-offset:3px}
@media(max-width:800px){#eval-workspace{grid-template-columns:1fr}.eval-sidebar{max-height:45vh;border-bottom:1px solid #424744}.eval-detail{overflow:visible}.eval-active .app-shell{display:block}.eval-active .top-context,.eval-active .key-hint{display:none}.eval-active .topbar{height:auto;min-height:60px;flex-wrap:wrap}.eval-active .top-actions{margin-left:0;min-width:0;flex-wrap:wrap}.eval-active .view-switch{flex-wrap:wrap}.eval-active .app-footer{height:auto;min-height:28px;flex-wrap:wrap;overflow-wrap:anywhere}.eval-active .security{white-space:normal}}
`;

function evalClient(C, matchesFilter) {
	'use strict';
	const root = document.getElementById('eval-workspace');
	const token = new URLSearchParams(location.hash.slice(1)).get('token');
	const traceSecurity = document.querySelector('.security').textContent;
	let enabled = false, rows = [], nextCursor = null, filter = 'unlabeled', selected = null;
	let generation = 0, detailGeneration = 0, draft = null, modelPromise, pollingRun = null;
	const format = (pattern, values) => pattern.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));
	const number = (value) => value === null || value === undefined ? C.unknown : String(value);
	const make = (tag, className = '', text) => {
		const node = document.createElement(tag); node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	};
	const button = (text, action, className = '') => {
		const node = make('button', className, text); node.type = 'button'; node.onclick = action; return node;
	};
	const labelName = (annotation) => !annotation ? C.unlabeled : annotation.failSet ? C.failSet : C[annotation.verdict];
	const ruleName = (rule) => (C.ruleNames[rule] || C.rules) + '（' + rule + '）';
	const tab = button(C.tab, () => switchEval(true));
	tab.id = 'view-eval'; tab.setAttribute('aria-pressed', 'false'); document.querySelector('.view-switch').append(tab);
	const sidebar = make('aside', 'eval-sidebar'), detail = make('main', 'eval-detail');
	const select = make('select'); select.id = 'eval-filter'; select.setAttribute('aria-label', C.filters);
	for (const value of ['all', 'unlabeled', 'fail', 'failSet', 'hits']) { const option = make('option', '', C[value]); option.value = value; select.append(option); }
	select.value = filter;
	const progress = make('p', 'eval-meta'), status = make('p', 'eval-muted'), list = make('div');
	status.setAttribute('role', 'status');
	const more = button(C.more, () => loadList(false), 'eval-next'); more.hidden = true;
	sidebar.append(make('h2', '', C.title), make('p', 'eval-muted', C.subtitle), progress, select, status, list, more);
	detail.append(make('p', 'eval-muted', C.choose)); root.append(sidebar, detail);

	async function api(path, body) {
		const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const data = await response.json();
		if (!response.ok) throw Object.assign(new Error(C.errors[data.error] || (response.status === 401 ? C.errors.unauthorized : C.readError)), { status: response.status, code: data.error });
		return data;
	}
	function metricsText(metrics) {
		return C.tools + ' ' + number(metrics?.toolCalls) + ' / ' + number(metrics?.toolErrors) + ' · ' + C.duration + ' ' + (metrics?.durationMs == null ? C.unknown : Math.round(metrics.durationMs / 60000)) + ' · ' + C.cost + ' ' + number(metrics?.costUsd);
	}
	function renderList() {
		list.replaceChildren();
		const visibleRows = rows.filter((row) => matchesFilter(row, filter));
		for (const row of visibleRows) {
			const node = button('', () => openSession(row.id), 'eval-session' + (selected === row.id ? ' selected' : ''));
			node.dataset.sessionId = row.id; node.dataset.label = row.annotation?.failSet ? 'failSet' : row.annotation?.verdict || 'unlabeled';
			node.append(make('small', 'eval-meta', row.started), make('span', 'eval-badge', C.activity + '：' + C.activityNames[row.state]), make('strong', '', row.request || (row.unavailable ? C.unavailable : C.noRequest)), make('small', 'eval-meta', metricsText(row.metrics)));
			node.append(make('span', 'eval-badge', C.labelState + '：' + labelName(row.annotation)));
			if (row.annotation) node.append(make('small', 'eval-meta', C.sources[row.annotation.source]));
			if (row.annotation?.progressed) node.append(make('small', 'eval-notice', C.progressed));
			const hits = row.findings.filter((finding) => finding.status === 'hit');
			if (hits.length) node.append(make('small', 'eval-notice', hits.map((finding) => ruleName(finding.rule)).join('；')));
			if (row.judgment) node.append(make('small', 'eval-meta', C.alreadyJudged + ' · ' + (C[row.judgment.verdict] || C.judgeStatuses[row.judgment.status])));
			list.append(node);
		}
		if (!visibleRows.length) list.append(make('p', 'eval-muted', nextCursor ? C.loading : C.empty));
		more.hidden = !nextCursor;
	}
	function countText(label, count) {
		return count === null || count === undefined ? label + '（' + C.seeCount + '）' : format(C.countOption, { label, count });
	}
	function timingText(ms) {
		return ms < 1_000 ? format(C.loadTimingMs, { value: ms }) : format(C.loadTimingSeconds, { value: (ms / 1_000).toFixed(1) });
	}
	function placeholders() {
		list.replaceChildren();
		for (let index = 0; index < 3; index++) list.append(make('div', 'eval-skeleton', ' '));
	}
	async function loadList(reset, recovered = false) {
		const request = ++generation;
		// A reset keeps the previous list visible until data arrives; blanking it
		// made every filter change look like a broken page.
		if (reset) { rows = []; nextCursor = null; more.hidden = true; list.replaceChildren(); placeholders(); }
		select.disabled = true; more.disabled = true;
		const startedAt = Date.now();
		status.textContent = format(C.loadingElapsed, { seconds: 0 });
		const ticker = setInterval(() => { if (request === generation) status.textContent = format(C.loadingElapsed, { seconds: Math.floor((Date.now() - startedAt) / 1000) }); }, 500);
		try {
			let data;
			do {
				data = await api('/api/eval/sessions?filter=' + filter + (nextCursor ? '&cursor=' + encodeURIComponent(nextCursor) : '') + (reset && recovered ? '&refresh=1' : ''));
				if (request !== generation) return;
				rows.push(...data.items); nextCursor = data.nextCursor;
			} while (!rows.length && nextCursor);
			progress.textContent = format(C.labelProgress, data);
			for (const option of select.options) option.textContent = countText(C[option.value], data.counts[option.value]);
			const matched = data.matched ?? data.total;
			status.textContent = (recovered ? C.listUpdated + ' · ' : '') + (filter === 'all' ? C.listCount + ' ' + rows.length + ' / ' + data.total : format(C.matchedCount, { matched, loaded: rows.length })) + (data.limited ? ' · ' + C.partial : '') + (data.elapsedMs === undefined ? '' : ' · ' + timingText(data.elapsedMs));
			renderList();
		} catch (error) {
			if (request !== generation) return;
			if (error.status === 409 && !recovered) return loadList(true, true);
			status.textContent = error.message || C.readError;
		} finally { clearInterval(ticker); if (request === generation) { more.disabled = false; select.disabled = false; } }
	}
	function annotationForm(data) {
		if (draft?.sessionId !== data.id || !draft.dirty) draft = { sessionId: data.id, verdict: data.annotation?.verdict || null, note: data.annotation?.note || '', failSet: !!data.annotation?.failSet, dirty: false };
		const currentDraft = draft;
		const box = make('section', 'eval-form'), current = make('p', 'eval-meta'), message = make('p', 'eval-muted'), progressNotice = make('p', 'eval-notice', C.progressed);
		message.setAttribute('role', 'status');
		const pass = button(C.pass, () => choose('pass')), fail = button(C.fail, () => choose('fail')), save = button(C.save, saveLabel, 'eval-primary');
		pass.id = 'eval-pass'; fail.id = 'eval-fail'; save.id = 'eval-save';
		const noteLabel = make('label', '', C.reason), note = make('input'); note.type = 'text'; note.id = 'eval-note'; note.maxLength = 500; note.placeholder = C.reasonPlaceholder; noteLabel.htmlFor = note.id;
		const failSetLabel = make('label', '', C.addFailSet), failSet = make('input'); failSet.type = 'checkbox'; failSet.id = 'eval-failset'; failSetLabel.prepend(failSet);
		function currentLabel() { current.textContent = data.annotation ? format(C.current, { verdict: labelName(data.annotation), source: C.sources[data.annotation.source] }) : C.unlabeled; }
		function update() {
			pass.setAttribute('aria-pressed', String(currentDraft.verdict === 'pass')); fail.setAttribute('aria-pressed', String(currentDraft.verdict === 'fail'));
			note.value = currentDraft.note; failSet.checked = currentDraft.failSet;
			noteLabel.hidden = note.hidden = failSetLabel.hidden = currentDraft.verdict !== 'fail';
			pass.disabled = fail.disabled = data.state === 'unknown'; save.disabled = data.state === 'unknown' || !currentDraft.verdict;
		}
		function choose(verdict) { currentDraft.verdict = verdict; currentDraft.dirty = true; if (verdict === 'pass') { currentDraft.note = ''; currentDraft.failSet = false; } update(); }
		note.oninput = () => { currentDraft.note = note.value; currentDraft.dirty = true; };
		failSet.onchange = () => { currentDraft.failSet = failSet.checked; currentDraft.dirty = true; };
		async function saveLabel() {
			save.disabled = true;
			try {
				const saved = await api('/api/eval/annotation', { sessionId: data.id, verdict: currentDraft.verdict, note: currentDraft.note, failSet: currentDraft.failSet });
				data.annotation = { ...saved, source: 'dashboard' }; currentDraft.dirty = false; currentLabel(); progressNotice.hidden = true; message.textContent = C.saved;
				await loadList(true); save.disabled = false;
			} catch (error) {
				message.textContent = !error.status || error.status >= 500 ? C.saveUnknown : error.message;
				if (error.status && error.status < 500) update();
			}
		}
		box.append(make('h3', '', C.annotation), current, pass, fail, save, noteLabel, note, failSetLabel);
		if (data.state === 'active') box.append(make('p', 'eval-notice', C.activeWarning));
		if (data.state === 'unknown') box.append(make('p', 'eval-notice', C.unknownState));
		progressNotice.hidden = !data.annotation?.progressed; box.append(progressNotice);
		box.append(message); currentLabel(); update();
		return { node: box, adopt(result) { if (result.suggestedVerdict === 'unsure') return; choose(result.suggestedVerdict); currentDraft.note = result.suggestedVerdict === 'fail' ? result.firstProblem?.description || result.summary : ''; update(); message.textContent = C.adopted; box.scrollIntoView({ block: 'start' }); } };
	}
	function timeline(data, eventIndex) {
		const box = make('section'); box.id = 'eval-timeline'; box.append(make('h3', '', C.timeline), make('p', 'eval-muted', C.pageEvents + ' ' + data.timeline.items.length + ' / ' + data.timeline.total));
		if (!data.timeline.total) box.append(make('p', 'eval-muted', C.noEvents));
		for (const event of data.timeline.items) {
			const item = make('article', 'eval-event' + (event.failed ? ' failed' : '') + (event.index === eventIndex ? ' focused' : '')); item.dataset.eventIndex = String(event.index);
			item.append(make('small', 'eval-meta', format(C.event, { event: event.index + 1 })));
			if (event.kind === 'tool') {
				item.append(make('strong', event.failed ? 'eval-error' : '', event.name + ' · ' + (C.outcomes[event.outcome] || C.unknown) + '（' + event.outcome + '）'));
				if (event.firstError) item.append(make('p', 'eval-error', C.firstError));
				for (const [key, label] of [['args', C.args], ['result', C.result]]) { const folded = make('details'); folded.append(make('summary', '', label), make('pre', '', event[key].text)); if (event[key].truncated) folded.append(make('p', 'eval-muted', C.truncated)); item.append(folded); }
			} else { item.append(make('strong', '', C[event.kind]), make('p', 'eval-text', event.content.text)); if (event.firstError) item.append(make('p', 'eval-error', C.firstError)); if (event.content.truncated) item.append(make('p', 'eval-muted', C.truncated)); }
			box.append(item);
		}
		if (data.timeline.nextCursor) box.append(button(C.moreEvents, () => openSession(data.id, { cursor: data.timeline.nextCursor }), 'eval-next'));
		return box;
	}
	function confirmJudge(prepared) {
		return new Promise((resolve) => {
			const dialog = make('dialog', 'eval-dialog'); dialog.setAttribute('aria-label', C.confirmTitle);
			dialog.append(make('h2', '', C.confirmTitle), make('p', 'eval-text', format(C.confirmDetails, { model: prepared.model, count: prepared.inputChars, truncated: prepared.truncated ? C.yes : C.no })), make('p', '', C.consent), button(C.cancel, () => dialog.close()), button(C.confirmJudge, () => dialog.close('confirm'), 'eval-primary'));
			dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'confirm'; dialog.remove(); resolve(accepted); }, { once: true });
			document.body.append(dialog); dialog.showModal();
		});
	}
	async function pollJudge(job, message, cancel) {
		if (pollingRun === job.runId) return;
		pollingRun = job.runId;
		try {
			let state;
			do { await new Promise((resolve) => setTimeout(resolve, 1000)); state = await api('/api/eval/judge/status?runId=' + encodeURIComponent(job.runId)); } while (state.status === 'running');
			cancel.disabled = true;
			if (state.error) { message.textContent = C.errors[state.error] || C.judgeStatusUnknown; return; }
			if (selected === job.sessionId) await openSession(job.sessionId);
			await loadList(true);
		} catch { message.textContent = C.judgeStatusUnknown; }
		finally { pollingRun = null; }
	}
	function judgePanel(data, annotation) {
		const box = make('section', 'eval-judge'), message = make('p', 'eval-muted'); message.setAttribute('role', 'status');
		box.append(make('h3', '', C.judge));
		const latest = data.judgment?.latest;
		if (latest) {
			box.append(make('p', 'eval-meta', latest.model + ' · ' + C.judgeStatuses[latest.status] + ' · ' + C.elapsed + ' ' + Math.round(latest.durationMs / 1000)), make('p', 'eval-error', C.judgeFailures[latest.failure] || C.judgeStatuses[latest.status]), make('p', 'eval-muted', C.judgeFailureHint), ...(latest.rawOutput ? [make('pre', 'eval-detail-error', latest.rawOutput)] : []), make('p', 'eval-meta', C.historyCount + ' ' + data.judgment.historyCount), make('p', 'eval-meta', C.tokenCount + ' ' + number(latest.usage?.input) + ' / ' + number(latest.usage?.output)), make('p', 'eval-meta', latest.usage?.costUsd == null ? C.actualCost : format(C.estimatedCost, { cost: latest.usage.costUsd })));
			if (latest.atEntryId !== data.atEntryId) box.append(make('p', 'eval-notice', C.analysisProgressed));
			if (latest.status === 'ok') {
				const result = latest.result;
				box.append(make('p', '', C.suggestion + '：' + C[result.suggestedVerdict] + ' · ' + C.confidence + ' ' + Math.round(result.confidence * 100) + '%'), make('h4', '', C.judgeSummary), make('p', 'eval-text', result.summary));
				const jump = (event) => openSession(data.id, { eventIndex: event - 1 });
				if (result.firstProblem) { const first = button(C.firstProblem + ' · ' + format(C.event, result.firstProblem) + '：' + result.firstProblem.description, () => jump(result.firstProblem.event)); first.id = 'eval-first-problem'; first.disabled = !data.judgment.anchorAvailable; box.append(first); }
				else box.append(make('p', 'eval-muted', C.noProblem));
				if (!data.judgment.anchorAvailable) box.append(make('p', 'eval-notice', C.oldAnalysis));
				box.append(make('h4', '', C.evidence));
				for (const evidence of result.evidence) box.append(make('p', 'eval-text', format(C.event, evidence) + '：' + evidence.quote));
				box.append(make('h4', '', C.suggestions));
				for (const suggestion of result.suggestions) box.append(make('p', 'eval-text', suggestion));
				const adopt = button(C.adopt, () => annotation.adopt(result)); adopt.id = 'eval-adopt'; adopt.disabled = result.suggestedVerdict === 'unsure' || data.state === 'unknown'; box.append(adopt);
			}
		} else box.append(make('p', 'eval-muted', C.nothingJudged));
		const model = make('select'); model.setAttribute('aria-label', C.model); model.id = 'eval-model'; model.disabled = true;
		model.append(make('option', '', C.modelsLoading));
		const analyze = button(C.analyze, start); analyze.id = 'eval-analyze'; analyze.disabled = true;
		const cancel = button(C.cancel, async () => { cancel.disabled = true; try { await api('/api/eval/judge/cancel', { runId: data.activeJudge.runId }); message.textContent = C.cancelling; } catch (error) { message.textContent = error.message || C.judgeStatusUnknown; } }); cancel.hidden = true;
		const retryModels = button(C.retryModels, readModels); retryModels.id = 'eval-retry-models'; retryModels.hidden = true;
		const diagnostic = make('div', 'eval-model-diagnostic'); diagnostic.hidden = true;
		diagnostic.append(make('p', 'eval-muted', C.modelCheckLabel), make('pre', 'eval-text', C.modelCheckCommand));
		box.append(model, analyze, retryModels, cancel, message, diagnostic);
		function running(job) {
			data.activeJudge = job; analyze.disabled = model.disabled = true; cancel.hidden = false;
			const started = Date.now(), tick = () => { message.textContent = format(C.judgingElapsed, { seconds: Math.round((Date.now() - started) / 1000) }); };
			tick();
			const timer = setInterval(tick, 1000);
			pollJudge(job, message, cancel).finally(() => clearInterval(timer));
		}
		async function start() {
			analyze.disabled = true; message.textContent = C.preparing;
			try {
				const prepared = await api('/api/eval/judge/prepare', { sessionId: data.id, model: model.value });
				if (selected !== data.id || !box.isConnected) return;
				if (!await confirmJudge(prepared)) { analyze.disabled = false; message.textContent = ''; return; }
				try { running(await api('/api/eval/judge', { confirmationId: prepared.confirmationId })); }
				catch (error) { message.textContent = !error.status || error.status >= 500 ? C.judgeStartUnknown : error.message; if (error.status && error.status < 500) analyze.disabled = false; }
			} catch (error) { message.textContent = error.message || C.readError; analyze.disabled = false; }
		}
		function readModels() {
			diagnostic.hidden = true; retryModels.hidden = retryModels.disabled = true; model.disabled = analyze.disabled = true;
			model.replaceChildren(make('option', '', C.modelsLoading)); message.textContent = '';
			if (!modelPromise) modelPromise = api('/api/eval/models').catch((error) => { modelPromise = undefined; throw error; });
			modelPromise.then((catalog) => {
				model.replaceChildren();
				if (!catalog.models.length) {
					message.textContent = C.modelsEmpty;
					diagnostic.hidden = false;
					model.append(make('option', '', C.modelsEmpty)); return;
				}
				if (!catalog.defaultModel) { const empty = make('option', '', C.chooseModel); empty.value = ''; model.append(empty); }
				for (const row of catalog.models) { const option = make('option', '', row.id); option.value = row.id; model.append(option); }
				model.value = catalog.defaultModel || ''; model.disabled = !!data.activeJudge; analyze.disabled = !!data.activeJudge || !model.value;
				model.onchange = () => { analyze.disabled = !model.value; };
			}).catch((error) => {
				model.replaceChildren(make('option', '', C.modelsUnavailable));
				message.textContent = error.message || C.readError; diagnostic.hidden = retryModels.hidden = retryModels.disabled = false;
			});
		}
		readModels();
		if (data.activeJudge) running(data.activeJudge);
		return box;
	}
	async function openSession(id, options = {}) {
		const request = ++detailGeneration; selected = id; renderList();
		if (!options.cursor && options.eventIndex === undefined) detail.replaceChildren(make('h2', '', C.title), make('p', 'eval-muted', C.loadingDetail));
		try {
			const data = await api('/api/eval/session?id=' + encodeURIComponent(id) + (options.cursor ? '&cursor=' + encodeURIComponent(options.cursor) : '') + (options.eventIndex !== undefined ? '&event=' + options.eventIndex : ''));
			if (request !== detailGeneration) return;
			rows = rows.map((row) => row.id === data.id ? { ...row, annotation: data.annotation, findings: data.findings } : row);
			renderList();
			const annotation = annotationForm(data);
			detail.replaceChildren(make('h2', '', C.title), make('p', 'eval-meta', data.started + ' · ' + C.activity + '：' + C.activityNames[data.state]), annotation.node, judgePanel(data, annotation));
			if (options.notice) detail.append(make('p', 'eval-notice', options.notice));
			for (const [key, label] of [['request', C.request], ['final', C.final]]) { const box = make('section'); box.append(make('h3', '', label), make('p', 'eval-text', data.summary[key].text)); if (data.summary[key].truncated) box.append(make('p', 'eval-muted', C.truncated)); detail.append(box); }
			const rules = make('section'); rules.append(make('h3', '', C.rules));
			for (const finding of data.findings) rules.append(make('p', 'eval-meta', ruleName(finding.rule) + ' · ' + C.findingNames[finding.status] + ' · ' + finding.count));
			const metrics = make('section'); metrics.append(make('h3', '', C.metrics), make('p', 'eval-meta', metricsText(data.metrics)), make('p', 'eval-meta', C.tokenCount + ' ' + number(data.metrics?.tokens ? data.metrics.tokens.input + data.metrics.tokens.output : null)));
			detail.append(rules, metrics, timeline(data, options.eventIndex));
			if (options.eventIndex !== undefined) detail.querySelector('[data-event-index="' + options.eventIndex + '"]')?.scrollIntoView({ block: 'center' });
			else if (options.cursor) detail.querySelector('#eval-timeline').scrollIntoView({ block: 'start' }); else detail.scrollTop = 0;
		} catch (error) {
			if (request !== detailGeneration) return;
			if (error.status === 409 && !options.recovered) return openSession(id, { recovered: true, notice: C.timelineUpdated });
			detail.replaceChildren(make('p', 'eval-error', error.status === 409 ? C.busy : error.message || C.readError));
		}
	}
	function switchEval(value) {
		enabled = value; root.hidden = !value; document.body.classList.toggle('eval-active', value); tab.setAttribute('aria-pressed', String(value)); tab.classList.toggle('active', value); document.querySelector('.security').textContent = value ? C.security : traceSecurity;
		if (value) { for (const id of ['view-stats', 'view-trace']) { document.getElementById(id).classList.remove('active'); document.getElementById(id).setAttribute('aria-pressed', 'false'); } loadList(true); }
	}
	for (const id of ['view-stats', 'view-trace']) document.getElementById(id).addEventListener('click', () => switchEval(false));
	select.onchange = () => { filter = select.value; loadList(true); };
	document.getElementById('refresh').addEventListener('click', (event) => { if (enabled) { event.stopImmediatePropagation(); loadList(true); if (selected) openSession(selected); } }, true);
}
export const evalScript = '(' + evalClient.toString() + ')(' + JSON.stringify(COPY) + ', ' + matchesSessionFilter.toString() + ');';
