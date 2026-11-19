using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Core.Tests.ShipyardData;

public class ShipyardLogbookFolderTests
{
	private static readonly string Root = Directory.CreateTempSubdirectory("logbook-shipyard-").FullName;

	private static Func<string, string?> Env(string? shipyardHome) =>
		name => name == ShipyardLogbookFolder.HomeVariable ? shipyardHome : null;

	private static string Under(params string[] parts) => Path.Combine([Root, .. parts]);

	[Test]
	public async Task Environment_override_selects_the_logbook_subfolder_of_the_given_folder()
	{
		var folder = ShipyardLogbookFolder.Resolve(Env(Under("override")), Under("home"));

		await Assert.That(folder.Path).IsEqualTo(Under("override", "logbook"));
	}

	[Test]
	public async Task Without_an_override_the_default_is_agent_shipyard_in_the_home_folder()
	{
		await Assert.That(ShipyardLogbookFolder.Resolve(Env(null), Under("home")).Path)
			.IsEqualTo(Under("home", ".agent-shipyard", "logbook"));
		await Assert.That(ShipyardLogbookFolder.Resolve(Env("  "), Under("home")).Path)
			.IsEqualTo(Under("home", ".agent-shipyard", "logbook"));
	}

	[Test]
	public async Task Trailing_separators_and_dot_segments_are_normalized()
	{
		var withSeparator = ShipyardLogbookFolder.Resolve(Env(Under("a") + Path.DirectorySeparatorChar), Under("home"));
		var withDots = ShipyardLogbookFolder.Resolve(Env(Under("a", "b", "..", "c")), Under("home" + Path.DirectorySeparatorChar));
		var defaultWithSeparator = ShipyardLogbookFolder.Resolve(Env(null), Under("home") + Path.DirectorySeparatorChar);

		await Assert.That(withSeparator.Path).IsEqualTo(Under("a", "logbook"));
		await Assert.That(withDots.Path).IsEqualTo(Under("a", "c", "logbook"));
		await Assert.That(defaultWithSeparator.Path).IsEqualTo(Under("home", ".agent-shipyard", "logbook"));
	}

	[Test]
	public async Task Local_api_files_have_fixed_names_in_the_logbook_folder()
	{
		var folder = ShipyardLogbookFolder.Resolve(Env(Under("s")), Under("home"));

		await Assert.That(folder.SettingsFile).IsEqualTo(Under("s", "logbook", "local-api.settings.json"));
		await Assert.That(folder.DiscoveryFile).IsEqualTo(Under("s", "logbook", "local-api.discovery.json"));
		await Assert.That(folder.StartLockFile).IsEqualTo(Under("s", "logbook", "local-api.start.lock"));
		await Assert.That(folder.LogFile).IsEqualTo(Under("s", "logbook", "local-api.log"));
	}

	[Test]
	[Arguments(".agent-issues")]
	[Arguments(".agent-wayfinder")]
	[Arguments(".AGENT-ISSUES")]
	public async Task A_folder_inside_old_state_is_rejected_for_the_override_and_the_default(string oldFolder)
	{
		await Assert.That(() => ShipyardLogbookFolder.Resolve(Env(Under("home", oldFolder)), Under("home")))
			.Throws<ShipyardDataFolderException>();
		await Assert.That(() => ShipyardLogbookFolder.Resolve(Env(Under("home", oldFolder, "nested")), Under("home")))
			.Throws<ShipyardDataFolderException>();
		await Assert.That(() => ShipyardLogbookFolder.Resolve(Env(null), Under("home", oldFolder)))
			.Throws<ShipyardDataFolderException>();
	}

	[Test]
	[Arguments("relative/folder")]
	[Arguments("~/shipyard")]
	[Arguments("./here")]
	public async Task A_relative_override_is_an_error_and_not_replaced_by_the_default(string value)
	{
		var exception = await Assert.That(() => ShipyardLogbookFolder.Resolve(Env(value), Under("home")))
			.Throws<ShipyardDataFolderException>();

		await Assert.That(exception!.Message).Contains(ShipyardLogbookFolder.HomeVariable);
	}

	[Test]
	[Arguments("")]
	[Arguments("relative")]
	public async Task A_missing_home_folder_without_an_override_is_an_error(string home)
	{
		await Assert.That(() => ShipyardLogbookFolder.Resolve(Env(null), home)).Throws<ShipyardDataFolderException>();
	}

	[Test]
	public async Task Ensure_exists_creates_the_folder_and_leaves_no_probe_file()
	{
		var folder = ShipyardLogbookFolder.Resolve(Env(Under("fresh")), Under("home")).EnsureExists();

		await Assert.That(Directory.Exists(folder.Path)).IsTrue();
		await Assert.That(Directory.GetFileSystemEntries(folder.Path)).IsEmpty();
		await Assert.That(Directory.Exists(Under("home"))).IsFalse();
	}

	[Test]
	public async Task Ensure_exists_reports_a_clear_error_and_does_not_pick_another_folder()
	{
		Directory.CreateDirectory(Root);
		var blocker = Under("blocked");
		File.WriteAllText(blocker, "a file where a folder must be");

		var folder = ShipyardLogbookFolder.Resolve(Env(blocker), Under("home"));
		var exception = await Assert.That(() => folder.EnsureExists()).Throws<ShipyardDataFolderException>();

		await Assert.That(exception!.Message).Contains(folder.Path);
		await Assert.That(Directory.Exists(Under("home"))).IsFalse();
	}

	[Test]
	public async Task A_path_that_cannot_be_a_folder_path_is_reported_as_a_folder_error()
	{
		await Assert.That(() => ShipyardLogbookFolder.Resolve(Env(Under("bad\0name")), Under("home")))
			.Throws<ShipyardDataFolderException>();
	}

	[Test]
	public async Task Ensure_exists_rejects_a_link_that_leads_into_old_state()
	{
		var legacy = Directory.CreateDirectory(Under("linkhome", ".agent-issues")).FullName;
		var shipyard = Directory.CreateDirectory(Under("linkshipyard")).FullName;
		Directory.CreateSymbolicLink(Path.Combine(shipyard, "logbook"), legacy);

		var folder = ShipyardLogbookFolder.Resolve(Env(shipyard), Under("home"));
		await Assert.That(() => folder.EnsureExists()).Throws<ShipyardDataFolderException>();
		await Assert.That(Directory.GetFileSystemEntries(legacy)).IsEmpty();
	}

	[Test]
	public async Task Ensure_exists_reports_an_unwritable_folder_and_does_not_pick_another_folder()
	{
		if (OperatingSystem.IsWindows() || Environment.UserName == "root")
		{
			return;
		}

		var shipyard = Directory.CreateDirectory(Under("readonly")).FullName;
		var logbook = Directory.CreateDirectory(Path.Combine(shipyard, "logbook")).FullName;
		File.SetUnixFileMode(logbook, UnixFileMode.UserRead | UnixFileMode.UserExecute);

		try
		{
			var folder = ShipyardLogbookFolder.Resolve(Env(shipyard), Under("home"));
			var exception = await Assert.That(() => folder.EnsureExists()).Throws<ShipyardDataFolderException>();

			await Assert.That(exception!.Message).Contains(logbook);
			await Assert.That(Directory.Exists(Under("home"))).IsFalse();
		}
		finally
		{
			File.SetUnixFileMode(logbook, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
		}
	}
}
