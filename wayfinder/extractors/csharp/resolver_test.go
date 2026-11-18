package csharp

import (
	"context"
	"slices"
	"testing"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
)

type importCase struct {
	files map[string]string
	// want maps "source:line" to the target qualified names the import links to.
	want map[string][]string
}

func extractAll(t *testing.T, files map[string]string) []extractor.Contribution {
	t.Helper()
	var contributions []extractor.Contribution
	for _, path := range sortedKeys(files) {
		contribution, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: path, Contents: []byte(files[path])})
		if err != nil {
			t.Fatalf("extract %s: %v", path, err)
		}
		contributions = append(contributions, contribution)
	}
	return contributions
}

func sortedKeys(files map[string]string) []string {
	keys := make([]string, 0, len(files))
	for key := range files {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

type contributionIndex []extractor.Contribution

func (index contributionIndex) ResolverTarget(_ context.Context, request extractor.ResolverTargetRequest) (extractor.ResolverTarget, bool, error) {
	for _, contribution := range index {
		if contribution.SourcePath() == request.SourcePath {
			return targetOf(contribution), true, nil
		}
	}
	return extractor.ResolverTarget{}, false, nil
}

func (index contributionIndex) ResolverPackagePage(_ context.Context, request extractor.ResolverPackagePageRequest) ([]extractor.ResolverTarget, error) {
	var targets []extractor.ResolverTarget
	for _, contribution := range index {
		if request.Recursive && contribution.SourcePath() > request.AfterSourcePath && len(targets) < request.Limit {
			targets = append(targets, targetOf(contribution))
		}
	}
	return targets, nil
}

func targetOf(contribution extractor.Contribution) extractor.ResolverTarget {
	return extractor.ResolverTarget{ProjectID: contribution.ProjectID(), SourcePath: contribution.SourcePath(), Metadata: contribution.Metadata(), Nodes: contribution.Facts().Nodes}
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
			t.Errorf("edge %+v relation, want %s", edge, ImportsFromRelation)
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
	files := map[string]string{
		"A.cs": "using Lib;\nusing static Lib.Util;\nusing U = Lib.Util;\nusing Ns = Lib.Deep;\nusing System;\nusing static Lib.Dup;\nusing Missing.Thing;\nnamespace App { class Program {} }\n",
		"B.cs": "namespace Lib { class Util {} class Dup {} }\n",
		"C.cs": "namespace Lib { class Dup {} }\nnamespace Lib.Deep { class Leaf {} }\n",
		"D.cs": "namespace App {\n using Deep;\n using Lib.Deep;\n}\nnamespace App.Deep { class Near {} }\n",
		"E.cs": "global using Lib;\n",
	}
	contributions := extractAll(t, files)
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

	workspace, err := Resolve(contributions)
	if err != nil {
		t.Fatalf("resolve workspace: %v", err)
	}
	page, err := ResolvePage(context.Background(), contributions[:2], "project:.", contributionIndex(contributions))
	if err != nil {
		t.Fatalf("resolve page: %v", err)
	}
	rest, err := ResolvePage(context.Background(), contributions[2:], "project:.", contributionIndex(contributions))
	if err != nil {
		t.Fatalf("resolve page: %v", err)
	}
	pages := graph.Facts{Edges: append(page.Facts().Edges, rest.Facts().Edges...)}

	for name, facts := range map[string]graph.Facts{"workspace": workspace.Facts(), "pages": pages} {
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
