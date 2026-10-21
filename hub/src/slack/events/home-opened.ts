import { publishHome } from "../home";
import { registerEvent } from "../registry";

// Slack sends app_home_opened for the Messages tab too; only the Home tab is drawn.
registerEvent("app_home_opened", async (env, teamId, event) => {
	if (event.tab !== "home" || typeof event.user !== "string") return;
	await publishHome(env, teamId, event.user);
});
