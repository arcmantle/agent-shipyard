namespace AgentLogbook.Contract.Tests;

/// <summary>
/// The pure-function vectors in <c>contract/test-vectors</c>. The .NET unit test projects run each vector against the implementation.
/// These tests keep the files honest: they match a fresh export from the TypeScript source, and no vector file goes unused by a .NET test.
/// </summary>
public class VectorTests
{
	public static IEnumerable<string> VectorFiles() =>
		Directory.EnumerateFiles(Path.Combine(ContractPaths.Contract, "test-vectors"), "*.json").Select(Path.GetFileName).Order(StringComparer.Ordinal)!;

	[Test]
	public async Task The_vector_files_match_a_fresh_export_of_the_TypeScript_source()
	{
		var result = await BunTool.RunAsync(["test-vectors.ts", "--check"]);

		await Assert.That(result.Succeeded).IsTrue().Because(result.Output);
	}

	[Test]
	[MethodDataSource(nameof(VectorFiles))]
	public async Task A_dotnet_test_runs_the_vector_file(string file)
	{
		var tests = Path.Combine(ContractPaths.NetRoot, "tests");
		var users = Directory.EnumerateFiles(tests, "*.cs", SearchOption.AllDirectories)
			.Where(path => !path.Contains($"{Path.DirectorySeparatorChar}AgentLogbook.Contract.Tests{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
			.Where(path =>
			{
				// A vector test reads the file from the test-vectors folder, so a file that only names the same word does not count.
				var text = File.ReadAllText(path);
				return text.Contains("test-vectors", StringComparison.Ordinal) && text.Contains(Path.GetFileNameWithoutExtension(file), StringComparison.Ordinal);
			})
			.ToArray();

		await Assert.That(users).IsNotEmpty().Because($"no .NET test reads the vector file {file}");
	}
}
