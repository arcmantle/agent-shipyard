import {
	ALLOWED_RELATIONS,
	ENTITY_CATEGORIES,
	ENTITY_TYPES,
	ENTITY_KINDS,
	ENTITY_PRIORITIES,
	ID_PREFIX,
	STATUS_FLOW,
	STRUCTURAL_RELATION_TYPES,
	getArchiveStatus,
	isStructuralRelationType,
	type EntityKind
} from "@agent-issues/core";
import { DEFAULT_CONTEXT_KEY } from "@agent-issues/api-local";
import { AGENT_HOSTS } from "./commands/plugin.js";

type OptionSpec = {
	name: string;
	description: string;
	required?: boolean;
	allowedValues?: readonly string[];
};

type PositionalSpec = {
	name: string;
	description: string;
	required?: boolean;
	allowedValues?: readonly string[];
};

type CommandSpec = {
	name: string;
	summary: string;
	usage: string[];
	positionals?: PositionalSpec[];
	options?: OptionSpec[];
	examples?: string[];
	notes?: string[];
	output?: {
		human?: string[];
		json?: string[];
	};
};

type GlobalOptionSpec = OptionSpec;

export type HelpPayload = {
	name: string;
	summary: string;
	globalOptions: GlobalOptionSpec[];
	commands: Array<{ name: string; summary: string; usage: string[] }>;
	discovery: string[];
	command?: CommandSpec;
};

export type CapabilitiesPayload = {
	help: HelpPayload;
	schema: SchemaPayload;
};

export type SchemaPayload = {
	entityCategories: readonly string[];
	entityKinds: Array<{
		kind: EntityKind;
		idPrefix: string;
		initialStatus: string;
		statuses: readonly string[];
		archiveStatus: string;
	}>;
	entityPriorities: readonly string[];
	relationTypes: string[];
	allowedRelations: typeof ALLOWED_RELATIONS;
	structuralRelationTypes: readonly string[];
	parentRules: Array<{
		parentKind: EntityKind;
		childKind: EntityKind;
		relationType: string;
	}>;
	context: {
		storage: "database";
		scopes: string[];
		defaultKey: string;
		listCommand: string;
		readCommand: string;
		searchCommand: string;
		conflictsCommand: string;
		initializeCommand: string;
		defineCommand: string;
		forgetCommand: string;
		termFields: string[];
	};
	issueComments: {
		storage: "database";
		parentKind: "issue";
		recordPrefix: "COM";
		addCommand: string;
		listCommand: string;
		editCommand: string;
		deleteCommand: string;
		historyCommand: string;
		fields: string[];
	};
	planEntries: {
		storage: "database";
		parentKind: "plan";
		recordPrefix: "PLAN_ENTRY";
		linkRelationType: "informs";
		linkTargetKind: "entity";
		addCommand: string;
		linkCommand: string;
		unlinkCommand: string;
		fields: string[];
	};
};

const GLOBAL_OPTIONS: GlobalOptionSpec[] = [
	{
		name: "--db <path>",
		description: "Use a specific SQLite database path."
	},
	{
		name: "--json",
		description: "Print machine-readable JSON. Entity mutations return acknowledgements; list and relation reads return summaries."
	},
	{
		name: "--pretty",
		description: "Pretty-print JSON when used with --json."
	},
	{
		name: "--help, -h",
		description: "Show help for the whole CLI or the selected command."
	}
];

const ENTITY_KIND_VALUES = ENTITY_KINDS;
const ENTITY_CATEGORY_OPTION: OptionSpec = {
	name: "--category <category>",
	description: "Set a category. Debt creation requires a category.",
	allowedValues: ENTITY_CATEGORIES
};
const ENTITY_PRIORITY_OPTION: OptionSpec = {
	name: "--priority <priority>",
	description: "Set a priority. Debt creation requires a priority.",
	allowedValues: ENTITY_PRIORITIES
};
const ENTITY_TYPE_OPTION: OptionSpec = {
	name: "--type <type>",
	description: "Set a kind-specific entity type.",
	allowedValues: Object.values(ENTITY_TYPES).flat()
};
const RELATION_TYPE_VALUES = Array.from(new Set(ALLOWED_RELATIONS.map((relation) => relation.type))).sort();
const STATUS_VALUES = Array.from(new Set(Object.values(STATUS_FLOW).flat())).sort();
const COMMAND_SPECS: CommandSpec[] = [
	{
		name: "instruction",
		summary: "Read and save personal instruction Markdown for the running CLI release.",
		usage: [
			"agent-issues instruction retrieve <key> [--json]",
			"agent-issues instruction preview <key> --input-file <path|-> [--json]",
			"agent-issues instruction list [--json]",
			"agent-issues instruction read <key> [--json]",
			"agent-issues instruction compare <key> [--json]",
			"agent-issues instruction dependencies <key> [--json]",
			"agent-issues instruction save <key> --body-file <path|-> --expected-revision <revision> [--json]",
			"agent-issues instruction history <key> [--json]",
			"agent-issues instruction revision <key> --revision <revision> [--json]",
			"agent-issues instruction restore <key> --revision <revision> --expected-revision <revision> [--json]",
			"agent-issues instruction reset-inspect <key> [--json]",
			"agent-issues instruction reset <key> --expected-revision <revision> --yes [--json]",
			"agent-issues instruction reset-all-inspect [--json]",
			"agent-issues instruction reset-all --input-file <path|-> --yes [--json]",
			"agent-issues instruction commit --input-file <path|-> [--json]",
			"agent-issues instruction fragment create <key> --body-file <path|-> [--json]",
			"agent-issues instruction fragment remove <key> --expected-revision <revision> [--json]"
		],
		examples: ["agent-issues instruction retrieve skill/prepare --json", "agent-issues instruction retrieve agent/agent-issues"],
		notes: [
			"Local mode uses one local profile. Cloud mode uses the authenticated tenant and user across projects.",
			"Retrieval fails if storage, the requested release, or the item is unavailable. There is no fallback.",
			"Read returns source Markdown without fragment expansion. Retrieve returns assembled Markdown.",
			"Preview reads a JSON object with a non-empty changes array of key and body pairs. It assembles pending Markdown without saving. Saved source metadata identifies base revisions; pendingKeys identifies unsaved bodies. Human output starts with Pending.",
			"Save changes an existing item's personal override, not official defaults or discovery metadata. It activates the next retrieval.",
			"Stale or invalid saves leave content unchanged. JSON write errors include current source and revision data for comparison and retry.",
			"Commit reads a JSON object with a changes array. Each change has operation (save or remove), key, and expectedRevision. Save also requires body. The final graph is validated before all changes commit together.",
			"Create adds only a personal fragment. Remove requires an unreferenced personal fragment and its current revision; revision history is retained."
		],
		output: { human: ["Complete stored Markdown."], json: ["Markdown, stable item key, kind, requesting release, source revision, and content hash."] }
	},
	{
		name: "sql",
		summary: "Run a read-only SQL query against the active local SQLite database.",
		usage: [
			"agent-issues sql <statement>"
		],
		positionals: [
			{
				name: "statement",
				description: "The SQL statement to run. Quote the statement in the shell.",
				required: true
			}
		],
		examples: [
			'agent-issues sql "SELECT id, title FROM entities" --json'
		],
		notes: [
			"This command is available only when the active saved login is local.",
			"The query runs through a read-only SQLite connection."
		],
		output: {
			human: ["A JSON array of result rows."],
			json: ["An object with a rows array."]
		}
	},
	{
		name: "context",
		summary: "Read and update shared, project-scoped, and initiative-scoped database-backed context.",
		usage: [
			"agent-issues context",
			"agent-issues context list",
			"agent-issues context show",
			"agent-issues context show --view initiatives --query <text>",
			"agent-issues context show default",
			"agent-issues context show <entityOrProjectOrInitiativeId>",
			"agent-issues context search <query> [--view <all|global|initiatives>]",
			"agent-issues context conflicts [<query>] [--view <all|initiatives>]",
			"agent-issues context set [--scope <entityOrProjectOrInitiativeId|default>] --title <title> --body-file <path|-> [--view <compact|full>]",
			"agent-issues context define <term> [--scope <entityOrProjectOrInitiativeId|default>] --body-file <path|-> [--avoid <comma-separated terms>] [--view <compact|full>]",
			"agent-issues context forget <term> [--scope <entityOrProjectOrInitiativeId|default>] [--view <compact|full>]"
		],
		positionals: [
			{
				name: "subcommand",
				description: "Context action. Defaults to show.",
				allowedValues: ["list", "show", "search", "conflicts", "set", "define", "forget"]
			},
			{
				name: "scopeOrTerm",
				description: "Context scope for show, or term name for define and forget."
			}
		],
		options: [
			{
				name: "--scope <entityOrProjectOrInitiativeId|default>",
				description: "Resolve context from a project, an initiative, or an entity inside an initiative."
			},
			{
				name: "--title <title>",
				description: "Context title for `context set`."
			},
			{
				name: "--body-file <path|->",
				description: "Read the authored markdown body from a file, or from stdin when the value is `-`: the context summary for `context set`, or the canonical term definition for `context define`."
			},
			{
				name: "--query <text>",
				description: "Filter project-wide context discovery for `context show`, `context search`, or `context conflicts`."
			},
			{
				name: "--avoid <comma-separated terms>",
				description: "Alternative terms to avoid for `context define`."
			},
			{
				name: "--view <all|global|initiatives|compact|full>",
				description: "For show, search, and conflicts: all/global/initiatives. For set, define, and forget: compact/full JSON acknowledgements."
			},
			{
				name: "--terms-only",
				description: "For `context search`, return only the matching term entries instead of the full project directory summary."
			}
		],
		examples: [
			"agent-issues context --json",
			"agent-issues context show --view initiatives --query review --json",
			"agent-issues context list --json",
			"agent-issues context show default --json",
			"agent-issues context show PROJ1 --json",
			"agent-issues context show INIT1 --json",
			"agent-issues context show ISS3 --json",
			"agent-issues context search review --view initiatives --json",
			"agent-issues context search review --view initiatives --terms-only --json",
			"agent-issues context conflicts --json",
			'agent-issues context set --scope PROJ1 --title "Payments Context" --body-file /tmp/summary.md',
			'agent-issues context define "Order" --scope INIT1 --body-file /tmp/order-definition.md --avoid "purchase, transaction" --json',
			'agent-issues context forget "Legacy order" --scope INIT1 --json'
		],
		notes: [
			"Context is stored in the agent-issues database, not in a raw CONTEXT.md file.",
			"`context show` without a scope returns the current project's shared context plus initiative-scoped discovery.",
			"Use `context show default` to read only the shared project glossary.",
			"Use `context search <query>` or `context show --query <text>` to narrow project-wide discovery before reading a specific project or initiative scope.",
			"Use `context search <query> --terms-only --json` when you only need matching definitions and do not want the surrounding project directory summary.",
			"Use `context conflicts` to list duplicate labels across scopes so agents can resolve terminology collisions early.",
			"Use project context for project-wide terms and initiative context for workstream-specific terms.",
			"Read the context before using project-specific vocabulary, and update it immediately when a term is resolved.",
			"Use `--body-file` for multiline markdown to avoid shell quoting problems."
		],
		output: {
			human: [
				"Context metadata block, project-wide context directory, or context list",
				"One line per term with definition and optional avoid list, plus duplicate-scope warnings in the project directory"
			],
			json: ["contexts", "context", "terms", "shared", "initiatives", "duplicateTerms", "view", "query", "conflictsOnly"]
		}
	},
	{
		name: "comment",
		summary: "Add, list, edit, delete, and inspect revision history for issue-owned comment records.",
		usage: [
			"agent-issues comment",
			"agent-issues comment add <issueId> --body-file <path|-> [--reference <issueId>]",
			"agent-issues comment list <issueId> [--before <cursor>] [--all]",
			"agent-issues comment edit <issueId> <commentId> --body-file <path|-> [--reference <issueId>]",
			"agent-issues comment delete <issueId> <commentId>",
			"agent-issues comment history <commentId>"
		],
		positionals: [
			{
				name: "subcommand",
				description: "Comment action.",
				allowedValues: ["add", "list", "edit", "delete", "history"]
			}
		],
		examples: [
			"agent-issues comment list ISS1 --json",
			"agent-issues comment add ISS1 --body-file - --reference ISS2 --json",
			"agent-issues comment history COM1 --json"
		],
		notes: [
			"Issue comments are database records owned by an issue. They are not workflow entity kinds.",
			"Use `schema --json` to discover the record fields and commands.",
			"Use `--body-file` for multiline markdown to avoid shell quoting problems."
		],
		output: {
			human: ["One comment record, a comment page, or revision history"],
			json: ["id", "reference", "issueId", "body", "referencedIssueIds", "revision", "contentHash", "comments", "total", "nextBefore"]
		}
	},
	{
		name: "issue-breakdown",
		summary: "Create, read, and approve issue-breakdown drafts before issue creation.",
		usage: [
			"agent-issues issue-breakdown",
			"agent-issues issue-breakdown create <targetId> --input-file <path>",
			"agent-issues issue-breakdown show <draftId>",
			"agent-issues issue-breakdown latest <targetId>",
			"agent-issues issue-breakdown approve <draftId> --snapshot-digest <digest>"
		],
		positionals: [
			{ name: "subcommand", description: "Issue-breakdown action.", allowedValues: ["create", "show", "latest", "approve"] },
			{ name: "targetId", description: "Target initiative or user-story ID or reference." },
			{ name: "draftId", description: "Issue-breakdown draft ID." }
		],
		options: [
			{ name: "--input-file <path>", description: "Read a JSON object with an issues array of proposed issue specifications." },
			{ name: "--snapshot-digest <digest>", description: "Approve only this exact issue-breakdown snapshot." }
		],
		examples: [
			"agent-issues issue-breakdown create INIT1 --input-file /tmp/issues.json --json",
			"agent-issues issue-breakdown latest INIT1 --json",
			"agent-issues issue-breakdown approve <draftId> --snapshot-digest <digest> --json"
		],
		notes: [
			"The JSON input has a non-empty issues array.",
			"Each issue requires key, title, outcome, workMode, scope, acceptanceCriteria, and relationReferences. parentKey is optional.",
			"Each relation reference requires relationType and one of targetId, targetKey, or targetReference.",
			"Creating a draft does not create issue records.",
			"Approval creates the complete graph only when the digest matches the reviewed snapshot."
		],
		output: {
			human: ["One issue-breakdown draft or approval result."],
			json: ["id", "status", "targetReference", "issues", "snapshotDigest", "createdIssueReferences"]
		}
	},
	{
		name: "plan-entry",
		summary: "Add, list, edit, delete, and inspect revision history for Plan entries.",
		usage: [
			"agent-issues plan-entry add <planId> --role <question|decision|scope|constraint|preference|consideration> --body-file <path|-> [--scope-direction <included|excluded>] [--reference <entityId>] [--supersedes <entryId>]",
			"agent-issues plan-entry list <planId>",
			"agent-issues plan-entry edit <planId> <entryId> --body-file <path|->",
			"agent-issues plan-entry delete <planId> <entryId>",
			"agent-issues plan-entry history <entryId>"
		],
		positionals: [
			{
				name: "subcommand",
				description: "Plan-entry action.",
				allowedValues: ["add", "list", "edit", "delete", "history"]
			},
			{ name: "planId", description: "Owning Plan ID or reference." },
			{ name: "entryId", description: "Plan-entry ID or reference for edit and delete." }
		],
		options: [
			{
				name: "--role <question|decision|scope|constraint|preference|consideration>",
				description: "Role for a new Plan entry.",
				allowedValues: ["question", "decision", "scope", "constraint", "preference", "consideration"]
			},
			{
				name: "--scope-direction <included|excluded>",
				description: "Required direction for a scope entry.",
				allowedValues: ["included", "excluded"]
			},
			{
				name: "--reference <entityId>",
				description: "Reference an entity from a new Plan entry. Repeat for each entity."
			},
			{
				name: "--supersedes <entryId>",
				description: "Replace a question or decision entry with a decision entry. Repeat for each entry."
			},
			{
				name: "--body-file <path|->",
				description: "Read the entry body from a file, or from stdin when the value is `-`."
			}
		],
		examples: [
			"agent-issues plan-entry add PLAN1 --role question --body-file - --reference ISS1",
			"agent-issues link PLAN_ENTRY1 informs ISS1",
			"agent-issues plan-entry add PLAN1 --role decision --body-file - --supersedes PLAN_ENTRY1",
			"agent-issues plan-entry list PLAN1 --json"
		],
		notes: [
			"Plans are initiative-owned entities created with `agent-issues create plan --parent <initiativeId>`.",
				"Link an existing Plan entry to an entity with `agent-issues link <planEntryId> informs <targetId>`.",
			"A decision can supersede question or decision entries.",
			"Delete retains the entry in revision history."
		],
		output: {
			human: ["One Plan entry, a Plan-entry list, or Plan-entry revision history"],
			json: ["id", "reference", "planId", "role", "body", "referencedEntityIds", "supersededEntryIds", "revision", "contentHash"]
		}
	},
	{
		name: "init",
		summary: "Initialize the local data store.",
		usage: ["agent-issues init"],
		examples: ["agent-issues init"],
		output: {
			human: ["Initialized data store at <dbPath>"],
			json: ["command", "dbPath", "status"]
		}
	},
	{
		name: "agent init",
		summary: "Install the Agent Issues plugin for Copilot CLI or Claude Code.",
		usage: ["agent-issues agent init [--host <copilot|claude>]"],
		options: [
			{
				name: "--host",
				description: "Host CLI that installs the plugin. Default: copilot.",
				allowedValues: AGENT_HOSTS
			}
		],
		examples: [
			"agent-issues agent init",
			"agent-issues agent init --host claude"
		],
		notes: [
			"Install agent-issues and agent-issues-mcp globally before you run this command.",
			"The selected host CLI must be installed and available on PATH."
		],
		output: {
			human: ["Installed the Agent Issues plugin for <host>."],
			json: ["command", "host", "marketplace", "plugin"]
		}
	},
	{
		name: "current-tenant",
		summary: "Show which tenant the CLI would use from the current workspace.",
		usage: ["agent-issues current-tenant"],
		examples: ["agent-issues current-tenant", "agent-issues current-tenant --json"],
		notes: [
			"The CLI always derives the tenant automatically - there is exactly one tenant per OS user.",
			"Workspace root discovery walks upward from the current directory and prefers pnpm-workspace.yaml, then .git, then package.json."
		],
		output: {
			human: ["Current tenant, workspace root, and database path"],
			json: ["command", "tenantId", "workspaceRoot", "dbPath"]
		}
	},
	{
		name: "project-identity",
		summary: "Show the project identity resolved from the current workspace.",
		usage: ["agent-issues project-identity"],
		examples: ["agent-issues project-identity", "agent-issues project-identity --json"],
		notes: [
			"Resolution precedence is environment override, .agent-issues.json file, Git remote name, package.json name, then folder name."
		],
		output: {
			human: ["Resolved project identity and its source"],
			json: ["command", "identity", "source"]
		}
	},
	{
		name: "list-tenants",
		summary: "List the tenants currently present in the selected database.",
		usage: ["agent-issues list-tenants", "agent-issues list-tenants --db <path> --json"],
		examples: ["agent-issues list-tenants", "agent-issues list-tenants --json"],
		notes: [
			"The command lists tenants with any stored entities, relations, context, terms, or handoffs.",
			"Use this before `delete-tenant` to avoid deleting the wrong tenant."
		],
		output: {
			human: ["Database path followed by one line per tenant with per-table counts"],
			json: ["command", "dbPath", "currentTenantId", "tenants"]
		}
	},
	{
		name: "delete-tenant",
		summary: "Delete one tenant and all of its rows from the selected database.",
		usage: ["agent-issues delete-tenant <tenantId> --force"],
		positionals: [{ name: "tenantId", description: "Tenant ID to delete.", required: true }],
		options: [
			{
				name: "--force",
				description: "Required safety flag for whole-tenant deletion."
			}
		],
		examples: ["agent-issues delete-tenant payments --force", "agent-issues delete-tenant agent-issues-de3fbe614e21 --force --json"],
		notes: [
			"This removes the tenant's counters, entities, relations, context, context terms, and handoffs.",
			"Tenant IDs are sanitized (display-style input like `Payments Sandbox` resolves to `payments-sandbox`).",
			"The command is irreversible. Run `list-tenants` first if you are not sure which tenant to delete."
		],
		output: {
			human: ["Deleted tenant summary with per-table removal counts, or a not-found message"],
			json: ["command", "dbPath", "tenantId", "displayName", "removed", "counts", "counters"]
		}
	},
	{
		name: "rename-tenant",
		summary: "Rename one tenant namespace across the selected database.",
		usage: ["agent-issues rename-tenant <tenantId> <newTenantId> --force"],
		positionals: [
			{ name: "tenantId", description: "Existing tenant ID to rename.", required: true },
			{ name: "newTenantId", description: "New tenant ID to assign.", required: true }
		],
		options: [
			{
				name: "--force",
				description: "Required safety flag for whole-tenant renaming."
			}
		],
		examples: ["agent-issues rename-tenant smoke-handoff handoff-sandbox --force", "agent-issues rename-tenant payments-sandbox payments --force --json"],
		notes: [
			"Tenant IDs are sanitized the same way (display-style input like `Payments Sandbox` resolves to `payments-sandbox`).",
			"Renaming updates counters, entities, relations, contexts, context terms, and handoffs.",
			"The target tenant must not already exist. Run `list-tenants` first if you are not sure."
		],
		output: {
			human: ["Renamed tenant summary with per-table moved counts, or a not-found message"],
			json: ["command", "dbPath", "previousTenantId", "previousDisplayName", "newTenantId", "newDisplayName", "renamed", "counts", "counters"]
		}
	},
	{
		name: "auth list",
		summary: "List saved logins in switching order and mark the active saved login.",
		usage: ["agent-issues auth list"],
		examples: ["agent-issues auth list", "agent-issues auth list --json"],
		notes: [
			"The permanent local login is listed first, followed by remote saved logins in creation order.",
			"Never prints raw access tokens, in either human or --json output."
		],
		output: {
			human: ["One line per saved login, with * marking the active login"],
			json: ["command", "logins"]
		}
	},
	{
		name: "auth login",
		summary: "Discover a remote service's Entra configuration and create or refresh a named saved login.",
		usage: ["agent-issues auth login", "agent-issues auth login --name <name> --url <url>"],
		options: [
			{
				name: "--name <name>",
				description: "Unique saved-login name for one-shot use. Prompted when omitted interactively."
			},
			{
				name: "--url <url>",
				description: "Remote agent-issues service URL for one-shot use. Prompted when omitted interactively."
			}
		],
		examples: ["agent-issues auth login", "agent-issues auth login --name work --url https://agent-issues.example.com"],
		notes: [
			"Remote login fetches /.well-known/agent-issues from the normalized service URL and uses its tenant and client IDs for device-code sign-in.",
			"Interactive login prompts for the saved-login name and service URL.",
			"When --json is present, --name and --url are required so prompt text never mixes with JSON output.",
			"Refreshing an existing name preserves saved-login switching order and makes that login active."
		],
		output: {
			human: ["Saved-login destination, signed-in identity, tenant, and session expiry"],
			json: ["command", "login"]
		}
	},
	{
		name: "auth logout",
		summary: "Remove a remote saved login.",
		usage: ["agent-issues auth logout [name]"],
		positionals: [
			{
				name: "name",
				description: "Remote saved login to remove. Defaults to the active saved login.",
				required: false
			}
		],
		examples: ["agent-issues auth logout work", "agent-issues auth logout --json"],
		notes: [
			"Removing the active remote saved login activates local atomically.",
			"The permanent local saved login cannot be removed."
		],
		output: {
			human: ["Confirmation of which saved login was removed"],
			json: ["command", "name"]
		}
	},
	{
		name: "auth status",
		summary: "Show the active saved login and its destination and identity details.",
		usage: ["agent-issues auth status"],
		examples: ["agent-issues auth status", "agent-issues auth status --json"],
		notes: ["Never prints raw access tokens, in either human or --json output."],
		output: {
			human: ["Active saved-login name, destination kind, remote URL when applicable, identity, and expiry"],
			json: ["command", "login"]
		}
	},
	{
		name: "auth switch",
		summary: "Activate a named saved login or advance to the next saved login.",
		usage: ["agent-issues auth switch [name]"],
		positionals: [{ name: "name", description: "Saved login to activate. Omit to advance in switching order.", required: false }],
		examples: ["agent-issues auth switch work", "agent-issues auth switch local", "agent-issues auth switch"],
		notes: [
			"Without a name, advances from local through remote saved logins in creation order, then wraps to local.",
			"Never prints the raw access token, in either human or --json output."
		],
		output: {
			human: ["Confirmation of the saved login switched to"],
			json: ["command", "login"]
		}
	},
	{
		name: "backfill-bodies",
		summary: "Generate metadata-derived bodies for initiatives, issues, PRDs, user stories, and ADRs when authored bodies are missing.",
		usage: [
			"agent-issues backfill-bodies [--kinds <comma-separated kinds>] [--dry-run] [--force]",
			"agent-issues backfill-bodies --all-tenants --json"
		],
		options: [
			{
				name: "--kinds <initiative,issue,prd,userStory,adr>",
				description: "Comma-separated record kinds to backfill. Defaults to initiative,issue,prd,userStory,adr."
			},
			{
				name: "--all-tenants",
				description: "Process every tenant already present in the selected database instead of only the current or explicit tenant."
			},
			{
				name: "--dry-run",
				description: "Preview what would be updated without writing any bodies to the database."
			},
			{
				name: "--force",
				description: "Overwrite existing bodies instead of only filling empty ones."
			}
		],
		examples: [
			"agent-issues backfill-bodies",
			"agent-issues backfill-bodies --kinds initiative,prd,userStory,adr --json",
			"agent-issues backfill-bodies --dry-run --json",
			"agent-issues backfill-bodies --all-tenants --force"
		],
		notes: [
			"By default the command only fills empty bodies and leaves authored content unchanged.",
			"Generated bodies are derived from existing tracker metadata such as structural parents, fixing issues, and dependency links.",
			"Use `--all-tenants` to sweep the entire shared database; otherwise the command only touches the current or explicitly selected tenant.",
			"Use `--dry-run` to preview the counts without mutating the database.",
			"The command is idempotent unless `--force` is supplied."
		],
		output: {
			human: [
				"Backfill scope, database path, selected kinds, dry-run mode, and overwrite mode",
				"One section per tenant with considered, updated, and skipped counts by kind"
			],
			json: ["command", "dbPath", "scope", "kinds", "dryRun", "force", "tenants"]
		}
	},
	{
		name: "create",
		summary: "Create an entity, optionally under a structural parent.",
		usage: ["agent-issues create <kind> --title <title> [--parent <id>] [--status <status>] [--body-file <path|->]"],
		positionals: [
			{
				name: "kind",
				description: "Entity kind to create.",
				required: true,
				allowedValues: ENTITY_KIND_VALUES
			}
		],
		options: [
			{
				name: "--title <title>",
				description: "Entity title.",
				required: true
			},
			ENTITY_CATEGORY_OPTION,
			ENTITY_PRIORITY_OPTION,
			ENTITY_TYPE_OPTION,
			{
				name: "--parent <id>",
				description: "Structural parent ID when one is required by the workflow."
			},
			{
				name: "--link <relationType> <targetId>",
				description: "Create a relation from the new entity to a target. Repeat for each link."
			},
			{
				name: "--status <status>",
				description: "Override the default initial status.",
				allowedValues: STATUS_VALUES
			},
			{
				name: "--body-file <path|->",
				description: "Read the authored markdown body from a file, or from stdin when the value is `-`."
			}
		],
		examples: [
			'agent-issues create initiative --title "Workflow tooling"',
			'agent-issues create plan --title "Routing decision" --parent INIT1 --body-file -',
			'agent-issues create prd --title "Handoff support" --parent INIT1',
			'agent-issues create issue --title "Add help schema" --parent INIT1',
			'agent-issues create debt --title "Replace legacy worker" --parent INIT1 --category technical --priority high',
			'agent-issues create handoff --title "Resume export work" --body-file - --link handsOff ISS1',
			'agent-issues create issue --title "Split parser edge cases" --parent ISS1',
			'agent-issues create issue --title "Add help schema" --parent INIT1 --body-file /tmp/iss1.md'
		],
		notes: [
			"Valid structural parent-child pairs are exposed by `agent-issues schema --json`.",
			"A Plan requires an initiative parent. Use `plan-entry` to record its questions and decisions.",
			"Issues can be created under initiatives as tracked work, or under other issues as structural sub-issues.",
			"If no status is supplied, the CLI uses the first status in the workflow for that kind.",
			"Use `--body-file` for multiline markdown to avoid shell quoting problems.",
			"Use `--link` to create graph relations atomically with the entity.",
			"Debt requires one project, epic, initiative, or issue parent, plus category and priority.",
			"Create a handoff with `--title`, `--body-file`, and `--link handsOff <focusId>`."
		],
		output: {
			human: ["<id> <kind> <status> <title>"],
			json: ["operation", "reference", "status", "revision"]
		}
	},
	{
		name: "archive",
		summary: "Move one entity to its archive status.",
		usage: ["agent-issues archive <id>"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
		examples: ["agent-issues archive ISS1", "agent-issues archive DEBT1"],
		notes: [
			"Archive status depends on entity kind and is exposed by `agent-issues schema --json`.",
			"Archiving debt sets its lifecycle to archived. Use `status <debtId> open` to restore it.",
			"For an ADR, archive is refused while a supersedes edge points at it."
		],
		output: {
			human: ["Archived <id> from <previousStatus> to <status>"],
			json: ["entity", "previousStatus"]
		}
	},
	{
		name: "history",
		summary: "Read one entity or context revision.",
		usage: [
			"agent-issues history <id> --revision <revision>",
			"agent-issues history --context <scope> --revision <revision>",
			"agent-issues history --context <scope> --term <term> --revision <revision>"
		],
		positionals: [{ name: "id", description: "Entity ID when --context is not supplied." }],
		options: [
			{ name: "--revision <revision>", description: "Revision number to materialize.", required: true },
			{ name: "--context <scope>", description: "Context scope for context history." },
			{ name: "--term <term>", description: "Context term for term revision history. Requires --context." }
		],
		examples: ["agent-issues history ISS1 --revision 2 --json", "agent-issues history --context INIT1 --revision 3 --json"],
		notes: ["History reads complete materialized content at the requested revision."],
		output: {
			human: ["Revision identity, current and requested revision numbers, and materialized content"],
			json: ["MaterializedEntityRevision | MaterializedContextRevision | MaterializedContextTermRevision"]
		}
	},
	{
		name: "restore",
		summary: "Restore one entity or context revision after confirmation.",
		usage: [
			"agent-issues restore <id> --revision <revision>",
			"agent-issues restore --context <scope> --revision <revision> [--view <compact|full>]",
			"agent-issues restore --context <scope> --term <term> --revision <revision> [--view <compact|full>]"
		],
		positionals: [{ name: "id", description: "Entity ID when --context is not supplied." }],
		options: [
			{ name: "--revision <revision>", description: "Revision number to restore.", required: true },
			{ name: "--context <scope>", description: "Context scope for context restoration." },
			{ name: "--term <term>", description: "Context term to restore. Requires --context." },
			{ name: "--view <compact|full>", description: "Context-only JSON acknowledgement shape.", allowedValues: ["compact", "full"] }
		],
		examples: ["agent-issues restore ISS1 --revision 2 --json", "agent-issues restore --context INIT1 --revision 3 --view compact --json"],
		notes: ["Entity restore always returns a compact acknowledgement. Use --view only with --context."],
		output: {
			human: ["Restored record identity, target revision, and new head revision"],
			json: ["Compact entity acknowledgement, or selected context restore result"]
		}
	},
	{
		name: "delete",
		summary: "Delete one leaf entity.",
		usage: ["agent-issues delete <id>"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
		examples: ["agent-issues delete ISS2"],
		notes: ["Deletion fails when the entity still has outgoing relations."],
		output: {
			human: ["Deleted <id> <kind> <title>"],
			json: ["entity", "removed"]
		}
	},
	{
		name: "export",
		summary: "Export one initiative or the whole project as markdown with graph metadata in frontmatter.",
		usage: [
			"agent-issues export <initiativeId> [--output <path>] [--force]",
			"agent-issues export project [--output <path>] [--force]",
			"agent-issues export <initiativeId|project> --single-file [--output <file>]"
		],
		positionals: [
			{
				name: "initiativeId|project",
				description: "One initiative ID, or `project` for a tenant-wide export.",
				required: true
			}
		],
		options: [
			{
				name: "--output <path>",
				description: "Directory path for grouped export output, or a file path when used with `--single-file`."
			},
			{
				name: "--single-file",
				description: "Emit one markdown document instead of a grouped folder export. Without `--output`, prints to stdout."
			},
			{
				name: "--force",
				description: "Replace an existing export directory when writing grouped output."
			}
		],
		examples: [
			"agent-issues export INIT1",
			"agent-issues export project --output ./tmp/export --force",
			"agent-issues export INIT1 --single-file",
			"agent-issues export INIT1 --single-file --output ./tmp/init1.md",
			"agent-issues export INIT1 --json"
		],
		notes: [
			"Grouped export is the default: it creates a folder tree that mirrors entity-kind and relation groupings in the database.",
			"Single-file export remains available with `--single-file` for piping or ad hoc capture.",
			"The YAML frontmatter summarizes counts, context, and relation edges so connections remain machine-readable.",
			"Project export includes normal entity and relation output, plus one nested initiative export per initiative."
		],
		output: {
			human: [
				"Default: export summary with output path and file count for a grouped folder export",
				"With `--single-file`: one markdown document with YAML frontmatter, entity sections, relation summaries, and context sections"
			],
			json: ["mode", "scope", "initiativeId", "generatedAt", "markdown", "outputPath", "files"]
		}
	},
	{
		name: "move",
		summary: "Move one entity under a new structural parent.",
		usage: ["agent-issues move <id> <newParentId>"],
		positionals: [
			{ name: "id", description: "Entity ID to move.", required: true },
			{ name: "newParentId", description: "New structural parent ID.", required: true }
		],
		examples: ["agent-issues move US1 PRD2", "agent-issues move ISS7 ISS1", "agent-issues move DEBT1 INIT2"],
		notes: [
			"Move rejects incompatible parent kinds, cycles, and initiatives.",
			"Use move to reparent a sub-issue under a different parent issue without rebuilding its other relations.",
			"Debt can move only to a project, epic, initiative, or issue owner."
		],
		output: {
			human: ["Moved <id> from <previousParentId|none> to <newParentId> as <relationType>"],
			json: ["entity", "previousParentId", "newParentId", "relationType"]
		}
	},
	{
		name: "relations",
		summary: "Show incoming and outgoing relations for one entity.",
		usage: ["agent-issues relations <id> [--direction <incoming|outgoing|both>] [--type <comma-separated types>]"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
		options: [
			{
				name: "--direction <incoming|outgoing|both>",
				description: "Select incoming, outgoing, or both relation directions. Defaults to both.",
				allowedValues: ["incoming", "outgoing", "both"]
			},
			{
				name: "--type <comma-separated types>",
				description: "Include only the selected relation types.",
				allowedValues: RELATION_TYPE_VALUES
			}
		],
		examples: [
			"agent-issues relations <id>",
			"agent-issues relations <id> --direction incoming --type blocks,decomposes --json",
			"agent-issues relations DEBT1 --direction incoming --type records,resolves --json"
		],
		notes: [
			"JSON returns the focused entity and selected edges with id, kind, status, and title only.",
			"Use --direction and --type to select edges before serialization."
		],
		output: {
			human: [
				"<id> <kind> <status> <title>",
				"Incoming section",
				"Outgoing section"
			],
			json: ["{ entity: CompactEntity, incoming: CompactRelation[], outgoing: CompactRelation[], planEntries: PlanEntryRecord[] }"]
		}
	},
	{
		name: "next-work",
		summary: "List ready and blocked unfinished issues for an initiative scope.",
		usage: ["agent-issues next-work <initiativeOrDescendantId>"],
		positionals: [{ name: "initiativeOrDescendantId", description: "An initiative, PRD, user story, or issue in the initiative.", required: true }],
		examples: ["agent-issues next-work INIT1 --json", "agent-issues next-work ISS7 --json"],
		notes: [
			"The result resolves an initiative from the supplied entity and includes unfinished issues below it, except deferred issues, including nested decomposed issues.",
			"Available issues have no open blocks source and no unfinished, non-deferred sub-issue. A deferred blocks source still blocks its target until done.",
			"Each issue also lists the unfinished issues it unblocks, including its decomposed parent when applicable."
		],
		output: {
			human: ["Initiative reference", "Available issues", "Blocked issues with blocker and unblock references"],
			json: ["{ initiative: CompactEntity, available: CompactNextWorkItem[], blocked: CompactNextWorkItem[] }"]
		}
	},
	{
		name: "orphans",
		summary: "List entities not reachable from any initiative.",
		usage: ["agent-issues orphans [kind]"],
		positionals: [
			{
				name: "kind",
				description: "Optional entity kind filter.",
				allowedValues: ENTITY_KIND_VALUES
			}
		],
		examples: ["agent-issues orphans", "agent-issues orphans issue --json"],
		output: {
			human: ["One line per orphaned entity: <id> <kind> <status> <title>"],
			json: ["Array<EntityRecord>"]
		}
	},
	{
		name: "status",
		summary: "Update an entity status.",
		usage: ["agent-issues status <id> <status>"],
		positionals: [
			{ name: "id", description: "Entity ID.", required: true },
			{
				name: "status",
				description: "New status.",
				required: true,
				allowedValues: STATUS_VALUES
			}
		],
		examples: ["agent-issues status ISS1 in-progress", "agent-issues status US1 done", "agent-issues status DEBT1 resolved"],
		notes: [
			"Each entity kind only accepts its own status flow.",
			"An ADR is current unless it is superseded or archived.",
			"Debt uses open, resolved, and archived states. Its lifecycle changes are manual; a resolves link does not change its state.",
			"Issues cannot move to in-progress or done while blocked by a non-done issue.",
			"Parent issues also cannot move to in-progress or done while any sub-issue remains open."
		],
		output: {
			human: ["Updated <id> from <previousStatus> to <status>"],
			json: ["entity", "previousStatus"]
		}
	},
	{
		name: "edit",
		summary: "Update an entity title and/or authored markdown body.",
		usage: ["agent-issues edit <id> [--title <title>] [--body-file <path|->] [--category <category>] [--priority <priority>] [--type <type>]"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
		options: [
			{
				name: "--title <title>",
				description: "Replacement entity title."
			},
			{
				name: "--body-file <path|->",
				description: "Read the authored markdown body from a file, or from stdin when the value is `-`."
			},
			ENTITY_CATEGORY_OPTION,
			ENTITY_PRIORITY_OPTION,
			ENTITY_TYPE_OPTION
		],
		examples: [
			'agent-issues edit ISS1 --body-file /tmp/iss1.md',
			'agent-issues edit HO1 --title "Resume export work" --body-file -'
		],
		notes: [
			"Supply at least one of `--title` or `--body-file`; supplied fields replace their previously stored values.",
			"Use `--body-file` for multiline markdown to avoid shell quoting problems."
		],
		output: {
			human: ["Updated <id> <kind> <title>"],
			json: ["operation", "reference", "revision"]
		}
	},
	{
		name: "link",
		summary: "Create a relation between entities, or from a Plan entry to an issue.",
		usage: ["agent-issues link <fromId> <relationType> <toId>"],
		positionals: [
			{ name: "fromId", description: "Source entity or Plan-entry ID.", required: true },
			{
				name: "relationType",
				description: "Relation type.",
				required: true,
				allowedValues: RELATION_TYPE_VALUES
			},
			{ name: "toId", description: "Target entity ID.", required: true }
		],
		examples: [
			"agent-issues link ISS1 fixes US1",
			"agent-issues link ADR1 constrains ISS1",
			"agent-issues link ISS2 blocks ISS1",
			"agent-issues link ISS1 decomposes ISS7",
			"agent-issues link ISS1 resolves DEBT1",
			"agent-issues link DEBT1 relatesTo ADR1",
			"agent-issues link PLAN_ENTRY1 informs ISS1"
		],
		notes: [
			"Allowed relation pairs are exposed by `agent-issues schema --json`.",
				"A Plan entry can link only to an entity in the current project and only as `informs`.",
			"For structural parent-child work, prefer `create --parent` or `move` over `link` so the intent stays explicit.",
			"Only epics, initiatives, and issues can resolve debt. A resolves link does not change debt lifecycle state.",
			"The CLI rejects self-links and cycle-forming `blocks` or `supersedes` links."
		],
		output: {
			human: [
				"Linked <fromId> -> <toId> as <relationType>",
				"or Relation already existed: <fromId> -> <toId> as <relationType>"
			],
			json: ["relation", "created"]
		}
	},
	{
		name: "unlink",
		summary: "Remove one relation between entities, or from a Plan entry to an issue.",
		usage: ["agent-issues unlink <fromId> <relationType> <toId>"],
		positionals: [
			{ name: "fromId", description: "Source entity or Plan-entry ID.", required: true },
			{
				name: "relationType",
				description: "Relation type.",
				required: true,
				allowedValues: RELATION_TYPE_VALUES
			},
			{ name: "toId", description: "Target entity ID.", required: true }
		],
		examples: ["agent-issues unlink ISS1 fixes US1", "agent-issues unlink PLAN_ENTRY1 informs ISS1"],
		notes: [
			"A Plan entry can unlink only from an issue and only as `informs`.",
			"Unlink rejects structural removals that would orphan a subtree."
		],
		output: {
			human: [
				"Unlinked <fromId> -> <toId> as <relationType>",
				"or Relation did not exist: <fromId> -> <toId> as <relationType>"
			],
			json: ["relation", "removed"]
		}
	},
	{
		name: "show",
		summary: "Show one complete entity or initiative.",
		usage: ["agent-issues show <id>"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
		examples: ["agent-issues show INIT1", "agent-issues show ISS1 --json"],
		notes: [
			"Show is the explicit complete read for authored body content and stored entity fields.",
			"For initiatives, show returns the complete initiative-wide graph and authored records."
		],
		output: {
			human: [
				"For initiatives: InitiativeBundle with complete records",
				"For other kinds: EntityDetails with a complete focused entity"
			],
			json: ["InitiativeBundle | EntityDetails"]
		}
	},
	{
		name: "list",
		summary: "List entities by kind.",
		usage: ["agent-issues list <kind> [--status <comma-separated statuses>] [--parent <id>] [--limit <count>]"],
		positionals: [
			{
				name: "kind",
				description: "Entity kind.",
				required: true,
				allowedValues: ENTITY_KIND_VALUES
			}
		],
		options: [
			{
				name: "--status <comma-separated statuses>",
				description: "Include only entities with a selected status.",
				allowedValues: STATUS_VALUES
			},
			{
				name: "--parent <id>",
				description: "Include only entities with this structural parent."
			},
			{
				name: "--limit <count>",
				description: "Return at most this many entities. Total reports the full filtered count."
			}
		],
		examples: [
			"agent-issues list issue",
			"agent-issues list issue --status todo,in-progress --parent <initiativeId> --limit 20 --json",
			"agent-issues list debt --status open --json"
		],
		notes: [
			"JSON returns { items, total }; total is the filtered count before --limit is applied.",
			"Use --status, --parent, and --limit to select records before serialization.",
			"Accepted status values depend on the entity kind; use agent-issues schema --json to inspect each kind's workflow.",
			"For kind=issue, JSON also returns openBlockers: an entityId -> open (not-done) blocking issue ids map, so a candidate's blocked status is visible without a separate relations call per issue."
		],
		output: {
			human: ["One line per entity: <id> <status> <title>", "Issue lines append (blocked by <id>, ...) when openBlockers is non-empty."],
			json: ["{ items: CompactEntity[], total: number, openBlockers?: Record<string, string[]> }"]
		}
	},
	{
		name: "site",
		summary: "Start the live site in the background and print its URL.",
		usage: ["agent-issues site [--port <port>]", "agent-issues site --stop [--port <port>]", "agent-issues site --json"],
		options: [
			{
				name: "--port <port>",
				description: "Port for the local HTTP server. Defaults to 4173."
			}
		],
		examples: [
			"agent-issues site",
			"agent-issues site --port 4300",
			"agent-issues site --stop"
		],
		notes: [
			"The command starts a detached site process, then returns immediately.",
			"Use agent-issues site --stop to close the live site."
		],
		output: {
			human: [
				"Started live site at <url>"
			],
			json: ["host", "port", "url", "started"]
		}
	},
	{
		name: "help",
		summary: "Show general or command-specific help.",
		usage: ["agent-issues help [command]", "agent-issues <command> --help"],
		positionals: [{ name: "command", description: "Optional command name." }],
		examples: ["agent-issues help", "agent-issues help create --json", "agent-issues create --help"]
	},
	{
		name: "schema",
		summary: "Show machine-discoverable workflow schema and relation rules.",
		usage: ["agent-issues schema", "agent-issues schema --json"],
		examples: ["agent-issues schema", "agent-issues schema --json"],
		notes: [
			"Use this command to discover entity kinds, status flows, allowed relations, structural relations, and archive mappings."
		],
		output: {
			human: [
				"Entity kinds section",
				"Relation types line",
				"Structural relation types line",
				"Allowed relations section",
				"Structural parent rules section"
			],
			json: ["entityKinds", "relationTypes", "allowedRelations", "structuralRelationTypes", "parentRules"]
		}
	},
	{
		name: "capabilities",
		summary: "Show combined help and schema data in one discovery payload.",
		usage: ["agent-issues capabilities", "agent-issues capabilities --json"],
		examples: [
			"agent-issues capabilities",
			"agent-issues capabilities --json"
		],
		notes: ["Use this command when an agent wants the command catalog and workflow schema in one round trip."],
		output: {
			human: [
				"General help text followed by the workflow schema summary"
			],
			json: ["help", "schema"]
		}
	}
];

const COMMAND_SPEC_BY_NAME = new Map(COMMAND_SPECS.map((spec) => [spec.name, spec]));

export function isKnownCommand(commandName: string): boolean {
	return COMMAND_SPEC_BY_NAME.has(commandName);
}

/**
 * Resolves a help lookup from raw positionals to a command spec name,
 * preferring the longest match so multi-word commands (e.g. "auth login")
 * are found before falling back to their first word alone.
 */
export function resolveHelpCommandName(positionals: string[]): string | undefined {
	for (let length = positionals.length; length > 0; length--) {
		const candidate = positionals.slice(0, length).join(" ");
		if (isKnownCommand(candidate)) {
			return candidate;
		}
	}

	return positionals[0];
}

export function getHelpPayload(commandName?: string): HelpPayload {
	const command = commandName ? getCommandSpec(commandName) : undefined;

	return {
		name: "agent-issues",
		summary: "Structured workflow CLI for shared context, initiatives, PRDs, user stories, ADRs, and issues.",
		globalOptions: GLOBAL_OPTIONS,
		commands: COMMAND_SPECS.map((spec) => ({
			name: spec.name,
			summary: spec.summary,
			usage: spec.usage
		})),
		discovery: [
			"Use `agent-issues context --json` to read the current project's shared glossary plus initiative-scoped discovery.",
			"Use `agent-issues current-tenant --json` to see which workspace-derived tenant the CLI will use by default.",
			"Use `agent-issues list-tenants --json` to inspect all tenant namespaces present in the selected database before switching or deleting one.",
			"Use `agent-issues rename-tenant <tenantId> <newTenantId> --force --json` to normalize a tenant namespace without deleting and recreating it.",
			"Use `agent-issues backfill-bodies --json` to fill missing issue, PRD, and user story bodies from existing tracker metadata.",
			"Use `agent-issues context show default --json` to read only the shared glossary.",
			"Use `agent-issues context show <entityOrProjectOrInitiativeId> --json` to read project or initiative context for active work.",
			"Use `agent-issues context search <query> --view initiatives --json` to find initiative-local terminology without reading the full project directory.",
			"Use `agent-issues context conflicts --json` to detect duplicate labels across scopes before you rely on a term.",
			"Use `agent-issues context define <term> --scope <entityOrProjectOrInitiativeId> --body-file <path|-> [--avoid <comma-separated>] --json` to update the scoped glossary when a term is resolved.",
			"Use `agent-issues create plan --parent <initiativeId> --title <title> --body-file <path|-> --json` to create an initiative-owned Plan, then use `agent-issues plan-entry add` to record its planning state and `agent-issues link <planEntryId> informs <issueId>` to connect implementation work.",
			"Use `agent-issues help <command> --json` for command-specific guidance.",
			"Use `agent-issues schema --json` for entity kinds, statuses, and relation rules.",
			"Use `agent-issues site --json` to launch a detached local server with snapshot and event endpoints.",
			"Use `agent-issues site --stop --json` to stop the local server on the default or selected port.",
			"Use `agent-issues capabilities --json` to fetch help and schema data in one call."
		],
		command
	};
}

export function getCapabilitiesPayload(): CapabilitiesPayload {
	return {
		help: getHelpPayload(),
		schema: getSchemaPayload()
	};
}

export function renderHelp(payload: HelpPayload): string {
	if (payload.command) {
		return renderCommandHelp(payload.command);
	}

	const lines = ["agent-issues", "", payload.summary, "", "Commands:"];
	const longestName = Math.max(...payload.commands.map((command) => command.name.length));

	for (const command of payload.commands) {
		lines.push(`  ${command.name.padEnd(longestName)}  ${command.summary}`);
	}

	lines.push("", "Global options:");
	for (const option of payload.globalOptions) {
		lines.push(`  ${option.name.padEnd(18)} ${option.description}`);
	}

	lines.push("", "Discovery:");
	for (const item of payload.discovery) {
		lines.push(`  ${item}`);
	}

	return lines.join("\n");
}

export function getSchemaPayload(): SchemaPayload {
	return {
		entityKinds: ENTITY_KINDS.map((kind) => ({
			kind,
			idPrefix: ID_PREFIX[kind],
			initialStatus: STATUS_FLOW[kind][0],
			statuses: STATUS_FLOW[kind],
			archiveStatus: getArchiveStatus(kind)
		})),
		entityCategories: ENTITY_CATEGORIES,
		entityPriorities: ENTITY_PRIORITIES,
		relationTypes: RELATION_TYPE_VALUES,
		allowedRelations: ALLOWED_RELATIONS,
		structuralRelationTypes: STRUCTURAL_RELATION_TYPES,
		parentRules: ALLOWED_RELATIONS.filter((relation) => isStructuralRelationType(relation.type)).map(
			(relation) => ({
				parentKind: relation.fromKind,
				childKind: relation.toKind,
				relationType: relation.type
			})
		),
		context: {
			storage: "database",
			scopes: ["default", "project", "initiative"],
			defaultKey: DEFAULT_CONTEXT_KEY,
			listCommand: "agent-issues context list --json",
			readCommand: "agent-issues context show [<entityOrProjectOrInitiativeId>|default] --json",
			searchCommand: "agent-issues context search <query> [--view <all|global|initiatives>] --json",
			conflictsCommand: "agent-issues context conflicts [<query>] [--view <all|initiatives>] --json",
			initializeCommand: "agent-issues context set --scope <entityOrProjectOrInitiativeId|default> --title <title> --body-file <path|-> --json",
			defineCommand: "agent-issues context define <term> --scope <entityOrProjectOrInitiativeId|default> --body-file <path|-> [--avoid <comma-separated terms>] --json",
			forgetCommand: "agent-issues context forget <term> --scope <entityOrProjectOrInitiativeId|default> --json",
			termFields: ["term", "definition", "avoid", "createdAt", "updatedAt"]
		},
		issueComments: {
			storage: "database",
			parentKind: "issue",
			recordPrefix: "COM",
			addCommand: "agent-issues comment add <issueId> --body-file <path|-> [--reference <issueId>] --json",
			listCommand: "agent-issues comment list <issueId> [--before <cursor>] [--all] --json",
			editCommand: "agent-issues comment edit <issueId> <commentId> --body-file <path|-> [--reference <issueId>] --json",
			deleteCommand: "agent-issues comment delete <issueId> <commentId> --json",
			historyCommand: "agent-issues comment history <commentId> --json",
			fields: ["id", "reference", "issueId", "body", "referencedIssueIds", "revision", "contentHash", "tombstone", "createdAt", "updatedAt"]
		},
		planEntries: {
			storage: "database",
			parentKind: "plan",
			recordPrefix: "PLAN_ENTRY",
			linkRelationType: "informs",
			linkTargetKind: "entity",
			addCommand: "agent-issues plan-entry add <planId> --role <role> --body-file <path|-> [--reference <entityId>] --json",
			linkCommand: "agent-issues link <planEntryId> informs <targetId> --json",
			unlinkCommand: "agent-issues unlink <planEntryId> informs <targetId> --json",
			fields: ["id", "reference", "planId", "role", "body", "referencedEntityIds", "supersededEntryIds", "revision", "contentHash", "tombstone", "createdAt", "updatedAt"]
		}
	};
}

export function renderSchema(payload: SchemaPayload): string {
	const lines = ["Entity kinds:"];

	for (const entityKind of payload.entityKinds) {
		lines.push(
			`  ${entityKind.kind} (${entityKind.idPrefix}) statuses=${entityKind.statuses.join(", ")} initial=${entityKind.initialStatus} archive=${entityKind.archiveStatus}`
		);
	}

	lines.push("", `Relation types: ${payload.relationTypes.join(", ")}`);
	lines.push("", `Structural relation types: ${payload.structuralRelationTypes.join(", ")}`);
	lines.push("", "Allowed relations:");

	for (const relation of payload.allowedRelations) {
		lines.push(`  ${relation.fromKind} --${relation.type}--> ${relation.toKind}`);
	}

	lines.push("", "Structural parent rules:");
	for (const rule of payload.parentRules) {
		lines.push(`  ${rule.parentKind} --${rule.relationType}--> ${rule.childKind}`);
	}

	lines.push("", "Context:");
	lines.push(`  storage=${payload.context.storage} scopes=${payload.context.scopes.join(", ")} default=${payload.context.defaultKey}`);
	lines.push(`  list: ${payload.context.listCommand}`);
	lines.push(`  read: ${payload.context.readCommand}`);
	lines.push(`  search: ${payload.context.searchCommand}`);
	lines.push(`  conflicts: ${payload.context.conflictsCommand}`);
	lines.push(`  initialize: ${payload.context.initializeCommand}`);
	lines.push(`  define term: ${payload.context.defineCommand}`);
	lines.push(`  forget term: ${payload.context.forgetCommand}`);
	lines.push(`  term fields: ${payload.context.termFields.join(", ")}`);

	lines.push("", "Issue comments:");
	lines.push(`  storage=${payload.issueComments.storage} parent=${payload.issueComments.parentKind} prefix=${payload.issueComments.recordPrefix}`);
	lines.push(`  add: ${payload.issueComments.addCommand}`);
	lines.push(`  list: ${payload.issueComments.listCommand}`);
	lines.push(`  edit: ${payload.issueComments.editCommand}`);
	lines.push(`  delete: ${payload.issueComments.deleteCommand}`);
	lines.push(`  history: ${payload.issueComments.historyCommand}`);
	lines.push(`  fields: ${payload.issueComments.fields.join(", ")}`);

	lines.push("", "Plan entries:");
	lines.push(`  storage=${payload.planEntries.storage} parent=${payload.planEntries.parentKind} prefix=${payload.planEntries.recordPrefix}`);
	lines.push(`  add: ${payload.planEntries.addCommand}`);
	lines.push(`  link: ${payload.planEntries.linkCommand}`);
	lines.push(`  unlink: ${payload.planEntries.unlinkCommand}`);
	lines.push(`  fields: ${payload.planEntries.fields.join(", ")}`);

	return lines.join("\n");
}

function getCommandSpec(commandName: string): CommandSpec {
	const spec = COMMAND_SPEC_BY_NAME.get(commandName);

	if (!spec) {
		throw new Error(`Unknown command: ${commandName}`);
	}

	return spec;
}

function renderCommandHelp(command: CommandSpec): string {
	const lines = [command.name, "", command.summary, "", "Usage:"];

	for (const usage of command.usage) {
		lines.push(`  ${usage}`);
	}

	if (command.positionals && command.positionals.length > 0) {
		lines.push("", "Arguments:");
		for (const positional of command.positionals) {
			lines.push(`  ${formatField(positional.name, positional.description, positional.required, positional.allowedValues)}`);
		}
	}

	const options = dedupeOptions([...(command.options ?? []), ...GLOBAL_OPTIONS]);
	if (options.length > 0) {
		lines.push("", "Options:");
		for (const option of options) {
			lines.push(`  ${formatField(option.name, option.description, option.required, option.allowedValues)}`);
		}
	}

	if (command.examples && command.examples.length > 0) {
		lines.push("", "Examples:");
		for (const example of command.examples) {
			lines.push(`  ${example}`);
		}
	}

	if (command.notes && command.notes.length > 0) {
		lines.push("", "Notes:");
		for (const note of command.notes) {
			lines.push(`  ${note}`);
		}
	}

	if (command.output) {
		lines.push("", "Output:");
		if (command.output.human && command.output.human.length > 0) {
			lines.push("  Human-readable:");
			for (const line of command.output.human) {
				lines.push(`    ${line}`);
			}
		}

		if (command.output.json && command.output.json.length > 0) {
			lines.push("  JSON fields:");
			for (const field of command.output.json) {
				lines.push(`    ${field}`);
			}
		}
	}

	return lines.join("\n");
}

function formatField(
	name: string,
	description: string,
	required?: boolean,
	allowedValues?: readonly string[]
): string {
	const parts = [name, description];

	if (required) {
		parts.push("required");
	}

	if (allowedValues && allowedValues.length > 0) {
		parts.push(`allowed: ${allowedValues.join(", ")}`);
	}

	return parts.join(" | ");
}

function dedupeOptions(options: OptionSpec[]): OptionSpec[] {
	const seen = new Set<string>();
	const deduped: OptionSpec[] = [];

	for (const option of options) {
		if (seen.has(option.name)) {
			continue;
		}

		seen.add(option.name);
		deduped.push(option);
	}

	return deduped;
}