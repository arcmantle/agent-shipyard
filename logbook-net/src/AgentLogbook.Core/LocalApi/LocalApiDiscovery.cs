using System.Diagnostics;
using System.Text.Json;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Core.LocalApi;

/// <summary>
/// The content of <c>local-api.discovery.json</c>: how a client finds the running foreground Local API host.
/// The host writes it only after the schema is ready and the API listens, and it removes it on a clean exit.
/// While the host drains its active requests after a stop request, the file stays and says <see cref="Stopping"/>.
/// A client that reads it must still check the host health, because a host that was killed leaves the file.
/// </summary>
public sealed record LocalApiDiscovery(string Url, int Port, int ProcessId, string ToolVersion, DateTimeOffset StartedAt, bool Stopping = false)
{
	private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };

	/// <summary>Writes the file in one step, so a reader never sees a partial file.</summary>
	public void Write(ShipyardLogbookFolder folder)
	{
		ArgumentNullException.ThrowIfNull(folder);

		var temporary = Path.Combine(folder.Path, $"{ShipyardLogbookFolder.DiscoveryFileName}.{Guid.NewGuid():N}.tmp");
		try
		{
			File.WriteAllText(temporary, JsonSerializer.Serialize(this, JsonOptions));
			File.Move(temporary, folder.DiscoveryFile, overwrite: true);
		}
		finally
		{
			File.Delete(temporary);
		}
	}

	/// <summary>Reads the file. A missing or unreadable file gives null.</summary>
	public static LocalApiDiscovery? Read(ShipyardLogbookFolder folder)
	{
		ArgumentNullException.ThrowIfNull(folder);

		try
		{
			return File.Exists(folder.DiscoveryFile)
				? JsonSerializer.Deserialize<LocalApiDiscovery>(File.ReadAllText(folder.DiscoveryFile), JsonOptions)
				: null;
		}
		catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
		{
			return null;
		}
	}

	/// <summary>Marks the file as a host that drains and ends. Only the file of this host is marked.</summary>
	public void MarkStopping(ShipyardLogbookFolder folder)
	{
		ArgumentNullException.ThrowIfNull(folder);

		if (Read(folder) is { } current && current with { Stopping = false } == this with { Stopping = false })
		{
			(this with { Stopping = true }).Write(folder);
		}
	}

	/// <summary>Removes the file when it describes this host. A file of a newer host stays.</summary>
	public void RemoveIfCurrent(ShipyardLogbookFolder folder)
	{
		ArgumentNullException.ThrowIfNull(folder);

		if (Read(folder) is { } current && current with { Stopping = false } == this with { Stopping = false })
		{
			File.Delete(folder.DiscoveryFile);
		}
	}

	/// <summary>
	/// True when the process of the file is alive and started no later than the recorded start time.
	/// When the state of the process cannot be read, the process counts as alive: a live host must never lose its file.
	/// </summary>
	public bool IsProcessAlive()
	{
		Process process;
		try
		{
			process = Process.GetProcessById(ProcessId);
		}
		catch (ArgumentException)
		{
			return false;
		}

		using (process)
		{
			try
			{
				return !process.HasExited && process.StartTime.ToUniversalTime() <= StartedAt.UtcDateTime.AddSeconds(2);
			}
			catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
			{
				return true;
			}
		}
	}
}
