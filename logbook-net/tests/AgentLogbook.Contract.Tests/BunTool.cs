using System.Diagnostics;

namespace AgentLogbook.Contract.Tests;

/// <summary>Runs one of the Bun tools in <c>logbook-net/tools</c>. The tools are the recorder, the differ, and the oracle: this project does not repeat their logic.</summary>
internal static class BunTool
{
	private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(10);

	internal sealed record Result(int ExitCode, string Output)
	{
		internal bool Succeeded => ExitCode == 0;
	}

	internal static async Task<Result> RunAsync(IEnumerable<string> arguments, IReadOnlyDictionary<string, string>? environment = null)
	{
		var info = new ProcessStartInfo("bun")
		{
			WorkingDirectory = ContractPaths.Tools,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			UseShellExecute = false,
		};
		foreach (var argument in arguments)
		{
			info.ArgumentList.Add(argument);
		}

		foreach (var (name, value) in environment ?? new Dictionary<string, string>())
		{
			info.Environment[name] = value;
		}

		Process process;
		try
		{
			process = Process.Start(info) ?? throw new InvalidOperationException("bun did not start.");
		}
		catch (System.ComponentModel.Win32Exception exception)
		{
			throw new InvalidOperationException("The contract tests need Bun on the PATH: it runs the parity tools.", exception);
		}

		using (process)
		{
			var output = new System.Text.StringBuilder();
			process.OutputDataReceived += (_, e) => Append(output, e.Data);
			process.ErrorDataReceived += (_, e) => Append(output, e.Data);
			process.BeginOutputReadLine();
			process.BeginErrorReadLine();
			using var timeout = new CancellationTokenSource(Timeout);
			try
			{
				await process.WaitForExitAsync(timeout.Token);
			}
			catch (OperationCanceledException)
			{
				process.Kill(entireProcessTree: true);
				throw new TimeoutException($"bun {string.Join(' ', arguments)} did not end within {Timeout}.{Environment.NewLine}{output}");
			}

			process.WaitForExit();
			lock (output)
			{
				return new Result(process.ExitCode, output.ToString());
			}
		}
	}

	private static void Append(System.Text.StringBuilder output, string? line)
	{
		if (line is null)
		{
			return;
		}

		lock (output)
		{
			output.AppendLine(line);
		}
	}
}
