using System.Text.Json;
using AgentLogbook.Core.ProjectIdentity;

namespace AgentLogbook.Core.Tests.ProjectIdentity;

/// <summary>Runs the exported TypeScript vectors (<c>contract/test-vectors/project-identity.json</c>) against the .NET implementation.</summary>
public class ProjectIdentityVectorTests
{
	private static readonly JsonElement[] Vectors = LoadVectors();

	private static JsonElement[] LoadVectors()
	{
		var folder = new DirectoryInfo(AppContext.BaseDirectory);
		while (folder is not null && !File.Exists(Path.Combine(folder.FullName, "contract", "test-vectors", "project-identity.json")))
		{
			folder = folder.Parent;
		}

		var path = Path.Combine(folder?.FullName ?? throw new FileNotFoundException("contract/test-vectors/project-identity.json"), "contract", "test-vectors", "project-identity.json");
		using var document = JsonDocument.Parse(File.ReadAllText(path));
		return [.. document.RootElement.GetProperty("vectors").EnumerateArray().Select(vector => vector.Clone())];
	}

	public static IEnumerable<Func<string>> SanitizeVectorNames() =>
		Vectors.Where(vector => vector.GetProperty("behavior").GetString() == "sanitize-path-segment")
			.Select(vector => (Func<string>)(() => vector.GetProperty("name").GetString()!));

	public static IEnumerable<Func<string>> ResolveVectorNames() =>
		Vectors.Where(vector => vector.GetProperty("behavior").GetString() == "resolve-project-identity")
			.Select(vector => (Func<string>)(() => vector.GetProperty("name").GetString()!));

	[Test]
	[MethodDataSource(nameof(SanitizeVectorNames))]
	public async Task Sanitize_matches_the_exported_vector(string name)
	{
		var vector = Vectors.Single(v => v.GetProperty("behavior").GetString() == "sanitize-path-segment" && v.GetProperty("name").GetString() == name);

		var actual = PathSegment.Sanitize(vector.GetProperty("input").GetProperty("value").GetString()!);

		await Assert.That(actual).IsEqualTo(vector.GetProperty("expected").GetProperty("value").GetString());
	}

	[Test]
	[MethodDataSource(nameof(ResolveVectorNames))]
	public async Task Resolve_matches_the_exported_vector(string name)
	{
		var vector = Vectors.Single(v => v.GetProperty("behavior").GetString() == "resolve-project-identity" && v.GetProperty("name").GetString() == name);
		var input = vector.GetProperty("input");
		var fixture = input.GetProperty("fixture");

		using var workspace = new TempWorkspace();
		if (fixture.TryGetProperty("directories", out var directories))
		{
			foreach (var directory in directories.EnumerateArray())
			{
				workspace.WithDirectory(directory.GetString()!);
			}
		}

		if (fixture.TryGetProperty("files", out var files))
		{
			foreach (var file in files.EnumerateObject())
			{
				workspace.WithFile(file.Name, file.Value.GetString()!);
			}
		}

		var environment = input.TryGetProperty("environment", out var variables)
			? variables.EnumerateObject().ToDictionary(variable => variable.Name, variable => variable.Value.GetString())
			: [];
		var workingDirectory = fixture.TryGetProperty("workingDirectory", out var relative) ? workspace.PathOf(relative.GetString()!) : workspace.Root;
		Directory.CreateDirectory(workingDirectory);

		var actual = ProjectIdentityResolver.Resolve(workingDirectory, variable => environment.GetValueOrDefault(variable));

		var expected = vector.GetProperty("expected").GetProperty("value");
		await Assert.That(actual.Identity).IsEqualTo(expected.GetProperty("identity").GetString());
		await Assert.That(actual.SourceName).IsEqualTo(expected.GetProperty("source").GetString());
	}
}
