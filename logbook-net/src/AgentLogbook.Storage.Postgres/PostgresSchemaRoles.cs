using System.Text.RegularExpressions;

namespace AgentLogbook.Storage.Postgres;

/// <summary>
/// The three database roles of the production database contract. The owner role owns the schema and is
/// the only role that changes it. The migration role may act as the owner. The runtime role gets only
/// the reviewed table privileges.
/// </summary>
public sealed partial record PostgresSchemaRoles
{
	public PostgresSchemaRoles(string owner, string runtime, string migration)
	{
		Owner = Validate(owner);
		Runtime = Validate(runtime);
		Migration = Validate(migration);
		if (new HashSet<string>([Owner, Runtime, Migration]).Count != 3)
		{
			throw new ArgumentException("The owner, runtime, and migration roles must be three different roles.");
		}
	}

	public string Owner { get; }

	public string Runtime { get; }

	public string Migration { get; }

	private static string Validate(string role) =>
		RoleName().IsMatch(role) && !role.StartsWith("pg_", StringComparison.Ordinal)
			? role
			: throw new ArgumentException($"'{role}' is not a valid database role name.", nameof(role));

	[GeneratedRegex("^[a-z][a-z0-9_]{0,62}$")]
	private static partial Regex RoleName();
}
