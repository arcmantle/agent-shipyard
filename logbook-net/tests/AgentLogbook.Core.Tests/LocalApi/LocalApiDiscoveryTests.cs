using System.Diagnostics;
using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Core.Tests.LocalApi;

public class LocalApiDiscoveryTests
{
	private static ShipyardLogbookFolder NewFolder()
	{
		var home = Directory.CreateTempSubdirectory("discovery-").FullName;
		return ShipyardLogbookFolder.Resolve(name => name == ShipyardLogbookFolder.HomeVariable ? home : null, home).EnsureExists();
	}

	private static LocalApiDiscovery Sample(int processId = 1234) =>
		new("http://127.0.0.1:5000", 5000, processId, "1.2.3", new DateTimeOffset(2026, 11, 19, 10, 0, 0, TimeSpan.Zero));

	[Test]
	public async Task Written_discovery_reads_back_and_leaves_no_temporary_file()
	{
		var folder = NewFolder();

		Sample().Write(folder);

		await Assert.That(LocalApiDiscovery.Read(folder)).IsEqualTo(Sample());
		await Assert.That(Directory.GetFiles(folder.Path).Select(file => Path.GetFileName(file)!)).IsEquivalentTo([ShipyardLogbookFolder.DiscoveryFileName]);
		await Assert.That(File.ReadAllText(folder.DiscoveryFile)).Contains("\"processId\": 1234");
	}

	[Test]
	public async Task A_missing_or_broken_file_reads_as_no_discovery()
	{
		var folder = NewFolder();
		await Assert.That(LocalApiDiscovery.Read(folder)).IsNull();

		File.WriteAllText(folder.DiscoveryFile, "{ not json");
		await Assert.That(LocalApiDiscovery.Read(folder)).IsNull();
	}

	[Test]
	public async Task Remove_leaves_the_file_of_another_host()
	{
		var folder = NewFolder();
		Sample(processId: 1).Write(folder);

		Sample(processId: 2).RemoveIfCurrent(folder);
		await Assert.That(File.Exists(folder.DiscoveryFile)).IsTrue();

		Sample(processId: 1).RemoveIfCurrent(folder);
		await Assert.That(File.Exists(folder.DiscoveryFile)).IsFalse();
	}

	[Test]
	public async Task The_current_process_is_alive_and_a_missing_process_is_not()
	{
		var started = Process.GetCurrentProcess().StartTime.ToUniversalTime();

		await Assert.That((Sample(Environment.ProcessId) with { StartedAt = started }).IsProcessAlive()).IsTrue();
		await Assert.That(Sample(int.MaxValue).IsProcessAlive()).IsFalse();
	}

	[Test]
	public async Task A_live_process_that_started_after_the_recorded_start_is_a_reused_process_id()
	{
		var recordedBeforeStart = Process.GetCurrentProcess().StartTime.ToUniversalTime().AddHours(-1);

		await Assert.That((Sample(Environment.ProcessId) with { StartedAt = recordedBeforeStart }).IsProcessAlive()).IsFalse();
	}
}
