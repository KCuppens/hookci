// Wrangler's Text rule imports *.sh and *.css files as their contents.
declare module "*.sh" {
	const text: string;
	export default text;
}

declare module "*.css" {
	const text: string;
	export default text;
}
