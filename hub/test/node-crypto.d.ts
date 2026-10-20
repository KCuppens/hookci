// The parts of Node's crypto and buffer modules (served by nodejs_compat)
// that tests use; the hub tsconfig has Workers types, not @types/node.
declare module "node:crypto" {
	interface Hmac {
		update(data: string): Hmac;
		digest(encoding: "hex"): string;
	}
	export function createHmac(algorithm: "sha256", key: string): Hmac;
	export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module "node:buffer" {
	export const Buffer: { from(s: string): Uint8Array };
}
