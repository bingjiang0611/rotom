// Replay panel for the eval page. Split out of ui.mjs to keep files small; the
// browser script concatenates both functions, so dependencies arrive through ctx.
export function replayClient(ctx) {
	const { make, button, C, format, api, ruleName, openSession, loadList } = ctx;
	function replayPoint(data, event) {
		const dialog = make('dialog', 'eval-dialog'); dialog.setAttribute('aria-label', C.replayPoint);
		const expected = make('textarea'); expected.rows = 3; expected.setAttribute('aria-label', C.replayExpected); expected.placeholder = C.replayExpectedHint;
		const mode = make('select'); mode.setAttribute('aria-label', C.replayCheck);
		for (const value of ['rule', 'model']) { const option = make('option', '', C.replayModes[value]); option.value = value; mode.append(option); }
		const rule = make('select'); rule.setAttribute('aria-label', C.replayRule);
		for (const value of C.replayRules) { const option = make('option', '', ruleName(value)); option.value = value; rule.append(option); }
		const message = make('p', 'eval-muted');
		mode.onchange = () => { rule.hidden = mode.value !== 'rule'; };
		const save = button(C.replaySave, async () => {
			save.disabled = true;
			try { await api('/api/eval/replay/case', { sessionId: data.id, cutEntryId: event.entryId, expected: expected.value, check: mode.value === 'rule' ? { mode: 'rule', rule: rule.value } : { mode: 'model' } }); dialog.close('saved'); }
			catch (error) { message.textContent = error.message || C.replayError; save.disabled = false; }
		}, 'eval-primary');
		dialog.append(make('h2', '', C.replayPoint), make('p', 'eval-muted', C.replayPointHint), expected, mode, rule, message, button(C.cancel, () => dialog.close()), save);
		dialog.addEventListener('close', async () => { const saved = dialog.returnValue === 'saved'; dialog.remove(); if (saved) { await loadList(true); if (ctx.current()) await openSession(ctx.current(), { notice: C.replaySaved }); } }, { once: true });
		document.body.append(dialog); dialog.showModal();
	}
	function markReplayPoints(cases, sessionId) {
		const pinned = new Set(cases.filter((item) => item.sessionId === sessionId).map((item) => item.cutEntryId));
		for (const control of document.querySelectorAll('[data-replay-entry]')) {
			const active = pinned.has(control.dataset.replayEntry);
			control.disabled = active; control.textContent = active ? C.replayPinned : C.replayPoint;
			control.classList.toggle('eval-replay-pinned', active); control.closest('.eval-event')?.classList.toggle('replay-pinned', active);
		}
	}
	function replayCase(item, onDelete) {
		const latest = item.latest, arms = item.arms || {}, node = make('article', 'eval-replay-case');
		node.append(make('strong', '', item.sessionId + ' · ' + item.cutEntryId.slice(0, 8)), make('p', 'eval-text', item.expected), make('p', 'eval-meta', latest ? C.replayRanAt + ' ' + latest.startedAt : C.replayNeverRun));
		const columns = make('div', 'eval-arms');
		for (const name of ['original', 'candidate', 'baseline']) {
			if (name === 'baseline' && !arms.baseline) continue;
			const row = arms[name], arm = make('div', 'eval-arm');
			const version = row?.judgePromptVersion ? ' · ' + format(C.replayJudgeVersion, { version: String(row.judgePromptVersion).split('/').pop() }) : '';
			arm.append(make('strong', '', C.replayArmNames[name]), make('span', '', (row ? (C[row.verdict] || row.verdict) : C.replayNeverRun) + version)); columns.append(arm);
		}
		node.append(columns);
		const labels = { caught: C.replayCaught, 'still-failing': C.replayStillFailing, 'judge-blind': C.replayJudgeBlind, unknown: C.replayLabelUnknown };
		if (arms.original || latest) node.append(make('p', arms.conclusion === 'judge-blind' || item.conclusion === 'judge-blind' ? 'eval-notice' : 'eval-text', C.replayConclusion + ' ' + (labels[item.conclusion] || labels.unknown)));
		if (latest?.reason) node.append(make('p', 'eval-muted', latest.reason));
		if (latest?.sameProduct === true) node.append(make('p', 'eval-notice', C.replaySameProduct));
		node.append(button(C.replayDelete, async () => { await api('/api/eval/replay/case/delete', { sessionId: item.sessionId, cutEntryId: item.cutEntryId }); await onDelete(); }, 'eval-next'));
		return node;
	}
	async function replayPanel(sessionId) {
		const box = make('section'); box.id = 'eval-replay';
		const message = make('p', 'eval-muted'), list = make('div'), progressNotice = make('p', 'eval-notice'), runResults = make('div', 'eval-replay-results');
		box.append(make('h3', '', C.replay), message, list);
		let state = { cases: [] }, activeRun = null;
		const render = async () => {
			try { state = await api('/api/eval/replay/cases'); } catch (error) { message.textContent = error.message || C.replayError; return; }
			list.replaceChildren(); markReplayPoints(state.cases, sessionId);
			const currentCases = state.cases.filter((item) => item.sessionId === sessionId), otherCases = state.cases.filter((item) => item.sessionId !== sessionId);
			const currentBox = make('div', 'eval-replay-current'); currentBox.append(make('p', 'eval-meta', C.currentReplayPoints));
			if (!currentCases.length) currentBox.append(make('p', 'eval-muted', C.replayEmpty));
			for (const item of currentCases) currentBox.append(replayCase(item, render));
			list.append(currentBox);
			if (otherCases.length) {
				const others = make('details', 'eval-replay-other'); others.append(make('summary', '', format(C.otherReplayPoints, { count: otherCases.length })));
				for (const item of otherCases) others.append(replayCase(item, render)); list.append(others);
			}
			const runBox = make('div', 'eval-replay-run');
			const fields = make('div', 'eval-replay-run-grid');
			const model = make('input'); model.setAttribute('aria-label', C.replayModel); model.placeholder = C.replayModelPlaceholder;
			const repeats = make('input'); repeats.type = 'number'; repeats.min = '1'; repeats.max = '3'; repeats.value = '1'; repeats.setAttribute('aria-label', C.replayRepeats);
			fields.append(model, repeats);
			const baseline = make('input'); baseline.type = 'checkbox'; baseline.id = 'eval-replay-baseline';
			const baselineLabel = make('label', '', C.replayBaseline); baselineLabel.htmlFor = 'eval-replay-baseline'; baselineLabel.prepend(baseline);
			const baselineAvailable = state.baseline?.enabled === true; baseline.hidden = baselineLabel.hidden = !baselineAvailable;
			const baselineNote = make('p', 'eval-muted', C.replayBaselineMissing); baselineNote.hidden = baselineAvailable;
			const cancel = button(C.replayCancel, async () => { cancel.disabled = true; if (activeRun) { try { await api('/api/eval/replay/cancel', { runId: activeRun }); } catch { progressNotice.textContent = C.replayError; } } }); cancel.hidden = true;
			const run = button(C.replayRun, async () => {
				const chosen = state.cases.filter((item) => item.selected !== false).map((item) => item.key), includeBaseline = baselineAvailable && baseline.checked;
				run.disabled = true; progressNotice.textContent = C.replayPreparing;
				let plan;
				try { plan = await api('/api/eval/replay/prepare', { cases: chosen, repeats: Number(repeats.value || 1), includeBaseline }); }
				catch (error) { progressNotice.textContent = error.message || C.replayError; run.disabled = false; return; }
				progressNotice.textContent = ''; run.disabled = false;
				if (!await confirmReplay({ plan, cases: chosen.length, model: model.value, repeats: plan.repeats, baseline: includeBaseline })) return;
				run.disabled = true; cancel.disabled = false; cancel.hidden = false;
				try {
					const started = await api('/api/eval/replay/run', { cases: chosen, model: model.value, repeats: plan.repeats, includeBaseline }); activeRun = started.runId;
					while (true) {
						await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
						const status = await api('/api/eval/replay/status?runId=' + encodeURIComponent(started.runId)); progressNotice.textContent = format(C.replayProgress, { done: status.done, total: status.total });
						if (status.status !== 'running') {
							progressNotice.textContent = C[status.status === 'done' ? 'replayDone' : 'replayStopped'] + ' · ' + format(C.replayProgress, { done: status.done, total: status.total });
							if (status.warnings?.includes('baseline_product_matches_candidate')) progressNotice.textContent += ' · ' + C.replaySameProduct;
							if (status.error) progressNotice.textContent += ' · ' + String(status.error).slice(0, 300);
							const totals = usageTotals(status.results || []); runResults.replaceChildren();
							if (totals.known) runResults.append(make('p', 'eval-text', format(C.replayUsage, { input: tokens(totals.input), output: tokens(totals.output), total: tokens(totals.input + totals.output) }))); else runResults.append(make('p', 'eval-muted', C.replayUsageUnknown));
							for (const row of status.conclusions || []) { const label = { caught: C.replayCaught, 'still-failing': C.replayStillFailing, 'judge-blind': C.replayJudgeBlind, unknown: C.replayLabelUnknown }[row.conclusion] || C.replayLabelUnknown; runResults.append(make('p', 'eval-meta', row.key.slice(-8).replace(/^-/u, '') + ' · ' + label)); }
							if ((status.conclusions || []).some((row) => row.conclusion === 'judge-blind')) runResults.append(make('p', 'eval-notice', C.replayJudgeBlindHint));
							break;
						}
					}
				} catch (error) { progressNotice.textContent = error.message || C.replayError; }
				activeRun = null; cancel.hidden = true; run.disabled = false; await render();
			}, 'eval-primary');
			const actions = make('div', 'eval-replay-actions'); actions.append(run, cancel);
			runBox.append(fields, baseline, baselineLabel, baselineNote, actions, progressNotice, runResults); list.append(runBox);
		};
		await render(); return box;
	}
	const tokens = (value) => Math.round(value).toLocaleString('en-US');
	function usageTotals(results) {
		let known = false, input = 0, output = 0;
		for (const row of results) { const usage = row && row.usage; if (!usage || (usage.input === null && usage.output === null)) continue; known = true; input += usage.input || 0; output += usage.output || 0; }
		return { known, input, output };
	}
	function confirmReplay({ plan, cases, model, repeats, baseline }) {
		const number = (value) => new Intl.NumberFormat('zh-CN').format(value ?? 0);
		return new Promise((resolve) => {
			const dialog = make('dialog', 'eval-dialog'); dialog.setAttribute('aria-label', C.replayConfirmTitle);
			const redactionLine = plan.modelCases > 0 && plan.redactionTotal > 0 ? [make('p', 'eval-text', format(C.replayPlanRedactions, { total: number(plan.redactionTotal), detail: plan.redactions.map((entry) => entry.type + ' ' + number(entry.count)).join('、') }))] : [];
			dialog.append(make('h2', '', C.replayConfirmTitle), make('p', 'eval-text', format(C.replayConfirmDetails, { cases, runs: plan.runs, model: model || C.unknown, repeats, baseline: baseline ? C.yes : C.no })), make('p', 'eval-text', format(C.replayPlanRuns, { runs: number(plan.runs), cases, repeats, arms: plan.arms, original: number(plan.originalRuns) })), make('p', 'eval-text', format(C.replayPlanChars, { cases: number(plan.cases.length), chars: number(plan.perCaseChars), max: number(plan.maxChars), total: number(plan.totalChars) })), make('p', 'eval-muted', format(C.replayPlanOriginalChars, { counts: number(plan.originalRuns), chars: number(plan.originalChars) })), ...redactionLine, make('p', '', C.consent), button(C.cancel, () => dialog.close()), button(C.replayConfirm, () => dialog.close('confirm'), 'eval-primary'));
			dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'confirm'; dialog.remove(); resolve(accepted); }, { once: true }); document.body.append(dialog); dialog.showModal();
		});
	}
	return { replayPoint, replayPanel };
}
