using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Core.Tests.LocalApi;

public class LocalPostgresSelectionTests
{
	private const string FromEnvironment = "postgres://env_user:env_pw@env-host:6001/env_db";
	private const string FromFile = "postgresql://file_user:file_pw@file-host:6002/file_db";

	private static string NewShipyard() => Directory.CreateTempSubdirectory("logbook-local-pg-").FullName;

	private static ShipyardLogbookFolder FolderIn(string shipyard) =>
		ShipyardLogbookFolder.Resolve(name => name == ShipyardLogbookFolder.HomeVariable ? shipyard : null, shipyard).EnsureExists();

	private static void WriteSettings(ShipyardLogbookFolder folder, string json) => File.WriteAllText(folder.SettingsFile, json);

	private static Func<string, string?> Env(params (string Name, string Value)[] variables) =>
		name => variables.Where(v => v.Name == name).Select(v => v.Value).FirstOrDefault();

	[Test]
	public async Task Environment_variable_wins_over_the_settings_file_and_the_default()
	{
		var folder = FolderIn(NewShipyard());
		WriteSettings(folder, $$"""{ "postgresUrl": "{{FromFile}}" }""");

		var selection = LocalPostgresSelection.Select(Env((LocalPostgresSelection.UrlVariable, FromEnvironment)), folder);

		await Assert.That(selection.Source).IsEqualTo(LocalPostgresSource.Environment);
		await Assert.That(selection.Connection.Host).IsEqualTo("env-host");
		await Assert.That(selection.Connection.Port).IsEqualTo(6001);
		await Assert.That(selection.Connection.Database).IsEqualTo("env_db");
		await Assert.That(selection.Connection.Username).IsEqualTo("env_user");
		await Assert.That(selection.Connection.Password).IsEqualTo("env_pw");
	}

	[Test]
	public async Task Settings_file_wins_over_the_default_when_the_variable_is_missing()
	{
		var folder = FolderIn(NewShipyard());
		WriteSettings(folder, $$"""{ "postgresUrl": "{{FromFile}}" }""");

		var missing = LocalPostgresSelection.Select(Env(), folder);

		await Assert.That(missing.Source).IsEqualTo(LocalPostgresSource.SettingsFile);
		await Assert.That(missing.Connection.Host).IsEqualTo("file-host");
	}

	[Test]
	[Arguments("")]
	[Arguments("   ")]
	public async Task A_blank_environment_variable_is_an_error_and_not_a_fall_back(string value)
	{
		var folder = FolderIn(NewShipyard());
		WriteSettings(folder, $$"""{ "postgresUrl": "{{FromFile}}" }""");

		await Assert.That(() => LocalPostgresSelection.Select(Env((LocalPostgresSelection.UrlVariable, value)), folder))
			.Throws<LocalPostgresSettingsException>();
	}

	[Test]
	public async Task Built_in_default_is_used_without_variable_and_without_a_setting()
	{
		var folder = FolderIn(NewShipyard());
		var noSetting = FolderIn(NewShipyard());
		WriteSettings(noSetting, "{ \"other\": 1 }");

		foreach (var candidate in new[] { folder, noSetting })
		{
			var selection = LocalPostgresSelection.Select(Env(), candidate);

			await Assert.That(selection.Source).IsEqualTo(LocalPostgresSource.BuiltInDefault);
			await Assert.That(selection.Connection).IsEqualTo(LocalPostgresConnection.Parse(LocalPostgresSelection.DefaultUrl));
		}
	}

	[Test]
	public async Task Production_database_url_never_selects_the_local_database()
	{
		var folder = FolderIn(NewShipyard());
		var production = "postgres://prod_user:prod_pw@prod-host:5432/prod_db";

		var selection = LocalPostgresSelection.Select(Env(("DATABASE_URL", production)), folder);

		await Assert.That(selection.Source).IsEqualTo(LocalPostgresSource.BuiltInDefault);
		await Assert.That(selection.Connection.Host).IsNotEqualTo("prod-host");
	}

	[Test]
	public async Task Production_database_url_does_not_replace_an_invalid_local_selection()
	{
		var folder = FolderIn(NewShipyard());

		await Assert.That(() => LocalPostgresSelection.Select(
				Env((LocalPostgresSelection.UrlVariable, "not a url"), ("DATABASE_URL", FromFile)), folder))
			.Throws<LocalPostgresSettingsException>();
	}

	[Test]
	[Arguments("not a url")]
	[Arguments("mysql://u:p@h:3306/db")]
	[Arguments("postgres://u:p@/db")]
	[Arguments("postgres://u:p@h:5432")]
	[Arguments("postgres://u:p@h:5432/a/b")]
	[Arguments("postgres://:p@h:5432/db")]
	[Arguments("postgres://h:5432/db")]
	[Arguments("postgres://u:p@h:5432/db?sslmode=disable")]
	[Arguments("postgres://u:p@h:99999/db")]
	public async Task Invalid_environment_value_fails_and_does_not_fall_back_to_the_file_or_default(string value)
	{
		var folder = FolderIn(NewShipyard());
		WriteSettings(folder, $$"""{ "postgresUrl": "{{FromFile}}" }""");

		var exception = await Assert.That(() => LocalPostgresSelection.Select(Env((LocalPostgresSelection.UrlVariable, value)), folder))
			.Throws<LocalPostgresSettingsException>();

		await Assert.That(exception!.Message).Contains(LocalPostgresSelection.UrlVariable);
	}

	[Test]
	[Arguments("{ not json")]
	[Arguments("[]")]
	[Arguments("{ \"postgresUrl\": 5 }")]
	[Arguments("{ \"postgresUrl\": \"\" }")]
	[Arguments("{ \"postgresUrl\": null }")]
	[Arguments("{ \"postgresUrl\": \"http://h/db\" }")]
	public async Task Invalid_settings_file_fails_and_does_not_fall_back_to_the_default(string json)
	{
		var folder = FolderIn(NewShipyard());
		WriteSettings(folder, json);

		var exception = await Assert.That(() => LocalPostgresSelection.Select(Env(), folder)).Throws<LocalPostgresSettingsException>();

		await Assert.That(exception!.Message).Contains(folder.SettingsFile);
	}

	[Test]
	public async Task Unreadable_settings_file_fails_and_does_not_fall_back_to_the_default()
	{
		var folder = FolderIn(NewShipyard());
		Directory.CreateDirectory(folder.SettingsFile);

		await Assert.That(() => LocalPostgresSelection.Select(Env(), folder)).Throws<LocalPostgresSettingsException>();
	}

	[Test]
	public async Task Errors_and_descriptions_never_contain_the_password()
	{
		var folder = FolderIn(NewShipyard());
		var secret = "s3cr3t-pw";

		var exception = await Assert.That(() => LocalPostgresSelection.Select(
				Env((LocalPostgresSelection.UrlVariable, $"postgres://u:{secret}@h:5432/a/b")), folder))
			.Throws<LocalPostgresSettingsException>();
		var description = LocalPostgresConnection.Parse($"postgres://u:{secret}@h/db").ToString();

		await Assert.That(exception!.Message).DoesNotContain(secret);
		await Assert.That(description).DoesNotContain(secret);
	}

	[Test]
	public async Task Percent_encoded_credentials_are_decoded_and_a_missing_port_is_5432()
	{
		var connection = LocalPostgresConnection.Parse("postgres://us%40er:p%3Aw%2Fd@host/my%20db");

		await Assert.That(connection.Username).IsEqualTo("us@er");
		await Assert.That(connection.Password).IsEqualTo("p:w/d");
		await Assert.That(connection.Database).IsEqualTo("my db");
		await Assert.That(connection.Port).IsEqualTo(5432);
	}
}
