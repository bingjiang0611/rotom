// A scoped dispatch adapter, not cancellation. Already-dispatched effects may
// finish after retirement. Cleanup listeners remain removable after retirement.
export function operationChrome(api, assertOperation) {
	const scoped = {};
	for (const name of ["debugger", "tabs", "windows", "tabGroups"]) {
		scoped[name] = new Proxy(api[name], {
			get(target, key) {
				const value = target[key];
				if (typeof value !== "function") return value;
				return (...args) => {
					assertOperation();
					return Promise.resolve(value.apply(target, args)).then((result) => { assertOperation(); return result; });
				};
			},
		});
	}
	return scoped;
}
