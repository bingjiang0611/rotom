import { COPY } from "./copy.mjs";
import { matchesSessionFilter } from "./service.mjs";
import { annotationClient } from "./annotation-ui.mjs";
import { judgeClient } from "./judge-ui.mjs";
import { replayClient } from "./replay-ui.mjs";
import { drawerClient } from "./drawer-ui.mjs";
import { evalStyles } from "./styles.mjs";

export const evalMarkup = '<section id="eval-workspace" hidden></section>';
export { evalStyles };

function evalClient(C, matchesFilter, annotationClient, judgeClient, replayClient, drawerClient) {
	'use strict';
	const root = document.getElementById('eval-workspace');
	const token = new URLSearchParams(location.hash.slice(1)).get('token');
	const traceSecurity = document.querySelector('.security').textContent;
	const polling = { value: null };
	let enabled = false, rows = [], nextCursor = null, filter = 'unlabeled', selected = null;
	let generation = 0, detailGeneration = 0;
	const models = { value: undefined };
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
	const badgeTone = (value) => value === 'pass' || value === 'idle' || value === 'ok' ? ' good' : value === 'fail' || value === 'failed' ? ' bad' : value === 'active' ? ' warn' : ' info';
	const tab = button(C.tab, () => switchEval(true));
	tab.id = 'view-eval'; tab.setAttribute('aria-pressed', 'false'); document.querySelector('.view-switch').append(tab);

	const sidebar = make('aside', 'eval-sidebar'), detail = make('main', 'eval-detail'), inspector = make('aside', 'eval-inspector');
	inspector.id = 'eval-inspector-panel'; inspector.tabIndex = -1;
	const sidebarHead = make('div', 'eval-sidebar-head');
	sidebarHead.append(make('h2', '', C.queueTitle), make('p', 'eval-muted', C.subtitle));
	const progress = make('p', 'eval-meta eval-progress'), status = make('p', 'eval-muted eval-list-status'), list = make('div', 'eval-list');
	status.setAttribute('role', 'status');
	const filterBar = make('div', 'eval-filters'), filterButtons = new Map();
	const select = make('select', 'eval-filter-select'); select.id = 'eval-filter'; select.setAttribute('aria-label', C.filters);
	for (const value of ['all', 'unlabeled', 'fail', 'failSet', 'hits']) {
		const option = make('option', '', C[value]); option.value = value; select.append(option);
		const chip = button(C[value], () => setFilter(value), 'eval-filter-chip'); chip.dataset.filter = value; chip.setAttribute('aria-pressed', String(value === filter)); filterButtons.set(value, chip); filterBar.append(chip);
	}
	select.value = filter;
	const more = button(C.more, () => loadList(false), 'eval-next eval-more'); more.hidden = true;
	sidebar.append(sidebarHead, progress, filterBar, select, status, list, more);
	detail.append(make('p', 'eval-muted', C.choose));
	inspector.append(make('p', 'eval-muted', C.choose));
	root.append(sidebar, detail, inspector);
	const drawer = drawerClient({ sidebar, detail, inspector });

	async function api(path, body) {
		let response;
		try {
			response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		} catch { throw Object.assign(new Error(C.errors.network), { network: true }); }
		let data;
		try { data = await response.json(); } catch { throw Object.assign(new Error(C.errors.network), { network: true, status: response.status }); }
		if (!response.ok) throw Object.assign(new Error(C.errors[data.error] || (response.status === 401 ? C.errors.unauthorized : C.readError)), { status: response.status, code: data.error });
		return data;
	}
	function metricsText(metrics) {
		return C.tools + ' ' + number(metrics?.toolCalls) + ' / ' + number(metrics?.toolErrors) + ' · ' + C.duration + ' ' + (metrics?.durationMs == null ? C.unknown : Math.round(metrics.durationMs / 60000)) + ' · ' + C.cost + ' ' + number(metrics?.costUsd);
	}
	function sessionSignals(row, node) {
		const signals = make('div', 'eval-session-signals');
		signals.append(make('span', 'eval-badge' + badgeTone(row.state), C.activityNames[row.state]));
		if (row.annotation) signals.append(make('span', 'eval-badge' + badgeTone(row.annotation.verdict), labelName(row.annotation)));
		const hits = row.findings.filter((finding) => finding.status === 'hit');
		if (hits.length) signals.append(make('span', 'eval-badge warn', format(C.ruleHitCount, { count: hits.length })));
		if (row.judgment) signals.append(make('span', 'eval-badge info', C.alreadyJudged));
		node.append(signals);
	}
	function renderList() {
		list.replaceChildren();
		const visibleRows = rows.filter((row) => matchesFilter(row, filter));
		for (const row of visibleRows) {
			const node = button('', () => openSession(row.id), 'eval-session' + (selected === row.id ? ' selected' : ''));
			node.dataset.sessionId = row.id; node.dataset.label = row.annotation?.failSet ? 'failSet' : row.annotation?.verdict || 'unlabeled';
			const head = make('span', 'eval-session-head');
			head.append(make('span', '', ''), make('small', 'eval-meta', row.started)); head.firstChild.className = 'eval-label-dot';
			node.append(head, make('strong', '', row.request || (row.unavailable ? C.unavailable : C.noRequest)), make('small', 'eval-meta', metricsText(row.metrics)));
			sessionSignals(row, node);
			if (row.annotation?.progressed) node.append(make('small', 'eval-notice', C.progressed));
			list.append(node);
		}
		if (!visibleRows.length) list.append(make('p', 'eval-muted eval-progress', nextCursor ? C.loading : C.empty));
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
	function setFilter(value) {
		filter = value; select.value = value;
		for (const [name, chip] of filterButtons) chip.setAttribute('aria-pressed', String(name === value));
		void loadList(true);
	}
	async function loadList(reset, recovered = false) {
		const request = ++generation;
		if (reset) { rows = []; nextCursor = null; more.hidden = true; placeholders(); }
		select.disabled = true; more.disabled = true;
		const startedAt = Date.now(); status.textContent = format(C.loadingElapsed, { seconds: 0 });
		const ticker = setInterval(() => { if (request === generation) status.textContent = format(C.loadingElapsed, { seconds: Math.floor((Date.now() - startedAt) / 1000) }); }, 500);
		try {
			let data;
			do {
				data = await api('/api/eval/sessions?filter=' + filter + (nextCursor ? '&cursor=' + encodeURIComponent(nextCursor) : '') + (reset && recovered ? '&refresh=1' : ''));
				if (request !== generation) return;
				rows.push(...data.items); nextCursor = data.nextCursor;
			} while (!rows.length && nextCursor);
			progress.textContent = format(C.labelProgress, data);
			for (const option of select.options) {
				const text = countText(C[option.value], data.counts[option.value]); option.textContent = text; filterButtons.get(option.value).textContent = text;
			}
			const matched = data.matched ?? data.total;
			status.textContent = (recovered ? C.listUpdated + ' · ' : '') + (filter === 'all' ? C.listCount + ' ' + rows.length + ' / ' + data.total : format(C.matchedCount, { matched, loaded: rows.length })) + (data.limited ? ' · ' + C.partial : '') + (data.elapsedMs === undefined ? '' : ' · ' + timingText(data.elapsedMs));
			renderList();
		} catch (error) {
			if (request !== generation) return;
			if (error.status === 409 && !recovered) return loadList(true, true);
			status.textContent = error.message || C.readError;
		} finally { clearInterval(ticker); if (request === generation) { more.disabled = false; select.disabled = false; } }
	}

	const draftRef = { value: null };
	const annotationUi = annotationClient({ make, button, C, format, number, api, labelName, loadList, draftRef, onSaved: afterSaved });
	function afterSaved(id) {
		const next = rows.find((row) => row.id !== id && !row.annotation);
		return openSession(next?.id || id, { notice: C.saved });
	}
	const failed = (data) => data.annotation?.verdict === 'fail' || data.annotation?.failSet === true;
	const replay = replayClient({ make, button, C, format, api, ruleName, openSession, loadList, current: () => selected });
	const judge = judgeClient({ make, button, C, format, number, api, ruleName, openSession, loadList, current: () => selected, polling, models });

	function timeline(data, eventIndex) {
		const box = make('section'); box.id = 'eval-timeline';
		const heading = make('div', 'eval-timeline-head'); heading.append(make('h3', '', C.timeline), make('p', 'eval-muted', C.pageEvents + ' ' + data.timeline.items.length + ' / ' + data.timeline.total)); box.append(heading);
		const spine = make('div', 'eval-spine');
		if (!data.timeline.total) spine.append(make('p', 'eval-muted', C.noEvents));
		for (const event of data.timeline.items) {
			const item = make('article', 'eval-event' + (event.failed ? ' failed' : '') + (event.index === eventIndex ? ' focused' : '')); item.dataset.eventIndex = String(event.index);
			const head = make('div', 'eval-event-head'); head.append(make('strong', event.failed ? 'eval-error' : '', event.kind === 'tool' ? event.name : C[event.kind]), make('small', 'eval-meta', format(C.event, { event: event.index + 1 }))); item.append(head);
			if (event.kind === 'tool') {
				head.insertBefore(make('span', 'eval-badge' + badgeTone(event.outcome), C.outcomes[event.outcome] || C.unknown), head.lastChild);
				if (event.firstError) item.append(make('p', 'eval-error', C.firstError));
				for (const [key, label] of [['args', C.args], ['result', C.result]]) { const folded = make('details'); folded.append(make('summary', '', label), make('pre', '', event[key].text)); if (event[key].truncated) folded.append(make('p', 'eval-muted', C.truncated)); item.append(folded); }
			} else {
				item.append(make('p', 'eval-text', event.content.text));
				if (event.firstError) item.append(make('p', 'eval-error', C.firstError));
				if (event.content.truncated) item.append(make('p', 'eval-muted', C.truncated));
				if (event.kind === 'assistant' && event.entryId && failed(data)) {
					const actions = make('div', 'eval-event-actions'), point = button(C.replayPoint, () => replay.replayPoint(data, event), 'eval-button');
					point.dataset.replayEntry = event.entryId; actions.append(point); item.append(actions);
				}
			}
			spine.append(item);
		}
		box.append(spine);
		if (data.timeline.nextCursor) box.append(button(C.moreEvents, () => openSession(data.id, { cursor: data.timeline.nextCursor }), 'eval-next'));
		return box;
	}
	function summaryItem(label, value, tone = '') {
		const node = make('div', 'eval-summary-item'); node.append(make('strong', tone, value), make('span', '', label)); return node;
	}
	function modelSummary(data) {
		const latest = data.judgment?.latest;
		if (!latest) return C.nothingJudged;
		if (latest.status !== 'ok') return C.judgeStatuses[latest.status] || C.unknown;
		return C[latest.result.suggestedVerdict] + ' · ' + Math.round(latest.result.confidence * 100) + '%';
	}
	function overview(data) {
		const box = make('section', 'eval-overview'); box.id = 'eval-overview';
		const grid = make('div', 'eval-overview-grid');
		for (const [key, label] of [['request', C.request], ['final', C.final]]) {
			const section = make('section'); section.id = 'eval-' + key; section.append(make('h3', '', label), make('p', 'eval-text', data.summary[key].text)); if (data.summary[key].truncated) section.append(make('p', 'eval-muted', C.truncated)); grid.append(section);
		}
		box.append(grid); return box;
	}
	function findings(data) {
		const box = make('section'); box.id = 'eval-rules'; box.append(make('h3', '', C.rules));
		for (const finding of data.findings) {
			const row = make('div', 'eval-rule-row'); row.append(make('span', 'eval-meta', ruleName(finding.rule)), make('span', 'eval-badge' + (finding.status === 'hit' ? ' warn' : finding.status === 'unknown' ? ' info' : ' good'), C.findingNames[finding.status] + ' · ' + finding.count)); box.append(row);
		}
		return box;
	}
	function caseHeader(data) {
		const head = make('header', 'eval-case-header'), text = make('div', 'eval-case-data');
		text.append(make('h2', '', data.summary.request.text || C.noRequest), make('p', 'eval-meta', data.started + ' · ' + data.id));
		const actions = make('div', 'eval-case-actions'), inspect = button(C.openEvaluation, () => drawer.open(inspect), 'eval-button eval-inspector-toggle');
		drawer.bind(inspect); actions.append(inspect); head.append(text, actions); return head;
	}
	function sectionNav() {
		const nav = make('nav', 'eval-section-nav'); nav.setAttribute('aria-label', C.evidenceNav);
		for (const [id, label] of [['eval-overview', C.keyEvidence], ['eval-rules', C.rules], ['eval-timeline', C.timeline]]) nav.append(button(label, () => detail.querySelector('#' + id)?.scrollIntoView({ block: 'start', behavior: 'smooth' })));
		return nav;
	}
	async function openSession(id, options = {}) {
		const request = ++detailGeneration; selected = id; renderList();
		if (!options.cursor && options.eventIndex === undefined) { detail.replaceChildren(make('p', 'eval-muted eval-progress', C.loadingDetail)); inspector.replaceChildren(make('p', 'eval-muted', C.loadingDetail)); }
		try {
			const data = await api('/api/eval/session?id=' + encodeURIComponent(id) + (options.cursor ? '&cursor=' + encodeURIComponent(options.cursor) : '') + (options.eventIndex !== undefined ? '&event=' + options.eventIndex : ''));
			if (request !== detailGeneration) return;
			rows = rows.map((row) => row.id === data.id ? { ...row, annotation: data.annotation, findings: data.findings } : row); renderList();
			const hits = data.findings.filter((finding) => finding.status === 'hit').length;
			const summary = make('div', 'eval-summary');
			summary.append(summaryItem(C.labelState, labelName(data.annotation)), summaryItem(C.modelSuggestion, modelSummary(data)), summaryItem(C.ruleHits, String(hits)), summaryItem(C.toolErrors, number(data.metrics?.toolErrors)), summaryItem(C.activity, C.activityNames[data.state]));
			const content = make('div', 'eval-content');
			if (options.notice) content.append(make('p', 'eval-notice', options.notice));
			content.append(overview(data), findings(data));
			const metric = make('section'); metric.id = 'eval-metrics'; metric.append(make('h3', '', C.metrics), make('p', 'eval-meta', metricsText(data.metrics)), make('p', 'eval-meta', C.tokenCount + ' ' + number(data.metrics?.tokens ? data.metrics.tokens.input + data.metrics.tokens.output : null))); content.append(metric, timeline(data, options.eventIndex));
			detail.replaceChildren(caseHeader(data), summary, sectionNav(), content);
			const annotation = annotationUi.annotationForm(data);
			const inspectorHead = make('div', 'eval-inspector-head'), closeInspector = button(C.close, () => drawer.close(), 'eval-button eval-inspector-close');
			closeInspector.setAttribute('aria-label', C.closeEvaluation); inspectorHead.append(make('h2', '', C.evaluationTitle), make('span', 'eval-badge' + badgeTone(data.state), C.activityNames[data.state]), closeInspector);
			inspector.replaceChildren(inspectorHead, annotation.node, judge.judgePanel(data, annotation));
			const replayPanel = await replay.replayPanel(data.id);
			if (request !== detailGeneration) return;
			inspector.append(replayPanel); drawer.refreshFocus();
			if (options.eventIndex !== undefined) detail.querySelector('[data-event-index="' + options.eventIndex + '"]')?.scrollIntoView({ block: 'center' });
			else if (options.cursor) detail.querySelector('#eval-timeline')?.scrollIntoView({ block: 'start' }); else detail.scrollTop = 0;
		} catch (error) {
			if (request !== detailGeneration) return;
			if (error.status === 409 && !options.recovered) return openSession(id, { recovered: true, notice: C.timelineUpdated });
			detail.replaceChildren(make('p', 'eval-error eval-progress', error.status === 409 ? C.busy : error.message || C.readError)); inspector.replaceChildren();
		}
	}
	function switchEval(value) {
		enabled = value; root.hidden = !value; document.body.classList.toggle('eval-active', value); if (!value) drawer.close(false); tab.setAttribute('aria-pressed', String(value)); tab.classList.toggle('active', value); document.querySelector('.security').textContent = value ? C.security : traceSecurity;
		if (value) { for (const id of ['view-stats', 'view-trace']) { document.getElementById(id).classList.remove('active'); document.getElementById(id).setAttribute('aria-pressed', 'false'); } void loadList(true); }
	}
	for (const id of ['view-stats', 'view-trace']) document.getElementById(id).addEventListener('click', () => switchEval(false));
	select.onchange = () => setFilter(select.value);
	document.getElementById('refresh').addEventListener('click', (event) => { if (enabled) { event.stopImmediatePropagation(); void loadList(true); if (selected) void openSession(selected); } }, true);
}
export const evalScript = '(' + evalClient.toString() + ')(' + JSON.stringify(COPY) + ', ' + matchesSessionFilter.toString() + ', ' + annotationClient.toString() + ', ' + judgeClient.toString() + ', ' + replayClient.toString() + ', ' + drawerClient.toString() + ');';
