import { Command, Option } from "clipanion";

import { BaseCommand } from "../shared.js";

export class FallbackCommand extends BaseCommand {
	public static paths = [Command.Default];

	public commandName = Option.String({ name: "command" });

	public async execute(): Promise<number> {
		throw new Error(`Command not implemented yet: ${this.commandName}`);
	}
}
