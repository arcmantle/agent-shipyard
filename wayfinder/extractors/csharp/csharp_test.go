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

func TestExtractCatalogUnitsCoverDeclarationKinds(t *testing.T) {
	source := "using Text = System.Text.StringBuilder;\nnamespace N;\n// Holds a widget.\npublic class Widget { public Widget() {} public int Size { get; set; } public void Run(int count) { var local = 1; } }\nstruct Point {}\ninterface IShape {}\nrecord Person(string Name);\nenum Color { Red }\ndelegate void Handler(int value);\n"
	contribution, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: "A.cs", Contents: []byte(source)})
	if err != nil {
		t.Fatalf("extract C# source: %v", err)
	}
	units := map[string]extractor.CatalogUnit{}
	for _, unit := range contribution.CatalogUnits() {
		units[unit.Name+"/"+string(unit.Kind)] = unit
	}
	for _, key := range []string{"Widget/csharp:class", "Widget/csharp:constructor", "Run/csharp:method", "Point/csharp:struct", "IShape/csharp:interface", "Person/csharp:record", "Color/csharp:enum", "Handler/csharp:delegate"} {
		unit, ok := units[key]
		if !ok {
			t.Errorf("catalog units = %+v, missing %s", units, key)
			continue
		}
		if unit.Signature == "" || unit.DeclarationSource == "" {
			t.Errorf("catalog unit %s = %+v, want signature and declaration source", key, unit)
		}
	}
	for key, want := range map[string]string{"Color/csharp:enum": "enum Color", "Person/csharp:record": "record Person(string Name);", "Handler/csharp:delegate": "delegate void Handler(int value);", "Point/csharp:struct": "struct Point"} {
		if got := units[key].Signature; got != want {
			t.Errorf("%s signature = %q, want %q", key, got, want)
		}
	}
	nodeSpans := map[string]int{}
	for _, node := range contribution.Facts().Nodes {
		nodeSpans[node.ID] = node.Evidence.Span.StartLine
	}
	if line := nodeSpans[units["Color/csharp:enum"].NodeID]; line != 8 {
		t.Errorf("enum catalog node start line = %d, want 8", line)
	}
	for key := range units {
		if strings.HasSuffix(key, "/csharp:namespace") || strings.HasSuffix(key, "/csharp:variable") || strings.HasSuffix(key, "/csharp:type_alias") {
			t.Errorf("catalog unit %s present, want declarations only", key)
		}
	}
	if got := units["Run/csharp:method"].Owner; got != "Widget" {
		t.Errorf("method owner = %q, want Widget", got)
	}
	if got := units["Widget/csharp:constructor"].Owner; got != "Widget" {
		t.Errorf("constructor owner = %q, want Widget", got)
	}
	if got := units["Widget/csharp:class"].Comments; len(got) != 1 || got[0] != "Holds a widget." {
		t.Errorf("class comments = %v, want leading comment", got)
	}
	for _, name := range []string{"Size", "count", "Name", "local"} {
		for key := range units {
			if strings.HasPrefix(key, name+"/") {
				t.Errorf("catalog unit %s present, want none for properties, parameters, or locals", key)
			}
		}
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

func TestExtractReturnsBaseListEntriesWithSourceLocations(t *testing.T) {
	contents := `namespace N;
class A : B, N.I<int>, global::X.Y {}
record R(int X) : Base(X), I {}
record struct RS : I {}
struct S : I {}
interface J : K, L<T> {}
enum E : byte { One }
`
	contribution, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: "T.cs", Contents: []byte(contents)})
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
		{"T.cs::N.A", "csharp:base_type", "B", 2, 11},
		{"T.cs::N.A", "csharp:base_type", "N.I", 2, 14},
		{"T.cs::N.R", "csharp:base_type", "Base", 3, 19},
		{"T.cs::N.R", "csharp:base_type", "I", 3, 28},
		{"T.cs::N.RS", "csharp:implements", "I", 4, 20},
		{"T.cs::N.S", "csharp:implements", "I", 5, 12},
		{"T.cs::N.J", "csharp:extends", "K", 6, 15},
		{"T.cs::N.J", "csharp:extends", "L", 6, 18},
	}
	if !slices.Equal(got, want) {
		t.Errorf("base list facts = %+v\nwant %+v (alias-qualified and enum underlying types are unsupported)", got, want)
	}
}
