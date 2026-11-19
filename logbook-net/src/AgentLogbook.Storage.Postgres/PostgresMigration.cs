namespace AgentLogbook.Storage.Postgres;

/// <summary>
/// One forward-only schema change. <see cref="Signature"/> is the schema signature that the database must have
/// after this migration, and so also before the next one.
/// </summary>
internal sealed record PostgresMigration(string Id, string Sql, string Signature);

/// <summary>An ordered migration sequence. The first migration creates the whole final schema.</summary>
internal sealed class PostgresMigrationChain
{
	public PostgresMigrationChain(IReadOnlyList<PostgresMigration> migrations)
	{
		ArgumentNullException.ThrowIfNull(migrations);
		if (migrations.Count == 0)
		{
			throw new ArgumentException("A migration chain needs at least a baseline.", nameof(migrations));
		}

		if (migrations.Select(migration => migration.Id).Distinct(StringComparer.Ordinal).Count() != migrations.Count)
		{
			throw new ArgumentException("Migration IDs must be unique.", nameof(migrations));
		}

		Migrations = migrations;
	}

	public IReadOnlyList<PostgresMigration> Migrations { get; }

	public IReadOnlyList<string> Ids => [.. Migrations.Select(migration => migration.Id)];

	public PostgresMigration Last => Migrations[^1];
}
