// Agents send x-hookci-* headers; agents installed as ZeroCI still send x-zeroci-*.

/** The value of the x-hookci-<name> header, else of the legacy x-zeroci-<name>. */
export function wireHeader(headers: Headers, name: string): string | null {
	return headers.get(`x-hookci-${name}`) ?? headers.get(`x-zeroci-${name}`);
}
