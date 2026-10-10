/** Process-local child handles only. A fault cannot release a lease or certify
 * closure; the child's existing close/group observers still own that evidence. */
export function createRunnerDrain() {
	const children = new Set<{ stop(): void; closed: Promise<void> }>();
	let draining = false;
	let pending: Promise<void> | undefined;
	return {
		assertOpen(): void {
			if (draining) throw new Error("Runner is draining; no new writer may start.");
		},
		track(stop: () => void): () => void {
			if (draining) throw new Error("Runner is draining; no new writer may start.");
			let resolve!: () => void;
			const child = { stop, closed: new Promise<void>(done => { resolve = done; }) };
			children.add(child);
			return () => { children.delete(child); resolve(); };
		},
		drain(): Promise<void> {
			if (pending) return pending;
			draining = true;
			const active = [...children];
			pending = Promise.all(active.map(child => child.closed)).then(() => {});
			for (const child of active) {
				try { child.stop(); } catch { /* Still wait for the actual observer. */ }
			}
			return pending;
		},
	};
}
