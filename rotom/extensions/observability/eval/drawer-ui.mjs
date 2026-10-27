// Accessible narrow-screen evaluation drawer. Kept separate so the main
// workbench module stays below the repository's per-file review limit.
export function drawerClient(ctx) {
	const { sidebar, detail, inspector } = ctx;
	const narrow = matchMedia('(max-width: 900px)');
	let trigger = null;
	function backgroundInert(value) {
		for (const node of [sidebar, detail, document.querySelector('.topbar'), document.querySelector('.app-footer')]) {
			if (!node) continue;
			if (value) node.setAttribute('inert', ''); else node.removeAttribute('inert');
		}
	}
	function setOpen(value, nextTrigger, restoreFocus = true) {
		if (!narrow.matches) value = false;
		if (value && nextTrigger) trigger = nextTrigger;
		document.body.classList.toggle('eval-inspector-open', value);
		for (const control of document.querySelectorAll('.eval-inspector-toggle')) control.setAttribute('aria-expanded', String(value));
		if (narrow.matches) {
			if (value) inspector.removeAttribute('inert'); else inspector.setAttribute('inert', '');
			inspector.setAttribute('aria-hidden', String(!value)); backgroundInert(value);
		} else { inspector.removeAttribute('inert'); inspector.setAttribute('aria-hidden', 'false'); backgroundInert(false); }
		if (value) requestAnimationFrame(() => inspector.querySelector('.eval-inspector-close')?.focus());
		else if (restoreFocus && trigger?.isConnected) trigger.focus();
	}
	function bind(control) {
		const open = document.body.classList.contains('eval-inspector-open');
		control.setAttribute('aria-controls', inspector.id); control.setAttribute('aria-expanded', String(open)); if (open) trigger = control;
	}
	function sync() { setOpen(false, null, false); }
	sync(); narrow.addEventListener('change', sync);
	document.addEventListener('keydown', (event) => {
		if (!document.body.classList.contains('eval-inspector-open')) return;
		if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
		if (event.key !== 'Tab') return;
		const focusable = [...inspector.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex="-1"])')].filter((node) => node.checkVisibility());
		if (!focusable.length) { event.preventDefault(); inspector.focus(); return; }
		const first = focusable[0], last = focusable.at(-1);
		if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
		else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
	});
	const refreshFocus = () => { if (document.body.classList.contains('eval-inspector-open')) requestAnimationFrame(() => inspector.querySelector('.eval-inspector-close')?.focus()); };
	return { open: (control) => setOpen(true, control), close: (restore = true) => setOpen(false, null, restore), bind, refreshFocus };
}
