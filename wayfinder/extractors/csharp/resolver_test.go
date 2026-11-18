package csharp

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"
	"testing"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
)

type sourceFile struct {
	project, path, contents string
}

func extractFiles(t *testing.T, files []sourceFile) []extractor.Contribution {
	t.Helper()
	contributions := make([]extractor.Contribution, 0, len(files))
	for _, file := range files {
		contribution, err := Extract(extractor.Source{ProjectID: file.project, SourcePath: file.path, Contents: []byte(file.contents)})
		if err != nil {
			t.Fatalf("extract %s: %v", file.path, err)
		}
		contributions = append(contributions, contribution)
	}
	return contributions
}

// describeEdges renders resolved edges as "relation source -> target" using
// C# names, sorted for comparison.
func describeEdges(contributions []extractor.Contribution, edges []graph.Edge) []string {
	names := map[string]string{}
	for _, contribution := range contributions {
		for _, node := range contribution.Facts().Nodes {
			names[node.ID] = node.QualifiedName
		}
	}
	described := make([]string, 0, len(edges))
	for _, edge := range edges {
		described = append(described, fmt.Sprintf("%s %s -> %s", edge.Relation, names[edge.SourceID], names[edge.TargetID]))
	}
	sort.Strings(described)
	return described
}

type contributionIndex struct {
	contributions []extractor.Contribution
}

func (index contributionIndex) ResolverTarget(_ context.Context, request extractor.ResolverTargetRequest) (extractor.ResolverTarget, bool, error) {
	for _, contribution := range index.contributions {
		if contribution.ProjectID() == request.ProjectID && contribution.SourcePath() == request.SourcePath {
			return targetOf(contribution), true, nil
		}
	}
	return extractor.ResolverTarget{}, false, nil
}

func (index contributionIndex) ResolverPackagePage(_ context.Context, request extractor.ResolverPackagePageRequest) ([]extractor.ResolverTarget, error) {
	if !request.Recursive {
		return nil, fmt.Errorf("C# resolution must read the whole project recursively")
	}
	var targets []extractor.ResolverTarget
	for _, contribution := range index.contributions {
		inPackage := request.PackagePath == "." || strings.HasPrefix(contribution.SourcePath(), request.PackagePath+"/")
		if contribution.ProjectID() == request.ProjectID && inPackage && contribution.SourcePath() > request.AfterSourcePath {
			targets = append(targets, targetOf(contribution))
		}
	}
	sort.Slice(targets, func(first, second int) bool { return targets[first].SourcePath < targets[second].SourcePath })
	return targets[:min(len(targets), request.Limit)], nil
}

func targetOf(contribution extractor.Contribution) extractor.ResolverTarget {
	return extractor.ResolverTarget{
		ProjectID:        contribution.ProjectID(),
		SourcePath:       contribution.SourcePath(),
		Metadata:         contribution.Metadata(),
		Nodes:            contribution.Facts().Nodes,
		SymbolReferences: contribution.SymbolReferences(),
	}
}

var resolutionFixture = []sourceFile{
	{"project:app", "app/Caller.cs", `namespace App;
class Caller
{
    Helper helper;
    void Run(Widget widget)
    {
        Local();
        this.Local();
        helper.Assist();
        widget.Spin();
        Util.Stat();
        Dup.Twice();
        Overloaded();
        System.Console.WriteLine();
        Missing.Go();
    }
    void Local() {}
    void Overloaded() {}
    void Overloaded(int value) {}
}
`},
	{"project:app", "app/Helper.cs", "namespace App;\nclass Helper { public void Assist() {} }\n"},
	{"project:app", "app/deep/Widget.cs", "namespace App;\nclass Widget { public void Spin() {} }\nstatic class Util { public static void Stat() {} }\n"},
	{"project:app", "app/Dup1.cs", "namespace App;\nclass Dup { public void Twice() {} }\n"},
	{"project:app", "app/Dup2.cs", "namespace App;\nclass Dup { public void Twice() {} }\n"},
	// Another project declares the same names but is not referenced by App.
	{"project:other", "other/Helper.cs", "namespace App;\nclass Helper { public void Assist() {} }\n"},
}

var wantResolutionEdges = []string{
	"csharp:calls Caller.cs::App.Caller.Run -> Helper.cs::App.Helper.Assist",
	"csharp:calls Caller.cs::App.Caller.Run -> Widget.cs::App.Util.Stat",
	"csharp:calls Caller.cs::App.Caller.Run -> Widget.cs::App.Widget.Spin",
	"csharp:calls Caller.cs::App.Caller.Run -> Caller.cs::App.Caller.Local",
	"csharp:calls Caller.cs::App.Caller.Run -> Caller.cs::App.Caller.Local",
	"references Caller.cs::App.Caller -> Helper.cs::App.Helper",
	"references Caller.cs::App.Caller.Run -> Widget.cs::App.Widget",
}

func shortenPaths(lines []string) []string {
	shortened := make([]string, 0, len(lines))
	for _, line := range lines {
		for _, prefix := range []string{"app/deep/", "app/", "other/"} {
			line = strings.ReplaceAll(line, prefix, "")
		}
		shortened = append(shortened, line)
	}
	sort.Strings(shortened)
	return shortened
}

func TestResolveLinksUniqueSameProjectTargetsAndLeavesOthersUnresolved(t *testing.T) {
	contributions := extractFiles(t, resolutionFixture)
	resolution, err := Resolve(contributions)
	if err != nil {
		t.Fatalf("resolve C#: %v", err)
	}
	got := shortenPaths(describeEdges(contributions, resolution.Facts().Edges))
	if want := shortenPaths(wantResolutionEdges); !slices.Equal(got, want) {
		t.Errorf("workspace edges =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	var ambiguous []string
	for _, diagnostic := range resolution.Diagnostics() {
		ambiguous = append(ambiguous, diagnostic.Message)
	}
	for _, name := range []string{`"Dup.Twice"`, `"Overloaded"`} {
		if !slices.ContainsFunc(ambiguous, func(message string) bool {
			return strings.Contains(message, name) && strings.Contains(message, "ambiguous")
		}) {
			t.Errorf("diagnostics = %v, want an ambiguity warning for %s", ambiguous, name)
		}
	}
}

func TestResolvePageAgreesWithWorkspaceResolution(t *testing.T) {
	contributions := extractFiles(t, resolutionFixture)
	workspace, err := Resolve(contributions)
	if err != nil {
		t.Fatalf("resolve C#: %v", err)
	}
	// The page holds only the caller; every target comes from the index.
	var caller []extractor.Contribution
	for _, contribution := range contributions {
		if contribution.SourcePath() == "app/Caller.cs" {
			caller = append(caller, contribution)
		}
	}
	page, err := ResolvePage(context.Background(), caller, "project:app", contributionIndex{contributions: contributions})
	if err != nil {
		t.Fatalf("resolve C# page: %v", err)
	}
	if got, want := shortenPaths(describeEdges(contributions, page.Facts().Edges)), shortenPaths(describeEdges(contributions, workspace.Facts().Edges)); !slices.Equal(got, want) {
		t.Errorf("page edges =\n%s\nwant workspace edges\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if got, want := len(page.Diagnostics()), len(workspace.Diagnostics()); got != want {
		t.Errorf("page diagnostics = %d, want %d", got, want)
	}
}

func TestResolveFindsTypesInEnclosingNamespacesAndNestedScopes(t *testing.T) {
	contributions := extractFiles(t, []sourceFile{
		{"project:.", "A.cs", "namespace Outer.Inner;\nclass User { Shared shared; Nested nested; Sub.Leaf leaf; class Nested {} }\n"},
		{"project:.", "B.cs", "namespace Outer;\nclass Shared {}\nnamespace Sub { class Leaf {} }\n"},
		{"project:.", "C.cs", "namespace Outer.Inner;\nclass Shared {}\n"},
	})
	resolution, err := Resolve(contributions)
	if err != nil {
		t.Fatalf("resolve C#: %v", err)
	}
	got := describeEdges(contributions, resolution.Facts().Edges)
	want := []string{
		"references A.cs::Outer.Inner.User -> A.cs::Outer.Inner.User.Nested",
		"references A.cs::Outer.Inner.User -> C.cs::Outer.Inner.Shared",
		"references A.cs::Outer.Inner.User -> B.cs::Outer.Sub.Leaf",
	}
	sort.Strings(want)
	if !slices.Equal(got, want) {
		t.Errorf("edges = %v, want %v", got, want)
	}
}

func TestResolveRejectsOtherExtractorContributions(t *testing.T) {
	foreign, err := extractor.NewContribution(graph.Vocabulary{}, extractor.ContributionInput{SourcePath: "a.go", Metadata: extractor.Metadata{Name: "go", Version: "v0", Extensions: []string{".go"}}})
	if err != nil {
		t.Skipf("cannot build foreign contribution: %v", err)
	}
	if _, err := Resolve([]extractor.Contribution{foreign}); err == nil {
		t.Error("Resolve accepted a Go contribution")
	}
}
