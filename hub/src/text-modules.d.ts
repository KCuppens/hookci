// Wrangler's Text rule imports *.sh files as their contents.
declare module "*.sh" {
	const text: string;
	export default text;
}
