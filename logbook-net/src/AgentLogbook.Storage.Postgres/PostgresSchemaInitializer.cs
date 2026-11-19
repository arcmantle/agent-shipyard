using System.Reflection;
using Dapper;
using Npgsql;

namespace AgentLogbook.Storage.Postgres;

/// <summary>What <see cref="PostgresSchemaInitializer"/> did to the database.</summary>
public enum PostgresSchemaInitialization
{
	/// <summary>The schema was empty. The initializer created the final schema and recorded the baseline.</summary>
	Created,

	/// <summary>The schema was already the final schema. The initializer changed no schema object.</summary>
	AlreadyCurrent,

	/// <summary>The schema was a known earlier version. The initializer applied the pending migrations.</summary>
	Upgraded,
}

/// <summary>
/// Creates, upgrades, or validates the Logbook schema at API host startup. All work happens in one transaction
/// under one advisory lock for the database and schema, so a failure changes nothing and two hosts that
/// start together do not race. Every migration runs once, in order, and the schema signature is checked
/// before the sequence and after it.
/// </summary>
public static class PostgresSchemaInitializer
{
	/// <summary>The ledger entry of the final schema. It is not an ID of the TypeScript migration sequence.</summary>
	public const string BaselineId = "agent-logbook-baseline-1";

	/// <summary>The migrations of this storage in the order that it applies them. A later change adds one entry here.</summary>
	internal static readonly PostgresMigrationChain Chain = new([new PostgresMigration(BaselineId, ReadBaselineScript(), BaselineSignature)]);

	/// <summary>The signature of the schema that the baseline script creates. It equals the signature of the final schema of the TypeScript storage.</summary>
	internal const string BaselineSignature = "22367ba1b048aa18db5ff505027e3bb8c6583111eb5d3d3c4367db95c07332e0";

	private const string LedgerTable = "schema_migrations";

	private const string CreateLedgerSql = $"""
		CREATE TABLE {LedgerTable} (
			id text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
		""";

	/// <summary>
	/// Initializes the schema that the connections of <paramref name="dataSource"/> use by default.
	/// With <paramref name="roles"/>, the transaction acts as the schema owner and the runtime role
	/// gets the reviewed table privileges. Without roles, the connection user owns the schema.
	/// </summary>
	/// <exception cref="UnrecognizedSchemaException">The schema is not empty and is not the final schema.</exception>
	public static Task<PostgresSchemaInitialization> InitializeAsync(
		NpgsqlDataSource dataSource,
		PostgresSchemaRoles? roles = null,
		CancellationToken cancellationToken = default) =>
		InitializeAsync(dataSource, Chain, roles, cancellationToken);

	internal static async Task<PostgresSchemaInitialization> InitializeAsync(
		NpgsqlDataSource dataSource,
		PostgresMigrationChain chain,
		PostgresSchemaRoles? roles = null,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(dataSource);
		ArgumentNullException.ThrowIfNull(chain);

		await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
		await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
		try
		{
			if (roles is not null)
			{
				await connection.ExecuteAsync($"SET LOCAL ROLE {Quote(roles.Owner)}", transaction: transaction);
			}

			if (await connection.ExecuteScalarAsync<string?>("SELECT current_schema()", transaction: transaction) is null)
			{
				throw new InvalidOperationException("The connection search_path names no existing schema, so the schema cannot be initialized.");
			}

			await connection.ExecuteAsync(
				"SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext(current_schema()))",
				transaction: transaction);

			var result = await EnsureFinalSchemaAsync(connection, transaction, chain);
			if (roles is not null)
			{
				await RequireOwnerAsync(connection, transaction, roles);
				await ApplyRuntimePrivilegesAsync(connection, transaction, roles);
			}

			await transaction.CommitAsync(cancellationToken);
			return result;
		}
		catch
		{
			try
			{
				await transaction.RollbackAsync(CancellationToken.None);
			}
			catch (Exception rollbackFailure) when (rollbackFailure is NpgsqlException or InvalidOperationException)
			{
				// The server ends the transaction when the connection is lost. Keep the original error.
			}

			throw;
		}
	}

	private static async Task<PostgresSchemaInitialization> EnsureFinalSchemaAsync(
		NpgsqlConnection connection,
		NpgsqlTransaction transaction,
		PostgresMigrationChain chain)
	{
		var schema = (await connection.ExecuteScalarAsync<string>("SELECT current_schema()", transaction: transaction))!;

		if (await PostgresSchemaCatalog.CountObjectsAsync(connection) == 0)
		{
			await connection.ExecuteAsync(CreateLedgerSql, transaction: transaction);
			await ApplyAsync(connection, transaction, schema, chain.Migrations);
			return PostgresSchemaInitialization.Created;
		}

		var ledgerIds = await ReadLedgerAsync(connection, transaction);
		if (ledgerIds is null)
		{
			throw new UnrecognizedSchemaException(
				$"Schema '{schema}' already has objects but no '{LedgerTable}' ledger. "
				+ "Agent Logbook does not adopt a database that it did not create. Use an empty database.");
		}

		var knownIds = chain.Ids;
		var typescriptIds = ledgerIds.Where(id => !knownIds.Contains(id)).ToArray();
		if (typescriptIds.Length > 0)
		{
			var origin = typescriptIds.Contains("final-baseline", StringComparer.Ordinal)
				? "was made by the TypeScript storage"
				: "has ledger entries that this storage did not write";
			throw new UnrecognizedSchemaException(
				$"The database {origin} ({string.Join(", ", typescriptIds.Take(3))}"
				+ $"{(typescriptIds.Length > 3 ? ", ..." : "")}). Agent Logbook does not adopt it. Use an empty database.");
		}

		if (ledgerIds.Count == 0 || !ledgerIds.SequenceEqual(knownIds.Take(ledgerIds.Count)))
		{
			throw new UnrecognizedSchemaException(
				$"The '{LedgerTable}' ledger does not list the Agent Logbook migrations in order.");
		}

		// The schema must be exactly the version that the ledger claims before any migration changes it.
		await RequireSignatureAsync(connection, schema, chain.Migrations[ledgerIds.Count - 1].Signature);
		if (ledgerIds.Count == chain.Migrations.Count)
		{
			return PostgresSchemaInitialization.AlreadyCurrent;
		}

		await ApplyAsync(connection, transaction, schema, chain.Migrations.Skip(ledgerIds.Count));
		return PostgresSchemaInitialization.Upgraded;
	}

	private static async Task ApplyAsync(
		NpgsqlConnection connection,
		NpgsqlTransaction transaction,
		string schema,
		IEnumerable<PostgresMigration> migrations)
	{
		foreach (var migration in migrations)
		{
			await connection.ExecuteAsync(migration.Sql, transaction: transaction);
			await connection.ExecuteAsync(
				$"INSERT INTO {LedgerTable} (id, applied_at) VALUES (@id, clock_timestamp())",
				new { id = migration.Id },
				transaction);
			// Each step must give the signature that the next start expects before it, not only the last step.
			await RequireSignatureAsync(connection, schema, migration.Signature);
		}
	}

	private static async Task RequireSignatureAsync(NpgsqlConnection connection, string schema, string expected)
	{
		var signature = await PostgresSchemaCatalog.ComputeSignatureAsync(connection);
		if (signature != expected)
		{
			throw new UnrecognizedSchemaException(
				$"The schema '{schema}' does not match the expected Agent Logbook schema (signature {signature}, expected {expected}).");
		}
	}

	/// <summary>The ledger IDs in the order that they were applied, or null if there is no ledger.</summary>
	private static async Task<IReadOnlyList<string>?> ReadLedgerAsync(NpgsqlConnection connection, NpgsqlTransaction transaction)
	{
		var isLedger = await connection.ExecuteScalarAsync<bool>(
			$"""
			SELECT EXISTS (
				SELECT 1 FROM pg_class relation
				JOIN pg_attribute id ON id.attrelid = relation.oid AND id.attname = 'id' AND id.atttypid = 'text'::regtype
				JOIN pg_attribute applied_at ON applied_at.attrelid = relation.oid AND applied_at.attname = 'applied_at'
				WHERE relation.relnamespace = current_schema()::regnamespace AND relation.relname = '{LedgerTable}' AND relation.relkind = 'r')
			""",
			transaction: transaction);
		if (!isLedger)
		{
			return null;
		}

		var ids = await connection.QueryAsync<string>(
			$"SELECT id FROM {LedgerTable} ORDER BY applied_at, id",
			transaction: transaction);
		return ids.ToList();
	}

	/// <summary>
	/// Grants on an object that the acting role does not own do nothing, without an error. Fail instead of
	/// reporting success with grants that never applied.
	/// </summary>
	private static async Task RequireOwnerAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, PostgresSchemaRoles roles)
	{
		var foreign = (await connection.QueryAsync<string>(
			"""
			SELECT relation.relname FROM pg_class relation
			WHERE relation.relnamespace = current_schema()::regnamespace AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
				AND relation.relowner <> to_regrole(@owner)
			ORDER BY relation.relname
			""",
			new { owner = roles.Owner },
			transaction)).ToArray();
		if (foreign.Length > 0)
		{
			throw new InvalidOperationException(
				$"The schema objects {string.Join(", ", foreign)} are not owned by '{roles.Owner}'. Agent Logbook does not change grants on them.");
		}
	}

	/// <summary>
	/// Gives the runtime role only the reviewed table access: read and write on tenant tables, read on the
	/// instruction default tables, and nothing on any table that a later migration adds until it is reviewed.
	/// The caller's transaction must act as the schema owner.
	/// </summary>
	private static async Task ApplyRuntimePrivilegesAsync(
		NpgsqlConnection connection,
		NpgsqlTransaction transaction,
		PostgresSchemaRoles roles)
	{
		var owner = Quote(roles.Owner);
		var runtime = Quote(roles.Runtime);
		var migration = Quote(roles.Migration);

		string[] statements =
		[
			"REVOKE ALL ON SCHEMA {schema} FROM " + runtime + ", " + migration,
			"GRANT USAGE ON SCHEMA {schema} TO " + runtime,
			"ALTER DEFAULT PRIVILEGES FOR ROLE " + owner + " REVOKE ALL ON TABLES FROM " + runtime + ", PUBLIC",
			"ALTER DEFAULT PRIVILEGES FOR ROLE " + owner + " IN SCHEMA {schema} REVOKE ALL ON TABLES FROM " + runtime + ", PUBLIC",
			"REVOKE ALL ON ALL TABLES IN SCHEMA {schema} FROM " + runtime + ", PUBLIC",
		];
		var schema = Quote((await connection.ExecuteScalarAsync<string>("SELECT current_schema()", transaction: transaction))!);
		foreach (var statement in statements)
		{
			await connection.ExecuteAsync(statement.Replace("{schema}", schema, StringComparison.Ordinal), transaction: transaction);
		}

		var columnGrants = await connection.QueryAsync<(string Table, string Column)>(
			"""
			SELECT relation.relname, attribute.attname FROM pg_attribute attribute
			JOIN pg_class relation ON relation.oid = attribute.attrelid
			WHERE relation.relnamespace = current_schema()::regnamespace
				AND attribute.attnum > 0 AND NOT attribute.attisdropped AND attribute.attacl IS NOT NULL
			""",
			transaction: transaction);
		foreach (var (table, column) in columnGrants)
		{
			await connection.ExecuteAsync(
				$"REVOKE ALL ({Quote(column)}) ON {schema}.{Quote(table)} FROM {runtime}, PUBLIC",
				transaction: transaction);
		}

		var tables = await connection.QueryAsync<(string Name, bool TenantScoped)>(
			"""
			SELECT relname, relrowsecurity AND relforcerowsecurity FROM pg_class
			WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p')
				AND ((relrowsecurity AND relforcerowsecurity) OR relname IN ('instruction_bundles', 'instruction_defaults'))
			""",
			transaction: transaction);
		foreach (var (name, tenantScoped) in tables)
		{
			var privileges = tenantScoped ? "SELECT, INSERT, UPDATE, DELETE" : "SELECT";
			await connection.ExecuteAsync($"GRANT {privileges} ON {schema}.{Quote(name)} TO {runtime}", transaction: transaction);
		}
	}

	private static string ReadBaselineScript()
	{
		using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("AgentLogbook.Storage.Postgres.Schema.baseline.sql")
			?? throw new InvalidOperationException("The baseline schema script is not embedded.");
		using var reader = new StreamReader(stream);
		return reader.ReadToEnd();
	}

	private static string Quote(string identifier) => "\"" + identifier.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
}
