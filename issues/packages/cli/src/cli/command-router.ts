export type CommandFamily =
	| "auth"
	| "backfill"
	| "comments"
	| "context"
	| "daemon"
	| "entities"
	| "export"
	| "fallback"
	| "issue-breakdowns"
	| "instructions"
	| "kanban"
	| "meta"
	| "plan-entries"
	| "plugin"
	| "site"
	| "sql"
	| "synchronize"
	| "tenants";

export async function loadCommandFamily<T>(argv: readonly string[], load: (family: CommandFamily) => Promise<T>): Promise<T> {
	return await load(resolveCommandFamily(argv));
}

function resolveCommandFamily(argv: readonly string[]): CommandFamily {
	switch (argv[0]) {
		case "auth":
			return "auth";
		case "backfill-bodies":
			return "backfill";
		case "comment":
			return "comments";
		case "context":
			return "context";
		case "daemon":
			return "daemon";
		case "create":
		case "edit":
		case "history":
		case "restore":
		case "archive":
		case "delete":
		case "move":
		case "link":
		case "unlink":
		case "status":
		case "next-work":
		case "relations":
		case "orphans":
		case "show":
		case "list":
			return "entities";
		case "export":
			return "export";
		case "issue-breakdown":
			return "issue-breakdowns";
		case "instruction":
			return "instructions";
		case "kanban":
			return "kanban";
		case "help":
		case "schema":
		case "capabilities":
			return "meta";
		case "plan-entry":
			return "plan-entries";
		case "agent":
			return "plugin";
		case "site":
			return "site";
		case "sql":
			return "sql";
		case "synchronize":
			return "synchronize";
		case "init":
		case "current-tenant":
		case "project-identity":
		case "list-tenants":
		case "delete-tenant":
		case "rename-tenant":
			return "tenants";
		default:
			return "fallback";
	}
}