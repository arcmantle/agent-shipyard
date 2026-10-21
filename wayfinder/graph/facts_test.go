package graph_test

import (
	"errors"
	"strings"
	"testing"

	"agent-wayfinder/graph"
)

func testEvidence() graph.FactEvidence {
	return graph.FactEvidence{
		Span: graph.SourceSpan{
			Path:        "src/main.ts",
			StartLine:   1,
			StartColumn: 1,
			EndLine:     1,
			EndColumn:   1,
		},
		FileHash:   "sha256:fixture",
		Extractor:  "fixture",
		Provenance: "static",
		Confidence: graph.ConfidenceExtracted,
	}
}

func TestNewNodeIDIsDeterministicForEquivalentSourceSpan(t *testing.T) {
	span := graph.SourceSpan{
		Path:        "src/main.ts",
		StartLine:   3,
		StartColumn: 1,
		EndLine:     5,
		EndColumn:   2,
	}

	first := graph.NewNodeID(graph.NodeKind("function"), span)
	second := graph.NewNodeID(graph.NodeKind("function"), span)
	if first != second {
		t.Fatalf("equivalent source spans produced IDs %q and %q", first, second)
	}
}

func TestNewNodeIDChangesWhenSourceSpanChanges(t *testing.T) {
	baseSpan := graph.SourceSpan{
		Path:        "src/main.ts",
		StartLine:   3,
		StartColumn: 1,
		EndLine:     5,
		EndColumn:   2,
	}
	baseID := graph.NewNodeID(graph.NodeKind("function"), baseSpan)
	tests := []struct {
		name string
		span graph.SourceSpan
	}{
		{name: "path", span: graph.SourceSpan{Path: "src/other.ts", StartLine: 3, StartColumn: 1, EndLine: 5, EndColumn: 2}},
		{name: "start line", span: graph.SourceSpan{Path: "src/main.ts", StartLine: 4, StartColumn: 1, EndLine: 5, EndColumn: 2}},
		{name: "start column", span: graph.SourceSpan{Path: "src/main.ts", StartLine: 3, StartColumn: 2, EndLine: 5, EndColumn: 2}},
		{name: "end line", span: graph.SourceSpan{Path: "src/main.ts", StartLine: 3, StartColumn: 1, EndLine: 6, EndColumn: 2}},
		{name: "end column", span: graph.SourceSpan{Path: "src/main.ts", StartLine: 3, StartColumn: 1, EndLine: 5, EndColumn: 3}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if graph.NewNodeID(graph.NodeKind("function"), test.span) == baseID {
				t.Fatalf("changed %s did not change the node ID", test.name)
			}
		})
	}
}

func TestNewNodeIDChangesWhenNodeKindChanges(t *testing.T) {
	span := graph.SourceSpan{Path: "src/main.ts", StartLine: 3, StartColumn: 1, EndLine: 5, EndColumn: 2}
	if graph.NewNodeID(graph.NodeKind("function"), span) == graph.NewNodeID(graph.NodeKind("class"), span) {
		t.Fatal("different node kinds produced the same ID")
	}
}

func TestVocabularyRejectsNodeWithoutEvidence(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"file"},
	})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}

	err = vocabulary.Validate(graph.Facts{
		Nodes: []graph.Node{{ID: "file:main.ts", Kind: graph.NodeKind("file")}},
	})
	if err == nil {
		t.Fatal("validate facts returned nil for a node without evidence")
	}
}

func TestVocabularyRejectsEdgeWithoutEvidence(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"file"},
		Relations: []graph.RelationDefinition{{
			Kind: graph.RelationKind("contains"),
			Endpoints: []graph.EndpointRule{{
				Source: graph.NodeKind("file"),
				Target: graph.NodeKind("file"),
			}},
		}},
	})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}

	err = vocabulary.Validate(graph.Facts{
		Nodes: []graph.Node{
			{ID: "file:main.ts", Kind: graph.NodeKind("file"), Evidence: testEvidence()},
			{ID: "file:other.ts", Kind: graph.NodeKind("file"), Evidence: testEvidence()},
		},
		Edges: []graph.Edge{{
			SourceID: "file:main.ts",
			TargetID: "file:other.ts",
			Relation: graph.RelationKind("contains"),
		}},
	})
	if err == nil {
		t.Fatal("validate facts returned nil for an edge without evidence")
	}
}

func TestVocabularyRejectsSourceSpanWithReverseLineOrder(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"file"}})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}

	evidence := testEvidence()
	evidence.Span.StartLine = 2
	evidence.Span.EndLine = 1
	err = vocabulary.Validate(graph.Facts{
		Nodes: []graph.Node{{ID: "file:main.ts", Kind: graph.NodeKind("file"), Evidence: evidence}},
	})
	if err == nil {
		t.Fatal("validate facts returned nil for a source span with reverse line order")
	}
}

func TestVocabularyValidatesRegisteredFacts(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"file", "function"},
		Relations: []graph.RelationDefinition{{
			Kind: graph.RelationKind("contains"),
			Endpoints: []graph.EndpointRule{{
				Source: graph.NodeKind("file"),
				Target: graph.NodeKind("function"),
			}},
		}},
	})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}

	err = vocabulary.Validate(graph.Facts{
		Nodes: []graph.Node{
			{ID: "file:main.ts", Kind: graph.NodeKind("file"), Evidence: testEvidence()},
			{ID: "function:main", Kind: graph.NodeKind("function"), Evidence: testEvidence()},
		},
		Edges: []graph.Edge{{
			SourceID: "file:main.ts",
			TargetID: "function:main",
			Relation: graph.RelationKind("contains"),
			Evidence: testEvidence(),
		}},
	})
	if err != nil {
		t.Fatalf("validate facts: %v", err)
	}
}

func TestVocabularyRejectsUnknownNodeKind(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"file"},
	})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}

	err = vocabulary.Validate(graph.Facts{
		Nodes: []graph.Node{{ID: "class:user", Kind: graph.NodeKind("class")}},
	})
	if err == nil {
		t.Fatal("validate facts returned nil for an unknown node kind")
	}

	var validationError *graph.ValidationError
	if !errors.As(err, &validationError) {
		t.Fatalf("validate facts error = %T, want *graph.ValidationError", err)
	}
	if validationError.Code != graph.UnknownNodeKind {
		t.Fatalf("validation error code = %q, want %q", validationError.Code, graph.UnknownNodeKind)
	}
}

func TestVocabularyRejectsUnknownRelationKind(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"file"},
	})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}

	err = vocabulary.Validate(graph.Facts{
		Nodes: []graph.Node{{ID: "file:main.ts", Kind: graph.NodeKind("file"), Evidence: testEvidence()}},
		Edges: []graph.Edge{{
			SourceID: "file:main.ts",
			TargetID: "file:main.ts",
			Relation: graph.RelationKind("contains"),
			Evidence: testEvidence(),
		}},
	})

	var validationError *graph.ValidationError
	if !errors.As(err, &validationError) {
		t.Fatalf("validate facts error = %T, want *graph.ValidationError", err)
	}
	if validationError.Code != graph.UnknownRelationKind {
		t.Fatalf("validation error code = %q, want %q", validationError.Code, graph.UnknownRelationKind)
	}
}

func TestVocabularyRejectsInvalidRelationEndpoint(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"file", "function"},
		Relations: []graph.RelationDefinition{{
			Kind: graph.RelationKind("contains"),
			Endpoints: []graph.EndpointRule{{
				Source: graph.NodeKind("file"),
				Target: graph.NodeKind("function"),
			}},
		}},
	})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}

	err = vocabulary.Validate(graph.Facts{
		Nodes: []graph.Node{
			{ID: "file:main.ts", Kind: graph.NodeKind("file"), Evidence: testEvidence()},
			{ID: "function:main", Kind: graph.NodeKind("function"), Evidence: testEvidence()},
		},
		Edges: []graph.Edge{{
			SourceID: "function:main",
			TargetID: "file:main.ts",
			Relation: graph.RelationKind("contains"),
			Evidence: testEvidence(),
		}},
	})

	var validationError *graph.ValidationError
	if !errors.As(err, &validationError) {
		t.Fatalf("validate facts error = %T, want *graph.ValidationError", err)
	}
	if validationError.Code != graph.InvalidRelationEndpoint {
		t.Fatalf("validation error code = %q, want %q", validationError.Code, graph.InvalidRelationEndpoint)
	}
	if !strings.Contains(validationError.Detail, "src/main.ts:1:1") {
		t.Errorf("validation error detail = %q, want source location", validationError.Detail)
	}
}

func TestVocabularyRejectsMissingTargetNode(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"file", "function"},
		Relations: []graph.RelationDefinition{{
			Kind: graph.RelationKind("contains"),
			Endpoints: []graph.EndpointRule{{
				Source: graph.NodeKind("file"),
				Target: graph.NodeKind("function"),
			}},
		}},
	})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}

	err = vocabulary.Validate(graph.Facts{
		Nodes: []graph.Node{{ID: "file:main.ts", Kind: graph.NodeKind("file"), Evidence: testEvidence()}},
		Edges: []graph.Edge{{
			SourceID: "file:main.ts",
			TargetID: "function:main",
			Relation: graph.RelationKind("contains"),
			Evidence: testEvidence(),
		}},
	})

	var validationError *graph.ValidationError
	if !errors.As(err, &validationError) {
		t.Fatalf("validate facts error = %T, want *graph.ValidationError", err)
	}
	if validationError.Code != graph.MissingTargetNode {
		t.Fatalf("validation error code = %q, want %q", validationError.Code, graph.MissingTargetNode)
	}
}

func TestVocabularyRejectsMissingSourceNode(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"file", "function"},
		Relations: []graph.RelationDefinition{{
			Kind: graph.RelationKind("contains"),
			Endpoints: []graph.EndpointRule{{
				Source: graph.NodeKind("file"),
				Target: graph.NodeKind("function"),
			}},
		}},
	})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}

	err = vocabulary.Validate(graph.Facts{
		Nodes: []graph.Node{{ID: "function:main", Kind: graph.NodeKind("function"), Evidence: testEvidence()}},
		Edges: []graph.Edge{{
			SourceID: "file:main.ts",
			TargetID: "function:main",
			Relation: graph.RelationKind("contains"),
			Evidence: testEvidence(),
		}},
	})

	var validationError *graph.ValidationError
	if !errors.As(err, &validationError) {
		t.Fatalf("validate facts error = %T, want *graph.ValidationError", err)
	}
	if validationError.Code != graph.MissingSourceNode {
		t.Fatalf("validation error code = %q, want %q", validationError.Code, graph.MissingSourceNode)
	}
}

func TestNewVocabularyRejectsEndpointWithUnknownNodeKind(t *testing.T) {
	_, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"file"},
		Relations: []graph.RelationDefinition{{
			Kind: graph.RelationKind("contains"),
			Endpoints: []graph.EndpointRule{{
				Source: graph.NodeKind("file"),
				Target: graph.NodeKind("function"),
			}},
		}},
	})

	var validationError *graph.ValidationError
	if !errors.As(err, &validationError) {
		t.Fatalf("new vocabulary error = %T, want *graph.ValidationError", err)
	}
	if validationError.Code != graph.UnknownNodeKind {
		t.Fatalf("validation error code = %q, want %q", validationError.Code, graph.UnknownNodeKind)
	}
}

func TestVocabularyRejectsDuplicateNodeID(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"file"},
	})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}

	err = vocabulary.Validate(graph.Facts{
		Nodes: []graph.Node{
			{ID: "file:main.ts", Kind: graph.NodeKind("file"), Evidence: testEvidence()},
			{ID: "file:main.ts", Kind: graph.NodeKind("file"), Evidence: testEvidence()},
		},
	})

	var validationError *graph.ValidationError
	if !errors.As(err, &validationError) {
		t.Fatalf("validate facts error = %T, want *graph.ValidationError", err)
	}
	if validationError.Code != graph.DuplicateNodeID {
		t.Fatalf("validation error code = %q, want %q", validationError.Code, graph.DuplicateNodeID)
	}
}

func TestVocabularyRejectsEmptyNodeID(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"file"},
	})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}

	err = vocabulary.Validate(graph.Facts{
		Nodes: []graph.Node{{Kind: graph.NodeKind("file")}},
	})

	var validationError *graph.ValidationError
	if !errors.As(err, &validationError) {
		t.Fatalf("validate facts error = %T, want *graph.ValidationError", err)
	}
	if validationError.Code != graph.EmptyNodeID {
		t.Fatalf("validation error code = %q, want %q", validationError.Code, graph.EmptyNodeID)
	}
}

func TestNewVocabularyRejectsInvalidDefinitions(t *testing.T) {
	tests := []struct {
		name       string
		definition graph.VocabularyDefinition
		wantCode   graph.ValidationCode
	}{
		{
			name:       "empty node kind",
			definition: graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{""}},
			wantCode:   graph.EmptyNodeKind,
		},
		{
			name:       "duplicate node kind",
			definition: graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"file", "file"}},
			wantCode:   graph.DuplicateNodeKind,
		},
		{
			name: "empty relation kind",
			definition: graph.VocabularyDefinition{
				NodeKinds: []graph.NodeKind{"file"},
				Relations: []graph.RelationDefinition{{
					Endpoints: []graph.EndpointRule{{Source: graph.NodeKind("file"), Target: graph.NodeKind("file")}},
				}},
			},
			wantCode: graph.EmptyRelationKind,
		},
		{
			name: "duplicate relation kind",
			definition: graph.VocabularyDefinition{
				NodeKinds: []graph.NodeKind{"file"},
				Relations: []graph.RelationDefinition{
					{Kind: graph.RelationKind("contains"), Endpoints: []graph.EndpointRule{{Source: graph.NodeKind("file"), Target: graph.NodeKind("file")}}},
					{Kind: graph.RelationKind("contains"), Endpoints: []graph.EndpointRule{{Source: graph.NodeKind("file"), Target: graph.NodeKind("file")}}},
				},
			},
			wantCode: graph.DuplicateRelationKind,
		},
		{
			name: "relation without endpoints",
			definition: graph.VocabularyDefinition{
				NodeKinds: []graph.NodeKind{"file"},
				Relations: []graph.RelationDefinition{{Kind: graph.RelationKind("contains")}},
			},
			wantCode: graph.EmptyRelationEndpoints,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := graph.NewVocabulary(test.definition)

			var validationError *graph.ValidationError
			if !errors.As(err, &validationError) {
				t.Fatalf("new vocabulary error = %T, want *graph.ValidationError", err)
			}
			if validationError.Code != test.wantCode {
				t.Fatalf("validation error code = %q, want %q", validationError.Code, test.wantCode)
			}
		})
	}
}
