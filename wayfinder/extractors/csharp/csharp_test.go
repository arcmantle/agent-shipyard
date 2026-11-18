package csharp

import (
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
	if class.Label != "Widget" || class.QualifiedName != "src/Widget.cs::Widget" {
		t.Errorf("class = %+v, want Widget with source-qualified name", class)
	}
	span := class.Evidence.Span
	if span.Path != "src/Widget.cs" || span.StartLine != 3 || span.EndLine != 6 || class.Evidence.Extractor != "csharp@"+Version {
		t.Errorf("class evidence = %+v, want span 3-6 in src/Widget.cs from the C# extractor", class.Evidence)
	}
	if len(contribution.CatalogUnits()) != 1 || contribution.CatalogUnits()[0].Name != "Widget" {
		t.Errorf("catalog units = %+v, want only Widget", contribution.CatalogUnits())
	}
}

func TestExtractClassInBlockNamespace(t *testing.T) {
	contribution, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: "A.cs", Contents: []byte("namespace N { class A {} }")})
	if err != nil {
		t.Fatalf("extract C# source: %v", err)
	}
	if got := contribution.Facts().Nodes; len(got) != 3 || got[2].Label != "A" {
		t.Errorf("nodes = %+v, want project, file, and class A", got)
	}
}

func TestExtractRejectsInvalidSourceWithLocation(t *testing.T) {
	_, err := Extract(extractor.Source{ProjectID: "project:.", SourcePath: "Bad.cs", Contents: []byte("class {")})
	if err == nil || !strings.Contains(err.Error(), `parse C# source "Bad.cs" at 1:`) {
		t.Errorf("extract error = %v, want parse error with location", err)
	}
}
