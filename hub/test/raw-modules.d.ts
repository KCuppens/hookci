// Vite's ?raw suffix imports a file as its text.
declare module "*?raw" {
	const text: string;
	export default text;
}
