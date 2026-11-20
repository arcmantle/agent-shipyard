using AgentLogbook.Cli.Commands;
using AgentLogbook.Core.WorkflowSchema;

namespace AgentLogbook.Cli.Entities;

/// <summary>The help text of the entity commands. The workflow values come from the embedded workflow schema.</summary>
internal static class EntitySpecs
{
	private static readonly WorkflowSchema Schema = WorkflowSchema.Current;

	public static IReadOnlyList<string> Kinds { get; } = [.. Schema.EntityKinds.Select(kind => kind.Kind)];

	/// <summary>Every status of any kind, sorted. A status filter and an override name one of them; the kind decides which are valid.</summary>
	private static IReadOnlyList<string> Statuses { get; } =
		[.. Schema.EntityKinds.SelectMany(kind => kind.Statuses).Distinct().Order(StringComparer.Ordinal)];

	public static CommandSpec Create { get; } = new(
		"create",
		"Create an entity, optionally under a structural parent.",
		["agent-logbook create <kind> --title <title> [--parent <id>] [--status <status>] [--body-file <path|->]"],
		Positionals: [new PositionalSpec("kind", "Entity kind to create.", Required: true, AllowedValues: Kinds)],
		Options:
		[
			new OptionSpec("--title <title>", "Entity title.", Required: true),
			new OptionSpec("--category <category>", "Set a category. Debt creation requires a category.", AllowedValues: Schema.EntityCategories),
			new OptionSpec("--priority <priority>", "Set a priority. Debt creation requires a priority.", AllowedValues: Schema.EntityPriorities),
			new OptionSpec("--type <type>", "Set a kind-specific entity type.", AllowedValues: ["pioneer-map", "pioneer-ticket"]),
			new OptionSpec("--parent <id>", "Structural parent ID when one is required by the workflow."),
			new OptionSpec("--status <status>", "Override the default initial status.", AllowedValues: Statuses),
			new OptionSpec("--body-file <path|->", "Read the authored markdown body from a file, or from stdin when the value is `-`."),
		],
		Examples:
		[
			"agent-logbook create initiative --title \"Workflow tooling\"",
			"agent-logbook create plan --title \"Routing decision\" --parent INIT1 --body-file -",
			"agent-logbook create prd --title \"Handoff support\" --parent INIT1",
			"agent-logbook create issue --title \"Add help schema\" --parent INIT1",
			"agent-logbook create debt --title \"Replace legacy worker\" --parent INIT1 --category technical --priority high",
			"agent-logbook create issue --title \"Split parser edge cases\" --parent ISS1",
			"agent-logbook create issue --title \"Add help schema\" --parent INIT1 --body-file /tmp/iss1.md",
		],
		Notes:
		[
			"Valid structural parent-child pairs are exposed by `agent-logbook schema --json`.",
			"A Plan requires an initiative parent. Use `plan-entry` to record its questions and decisions.",
			"Issues can be created under initiatives as tracked work, or under other issues as structural sub-issues.",
			"If no status is supplied, the CLI uses the first status in the workflow for that kind.",
			"Use `--body-file` for multiline markdown to avoid shell quoting problems.",
			"Debt requires one project, epic, initiative, or issue parent, plus category and priority.",
		],
		Output: new OutputSpec(Human: ["<id> <kind> <status> <title>"], Json: ["operation", "reference", "status", "revision"]));

	public static CommandSpec Show { get; } = new(
		"show",
		"Show one complete entity or initiative.",
		["agent-logbook show <id>"],
		Positionals: [new PositionalSpec("id", "Entity ID.", Required: true)],
		Examples: ["agent-logbook show INIT1", "agent-logbook show ISS1 --json"],
		Notes:
		[
			"Show is the explicit complete read for authored body content and stored entity fields.",
			"For initiatives, show returns the complete initiative-wide graph and authored records.",
		],
		Output: new OutputSpec(
			Human: ["For initiatives: InitiativeBundle with complete records", "For other kinds: EntityDetails with a complete focused entity"],
			Json: ["InitiativeBundle | EntityDetails"]));

	public static CommandSpec List { get; } = new(
		"list",
		"List entities by kind.",
		["agent-logbook list <kind> [--status <comma-separated statuses>] [--parent <id>] [--limit <count>]"],
		Positionals: [new PositionalSpec("kind", "Entity kind.", Required: true, AllowedValues: Kinds)],
		Options:
		[
			new OptionSpec("--status <comma-separated statuses>", "Include only entities with a selected status.", AllowedValues: Statuses),
			new OptionSpec("--parent <id>", "Include only entities with this structural parent."),
			new OptionSpec("--limit <count>", "Return at most this many entities. Total reports the full filtered count."),
		],
		Examples:
		[
			"agent-logbook list issue",
			"agent-logbook list issue --status todo,in-progress --parent <initiativeId> --limit 20 --json",
			"agent-logbook list debt --status open --json",
		],
		Notes:
		[
			"JSON returns { items, total }; total is the filtered count before --limit is applied.",
			"Use --status, --parent, and --limit to select records before serialization.",
			"Accepted status values depend on the entity kind; use agent-logbook schema --json to inspect each kind's workflow.",
			"For kind=issue, JSON also returns openBlockers: an entityId -> open (not-done) blocking issue ids map, so a candidate's blocked status is visible without a separate relations call per issue.",
		],
		Output: new OutputSpec(
			Human:
			[
				"One line per entity: <id> <status> <title>",
				"Issue lines append (blocked by <id>, ...) when openBlockers is non-empty.",
			],
			Json: ["{ items: CompactEntity[], total: number, openBlockers?: Record<string, string[]> }"]));
}
