using System.Runtime.InteropServices;
using AgentLogbook.Cli;

using var shutdown = new CancellationTokenSource();

// Only the long-running serve command takes over the termination signals. Other commands keep the default behavior.
var registrations = args is ["serve", ..]
	? new[] { PosixSignal.SIGINT, PosixSignal.SIGTERM, PosixSignal.SIGHUP }
		.Select(signal => PosixSignalRegistration.Create(signal, context =>
		{
			context.Cancel = true;
			shutdown.Cancel();
		}))
		.ToArray()
	: [];

try
{
	return await CliApp.RunAsync(args, Console.Out, Console.Error, shutdown.Token);
}
finally
{
	foreach (var registration in registrations)
	{
		registration.Dispose();
	}
}
