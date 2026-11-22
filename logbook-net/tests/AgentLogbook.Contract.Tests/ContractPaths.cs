namespace AgentLogbook.Contract.Tests;

/// <summary>Where the contract files and the Bun tools of <c>logbook-net</c> are.</summary>
internal static class ContractPaths
{
	internal static string NetRoot { get; } = FindNetRoot();

	internal static string Tools => Path.Combine(NetRoot, "tools");

	internal static string Contract => Path.Combine(NetRoot, "contract");

	private static string FindNetRoot()
	{
		for (var folder = new DirectoryInfo(AppContext.BaseDirectory); folder is not null; folder = folder.Parent)
		{
			if (File.Exists(Path.Combine(folder.FullName, "AgentLogbook.slnx")))
			{
				return folder.FullName;
			}
		}

		throw new InvalidOperationException("AgentLogbook.slnx was not found above the test output folder.");
	}
}
