using AgentLogbook.Api;

// Not disposed: the process-exit handler may still cancel it while the process ends.
var shutdown = new CancellationTokenSource();
Console.CancelKeyPress += (_, args) =>
{
	args.Cancel = true;
	shutdown.Cancel();
};
AppDomain.CurrentDomain.ProcessExit += (_, _) => shutdown.Cancel();

try
{
	var version = typeof(DevelopmentApiHost).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
	await using var host = await DevelopmentApiHost.StartAsync(version, Environment.GetEnvironmentVariable, Environment.UserName, shutdown.Token);
	Console.WriteLine($"Development API host listening on {host.Url}.");

	try
	{
		await Task.Delay(Timeout.Infinite, shutdown.Token);
	}
	catch (OperationCanceledException)
	{
		// A termination signal is the normal end of this host.
	}

	await host.StopAsync(CancellationToken.None);
	return 0;
}
catch (OperationCanceledException) when (shutdown.IsCancellationRequested)
{
	return 0;
}
catch (Exception exception) when (exception is InvalidOperationException or Npgsql.NpgsqlException or IOException
	or AgentLogbook.Core.ShipyardData.ShipyardDataFolderException or AgentLogbook.Storage.Postgres.UnrecognizedSchemaException)
{
	Console.Error.WriteLine($"The Development API host did not start. {exception.Message}");
	return 1;
}
