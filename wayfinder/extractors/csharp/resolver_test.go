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
	resolution := resolveProjects(t, contributions, nil)
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
	workspace := resolveProjects(t, contributions, nil)
	// The page holds only the caller; every target comes from the index.
	var caller []extractor.Contribution
	for _, contribution := range contributions {
		if contribution.SourcePath() == "app/Caller.cs" {
			caller = append(caller, contribution)
		}
	}
	page, err := ResolvePage(context.Background(), caller, "project:app", nil, contributionIndex{contributions: contributions})
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
	resolution := resolveProjects(t, contributions, nil)
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
	if _, err := Resolve([]extractor.Contribution{foreign}, nil); err == nil {
		t.Error("Resolve accepted a Go contribution")
	}
}

// resolveProjects resolves each project of the contributions with the
// contributions of the projects references lists for it.
func resolveProjects(t *testing.T, contributions []extractor.Contribution, references map[string][]string) Resolution {
	t.Helper()
	return resolveEach(t, contributions, references, func(own, referenced []extractor.Contribution, projectID string, referencedIDs []string) (Resolution, error) {
		return Resolve(own, referenced)
	})
}

// resolvePages resolves the page's contributions of each project against a
// resolver index holding every contribution.
func resolvePages(t *testing.T, page, all []extractor.Contribution, references map[string][]string) Resolution {
	t.Helper()
	return resolveEach(t, page, references, func(own, _ []extractor.Contribution, projectID string, referencedIDs []string) (Resolution, error) {
		return ResolvePage(context.Background(), own, projectID, referencedIDs, contributionIndex{contributions: all})
	})
}

func resolveEach(t *testing.T, contributions []extractor.Contribution, references map[string][]string, resolve func(own, referenced []extractor.Contribution, projectID string, referencedIDs []string) (Resolution, error)) Resolution {
	t.Helper()
	byProject := map[string][]extractor.Contribution{}
	var projectIDs []string
	for _, contribution := range contributions {
		if _, found := byProject[contribution.ProjectID()]; !found {
			projectIDs = append(projectIDs, contribution.ProjectID())
		}
		byProject[contribution.ProjectID()] = append(byProject[contribution.ProjectID()], contribution)
	}
	sort.Strings(projectIDs)
	merged := Resolution{}
	for _, projectID := range projectIDs {
		var referenced []extractor.Contribution
		for _, referencedID := range references[projectID] {
			referenced = append(referenced, byProject[referencedID]...)
		}
		resolution, err := resolve(byProject[projectID], referenced, projectID, references[projectID])
		if err != nil {
			t.Fatalf("resolve C# project %s: %v", projectID, err)
		}
		merged.facts.Nodes = append(merged.facts.Nodes, resolution.facts.Nodes...)
		merged.facts.Edges = append(merged.facts.Edges, resolution.facts.Edges...)
		merged.diagnostics = append(merged.diagnostics, resolution.diagnostics...)
	}
	return merged
}

func importLinks(t *testing.T, contributions []extractor.Contribution, facts graph.Facts) map[string][]string {
	t.Helper()
	nodes := map[string]graph.Node{}
	for _, contribution := range contributions {
		for _, node := range contribution.Facts().Nodes {
			nodes[node.ID] = node
		}
	}
	links := map[string][]string{}
	for _, edge := range facts.Edges {
		if edge.Relation != ImportsFromRelation {
			continue
		}
		source := nodes[edge.SourceID]
		if source.Kind == "file" {
			continue // file-to-file links only record dependencies
		}
		if edge.Evidence.Span != source.Evidence.Span {
			t.Errorf("edge %+v evidence, want the directive span %+v", edge, source.Evidence.Span)
		}
		key := source.Evidence.Span.Path + ":" + string(rune('0'+source.Evidence.Span.StartLine))
		links[key] = append(links[key], nodes[edge.TargetID].QualifiedName)
	}
	for _, targets := range links {
		slices.Sort(targets)
	}
	return links
}

func TestResolveImportsWithinOneProject(t *testing.T) {
	contributions := extractFiles(t, []sourceFile{
		{"project:.", "A.cs", "using Lib;\nusing static Lib.Util;\nusing U = Lib.Util;\nusing Ns = Lib.Deep;\nusing System;\nusing static Lib.Dup;\nusing Missing.Thing;\nnamespace App { class Program {} }\n"},
		{"project:.", "B.cs", "namespace Lib { class Util {} class Dup {} }\n"},
		{"project:.", "C.cs", "namespace Lib { class Dup {} }\nnamespace Lib.Deep { class Leaf {} }\n"},
		{"project:.", "D.cs", "namespace App {\n using Deep;\n using Lib.Deep;\n}\nnamespace App.Deep { class Near {} }\n"},
		{"project:.", "E.cs", "global using Lib;\n"},
	})
	want := map[string][]string{
		"A.cs:1": {"B.cs::Lib", "C.cs::Lib"},
		"A.cs:2": {"B.cs::Lib.Util"},
		"A.cs:3": {"B.cs::Lib.Util"},
		"A.cs:4": {"C.cs::Lib.Deep"},
		// Inside namespace App, `Deep` finds App.Deep before any global Deep.
		"D.cs:2": {"D.cs::App.Deep"},
		// `Lib.Deep` has no App.Lib.Deep, so it falls back to the global scope.
		"D.cs:3": {"C.cs::Lib.Deep"},
		"E.cs:1": {"B.cs::Lib", "C.cs::Lib"},
	}

	workspace := resolveProjects(t, contributions, nil)
	pages := Resolution{}
	pages.facts.Edges = append(resolvePages(t, contributions[:2], contributions, nil).Facts().Edges, resolvePages(t, contributions[2:], contributions, nil).Facts().Edges...)
	// Each page reads the whole project from the index, as the real pages do.
	for name, facts := range map[string]graph.Facts{"workspace": workspace.Facts(), "pages": pages.Facts()} {
		got := importLinks(t, contributions, facts)
		for key, targets := range want {
			if !slices.Equal(got[key], targets) {
				t.Errorf("%s: %s links = %v, want %v", name, key, got[key], targets)
			}
		}
		for key, targets := range got {
			if _, expected := want[key]; !expected {
				t.Errorf("%s: unexpected links %s -> %v (external, ambiguous, and unsupported imports stay unresolved)", name, key, targets)
			}
		}
	}
	if len(workspace.Diagnostics()) != 1 {
		t.Errorf("diagnostics = %+v, want one ambiguity warning for the duplicate static target", workspace.Diagnostics())
	}
}

// crossProjectFixture has App reaching Mid directly and Lib through Mid, while
// Other is a solution member App does not reference.
var crossProjectFixture = []sourceFile{
	{"project:app", "app/Program.cs", `using Lib;
using Mid;
using Other;
using System;
using static Lib.Util;
using W = Lib.Widget;
namespace App;
class Program
{
    Lib.Widget widget;
    void Run(Mid.Gadget gadget)
    {
        widget.Spin();
        gadget.Run();
        Lib.Util.Stat();
        Other.Hidden.Go();
        System.Console.WriteLine();
    }
}
`},
	{"project:mid", "mid/Mid.cs", "namespace Mid;\npublic class Gadget { public void Run() {} }\n"},
	{"project:lib", "lib/Lib.cs", "namespace Lib;\npublic class Widget { public void Spin() {} }\npublic static class Util { public static void Stat() {} }\n"},
	{"project:other", "other/Other.cs", "namespace Other;\npublic class Hidden { public static void Go() {} }\n"},
}

var crossProjectReferences = map[string][]string{
	"project:app": {"project:mid", "project:lib"},
	"project:mid": {"project:lib"},
}

func TestResolveFollowsDirectAndTransitiveProjectReferencesOnly(t *testing.T) {
	contributions := extractFiles(t, crossProjectFixture)
	want := []string{
		"csharp:calls Program.cs::App.Program.Run -> Lib.cs::Lib.Util.Stat",
		"csharp:calls Program.cs::App.Program.Run -> Lib.cs::Lib.Widget.Spin",
		"csharp:calls Program.cs::App.Program.Run -> Mid.cs::Mid.Gadget.Run",
		"csharp:imports_from Program.cs -> Lib.cs",
		"csharp:imports_from Program.cs -> Mid.cs",
		"csharp:imports_from Program.cs::W -> Lib.cs::Lib.Widget",
		"csharp:imports_from Program.cs::using Lib -> Lib.cs::Lib",
		"csharp:imports_from Program.cs::using Mid -> Mid.cs::Mid",
		"csharp:imports_from Program.cs::using static Lib.Util -> Lib.cs::Lib.Util",
		"references Program.cs::App.Program -> Lib.cs::Lib.Widget",
		"references Program.cs::App.Program.Run -> Mid.cs::Mid.Gadget",
	}
	short := func(lines []string) []string {
		out := make([]string, 0, len(lines))
		for _, line := range lines {
			for _, prefix := range []string{"app/", "mid/", "lib/", "other/"} {
				line = strings.ReplaceAll(line, prefix, "")
			}
			out = append(out, line)
		}
		sort.Strings(out)
		return out
	}
	for name, resolution := range map[string]Resolution{
		"workspace": resolveProjects(t, contributions, crossProjectReferences),
		"pages":     resolvePages(t, contributions, contributions, crossProjectReferences),
	} {
		got := short(describeEdges(contributions, resolution.Facts().Edges))
		if !slices.Equal(got, short(want)) {
			t.Errorf("%s edges =\n%s\nwant\n%s", name, strings.Join(got, "\n"), strings.Join(short(want), "\n"))
		}
	}
}

func TestResolveDoesNotLinkProjectsWithoutAReference(t *testing.T) {
	contributions := extractFiles(t, crossProjectFixture)
	for name, resolution := range map[string]Resolution{
		"workspace": resolveProjects(t, contributions, nil),
		"pages":     resolvePages(t, contributions, contributions, nil),
	} {
		for _, edge := range describeEdges(contributions, resolution.Facts().Edges) {
			if strings.Contains(edge, "lib/") || strings.Contains(edge, "mid/") || strings.Contains(edge, "other/") {
				t.Errorf("%s: edge %q crosses projects without a project reference", name, edge)
			}
		}
	}
}

func TestResolveKeepsAmbiguousAndOwnDeclarationsAcrossProjects(t *testing.T) {
	contributions := extractFiles(t, []sourceFile{
		{"project:app", "app/Caller.cs", "namespace Shared;\nclass Caller { Twin twin; Mine mine; }\n"},
		{"project:app", "app/Mine.cs", "namespace Shared;\nclass Mine {}\n"},
		{"project:one", "one/Twin.cs", "namespace Shared;\nclass Twin {}\nclass Mine {}\n"},
		{"project:two", "two/Twin.cs", "namespace Shared;\nclass Twin {}\n"},
	})
	references := map[string][]string{"project:app": {"project:one", "project:two"}}
	for name, resolution := range map[string]Resolution{
		"workspace": resolveProjects(t, contributions, references),
		"pages":     resolvePages(t, contributions, contributions, references),
	} {
		got := describeEdges(contributions, resolution.Facts().Edges)
		if want := []string{"references app/Caller.cs::Shared.Caller -> app/Mine.cs::Shared.Mine"}; !slices.Equal(got, want) {
			t.Errorf("%s edges = %v, want %v (own Mine wins; Twin is declared by two referenced projects)", name, got, want)
		}
		if len(resolution.Diagnostics()) != 1 {
			t.Errorf("%s diagnostics = %+v, want one ambiguity warning for Twin", name, resolution.Diagnostics())
		}
	}
}

func TestResolveRejectsMixedProjectContributions(t *testing.T) {
	contributions := extractFiles(t, crossProjectFixture)
	if _, err := Resolve(contributions, nil); err == nil {
		t.Error("Resolve accepted contributions of several projects as one project")
	}
	if _, err := Resolve(contributions[:1], contributions[:1]); err == nil {
		t.Error("Resolve accepted a referenced contribution of the resolved project")
	}
}

func TestResolveOwnTypeShadowsReferencedTypeForUnqualifiedCalls(t *testing.T) {
	contributions := extractFiles(t, []sourceFile{
		{"project:app", "app/T.cs", "namespace N;\nclass T { void Run() { Helper(); } }\n"},
		{"project:lib", "lib/T.cs", "namespace N;\nclass T { void Helper() {} }\n"},
	})
	references := map[string][]string{"project:app": {"project:lib"}}
	for name, resolution := range map[string]Resolution{
		"workspace": resolveProjects(t, contributions, references),
		"pages":     resolvePages(t, contributions, contributions, references),
	} {
		if got := describeEdges(contributions, resolution.Facts().Edges); len(got) != 0 {
			t.Errorf("%s edges = %v, want none (own T shadows the referenced T)", name, got)
		}
	}
}
