import { THEME_SCRIPT } from "../../src/pages/shell";

/** The page with the shared Light/Dark script removed, so a test can assert it carries no page script of its own. */
export function withoutThemeScript(html: string): string {
	return html.replace(`<script>${THEME_SCRIPT}</script>`, "");
}
