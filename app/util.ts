export default function debounce<T extends Function>(func: T, wait: number, immediate?: boolean) {
	let timeout: any;

	const f = function (...args: any[]) {
		return new Promise((resolve) => {
			clearTimeout(timeout);
			timeout = setTimeout(() => {
				timeout = null;
				if (!immediate) {
					// @ts-ignore
					Promise.resolve(func.apply(this, [...args])).then(resolve);
				}
			}, wait);
			if (immediate && !timeout) {
				// @ts-ignore
				Promise.resolve(func.apply(this, [...args])).then(resolve);
			}
		});
	} as any;

	f.immediate = func;

	return f as T & { immediate: T };
}
