using System.Text;
using AgentLogbook.Cli.Commands;
using AgentLogbook.Core.WorkflowSchema;

namespace AgentLogbook.Cli.Metadata;

/// <summary>Renders the human-readable help and schema text. The text has no trailing newline.</summary>
public static class MetadataRenderer
{
	public static string RenderHelp(HelpPayload payload)
	{
		if (payload.Command is not null)
		{
			return RenderCommandHelp(payload.Command);
		}

		var lines = new List<string> { payload.Name, "", payload.Summary, "", "Commands:" };
		var longestName = payload.Commands.Max(command => command.Name.Length);
		lines.AddRange(payload.Commands.Select(command => $"  {command.Name.PadRight(longestName)}  {command.Summary}"));

		lines.AddRange(["", "Global options:"]);
		lines.AddRange(payload.GlobalOptions.Select(option => $"  {option.Name.PadRight(18)} {option.Description}"));

		lines.AddRange(["", "Discovery:"]);
		lines.AddRange(payload.Discovery.Select(item => $"  {item}"));
		return string.Join('\n', lines);
	}

	public static string RenderCommandHelp(CommandSpec command)
	{
		var lines = new List<string> { command.Name, "", command.Summary, "", "Usage:" };
		lines.AddRange(command.Usage.Select(usage => $"  {usage}"));

		if (command.Positionals is { Count: > 0 })
		{
			lines.AddRange(["", "Arguments:"]);
			lines.AddRange(command.Positionals.Select(positional =>
				$"  {FormatField(positional.Name, positional.Description, positional.Required, positional.AllowedValues)}"));
		}

		var options = DedupeOptions([.. command.Options ?? [], .. CommandCatalog.GlobalOptions]);
		if (options.Count > 0)
		{
			lines.AddRange(["", "Options:"]);
			lines.AddRange(options.Select(option =>
				$"  {FormatField(option.Name, option.Description, option.Required, option.AllowedValues)}"));
		}

		AddSection(lines, "Examples:", command.Examples, "  ");
		AddSection(lines, "Notes:", command.Notes, "  ");

		if (command.Output is { } output)
		{
			lines.AddRange(["", "Output:"]);
			if (output.Human is { Count: > 0 })
			{
				lines.Add("  Human-readable:");
				lines.AddRange(output.Human.Select(line => $"    {line}"));
			}

			if (output.Json is { Count: > 0 })
			{
				lines.Add("  JSON fields:");
				lines.AddRange(output.Json.Select(field => $"    {field}"));
			}
		}

		return string.Join('\n', lines);
	}

	public static string RenderSchema(WorkflowSchema schema)
	{
		var lines = new List<string> { "Entity kinds:" };
		lines.AddRange(schema.EntityKinds.Select(kind =>
			$"  {kind.Kind} ({kind.IdPrefix}) statuses={Join(kind.Statuses)} initial={kind.InitialStatus} archive={kind.ArchiveStatus}"));

		lines.AddRange(["", $"Relation types: {Join(schema.RelationTypes)}"]);
		lines.AddRange(["", $"Structural relation types: {Join(schema.StructuralRelationTypes)}"]);
		lines.AddRange(["", "Allowed relations:"]);
		lines.AddRange(schema.AllowedRelations.Select(relation => $"  {relation.FromKind} --{relation.Type}--> {relation.ToKind}"));

		lines.AddRange(["", "Structural parent rules:"]);
		lines.AddRange(schema.ParentRules.Select(rule => $"  {rule.ParentKind} --{rule.RelationType}--> {rule.ChildKind}"));

		var context = schema.Context;
		lines.AddRange(["", "Context:"]);
		lines.Add($"  storage={context.Storage} scopes={Join(context.Scopes)} default={context.DefaultKey}");
		lines.Add($"  list: {context.ListCommand}");
		lines.Add($"  read: {context.ReadCommand}");
		lines.Add($"  search: {context.SearchCommand}");
		lines.Add($"  conflicts: {context.ConflictsCommand}");
		lines.Add($"  initialize: {context.InitializeCommand}");
		lines.Add($"  define term: {context.DefineCommand}");
		lines.Add($"  forget term: {context.ForgetCommand}");
		lines.Add($"  term fields: {Join(context.TermFields)}");

		var comments = schema.IssueComments;
		lines.AddRange(["", "Issue comments:"]);
		lines.Add($"  storage={comments.Storage} parent={comments.ParentKind} prefix={comments.RecordPrefix}");
		lines.Add($"  add: {comments.AddCommand}");
		lines.Add($"  list: {comments.ListCommand}");
		lines.Add($"  edit: {comments.EditCommand}");
		lines.Add($"  delete: {comments.DeleteCommand}");
		lines.Add($"  history: {comments.HistoryCommand}");
		lines.Add($"  fields: {Join(comments.Fields)}");

		var entries = schema.PlanEntries;
		lines.AddRange(["", "Plan entries:"]);
		lines.Add($"  storage={entries.Storage} parent={entries.ParentKind} prefix={entries.RecordPrefix}");
		lines.Add($"  add: {entries.AddCommand}");
		lines.Add($"  link: {entries.LinkCommand}");
		lines.Add($"  unlink: {entries.UnlinkCommand}");
		lines.Add($"  fields: {Join(entries.Fields)}");

		return string.Join('\n', lines);
	}

	/// <summary>The general help followed by the schema, as <c>capabilities</c> prints it.</summary>
	public static string RenderCapabilities(CapabilitiesPayload payload) =>
		$"{RenderHelp(payload.Help)}\n\n{RenderSchema(payload.Schema)}";

	private static string Join(IEnumerable<string> values) => string.Join(", ", values);

	private static void AddSection(List<string> lines, string title, IReadOnlyList<string>? items, string indent)
	{
		if (items is not { Count: > 0 })
		{
			return;
		}

		lines.AddRange(["", title]);
		lines.AddRange(items.Select(item => indent + item));
	}

	private static string FormatField(string name, string description, bool? required, IReadOnlyList<string>? allowedValues)
	{
		var builder = new StringBuilder().Append(name).Append(" | ").Append(description);
		if (required == true)
		{
			builder.Append(" | required");
		}

		if (allowedValues is { Count: > 0 })
		{
			builder.Append(" | allowed: ").Append(Join(allowedValues));
		}

		return builder.ToString();
	}

	private static List<OptionSpec> DedupeOptions(IEnumerable<OptionSpec> options)
	{
		var seen = new HashSet<string>(StringComparer.Ordinal);
		return [.. options.Where(option => seen.Add(option.Name))];
	}
}
