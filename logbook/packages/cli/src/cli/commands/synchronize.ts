import { BaseCommand } from "../shared.js";

/**
 * `synchronize` is blocked: it does not carry issue-breakdown drafts, project
 * settings, personal instructions, or relations outside the current project,
 * and it keeps local authorship. Use `agent-issues cloud migrate` to move local data.
 */
export class SynchronizeCommand extends BaseCommand {
	public static paths = [["synchronize"]];

	public async execute(): Promise<number> {
		throw new Error('"synchronize" is disabled because it does not carry every record kind. Use "agent-issues cloud migrate" to move local data to the cloud.');
	}
}
