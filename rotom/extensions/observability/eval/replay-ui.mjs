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
		let state = { cases: [] };
		const render = async () => {
			try { state = await api('/api/eval/replay/cases'); } catch (error) { message.textContent = error.message || C.replayError; return; }
			list.replaceChildren();
			if (!state.cases.length) list.append(make('p', 'eval-muted', C.replayEmpty));
			for (const item of state.cases) {
				const latest = item.latest, node = make('article', 'eval-session');
				node.append(make('strong', '', item.sessionId + ' · ' + item.cutEntryId.slice(0, 8)), make('p', 'eval-text', item.expected),
					make('p', 'eval-meta', latest ? (C[latest.verdict] || latest.verdict) + ' · ' + latest.arm + ' · ' + latest.startedAt : C.replayNeverRun),
					latest?.reason ? make('p', 'eval-muted', latest.reason) : make('span', ''));
				node.append(button(C.replayDelete, async () => { await api('/api/eval/replay/case/delete', { sessionId: item.sessionId, cutEntryId: item.cutEntryId }); await render(); }, 'eval-next'));
				list.append(node);
			}
			const runBox = make('div', 'eval-form');
			const model = make('input'); model.setAttribute('aria-label', C.replayModel); model.placeholder = 'provider/model';
			const repeats = make('input'); repeats.type = 'number'; repeats.min = '1'; repeats.max = '3'; repeats.value = '1'; repeats.setAttribute('aria-label', C.replayRepeats);
			const baseline = make('input'); baseline.type = 'checkbox'; baseline.id = 'eval-replay-baseline';
			const baselineLabel = make('label', '', C.replayBaseline); baselineLabel.htmlFor = 'eval-replay-baseline';
			const run = button(C.replayRun, async () => {
				const chosen = state.cases.filter((item) => item.selected !== false).map((item) => item.key);
				const runs = chosen.length * Number(repeats.value || 1) * (baseline.checked ? 2 : 1);
				const accepted = await confirmReplay({ cases: chosen.length, runs, model: model.value, repeats: repeats.value, baseline: baseline.checked });
				if (!accepted) return;
				run.disabled = true;
				try {
					const started = await api('/api/eval/replay/run', { cases: chosen, model: model.value, repeats: Number(repeats.value || 1), includeBaseline: baseline.checked });
					while (true) {
						await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
						const status = await api('/api/eval/replay/status?runId=' + encodeURIComponent(started.runId));
						progressNotice.textContent = format(C.replayProgress, { done: status.done, total: status.total });
						if (status.status !== 'running') { progressNotice.textContent = C[status.status === 'done' ? 'replayDone' : 'replayStopped'] + ' · ' + format(C.replayProgress, { done: status.done, total: status.total }); break; }
					}
				} catch (error) { progressNotice.textContent = error.message || C.replayError; }
				run.disabled = false;
				await render();
			}, 'eval-primary');
			runBox.append(model, repeats, baseline, baselineLabel, run, progressNotice);
			list.append(runBox);
		};
		await render();
		return box;
	}
	function confirmReplay({ cases, runs, model, repeats, baseline }) {
		return new Promise((resolve) => {
			const dialog = make('dialog', 'eval-dialog'); dialog.setAttribute('aria-label', C.replayConfirmTitle);
			dialog.append(make('h2', '', C.replayConfirmTitle), make('p', 'eval-text', format(C.replayConfirmDetails, { cases, runs, model: model || C.unknown, repeats, baseline: baseline ? C.yes : C.no })), make('p', '', C.consent), button(C.cancel, () => dialog.close()), button(C.replayConfirm, () => dialog.close('confirm'), 'eval-primary'));
			dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'confirm'; dialog.remove(); resolve(accepted); }, { once: true });
			document.body.append(dialog); dialog.showModal();
		});
	}
	return { replayPoint, replayPanel };
}
