package index

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"agent-wayfinder/extractors/registry"
	"agent-wayfinder/workspace"
)

func TestResolveWorkspaceFactsLinksCSharpAcrossLocalProjectReferences(t *testing.T) {
	root := t.TempDir()
	for name, contents := range map[string]string{
		"src/App/App.csproj": "<Project><ItemGroup><ProjectReference Include=\"..\\Mid\\Mid.csproj\" /></ItemGroup></Project>\n",
		"src/App/Program.cs": "using Lib;\nusing Other;\nnamespace App;\npublic class Program\n{\n    Lib.Widget widget;\n    public void Run()\n    {\n        widget.Spin();\n        Other.Hidden.Go();\n    }\n}\n",
		"src/Mid/Mid.csproj": "<Project><ItemGroup><ProjectReference Include=\"..\\Lib\\Lib.csproj\" /></ItemGroup></Project>\n",
		"src/Mid/Gadget.cs":  "namespace Mid;\npublic class Gadget {}\n",
		"src/Lib/Lib.csproj": "<Project />\n",
		"src/Lib/Widget.cs":  "namespace Lib;\npublic class Widget { public void Spin() {} }\n",
		"src/Other/O.csproj": "<Project />\n",
		"src/Other/Other.cs": "namespace Other;\npublic class Hidden { public static void Go() {} }\n",
	} {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	discovery, err := workspace.Discover(root, workspace.DiscoverOptions{})
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}
	registered, err := registry.Default()
	if err != nil {
		t.Fatalf("create extractor registry: %v", err)
	}
	sources, err := extractDiscoveredSources(root, discovery.Sources, registered, false)
	if err != nil {
		t.Fatalf("extract sources: %v", err)
	}
	facts, _, err := resolveWorkspaceFacts(root, sources)
	if err != nil {
		t.Fatalf("resolve workspace facts: %v", err)
	}

	names := map[string]string{}
	for _, source := range sources {
		for _, node := range source.contribution.Facts().Nodes {
			names[node.ID] = node.QualifiedName
		}
	}
	var links []string
	for _, edge := range facts.Edges {
		if edge.Relation == "csharp:calls" || edge.Relation == "references" {
			links = append(links, string(edge.Relation)+" "+names[edge.SourceID]+" -> "+names[edge.TargetID])
		}
	}
	slices.Sort(links)
	want := []string{
		"csharp:calls src/App/Program.cs::App.Program.Run -> src/Lib/Widget.cs::Lib.Widget.Spin",
		"references src/App/Program.cs::App.Program -> src/Lib/Widget.cs::Lib.Widget",
	}
	if !slices.Equal(links, want) {
		t.Errorf("links = %v, want %v (transitive Lib linked; unreferenced Other unlinked)", links, want)
	}
}
