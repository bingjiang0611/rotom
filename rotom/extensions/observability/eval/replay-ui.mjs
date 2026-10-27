// Replay panel for the eval page. Split out of ui.mjs to keep files small; the
// browser script concatenates both functions, so dependencies arrive through ctx.
export function replayClient(ctx) {
	const { make, button, C, format, api, ruleName, openSession, loadList, current } = ctx;
	function replayPoint(data, event) {
		const dialog = make('dialog', 'eval-dialog'); dialog.setAttribute('aria-label', C.replayPoint);
		const expected = make('textarea'); expected.rows = 3; expected.setAttribute('aria-label', C.replayExpected); expected.placeholder = C.replayExpectedHint;
		const mode = make('select'); mode.setAttribute('aria-label', C.replayCheck);
		for (const value of ['rule', 'model']) { const option = make('option', '', C.replayModes[value]); option.value = value; mode.append(option); }
		const rule = make('select'); rule.setAttribute('aria-label', C.replayRule);
		for (const value of C.replayRules) { const option = make('option', '', ruleName(value)); option.value = value; rule.append(option); }
		const message = make('p', 'eval-muted');
		mode.onchange = () => { rule.hidden = mode.value !== 'rule'; };
		const save = button(C.replaySave, async () => { save.disabled = true; try { await api('/api/eval/replay/case', { sessionId: data.id, cutEntryId: event.entryId, expected: expected.value, check: mode.value === 'rule' ? { mode: 'rule', rule: rule.value } : { mode: 'model' } }); dialog.close('saved'); } catch (error) { message.textContent = error.message || C.replayError; save.disabled = false; } }, 'eval-primary');
		dialog.append(make('h2', '', C.replayPoint), make('p', 'eval-muted', C.replayPointHint), expected, mode, rule, message, button(C.cancel, () => dialog.close()), save);
		dialog.addEventListener('close', async () => { const saved = dialog.returnValue === 'saved'; dialog.remove(); if (saved) { await loadList(true); if (ctx.current()) await openSession(ctx.current(), { notice: C.replaySaved }); } }, { once: true });
		document.body.append(dialog); dialog.showModal();
	}
	async function replayPanel() {
		const box = make('section'); box.id = 'eval-replay';
		const message = make('p', 'eval-muted'), list = make('div'), progressNotice = make('p', 'eval-notice');
		box.append(make('h3', '', C.replay), message, list);
		let state = { cases: [] }, activeRun = null;
		const render = async () => {
			try { state = await api('/api/eval/replay/cases'); } catch (error) { message.textContent = error.message || C.replayError; return; }
			list.replaceChildren();
			if (!state.cases.length) list.append(make('p', 'eval-muted', C.replayEmpty));
			for (const item of state.cases) {
				const latest = item.latest, node = make('article', 'eval-session');
				node.append(make('strong', '', item.sessionId + ' · ' + item.cutEntryId.slice(0, 8)), make('p', 'eval-text', item.expected),
					make('p', 'eval-meta', latest ? (C[latest.verdict] || latest.verdict) + ' · ' + latest.arm + ' · ' + latest.startedAt : C.replayNeverRun),
					latest?.reason ? make('p', 'eval-muted', latest.reason) : make('span', ''));
				// Two arms that load the same product cannot show a difference.
				if (latest?.sameProduct === true) node.append(make('p', 'eval-notice', C.replaySameProduct));
				node.append(button(C.replayDelete, async () => { await api('/api/eval/replay/case/delete', { sessionId: item.sessionId, cutEntryId: item.cutEntryId }); await render(); }, 'eval-next'));
				list.append(node);
			}
			const runBox = make('div', 'eval-form');
			const model = make('input'); model.setAttribute('aria-label', C.replayModel); model.placeholder = 'provider/model';
			const repeats = make('input'); repeats.type = 'number'; repeats.min = '1'; repeats.max = '3'; repeats.value = '1'; repeats.setAttribute('aria-label', C.replayRepeats);
			const baseline = make('input'); baseline.type = 'checkbox'; baseline.id = 'eval-replay-baseline';
			const baselineLabel = make('label', '', C.replayBaseline); baselineLabel.htmlFor = 'eval-replay-baseline';
			// No configured comparison product, no checkbox: the server refuses it too.
			const baselineAvailable = state.baseline?.enabled === true;
			baseline.hidden = baselineLabel.hidden = !baselineAvailable;
			const cancel = button(C.replayCancel, async () => { cancel.disabled = true; if (activeRun) { try { await api('/api/eval/replay/cancel', { runId: activeRun }); } catch { progressNotice.textContent = C.replayError; } } });
			cancel.hidden = true;
			const baselineNote = make('p', 'eval-muted', C.replayBaselineMissing);
			baselineNote.hidden = baselineAvailable;
			const run = button(C.replayRun, async () => {
				const chosen = state.cases.filter((item) => item.selected !== false).map((item) => item.key);
				const includeBaseline = baselineAvailable && baseline.checked;
				// Measure first: the dialog states how much context and how many runs
				// this spends, computed server-side from the redacted prefix.
				run.disabled = true; progressNotice.textContent = C.replayPreparing;
				let plan;
				try { plan = await api('/api/eval/replay/prepare', { cases: chosen, repeats: Number(repeats.value || 1), includeBaseline }); }
				catch (error) { progressNotice.textContent = error.message || C.replayError; run.disabled = false; return; }
				progressNotice.textContent = '';
				run.disabled = false;
				const accepted = await confirmReplay({ plan, cases: chosen.length, model: model.value, repeats: plan.repeats, baseline: includeBaseline });
				if (!accepted) return;
				run.disabled = true; cancel.disabled = false; cancel.hidden = false;
				try {
					const started = await api('/api/eval/replay/run', { cases: chosen, model: model.value, repeats: plan.repeats, includeBaseline });
					activeRun = started.runId;
					while (true) {
						await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
						const status = await api('/api/eval/replay/status?runId=' + encodeURIComponent(started.runId));
						progressNotice.textContent = format(C.replayProgress, { done: status.done, total: status.total });
						if (status.status !== 'running') {
							progressNotice.textContent = C[status.status === 'done' ? 'replayDone' : 'replayStopped'] + ' · ' + format(C.replayProgress, { done: status.done, total: status.total });
							if (status.warnings?.includes('baseline_product_matches_candidate')) progressNotice.textContent += ' · ' + C.replaySameProduct;
							break;
						}
					}
				} catch (error) { progressNotice.textContent = error.message || C.replayError; }
				activeRun = null; cancel.hidden = true;
				run.disabled = false;
				await render();
			}, 'eval-primary');
			runBox.append(model, repeats, baseline, baselineLabel, baselineNote, run, cancel, progressNotice);
			list.append(runBox);
		};
		await render();
		return box;
	}
	function confirmReplay({ plan, cases, model, repeats, baseline }) {
		const number = (value) => new Intl.NumberFormat('zh-CN').format(value ?? 0);
		const perCaseChars = plan.cases.reduce((total, item) => total + item.chars, 0);
		return new Promise((resolve) => {
			const dialog = make('dialog', 'eval-dialog'); dialog.setAttribute('aria-label', C.replayConfirmTitle);
			// Model points also send their prefix to a judge, so the masked-credential
			// count is stated separately instead of being folded into the total.
			const redactionLine = plan.modelCases > 0 && plan.redactionTotal > 0
				? [make('p', 'eval-text', format(C.replayPlanRedactions, { total: number(plan.redactionTotal), detail: plan.redactions.map((entry) => entry.type + ' ' + number(entry.count)).join('、') }))]
				: [];
			dialog.append(make('h2', '', C.replayConfirmTitle),
				make('p', 'eval-text', format(C.replayConfirmDetails, { cases, runs: plan.runs, model: model || C.unknown, repeats, baseline: baseline ? C.yes : C.no })),
				make('p', 'eval-text', format(C.replayPlanRuns, { runs: number(plan.runs), cases, repeats, arms: plan.arms })),
				make('p', 'eval-text', format(C.replayPlanChars, { chars: number(perCaseChars), total: number(plan.totalChars) })),
				...redactionLine,
				make('p', '', C.consent), button(C.cancel, () => dialog.close()), button(C.replayConfirm, () => dialog.close('confirm'), 'eval-primary'));
			dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'confirm'; dialog.remove(); resolve(accepted); }, { once: true });
			document.body.append(dialog); dialog.showModal();
		});
	}
	return { replayPoint, replayPanel };
}
