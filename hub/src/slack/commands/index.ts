// Every /zeroci subcommand module, imported for its registerCommand call by
// the Worker entry and by SlackWorkspaceDO, which runs the handlers.

import "../sink-command";
import "./bind";
import "./help";
import "./me";
import "./privacy";
import "./retry";
import "./status";
import "./unwatch";
import "./watch";
