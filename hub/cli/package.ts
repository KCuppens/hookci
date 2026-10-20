import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "zeroci-hub";

interface PackageJson {
	name?: string;
	version?: string;
}

function readPackageJson(dir: string): PackageJson | null {
	const path = join(dir, "package.json");
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

/**
 * The zeroci-hub package root, found by walking up from this module to the
 * package.json named zeroci-hub. Works from both cli/ (tests) and dist/cli/
 * (the installed package), which sit at different depths.
 */
export function packageRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		if (readPackageJson(dir)?.name === PACKAGE_NAME) return dir;
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`no ${PACKAGE_NAME} package.json above ${fileURLToPath(import.meta.url)}`);
		dir = parent;
	}
}

export function packageVersion(): string {
	const version = readPackageJson(packageRoot())?.version;
	if (!version) throw new Error(`${PACKAGE_NAME} package.json has no version`);
	return version;
}
