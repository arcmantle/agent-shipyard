using System.Text.Json;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Core.LocalApi;

/// <summary>The PostgreSQL connection that the Local API host uses, and the place that chose it.</summary>
public sealed record LocalPostgresSelection(LocalPostgresConnection Connection, LocalPostgresSource Source, string Origin)
{
	public const string UrlVariable = "AGENT_LOGBOOK_LOCAL_PG_URL";

	public const string SettingName = "postgresUrl";

	/// <summary>The connection of the supplied Docker Compose file (<c>docker/compose.yaml</c>).</summary>
	public const string DefaultUrl = "postgres://agent_logbook:agent_logbook_dev_only@127.0.0.1:5433/agent_logbook";

	/// <summary>
	/// Selects the connection from <see cref="UrlVariable"/>, then <c>local-api.settings.json</c>, then <see cref="DefaultUrl"/>.
	/// The first place that is set decides, and a set but blank variable is an error. A value that is not usable is an error: the selection never
	/// continues with a later place. The production <c>DATABASE_URL</c> is never read.
	/// </summary>
	/// <exception cref="LocalPostgresSettingsException">The selected value or settings file is not usable.</exception>
	public static LocalPostgresSelection Select(Func<string, string?> getEnvironmentVariable, ShipyardLogbookFolder folder)
	{
		ArgumentNullException.ThrowIfNull(getEnvironmentVariable);
		ArgumentNullException.ThrowIfNull(folder);

		var fromEnvironment = getEnvironmentVariable(UrlVariable);
		if (fromEnvironment is not null)
		{
			return Create(fromEnvironment, LocalPostgresSource.Environment, $"the environment variable {UrlVariable}");
		}

		var fromFile = ReadSettingsFile(folder.SettingsFile);
		if (fromFile is not null)
		{
			return Create(fromFile, LocalPostgresSource.SettingsFile, $"the setting '{SettingName}' in '{folder.SettingsFile}'");
		}

		return Create(DefaultUrl, LocalPostgresSource.BuiltInDefault, "the built-in default for the supplied Docker Compose file");
	}

	public static LocalPostgresSelection Select() =>
		Select(Environment.GetEnvironmentVariable, ShipyardLogbookFolder.Resolve());

	private static LocalPostgresSelection Create(string url, LocalPostgresSource source, string origin)
	{
		try
		{
			return new(LocalPostgresConnection.Parse(url), source, origin);
		}
		catch (FormatException exception)
		{
			throw new LocalPostgresSettingsException(
				$"The local PostgreSQL connection from {origin} is not valid: {exception.Message} No other connection is used.");
		}
	}

	private static string? ReadSettingsFile(string file)
	{
		string text;
		try
		{
			if (Directory.Exists(file))
			{
				throw new IOException("The path is a folder.");
			}

			if (!File.Exists(file))
			{
				return null;
			}

			text = File.ReadAllText(file);
		}
		catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or NotSupportedException)
		{
			throw new LocalPostgresSettingsException(
				$"Cannot read the Local API settings file '{file}': {exception.Message} No other connection is used.",
				exception);
		}

		try
		{
			using var document = JsonDocument.Parse(text, new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip });
			if (document.RootElement.ValueKind != JsonValueKind.Object)
			{
				throw new LocalPostgresSettingsException(
					$"The Local API settings file '{file}' must contain one JSON object. No other connection is used.");
			}

			if (!document.RootElement.TryGetProperty(SettingName, out var value))
			{
				return null;
			}

			if (value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString()))
			{
				throw new LocalPostgresSettingsException(
					$"The setting '{SettingName}' in '{file}' must be a non-empty string. No other connection is used.");
			}

			return value.GetString();
		}
		catch (JsonException exception)
		{
			throw new LocalPostgresSettingsException(
				$"The Local API settings file '{file}' is not valid JSON: {exception.Message} No other connection is used.",
				exception);
		}
	}
}
