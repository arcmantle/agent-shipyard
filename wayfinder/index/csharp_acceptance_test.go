package index_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"agent-wayfinder/graph"
	"agent-wayfinder/index"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
	"agent-wayfinder/testkit"
)

// csharpAcceptanceWorkspace is a representative solution: App references Mid,
// Mid references Lib, and Other is a solution member App never references.
func csharpAcceptanceWorkspace(t *testing.T) testkit.Workspace {
	t.Helper()
	return testkit.NewWorkspace(t, map[string]string{
		"All.sln": "Project(\"{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}\") = \"App\", \"src\\App\\App.csproj\", \"{1}\"\r\nEndProject\r\n" +
			"Project(\"{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}\") = \"Other\", \"src\\Other\\Other.csproj\", \"{2}\"\r\nEndProject\r\n",
		"src/App/App.csproj":        "<Project><ItemGroup><ProjectReference Include=\"..\\Mid\\Mid.csproj\" /></ItemGroup></Project>\n",
		"src/App/Program.cs":        "extern alias Legacy;\nusing Lib;\nusing Other;\nnamespace App;\n// Validates signed access tokens.\npublic class Program : Lib.Widget, Mid.IGadget, System.IDisposable\n{\n    const int Limit = 3;\n    Lib.Widget widget;\n    public int Size { get; set; }\n    public void Run(Mid.Gadget gadget, int parameter)\n    {\n        var local = 1;\n        widget.Spin();\n        gadget.Run();\n        Other.Hidden.Go();\n    }\n}\npublic class Clash : Mid.Dup {}\n",
		"src/App/Program.csx":       "class Script {}\n",
		"src/App/Model.g.cs":        "class GeneratedModel {}\n",
		"src/App/obj/Debug/Temp.cs": "class BuildOutput {}\n",
		"src/Mid/Mid.csproj":        "<Project><ItemGroup><ProjectReference Include=\"..\\Lib\\Lib.csproj\" /></ItemGroup></Project>\n",
		"src/Mid/Gadget.cs":         "namespace Mid;\npublic interface IGadget {}\npublic class Gadget { public void Run() {} }\n",
		"src/Mid/DupA.cs":           "namespace Mid;\npublic class Dup {}\n",
		"src/Mid/DupB.cs":           "namespace Mid;\npublic class Dup {}\n",
		"src/Lib/Lib.csproj":        "<Project />\n",
		"src/Lib/Widget.cs":         "namespace Lib;\npublic class Widget { public void Spin() {} }\n",
		"src/Other/Other.csproj":    "<Project />\n",
		"src/Other/Hidden.cs":       "namespace Other;\npublic class Hidden { public static void Go() {} }\n",
	})
}

func csharpAcceptanceLinks(facts *factCollector) []string {
	nodes := make(map[string]graph.Node, len(facts.nodes))
	for _, node := range facts.nodes {
		nodes[node.ID] = node
	}
	var links []string
	for _, edge := range facts.edges {
		switch edge.Relation {
		case "csharp:calls", "csharp:extends", "csharp:implements", "csharp:imports_from", "references":
			if nodes[edge.SourceID].Kind != "file" {
				links = append(links, string(edge.Relation)+" "+nodes[edge.SourceID].QualifiedName+" -> "+nodes[edge.TargetID].QualifiedName)
			}
		}
	}
	slices.Sort(links)
	return links
}

func exportCSharpFacts(t *testing.T, store *sqlite.Store, snapshot storage.Snapshot) *factCollector {
	t.Helper()
	facts := &factCollector{}
	if err := store.Export(context.Background(), snapshot, storage.ExportRequest{}, facts); err != nil {
		t.Fatalf("export graph: %v", err)
	}
	return facts
}

func openCSharpStore(t *testing.T, name string) *sqlite.Store {
	t.Helper()
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), name))
	if err != nil {
		t.Fatalf("open graph store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestAcceptanceCSharpSolutionWorkflowWithoutDotNet(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the shell-script .NET shims cannot run on Windows")
	}
	// A dotnet on PATH that records any invocation proves indexing never builds.
	toolDir := t.TempDir()
	marker := filepath.Join(toolDir, "dotnet-invoked")
	script := "#!/bin/sh\ntouch " + marker + "\nexit 1\n"
	for _, name := range []string{"dotnet", "msbuild", "csc"} {
		if err := os.WriteFile(filepath.Join(toolDir, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", toolDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("DOTNET_ROOT", "")

	workspace := csharpAcceptanceWorkspace(t)
	request := index.Request{Root: workspace.Root, RetainCatalogUnits: true}
	store := openCSharpStore(t, "graph.db")
	snapshot, err := index.Publish(context.Background(), store, request)
	if err != nil {
		t.Fatalf("publish C# solution: %v", err)
	}
	facts := exportCSharpFacts(t, store, snapshot)

	// Declarations, variable facts, and exclusions through the graph.
	kinds := map[string]string{}
	for _, node := range facts.nodes {
		kinds[node.QualifiedName] = string(node.Kind)
	}
	for qualifiedName, kind := range map[string]string{
		"src/App/Program.cs::App.Program":           "csharp:class",
		"src/Mid/Gadget.cs::Mid.IGadget":            "csharp:interface",
		"src/App/Program.cs::App.Program.Run":       "csharp:method",
		"src/App/Program.cs::App.Program.Limit":     "csharp:variable",
		"src/App/Program.cs::App.Program.widget":    "csharp:variable",
		"src/App/Program.cs::App.Program.Run.local": "csharp:variable",
	} {
		if kinds[qualifiedName] != kind {
			t.Errorf("node %q kind = %q, want %q", qualifiedName, kinds[qualifiedName], kind)
		}
	}
	for _, node := range facts.nodes {
		for _, excluded := range []string{".csx", ".g.cs", "/obj/", "Script", "GeneratedModel", "BuildOutput", "Legacy", ".Size", ".parameter", ".gadget"} {
			if strings.Contains(node.QualifiedName, excluded) || strings.Contains(node.Evidence.Span.Path, excluded) {
				t.Errorf("graph contains %q (%s), want no excluded file, property, parameter, or extern alias node", node.QualifiedName, excluded)
			}
		}
	}

	// Direct, transitive, and unresolved links.
	wantLinks := []string{
		"csharp:calls src/App/Program.cs::App.Program.Run -> src/Lib/Widget.cs::Lib.Widget.Spin",
		"csharp:calls src/App/Program.cs::App.Program.Run -> src/Mid/Gadget.cs::Mid.Gadget.Run",
		"csharp:extends src/App/Program.cs::App.Program -> src/Lib/Widget.cs::Lib.Widget",
		"csharp:implements src/App/Program.cs::App.Program -> src/Mid/Gadget.cs::Mid.IGadget",
		"csharp:imports_from src/App/Program.cs::using Lib -> src/Lib/Widget.cs::Lib",
		"references src/App/Program.cs::App.Program -> src/Lib/Widget.cs::Lib.Widget",
		"references src/App/Program.cs::App.Program.Run -> src/Mid/Gadget.cs::Mid.Gadget",
	}
	if got := csharpAcceptanceLinks(facts); !slices.Equal(got, wantLinks) {
		t.Errorf("links =\n%s\nwant\n%s\n(transitive Lib linked; unreferenced Other, external System, and ambiguous Dup unlinked)", strings.Join(got, "\n"), strings.Join(wantLinks, "\n"))
	}

	// Existing graph query workflow.
	result, err := query.ExecuteGraphQuerySnapshot(context.Background(), store, snapshot, mustParseGraphQuery(t, `MATCH (node {name: "Spin"}) RETURN node.qualifiedName, node.kind LIMIT 5`), query.GraphQueryLimits{MaxDepth: 2, MaxNodes: 20}, query.GraphQueryOptions{})
	if err != nil {
		t.Fatalf("query C# method: %v", err)
	}
	if len(result.Rows) != 1 || result.Rows[0][0] != "src/Lib/Widget.cs::Lib.Widget.Spin" || result.Rows[0][1] != "csharp:method" {
		t.Errorf("query rows = %+v, want the Lib Spin method", result.Rows)
	}

	// Existing catalog workflow.
	if _, err := index.Catalog(context.Background(), store, index.CatalogRequest{Root: workspace.Root, Snapshot: snapshot}); err != nil {
		t.Fatalf("build C# catalog: %v", err)
	}
	matches, err := store.SearchCatalog(context.Background(), snapshot, storage.CatalogSearchRequest{Text: "Program", Limit: 20})
	if err != nil {
		t.Fatalf("search C# catalog: %v", err)
	}
	if !slices.ContainsFunc(matches, func(match storage.CatalogMatch) bool {
		return match.Node.Label == "Program" && match.Node.Kind == "csharp:class" && match.Node.Evidence.Span.Path == "src/App/Program.cs"
	}) {
		t.Errorf("catalog matches = %+v, want the Program class with its source location", matches)
	}

	// Incremental indexing matches a fresh index after source and project-reference changes.
	workspace.WriteFile(t, "src/Lib/Widget.cs", "namespace Lib;\npublic class Widget { public void Spin2() {} }\n")
	workspace.WriteFile(t, "src/App/App.csproj", "<Project><ItemGroup><ProjectReference Include=\"..\\Mid\\Mid.csproj\" /><ProjectReference Include=\"..\\Other\\Other.csproj\" /></ItemGroup></Project>\n")
	batchSnapshot, err := index.PublishBatch(context.Background(), rejectingContributionReader{Store: store}, index.BatchRequest{Root: workspace.Root, ChangedPaths: []string{"src/Lib/Widget.cs", "src/App/App.csproj"}})
	if err != nil {
		t.Fatalf("publish C# batch: %v", err)
	}
	freshStore := openCSharpStore(t, "fresh.db")
	freshSnapshot, err := index.Publish(context.Background(), freshStore, request)
	if err != nil {
		t.Fatalf("publish fresh C# solution: %v", err)
	}
	batch, fresh := exportCSharpFacts(t, store, batchSnapshot), exportCSharpFacts(t, freshStore, freshSnapshot)
	if got, want := csharpFactLines(batch), csharpFactLines(fresh); !slices.Equal(got, want) {
		t.Errorf("incremental facts differ from fresh facts\nincremental only: %v\nfresh only: %v", diffLines(got, want), diffLines(want, got))
	}
	freshLinks := strings.Join(csharpAcceptanceLinks(fresh), "\n")
	if !strings.Contains(freshLinks, "csharp:calls src/App/Program.cs::App.Program.Run -> src/Other/Hidden.cs::Other.Hidden.Go") {
		t.Errorf("fresh links =\n%s\nwant the newly referenced Other project linked", freshLinks)
	}
	if strings.Contains(freshLinks, "-> src/Lib/Widget.cs::Lib.Widget.Spin\n") || strings.HasSuffix(freshLinks, "-> src/Lib/Widget.cs::Lib.Widget.Spin") {
		t.Errorf("fresh links =\n%s\nwant no link to the renamed Spin method", freshLinks)
	}

	if _, err := os.Stat(marker); err == nil {
		t.Error("indexing invoked .NET tooling")
	}
}
