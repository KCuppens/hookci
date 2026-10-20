// /zeroci help, a bare /zeroci and unknown subcommands: one line per command.

import { S } from "../../strings";
import { type CommandHandler, registerCommand } from "../registry";
import { ephemeral } from "./common";

const help: CommandHandler = async () => ephemeral(S.slack.help);

registerCommand("help", help);
registerCommand("", help);
