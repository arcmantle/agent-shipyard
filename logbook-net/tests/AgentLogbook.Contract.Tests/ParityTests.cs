using System.Text.Json;
using System.Text.RegularExpressions;

namespace AgentLogbook.Contract.Tests;

/// <summary>
/// The Parity corpus against the .NET implementation: the candidate CLI, its MCP server, and the Local API host in the build output,
/// compared with the golden files recorded from the TypeScript implementation. The Bun differ owns the comparison and applies the intended-difference rules.
/// </summary>
public partial class ParityTests
{
	/// <summary>The case ids of <c>contract/cases</c>.</summary>
	private static IReadOnlyList<string> CaseIds() =>
		[.. Directory.EnumerateFiles(Path.Combine(ContractPaths.Contract, "cases"), "*.case.json", SearchOption.AllDirectories)
			.Select(file =>
			{
				using var document = JsonDocument.Parse(File.ReadAllText(file));
				return document.RootElement.GetProperty("id").GetString()!;
			})
			.Order(StringComparer.Ordinal)];

	private static IReadOnlyList<string> RuleIds()
	{
		using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(ContractPaths.Contract, "intended-differences.json")));
		return [.. document.RootElement.EnumerateArray().Select(rule => rule.GetProperty("id").GetString()!)];
	}

	/// <summary>Runs the differ over one case on empty tables: the Local API host has one tenant, so cases must not see each other's records.</summary>
	private static async Task<BunTool.Result> CheckCaseAsync(string caseId, string url)
	{
		await LocalApiHost.EmptyTablesAsync();
		var cli = JsonSerializer.Serialize(new[] { LocalApiHost.DotnetHost, LocalApiHost.CliDll });
		return await BunTool.RunAsync(
			["src/parity.ts", "check", "--candidate-cli", cli, "--candidate-url", url, caseId],
			new Dictionary<string, string> { ["AGENT_LOGBOOK_API_URL"] = url });
	}

	/// <summary>
	/// One test for the whole corpus, so that the unused-rule report is complete: the differ reports an unused rule only when every case runs.
	/// It names every case that differs, and every intended-difference rule that changed no case.
	/// </summary>
	[Test]
	public async Task The_candidate_matches_every_golden_file_and_every_intended_difference_is_used()
	{
		var url = await LocalApiHost.UrlAsync();
		var failures = new List<string>();
		var used = new HashSet<string>(StringComparer.Ordinal);
		foreach (var caseId in CaseIds())
		{
			var result = await CheckCaseAsync(caseId, url);
			if (!result.Succeeded)
			{
				failures.Add($"case {caseId} differs from its golden file:{Environment.NewLine}{result.Output}");
				continue;
			}

			used.UnionWith(UsedRules(result.Output));
		}

		var unused = RuleIds().Where(rule => !used.Contains(rule)).ToArray();
		failures.AddRange(unused.Select(rule => $"intended difference {rule} changed no case"));

		await Assert.That(failures).IsEmpty().Because(string.Join(Environment.NewLine, failures));
	}

	/// <summary>The rule ids from the report line <c>intended differences used: rule (case, case); rule (case)</c>.</summary>
	private static IEnumerable<string> UsedRules(string output)
	{
		var line = UsedRulesLine().Match(output);
		if (!line.Success || line.Groups[1].Value == "none")
		{
			yield break;
		}

		foreach (var entry in line.Groups[1].Value.Split("; "))
		{
			yield return entry[..entry.IndexOf(" (", StringComparison.Ordinal)];
		}
	}

	[GeneratedRegex(@"^intended differences used: (.*)$", RegexOptions.Multiline)]
	private static partial Regex UsedRulesLine();
}
