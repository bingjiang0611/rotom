// Judge panel for the eval page. Split out of ui.mjs to keep files small; the
// browser script concatenates both functions, so dependencies arrive through ctx.
export function judgeClient(ctx) {
	const { make, button, C, format, number, api, ruleName, openSession, loadList, current, polling } = ctx;
	function confirmJudge(prepared) {
		return new Promise((resolve) => {
			const dialog = make('dialog', 'eval-dialog'); dialog.setAttribute('aria-label', C.confirmTitle);
			const redactions = prepared.redactions ?? [], total = redactions.reduce((sum, entry) => sum + entry.count, 0);
			dialog.append(make('h2', '', C.confirmTitle), make('p', 'eval-text', format(C.confirmDetails, { model: prepared.model, count: prepared.inputChars, truncated: prepared.truncated ? C.yes : C.no })), ...(total ? [make('p', 'eval-meta', format(C.redacted, { count: total, types: redactions.map((entry) => entry.type).join('、') }))] : []), make('p', '', C.consent), button(C.cancel, () => dialog.close()), button(C.confirmJudge, () => dialog.close('confirm'), 'eval-primary'));
			dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'confirm'; dialog.remove(); resolve(accepted); }, { once: true });
			document.body.append(dialog); dialog.showModal();
		});
	}
	async function pollJudge(job, message, cancel) {
		if (ctx.polling.value === job.runId) return;
		ctx.polling.value = job.runId;
		try {
			let state;
			do { await new Promise((resolve) => setTimeout(resolve, 1000)); state = await api('/api/eval/judge/status?runId=' + encodeURIComponent(job.runId)); } while (state.status === 'running');
			cancel.disabled = true;
			if (state.error) { message.textContent = C.errors[state.error] || C.judgeStatusUnknown; return; }
			if (ctx.current() === job.sessionId) await openSession(job.sessionId);
			await loadList(true);
		} catch { message.textContent = C.judgeStatusUnknown; }
		finally { ctx.polling.value = null; }
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
				if (ctx.current() !== data.id || !box.isConnected) return;
				if (!await confirmJudge(prepared)) { analyze.disabled = false; message.textContent = ''; return; }
				try { running(await api('/api/eval/judge', { confirmationId: prepared.confirmationId })); }
				catch (error) { message.textContent = !error.status || error.status >= 500 ? C.judgeStartUnknown : error.message; if (error.status && error.status < 500) analyze.disabled = false; }
			} catch (error) { message.textContent = error.message || C.readError; analyze.disabled = false; }
		}
		function readModels() {
			diagnostic.hidden = true; retryModels.hidden = retryModels.disabled = true; model.disabled = analyze.disabled = true;
			model.replaceChildren(make('option', '', C.modelsLoading)); message.textContent = '';
			if (!ctx.models.value) ctx.models.value = api('/api/eval/models').catch((error) => { ctx.models.value = undefined; throw error; });
			ctx.models.value.then((catalog) => {
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
	return { judgePanel, pollJudge };
}
