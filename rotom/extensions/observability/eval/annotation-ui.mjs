// Annotation form for the eval page. Split out of ui.mjs to keep files small;
// the browser script concatenates the functions, so dependencies arrive through ctx.
export function annotationClient(ctx) {
	const { make, button, C, format, number, api, labelName, loadList, draftRef } = ctx;
	function annotationForm(data) {
		if (draftRef.value?.sessionId !== data.id || !draftRef.value.dirty) draftRef.value = { sessionId: data.id, verdict: data.annotation?.verdict || null, note: data.annotation?.note || '', failSet: !!data.annotation?.failSet, dirty: false };
		const currentDraft = draftRef.value;
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
	return { annotationForm };
}
