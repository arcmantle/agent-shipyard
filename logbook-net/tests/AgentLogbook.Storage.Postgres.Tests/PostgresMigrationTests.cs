using AgentLogbook.Storage.Postgres;
using Npgsql;

namespace AgentLogbook.Storage.Postgres.Tests;

public class PostgresMigrationTests
{
	private const string CreateLabels = "CREATE TABLE labels (id int PRIMARY KEY, name text NOT NULL);";
	private const string BackfillLabels = "INSERT INTO labels (id, name) VALUES (1, 'draft'), (2, 'ready'); UPDATE labels SET name = upper(name);";
	private const string AddNote = "ALTER TABLE labels ADD COLUMN note text; UPDATE labels SET note = 'backfilled';";

	private const string LabelTable = "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'labels'";

	private static string TableList() => "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'";

	private static readonly PostgresMigration Baseline = PostgresSchemaInitializer.Chain.Migrations[0];

	/// <summary>The signature that a migration sequence must give, found by running it once in a scratch database.</summary>
	private static async Task<string> SignatureAfterAsync(params string[] sql)
	{
		var scratch = await PostgresFixture.CreateDatabaseAsync();
		await scratch.InitializeAsync();
		foreach (var statement in sql)
		{
			await scratch.ExecuteAsync(statement);
		}

		return await scratch.SignatureAsync();
	}

	private static async Task<PostgresMigrationChain> TwoMigrationsAsync() => new(
	[
		Baseline,
		new PostgresMigration("test-1-labels", CreateLabels + BackfillLabels, await SignatureAfterAsync(CreateLabels)),
		new PostgresMigration("test-2-note", AddNote, await SignatureAfterAsync(CreateLabels, AddNote)),
	]);

	[Test]
	public async Task An_upgrade_applies_the_pending_migrations_in_order_and_a_repeated_start_applies_none()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();
		var chain = await TwoMigrationsAsync();

		var upgrade = await database.InitializeAsync(chain);
		var repeat = await database.InitializeAsync(chain);

		await Assert.That(upgrade).IsEqualTo(PostgresSchemaInitialization.Upgraded);
		await Assert.That(repeat).IsEqualTo(PostgresSchemaInitialization.AlreadyCurrent);
		await Assert.That(await database.LedgerAsync()).IsEquivalentTo([Baseline.Id, "test-1-labels", "test-2-note"]);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM labels")).IsEqualTo(2L);
	}

	[Test]
	public async Task An_upgrade_from_a_middle_ledger_applies_only_the_missing_migrations()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		var chain = await TwoMigrationsAsync();
		await database.InitializeAsync(new PostgresMigrationChain([.. chain.Migrations.Take(2)]));

		var result = await database.InitializeAsync(chain);

		await Assert.That(result).IsEqualTo(PostgresSchemaInitialization.Upgraded);
		await Assert.That(await database.LedgerAsync()).IsEquivalentTo([Baseline.Id, "test-1-labels", "test-2-note"]);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM labels WHERE note IS NOT NULL")).IsEqualTo(2L);
	}

	[Test]
	public async Task A_wrong_signature_of_a_middle_migration_fails_even_on_a_fresh_database()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		var good = await TwoMigrationsAsync();
		var chain = new PostgresMigrationChain([Baseline, good.Migrations[1] with { Signature = "wrong" }, good.Migrations[2]]);

		await Assert.ThrowsAsync<UnrecognizedSchemaException>(async () => await database.InitializeAsync(chain));

		await Assert.That(await database.ColumnAsync(TableList())).IsEmpty();
	}

	[Test]
	public async Task A_fresh_database_gets_the_baseline_and_every_later_migration()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();

		var result = await database.InitializeAsync(await TwoMigrationsAsync());

		await Assert.That(result).IsEqualTo(PostgresSchemaInitialization.Created);
		await Assert.That(await database.LedgerAsync()).IsEquivalentTo([Baseline.Id, "test-1-labels", "test-2-note"]);
	}

	[Test]
	public async Task A_migration_can_backfill_data()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();

		await database.InitializeAsync(await TwoMigrationsAsync());

		await Assert.That(await database.ColumnAsync("SELECT name || ':' || note FROM labels ORDER BY id")).IsEquivalentTo(["DRAFT:backfilled", "READY:backfilled"]);
	}

	[Test]
	public async Task Hosts_that_start_together_apply_each_migration_once()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();
		var chain = await TwoMigrationsAsync();

		var results = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => database.InitializeAsync(chain)));

		await Assert.That(results.Count(result => result == PostgresSchemaInitialization.Upgraded)).IsEqualTo(1);
		await Assert.That(results.Count(result => result == PostgresSchemaInitialization.AlreadyCurrent)).IsEqualTo(3);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM labels")).IsEqualTo(2L);
		await Assert.That(await database.LedgerAsync()).IsEquivalentTo([Baseline.Id, "test-1-labels", "test-2-note"]);
	}

	[Test]
	public async Task A_failed_migration_rolls_back_every_schema_data_and_ledger_change()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();
		var chain = new PostgresMigrationChain(
		[
			Baseline,
			new PostgresMigration("test-1-labels", CreateLabels + BackfillLabels, await SignatureAfterAsync(CreateLabels)),
			new PostgresMigration("test-2-broken", "ALTER TABLE labels ADD COLUMN note text; SELECT 1 / 0;", "unused"),
		]);

		await Assert.ThrowsAsync<PostgresException>(async () => await database.InitializeAsync(chain));

		await Assert.That(await database.LedgerAsync()).IsEquivalentTo([Baseline.Id]);
		await Assert.That(await database.ColumnAsync(LabelTable)).IsEmpty();
	}

	[Test]
	public async Task A_failed_post_signature_check_rolls_back_the_migrations()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();
		var chain = new PostgresMigrationChain(
		[
			Baseline,
			new PostgresMigration("test-1-labels", CreateLabels + BackfillLabels, "not-the-signature"),
		]);

		var error = await Assert.ThrowsAsync<UnrecognizedSchemaException>(async () => await database.InitializeAsync(chain));

		await Assert.That(error!.Message).Contains("does not match");
		await Assert.That(await database.LedgerAsync()).IsEquivalentTo([Baseline.Id]);
		await Assert.That(await database.ColumnAsync(LabelTable)).IsEmpty();
	}

	[Test]
	public async Task An_unknown_pre_signature_is_rejected_before_any_migration_runs()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();
		await database.ExecuteAsync("DROP INDEX entities_search_idx");

		var error = await Assert.ThrowsAsync<UnrecognizedSchemaException>(async () => await database.InitializeAsync(await TwoMigrationsAsync()));

		await Assert.That(error!.Message).Contains("does not match");
		await Assert.That(await database.LedgerAsync()).IsEquivalentTo([Baseline.Id]);
		await Assert.That(await database.ColumnAsync(LabelTable)).IsEmpty();
	}

	[Test]
	public async Task A_ledger_that_is_ahead_of_this_storage_is_rejected()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync(await TwoMigrationsAsync());

		var error = await Assert.ThrowsAsync<UnrecognizedSchemaException>(async () => await database.InitializeAsync());

		await Assert.That(error!.Message).Contains("did not write");
		await Assert.That(await database.LedgerAsync()).Count().IsEqualTo(3);
	}

	[Test]
	public async Task The_lock_is_held_for_one_database_schema_and_does_not_block_another_schema()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.ExecuteAsync($"CREATE SCHEMA second AUTHORIZATION {PostgresFixture.Roles.Owner}");
		await using var admin = database.Admin();
		await using var holder = await admin.OpenConnectionAsync();
		await using var hold = await holder.BeginTransactionAsync();
		await using (var lockPublic = new NpgsqlCommand(
			"SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext('public'))", holder, hold))
		{
			await lockPublic.ExecuteNonQueryAsync();
		}

		var blocked = database.InitializeAsync(PostgresSchemaInitializer.Chain);
		while (await database.ScalarAsync<long>("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted") == 0)
		{
			await Task.Delay(50);
		}

		var other = database.InitializeAsync(PostgresSchemaInitializer.Chain, "second");
		var otherResult = await other.WaitAsync(TimeSpan.FromSeconds(30));
		var stillBlocked = !blocked.IsCompleted;
		await hold.CommitAsync();
		var blockedResult = await blocked.WaitAsync(TimeSpan.FromSeconds(30));

		await Assert.That(otherResult).IsEqualTo(PostgresSchemaInitialization.Created);
		await Assert.That(stillBlocked).IsTrue();
		await Assert.That(blockedResult).IsEqualTo(PostgresSchemaInitialization.Created);
	}
}
