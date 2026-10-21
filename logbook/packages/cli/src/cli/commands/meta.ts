import { Option } from "clipanion";

import { getCapabilitiesPayload, getHelpPayload, getSchemaPayload, renderHelp, renderSchema, resolveHelpCommandName } from "../help.js";

import { BaseCommand } from "../shared.js";

export class HelpCommand extends BaseCommand {
	public static paths = [["help"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		const commandName = this.positionals.length > 0 ? resolveHelpCommandName(this.positionals) : undefined;
		const payload = getHelpPayload(commandName);
		this.print(payload, renderHelp(payload));
		return 0;
	}
}

export class SchemaCommand extends BaseCommand {
	public static paths = [["schema"]];

	public async execute(): Promise<number> {
		const payload = getSchemaPayload();
		this.print(payload, renderSchema(payload));
		return 0;
	}
}

export class CapabilitiesCommand extends BaseCommand {
	public static paths = [["capabilities"]];

	public async execute(): Promise<number> {
		const capabilities = getCapabilitiesPayload();
		this.print(
			capabilities,
			`${renderHelp(capabilities.help)}\n\n${renderSchema(capabilities.schema)}`
		);
		return 0;
	}
}
