namespace AgentLogbook.Core.ShipyardData;

/// <summary>
/// The Logbook subfolder of the Shipyard data folder and the Local API files in it.
/// The Shipyard data folder is <c>AGENT_SHIPYARD_HOME</c> when set, otherwise <c>.agent-shipyard</c> in the user home folder.
/// Logbook writes only in its <c>logbook</c> subfolder. The folder never resolves into the old <c>.agent-issues</c>
/// or <c>.agent-wayfinder</c> state, and an unusable folder is an error, not a reason to pick another location.
/// </summary>
public sealed class ShipyardLogbookFolder
{
	public const string HomeVariable = "AGENT_SHIPYARD_HOME";
	public const string DefaultFolderName = ".agent-shipyard";
	public const string LogbookSubfolderName = "logbook";

	public const string SettingsFileName = "local-api.settings.json";
	public const string DiscoveryFileName = "local-api.discovery.json";
	public const string StartLockFileName = "local-api.start.lock";
	public const string LogFileName = "local-api.log";

	private static readonly string[] ForbiddenSegments = [".agent-issues", ".agent-wayfinder"];

	private ShipyardLogbookFolder(string path)
	{
		Path = path;
	}

	/// <summary>The absolute path of the Logbook subfolder.</summary>
	public string Path { get; }

	public string SettingsFile => System.IO.Path.Combine(Path, SettingsFileName);

	public string DiscoveryFile => System.IO.Path.Combine(Path, DiscoveryFileName);

	public string StartLockFile => System.IO.Path.Combine(Path, StartLockFileName);

	public string LogFile => System.IO.Path.Combine(Path, LogFileName);

	public static ShipyardLogbookFolder Resolve() =>
		Resolve(Environment.GetEnvironmentVariable, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));

	public static ShipyardLogbookFolder Resolve(Func<string, string?> getEnvironmentVariable, string userHomeFolder)
	{
		try
		{
			return ResolveCore(getEnvironmentVariable, userHomeFolder);
		}
		catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
		{
			throw new ShipyardDataFolderException(
				$"The Shipyard data folder path is not valid: {exception.Message} Set {HomeVariable} to an absolute folder path.",
				exception);
		}
	}

	private static ShipyardLogbookFolder ResolveCore(Func<string, string?> getEnvironmentVariable, string userHomeFolder)
	{
		var configured = getEnvironmentVariable(HomeVariable);
		var shipyardFolder = string.IsNullOrWhiteSpace(configured)
			? DefaultShipyardFolder(userHomeFolder)
			: ConfiguredShipyardFolder(configured);

		var logbookFolder = System.IO.Path.Combine(shipyardFolder, LogbookSubfolderName);
		RejectLegacyLocation(logbookFolder);

		return new(logbookFolder);
	}

	/// <summary>Creates the Logbook subfolder when it is missing and proves that it is a usable folder.</summary>
	public ShipyardLogbookFolder EnsureExists()
	{
		try
		{
			Directory.CreateDirectory(Path);
			RejectLinkIntoLegacyLocation(Path);
			RejectLinkIntoLegacyLocation(System.IO.Path.GetDirectoryName(Path)!);
			ProveWritable();
		}
		catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or NotSupportedException
			or ArgumentException or System.Security.SecurityException)
		{
			throw new ShipyardDataFolderException(
				$"Cannot use the Shipyard Logbook data folder '{Path}': {exception.Message} No other location is used.",
				exception);
		}

		return this;
	}

	/// <summary>A symbolic link or junction that leads into old state is as wrong as a path that names it.</summary>
	private static void RejectLinkIntoLegacyLocation(string folder)
	{
		var target = new DirectoryInfo(folder).ResolveLinkTarget(returnFinalTarget: true);
		if (target is not null)
		{
			RejectLegacyLocation(Normalize(target.FullName));
		}
	}

	private void ProveWritable()
	{
		var probe = System.IO.Path.Combine(Path, $".write-probe-{Guid.NewGuid():N}");
		using (new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose))
		{
		}
	}

	private static string DefaultShipyardFolder(string userHomeFolder)
	{
		if (string.IsNullOrWhiteSpace(userHomeFolder) || !System.IO.Path.IsPathFullyQualified(userHomeFolder))
		{
			throw new ShipyardDataFolderException(
				$"Cannot find the user home folder to place '{DefaultFolderName}'. Set {HomeVariable} to an absolute folder path.");
		}

		return System.IO.Path.Combine(Normalize(userHomeFolder), DefaultFolderName);
	}

	private static string ConfiguredShipyardFolder(string configured)
	{
		var value = configured.Trim();
		if (!System.IO.Path.IsPathFullyQualified(value))
		{
			throw new ShipyardDataFolderException(
				$"{HomeVariable} must be an absolute folder path, but it is '{configured}'.");
		}

		return Normalize(value);
	}

	private static string Normalize(string path) =>
		System.IO.Path.TrimEndingDirectorySeparator(System.IO.Path.GetFullPath(path));

	private static void RejectLegacyLocation(string logbookFolder)
	{
		var segments = logbookFolder.Split(
			[System.IO.Path.DirectorySeparatorChar, System.IO.Path.AltDirectorySeparatorChar],
			StringSplitOptions.RemoveEmptyEntries);

		var legacy = segments.FirstOrDefault(segment =>
			ForbiddenSegments.Contains(segment, StringComparer.OrdinalIgnoreCase));

		if (legacy is not null)
		{
			throw new ShipyardDataFolderException(
				$"The Shipyard Logbook data folder '{logbookFolder}' is inside the old '{legacy}' state. Set {HomeVariable} to a different folder.");
		}
	}
}
