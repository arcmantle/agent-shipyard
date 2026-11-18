package csharp

import (
	"slices"
	"strings"
	"testing"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
)

func TestExtractReturnsClassWithSourceEvidence(t *testing.T) {
	contents := "namespace Fixture;\n\npublic class Widget\n{\n    public void Run() {}\n}\n"
	contribution, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: "src/Widget.cs", Contents: []byte(contents)})
	if err != nil {
		t.Fatalf("extract C# source: %v", err)
	}

	var classes []graph.Node
	for _, node := range contribution.Facts().Nodes {
		if node.Kind == ClassNodeKind {
			classes = append(classes, node)
		}
	}
	if len(classes) != 1 {
		t.Fatalf("class nodes = %+v, want exactly one", classes)
	}
	class := classes[0]
	if class.Label != "Widget" || class.QualifiedName != "src/Widget.cs::Fixture.Widget" {
		t.Errorf("class = %+v, want Widget with source-qualified name", class)
	}
	span := class.Evidence.Span
	if span.Path != "src/Widget.cs" || span.StartLine != 3 || span.EndLine != 6 || class.Evidence.Extractor != "csharp@"+Version {
		t.Errorf("class evidence = %+v, want span 3-6 in src/Widget.cs from the C# extractor", class.Evidence)
	}
	if units := contribution.CatalogUnits(); len(units) != 2 || units[0].Name != "Widget" || units[1].Name != "Run" {
		t.Errorf("catalog units = %+v, want Widget and Run", units)
	}
}

func TestExtractClassInBlockNamespace(t *testing.T) {
	contribution, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: "A.cs", Contents: []byte("namespace N { class A {} }")})
	if err != nil {
		t.Fatalf("extract C# source: %v", err)
	}
	if got := contribution.Facts().Nodes; len(got) != 4 || got[3].Label != "A" {
		t.Errorf("nodes = %+v, want project, file, namespace, and class A", got)
	}
}

func TestExtractRejectsInvalidSourceWithLocation(t *testing.T) {
	_, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: "Bad.cs", Contents: []byte("class {")})
	if err == nil || !strings.Contains(err.Error(), `parse C# source "Bad.cs" at 1:`) {
		t.Errorf("extract error = %v, want parse error with location", err)
	}
}

func TestExtractReturnsEveryDeclarationKindWithOwnership(t *testing.T) {
	contents := `using Text = System.Text.StringBuilder;
using System;
namespace Outer.Inner
{
    public class Widget
    {
        public Widget(int seed) {}
        public int Size { get; set; }
        public void Run(int count) {}
        class Nested {}
    }
    struct Point {}
    interface IShape { void Draw(); }
    record Person(string Name);
    enum Color { Red }
    delegate void Handler(int value);
}
`
	contribution, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: "All.cs", Contents: []byte(contents)})
	if err != nil {
		t.Fatalf("extract C# source: %v", err)
	}
	facts := contribution.Facts()
	byName := map[string]graph.Node{}
	for _, node := range facts.Nodes {
		byName[node.QualifiedName] = node
	}
	want := map[string]graph.NodeKind{
		"All.cs::Text":                      TypeAliasNodeKind,
		"All.cs::Outer.Inner":               NamespaceNodeKind,
		"All.cs::Outer.Inner.Widget":        ClassNodeKind,
		"All.cs::Outer.Inner.Widget.Widget": ConstructorNodeKind,
		"All.cs::Outer.Inner.Widget.Run":    MethodNodeKind,
		"All.cs::Outer.Inner.Widget.Nested": ClassNodeKind,
		"All.cs::Outer.Inner.Point":         StructNodeKind,
		"All.cs::Outer.Inner.IShape":        InterfaceNodeKind,
		"All.cs::Outer.Inner.IShape.Draw":   MethodNodeKind,
		"All.cs::Outer.Inner.Person":        RecordNodeKind,
		"All.cs::Outer.Inner.Color":         EnumNodeKind,
		"All.cs::Outer.Inner.Handler":       DelegateNodeKind,
	}
	for name, kind := range want {
		if node, found := byName[name]; !found || node.Kind != kind {
			t.Errorf("node %q = %+v (found %v), want kind %s", name, node, found, kind)
		}
	}
	if len(facts.Nodes) != len(want)+2 {
		t.Errorf("nodes = %+v, want declarations plus project and file only (no parameter or property nodes)", facts.Nodes)
	}
	owners := map[string]string{}
	ids := map[string]string{}
	for _, node := range facts.Nodes {
		ids[node.ID] = node.QualifiedName
	}
	for _, edge := range facts.Edges {
		if edge.Relation == "defines" {
			owners[ids[edge.TargetID]] = ids[edge.SourceID]
		}
	}
	for name, owner := range map[string]string{
		"All.cs::Text":                      "All.cs",
		"All.cs::Outer.Inner":               "All.cs",
		"All.cs::Outer.Inner.Widget":        "All.cs::Outer.Inner",
		"All.cs::Outer.Inner.Widget.Run":    "All.cs::Outer.Inner.Widget",
		"All.cs::Outer.Inner.Widget.Nested": "All.cs::Outer.Inner.Widget",
		"All.cs::Outer.Inner.IShape.Draw":   "All.cs::Outer.Inner.IShape",
	} {
		if owners[name] != owner {
			t.Errorf("owner of %q = %q, want %q", name, owners[name], owner)
		}
	}
}

func TestExtractFileScopedNamespaceOwnsLaterDeclarations(t *testing.T) {
	contribution, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: "F.cs", Contents: []byte("namespace A.B;\nclass C { void M() {} }\nrecord struct P(int X);\n")})
	if err != nil {
		t.Fatalf("extract C# source: %v", err)
	}
	var names []string
	for _, node := range contribution.Facts().Nodes[2:] {
		names = append(names, node.QualifiedName)
	}
	want := []string{"F.cs::A.B", "F.cs::A.B.C", "F.cs::A.B.C.M", "F.cs::A.B.P"}
	if !slices.Equal(names, want) {
		t.Errorf("qualified names = %v, want %v", names, want)
	}
}

func TestExtractReturnsVariableFactsWithOwnership(t *testing.T) {
	contents := `class Widget
{
    private int size, count = 2;
    public const string Name = "w";
    public int Prop { get; set; }
    void Run(int parameter)
    {
        var local = 1;
        const int Limit = 3;
        foreach (var item in new int[0]) {}
        for (int i = 0; i < 2; i++) {}
    }
}
`
	contribution, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: "V.cs", Contents: []byte(contents)})
	if err != nil {
		t.Fatalf("extract C# source: %v", err)
	}
	facts := contribution.Facts()
	ids := map[string]string{}
	for _, node := range facts.Nodes {
		ids[node.ID] = node.QualifiedName
	}
	owners := map[string]string{}
	for _, edge := range facts.Edges {
		if edge.Relation == "defines" {
			owners[ids[edge.TargetID]] = ids[edge.SourceID]
		}
	}
	want := map[string][2]int{ // qualified name -> start line, end line
		"V.cs::Widget.size":      {3, 3},
		"V.cs::Widget.count":     {3, 3},
		"V.cs::Widget.Name":      {4, 4},
		"V.cs::Widget.Run.local": {8, 8},
		"V.cs::Widget.Run.Limit": {9, 9},
		"V.cs::Widget.Run.item":  {10, 10},
		"V.cs::Widget.Run.i":     {11, 11},
	}
	variables := 0
	for _, node := range facts.Nodes {
		if node.Kind == VariableNodeKind {
			variables++
			lines, found := want[node.QualifiedName]
			if !found || node.Evidence.Span.StartLine != lines[0] || node.Evidence.Span.EndLine != lines[1] {
				t.Errorf("variable %+v not in expected set with lines %v", node, want)
			}
		}
		if node.Label == "Prop" || node.Label == "parameter" {
			t.Errorf("node %+v, want no property or parameter node", node)
		}
	}
	if variables != len(want) {
		t.Errorf("variable count = %d, want %d", variables, len(want))
	}
	for name, owner := range map[string]string{
		"V.cs::Widget.size":      "V.cs::Widget",
		"V.cs::Widget.Name":      "V.cs::Widget",
		"V.cs::Widget.Run.local": "V.cs::Widget.Run",
		"V.cs::Widget.Run.i":     "V.cs::Widget.Run",
	} {
		if owners[name] != owner {
			t.Errorf("owner of %q = %q, want %q", name, owners[name], owner)
		}
	}
}

func TestExtractReturnsLocalsInAccessorsAndPatterns(t *testing.T) {
	contents := "class C\n{\n    int P { get { var viaAccessor = 1; return viaAccessor; } }\n    void M(object o)\n    {\n        int.TryParse(\"1\", out var parsed);\n        if (o is string text) {}\n        try {} catch (System.Exception caught) {}\n    }\n}\n"
	contribution, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: "P.cs", Contents: []byte(contents)})
	if err != nil {
		t.Fatalf("extract C# source: %v", err)
	}
	got := map[string]bool{}
	for _, node := range contribution.Facts().Nodes {
		if node.Kind == VariableNodeKind {
			got[node.QualifiedName] = true
		}
	}
	for _, name := range []string{"P.cs::C.viaAccessor", "P.cs::C.M.parsed", "P.cs::C.M.text", "P.cs::C.M.caught"} {
		if !got[name] {
			t.Errorf("variables = %v, want %q", got, name)
		}
	}
}
