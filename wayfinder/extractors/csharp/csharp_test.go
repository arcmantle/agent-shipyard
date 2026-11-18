package csharp

import (
	"reflect"
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
	// The `using System;` directive is the only import node.
	if len(facts.Nodes) != len(want)+3 {
		t.Errorf("nodes = %+v, want declarations, one import, project, and file only (no parameter or property nodes)", facts.Nodes)
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

func TestExtractRecordsEveryUsingFormAsImportWithEvidence(t *testing.T) {
	contents := "global using System;\nglobal using static System.Math;\nextern alias Legacy;\nusing Text = global::System.Text.StringBuilder;\nusing static Fixture.Util<int>;\nnamespace Outer { using Inner.Deep; }\n"
	contribution, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: "U.cs", Contents: []byte(contents)})
	if err != nil {
		t.Fatalf("extract C# source: %v", err)
	}
	nodes := map[string]graph.Node{}
	for _, node := range contribution.Facts().Nodes {
		nodes[node.ID] = node
	}
	type got struct {
		kind     graph.NodeKind
		line     int
		bindings []extractor.ModuleBinding
	}
	byTarget := map[string]got{}
	for _, reference := range contribution.UnresolvedReferences() {
		node := nodes[reference.SourceID]
		if reference.Kind != extractor.ModuleReferenceImport {
			t.Errorf("reference %+v kind, want import", reference)
		}
		byTarget[reference.Target] = got{node.Kind, node.Evidence.Span.StartLine, reference.Bindings}
	}
	want := map[string]got{
		"System":                    {ImportNodeKind, 1, nil},
		"System.Math":               {ImportNodeKind, 2, []extractor.ModuleBinding{{ImportedName: "System.Math", ExportedName: StaticBinding}}},
		"System.Text.StringBuilder": {TypeAliasNodeKind, 4, []extractor.ModuleBinding{{ImportedName: "System.Text.StringBuilder", LocalName: "Text"}}},
		"Fixture.Util<int>":         {ImportNodeKind, 5, []extractor.ModuleBinding{{ImportedName: "Fixture.Util<int>", ExportedName: StaticBinding}}},
		"Inner.Deep":                {ImportNodeKind, 6, nil},
	}
	if !reflect.DeepEqual(byTarget, want) {
		t.Errorf("imports = %+v, want %+v (extern alias excluded)", byTarget, want)
	}
}
