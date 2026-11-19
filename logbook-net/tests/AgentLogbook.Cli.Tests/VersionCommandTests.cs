using AgentLogbook.Cli;

namespace AgentLogbook.Cli.Tests;

public class VersionCommandTests
{
	private static (int Exit, string Out, string Err) Run(params string[] args)
	{
		var stdout = new StringWriter();
		var stderr = new StringWriter();
		var exit = CliApp.Run(args, stdout, stderr);
		return (exit, stdout.ToString(), stderr.ToString());
	}

	[Test]
	public async Task Version_prints_only_the_version_and_exits_zero()
	{
		var (exit, output, error) = Run("--version");

		await Assert.That(exit).IsEqualTo(0);
		await Assert.That(output).IsEqualTo(CliApp.Version + Environment.NewLine);
		await Assert.That(error).IsEmpty();
	}

	[Test]
	public async Task Version_is_a_plain_semantic_version_without_build_metadata()
	{
		await Assert.That(CliApp.Version).Matches(@"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$");
	}

	[Test]
	public async Task Unknown_argument_fails_on_stderr_and_exits_one()
	{
		var (exit, output, error) = Run("--bogus");

		await Assert.That(exit).IsEqualTo(1);
		await Assert.That(output).IsEmpty();
		await Assert.That(error).Contains("--bogus");
	}

	[Test]
	public async Task No_arguments_prints_the_general_help_and_exits_zero()
	{
		var (exit, output, error) = Run();

		await Assert.That(exit).IsEqualTo(0);
		await Assert.That(output).StartsWith("agent-logbook\n\n");
		await Assert.That(output).Contains("Commands:");
		await Assert.That(error).IsEmpty();
	}
}
