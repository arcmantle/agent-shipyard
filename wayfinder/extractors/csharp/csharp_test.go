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

const symbolFixture = `namespace Fixture;
class Caller
{
    private Helper helper;
    void Run(Widget widget)
    {
        var made = new Gadget();
        Local();
        this.Local();
        Util.Stat();
        widget.Spin();
        made.Spin();
        helper?.Assist();
        Fixture.Util.Stat();
        Make().Hidden();
    }
    void Local() {}
}
`

func TestExtractReturnsSymbolReferencesAndCallsWithSourceLocations(t *testing.T) {
	contribution, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: "Caller.cs", Contents: []byte(symbolFixture)})
	if err != nil {
		t.Fatalf("extract C# source: %v", err)
	}
	nodes := map[string]string{}
	for _, node := range contribution.Facts().Nodes {
		nodes[node.ID] = node.QualifiedName
	}
	type fact struct {
		source, relation, target string
		line, column             int
	}
	var got []fact
	for _, reference := range contribution.SymbolReferences() {
		span := reference.Evidence.Span
		got = append(got, fact{nodes[reference.SourceID], string(reference.Relation), reference.Target, span.StartLine, span.StartColumn})
	}
	want := []fact{
		{"Caller.cs::Fixture.Caller", "references", "Helper", 4, 13},
		{"Caller.cs::Fixture.Caller.Run", "references", "Widget", 5, 14},
		{"Caller.cs::Fixture.Caller.Run", "references", "Gadget", 7, 24},
		{"Caller.cs::Fixture.Caller.Run", "csharp:calls", "Local", 8, 9},
		{"Caller.cs::Fixture.Caller.Run", "csharp:calls", "Local", 9, 14},
		{"Caller.cs::Fixture.Caller.Run", "csharp:calls", "Util.Stat", 10, 14},
		{"Caller.cs::Fixture.Caller.Run", "csharp:calls", "Widget.Spin", 11, 16},
		{"Caller.cs::Fixture.Caller.Run", "csharp:calls", "Gadget.Spin", 12, 14},
		{"Caller.cs::Fixture.Caller.Run", "csharp:calls", "Helper.Assist", 13, 17},
		{"Caller.cs::Fixture.Caller.Run", "csharp:calls", "Fixture.Util.Stat", 14, 22},
		{"Caller.cs::Fixture.Caller.Run", "csharp:calls", "Make", 15, 9},
	}
	if !slices.Equal(got, want) {
		t.Errorf("symbol references = %+v\nwant %+v", got, want)
	}
}

func TestExtractSkipsAmbiguousReceiversAndLocalFunctionCalls(t *testing.T) {
	contents := `class C
{
    Settings Config { get; }
    void A()
    {
        { Foo x; x.Go(); }
        { Bar x; x.Go(); }
        Config.Get();
        Inner();
        void Inner() {}
    }
}
`
	contribution, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: "C.cs", Contents: []byte(contents)})
	if err != nil {
		t.Fatalf("extract C# source: %v", err)
	}
	var calls []string
	for _, reference := range contribution.SymbolReferences() {
		if reference.Relation == CallsRelation {
			calls = append(calls, reference.Target)
		}
	}
	if want := []string{"Settings.Get"}; !slices.Equal(calls, want) {
		t.Errorf("call targets = %v, want %v (no guess for a name declared with two types or for a local function)", calls, want)
	}
}
