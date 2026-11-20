namespace AgentLogbook.Api.Tests;

public class DevelopmentApiHostTests
{
	private static Func<string, string?> Environment(params (string Name, string Value)[] values) =>
		name => values.Where(item => item.Name == name).Select(item => item.Value).FirstOrDefault();

	private static readonly (string, string) Connection = (DevelopmentApiHost.ConnectionStringVariable, "Host=127.0.0.1;Port=1;Username=u;Password=p;Database=d;Timeout=2;Pooling=false");

	private static readonly (string, string) Port = (DevelopmentApiHost.PortVariable, "5000");

	[Test]
	public async Task It_refuses_to_start_without_an_explicit_shipyard_folder_so_it_cannot_use_the_user_folder()
	{
		var exception = await Assert.That(async () =>
			await DevelopmentApiHost.StartAsync("1.0.0", Environment(Connection, Port), "tester")).Throws<InvalidOperationException>();

		await Assert.That(exception!.Message).Contains("AGENT_SHIPYARD_HOME");
	}

	[Test]
	public async Task It_refuses_to_start_without_a_connection_string_or_a_valid_port()
	{
		var home = (Core.ShipyardData.ShipyardLogbookFolder.HomeVariable, Path.Combine(Path.GetTempPath(), "never-created-" + Guid.NewGuid().ToString("N")));

		await Assert.That(async () => await DevelopmentApiHost.StartAsync("1.0.0", Environment(home, Port), "tester"))
			.Throws<InvalidOperationException>();
		await Assert.That(async () => await DevelopmentApiHost.StartAsync("1.0.0", Environment(home, Connection), "tester"))
			.Throws<InvalidOperationException>();
		await Assert.That(async () => await DevelopmentApiHost.StartAsync("1.0.0", Environment(home, Connection, (DevelopmentApiHost.PortVariable, "70000")), "tester"))
			.Throws<InvalidOperationException>();
		await Assert.That(Directory.Exists(home.Item2)).IsFalse();
	}
}
