// Wrangler's Text rule imports *.sh, *.css and the viewer's script as their contents.
// The script's rule glob is **/*viewer.js so it also matches the hashed name prepack gives it in dist/worker.
declare module "*.sh" {
	const text: string;
	export default text;
}

declare module "*.css" {
	const text: string;
	export default text;
}

declare module "*/static/viewer.js" {
	const text: string;
	export default text;
}
