// The Retry button on a failed deploy badge; the work is handleDeployRetry.

import { RETRY_ACTION } from "../../deploy/render";
import { handleDeployRetry } from "../../deploy/retry";
import { registerAction } from "../registry";

registerAction(RETRY_ACTION, ({ env, teamId, userId, value }) => handleDeployRetry(env, { teamId, userId, value }));
