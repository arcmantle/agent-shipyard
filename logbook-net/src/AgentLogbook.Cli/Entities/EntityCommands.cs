using System.Globalization;
using System.Text;
using AgentLogbook.Cli.Commands;
using AgentLogbook.Cli.Metadata;
using AgentLogbook.Cli.Storage;
using AgentLogbook.Core.Entities;
using AgentLogbook.Core.Rpc;

namespace AgentLogbook.Cli.Entities;

/// <summary>
/// The <c>create</c>, <c>show</c> and <c>list</c> commands. Each one checks its arguments, then sends one RPC call through
/// <see cref="Client.HttpStore"/> and prints what the TypeScript command prints. A failure prints one line on stderr and exits with 1.
/// </summary>
internal abstract class EntityCommand : ICliCommand
{
	public abstract CommandSpec Spec { get; }

	public int Run(CliInvocation invocation) => RunAsync(invocation, CancellationToken.None).GetAwaiter().GetResult();

	protected abstract Task<int> ExecuteAsync(CliInvocation invocation, CancellationToken cancellationToken);

	private async Task<int> RunAsync(CliInvocation invocation, CancellationToken cancellationToken)
	{
		try
		{
			return await ExecuteAsync(invocation, cancellationToken);
		}
		catch (Exception exception) when (exception is CommandInputException || CliStore.IsReportable(exception))
		{
			return CliStore.Fail(invocation, Spec.Name, exception.Message);
		}
	}

	protected static string RequirePositional(CliInvocation invocation, string usage) =>
		invocation.Positionals.Count > 0 && invocation.Positionals[0].Length > 0
			? invocation.Positionals[0]
			: throw new CommandInputException($"Missing argument. Usage: {usage}");

	protected static string? Option(CliInvocation invocation, string name) => invocation.Parse.GetValue<string>(name);

	protected static void Print(CliInvocation invocation, object json, string text, bool keepNulls = false) =>
		invocation.Runtime.Stdout.Write((invocation.Json ? CliJson.Serialize(json, invocation.Pretty, keepNulls) : text) + "\n");
}

/// <summary>An argument or option that a command refuses before it calls the API host. The message is safe to show.</summary>
internal sealed class CommandInputException(string message) : Exception(message);

internal sealed class CreateCommand : EntityCommand
{
	public override CommandSpec Spec => EntitySpecs.Create;

	protected override async Task<int> ExecuteAsync(CliInvocation invocation, CancellationToken cancellationToken)
	{
		var kind = RequirePositional(invocation, "create <kind>");
		if (!EntityRules.IsKind(kind))
		{
			throw new CommandInputException($"Unknown entity kind: {kind}");
		}

		var body = await ReadBodyFileAsync(Option(invocation, "--body-file"), invocation.Runtime.WorkingDirectory, cancellationToken);
		var title = Option(invocation, "--title");
		if (string.IsNullOrEmpty(title))
		{
			throw new CommandInputException("--title is required for create.");
		}

		using var store = await CliStore.OpenAsync(invocation.Runtime, cancellationToken);
		var entity = await store.CreateEntityAsync(
			new CreateEntityRequest
			{
				Kind = kind,
				Title = title,
				ParentId = Option(invocation, "--parent"),
				Status = Option(invocation, "--status"),
				Body = body,
				Category = Option(invocation, "--category"),
				Priority = Option(invocation, "--priority"),
				Type = Option(invocation, "--type"),
			},
			cancellationToken);

		Print(
			invocation,
			new CreateAcknowledgement("create", entity.Id, entity.Reference, entity.Status, entity.Revision),
			$"{entity.Reference} {entity.Kind} {entity.Status} {entity.Title}");
		return 0;
	}

	/// <summary>The markdown body: the file at <paramref name="path"/>, or standard input for <c>-</c>. Null when the option is not set.</summary>
	private static async Task<string?> ReadBodyFileAsync(string? path, string workingDirectory, CancellationToken cancellationToken)
	{
		if (path is null)
		{
			return null;
		}

		try
		{
			if (path == "-")
			{
				using var stdin = Console.OpenStandardInput();
				using var buffer = new MemoryStream();
				await stdin.CopyToAsync(buffer, cancellationToken);
				return Utf8.GetString(buffer.ToArray());
			}

			return Utf8.GetString(await File.ReadAllBytesAsync(Path.GetFullPath(path, workingDirectory), cancellationToken));
		}
		catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
		{
			throw new CommandInputException(path == "-"
				? $"Could not read --body-file from stdin: {exception.Message}"
				: $"Could not read --body-file {path}: {exception.Message}");
		}
	}

	// A byte order mark stays in the text, as it does when the TypeScript command reads the file.
	private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);
}

internal sealed class ShowCommand : EntityCommand
{
	public override CommandSpec Spec => EntitySpecs.Show;

	protected override async Task<int> ExecuteAsync(CliInvocation invocation, CancellationToken cancellationToken)
	{
		var entityId = RequirePositional(invocation, "show <id>");
		using var store = await CliStore.OpenAsync(invocation.Runtime, cancellationToken);
		var details = await store.GetEntityDetailsAsync(entityId, cancellationToken);

		// The initiative graph and the Plan projection belong to later slices. A plain details print would not be what show prints for them.
		if (details.Entity.Kind is "initiative" or "plan")
		{
			throw new CommandInputException($"Showing {details.Entity.Kind} entities is not available in this release.");
		}

		Print(invocation, details, EntityOutput.RenderDetails(details), keepNulls: true);
		return 0;
	}
}

internal sealed class ListCommand : EntityCommand
{
	public override CommandSpec Spec => EntitySpecs.List;

	protected override async Task<int> ExecuteAsync(CliInvocation invocation, CancellationToken cancellationToken)
	{
		var limit = ParseLimit(Option(invocation, "--limit"));
		var kind = RequirePositional(invocation, "list <kind>");
		if (!EntityRules.IsKind(kind))
		{
			throw new CommandInputException($"Unknown entity kind: {kind}");
		}

		var statuses = (Option(invocation, "--status") ?? string.Empty)
			.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
		if (statuses.FirstOrDefault(status => !EntityRules.IsValidStatus(kind, status)) is { } invalid)
		{
			throw new CommandInputException($"Invalid {kind} status: {invalid}");
		}

		using var store = await CliStore.OpenAsync(invocation.Runtime, cancellationToken);
		var result = await store.QueryEntitiesAsync(
			new QueryEntitiesRequest { Kind = kind, Statuses = statuses, ParentId = Option(invocation, "--parent"), Limit = limit },
			cancellationToken);

		Print(invocation, EntityOutput.ToCompactList(result), EntityOutput.RenderList(kind, result));
		return 0;
	}

	private static int? ParseLimit(string? value)
	{
		if (value is null)
		{
			return null;
		}

		return double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var number)
			&& number >= 1 && number <= int.MaxValue && number == Math.Floor(number)
			? (int)number
			: throw new CommandInputException($"--limit must be a positive integer: {value}");
	}
}
