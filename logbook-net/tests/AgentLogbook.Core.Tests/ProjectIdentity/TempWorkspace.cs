namespace AgentLogbook.Core.Tests.ProjectIdentity;

/// <summary>A temporary workspace folder named <c>fixture-root</c>. A <c>pnpm-workspace.yaml</c> marker keeps it its own root wherever the temp folder lives.</summary>
internal sealed class TempWorkspace : IDisposable
{
	private readonly string _parent = Directory.CreateTempSubdirectory("logbook-identity-").FullName;

	public TempWorkspace(string name = "fixture-root")
	{
		Root = Path.Combine(_parent, name);
		Directory.CreateDirectory(Root);
		File.WriteAllText(Path.Combine(Root, "pnpm-workspace.yaml"), "");
	}

	public string Root { get; }

	public string PathOf(string relative) => Path.GetFullPath(Path.Combine(Root, relative));

	public TempWorkspace WithFile(string relative, string contents)
	{
		var path = PathOf(relative);
		Directory.CreateDirectory(Path.GetDirectoryName(path)!);
		File.WriteAllText(path, contents);
		return this;
	}

	public TempWorkspace WithDirectory(string relative)
	{
		Directory.CreateDirectory(PathOf(relative));
		return this;
	}

	public void Dispose() => Directory.Delete(_parent, recursive: true);
}
