export default function debounce<T extends Function>(func: T, wait: number, immediate?: boolean): T {
	let timeout: any;

	return function (...args: any[]) {
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
}
