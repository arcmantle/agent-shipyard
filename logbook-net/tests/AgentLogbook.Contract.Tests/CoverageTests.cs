namespace AgentLogbook.Contract.Tests;

/// <summary>The coverage accounting of the Port slices: every surface is classified, and a claimed surface has its required cases.</summary>
public class CoverageTests
{
	[Test]
	public async Task Every_surface_is_classified_and_every_claimed_surface_has_its_cases()
	{
		var result = await BunTool.RunAsync(["src/coverage.ts"]);

		await Assert.That(result.Succeeded).IsTrue().Because(result.Output);
	}
}
