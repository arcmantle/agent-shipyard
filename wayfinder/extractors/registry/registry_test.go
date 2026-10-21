package registry

import (
	"testing"

	"agent-wayfinder/graph"
)

func TestDefaultSelectsIsolatedLanguageExtractors(t *testing.T) {
	registry, err := Default()
	if err != nil {
		t.Fatalf("create default registry: %v", err)
	}

	testCases := []struct {
		path string
		name string
	}{
		{path: "cmd/agent-wayfinder/main.go", name: "go"},
		{path: "src/component.tsx", name: "typescript"},
		{path: "src/server.mjs", name: "javascript"},
	}

	for _, testCase := range testCases {
		t.Run(testCase.path, func(t *testing.T) {
			registered, ok := registry.ForPath(testCase.path)
			if !ok {
				t.Fatalf("no extractor registered for %q", testCase.path)
			}
			if got := registered.Metadata().Name; got != testCase.name {
				t.Errorf("extractor name = %q, want %q", got, testCase.name)
			}
		})
	}

	if _, ok := registry.ForPath("docs/overview.md"); ok {
		t.Error("unsupported file selected an extractor")
	}
}

func TestDefaultJavaScriptExtractorExposesValidatedLanguageFacts(t *testing.T) {
	registry, err := Default()
	if err != nil {
		t.Fatalf("create default registry: %v", err)
	}

	registered, ok := registry.ForPath("src/server.js")
	if !ok {
		t.Fatal("no JavaScript extractor registered")
	}
	vocabulary, err := registered.Vocabulary()
	if err != nil {
		t.Fatalf("get JavaScript vocabulary: %v", err)
	}

	evidence := graph.FactEvidence{
		Span:       graph.SourceSpan{Path: "src/server.js", StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 1},
		FileHash:   "sha256:fixture",
		Extractor:  "javascript",
		Provenance: "static",
		Confidence: graph.ConfidenceExtracted,
	}
	facts := graph.Facts{
		Nodes: []graph.Node{
			{ID: "file:server", Kind: "file", Evidence: evidence},
			{ID: "javascript:class:server", Kind: "javascript:class", Evidence: evidence},
		},
		Edges: []graph.Edge{{
			SourceID: "file:server",
			TargetID: "javascript:class:server",
			Relation: "defines",
			Evidence: evidence,
		}},
	}
	if err := vocabulary.Validate(facts); err != nil {
		t.Fatalf("validate JavaScript facts: %v", err)
	}

	facts.Nodes[1].Kind = "typescript:interface"
	if err := vocabulary.Validate(facts); err == nil {
		t.Fatal("validate JavaScript facts accepted a TypeScript-only node kind")
	}
}

func TestDefaultGoExtractorExposesValidatedLanguageFacts(t *testing.T) {
	registry, err := Default()
	if err != nil {
		t.Fatalf("create default registry: %v", err)
	}

	registered, ok := registry.ForPath("cmd/agent-wayfinder/main.go")
	if !ok {
		t.Fatal("no Go extractor registered")
	}
	vocabulary, err := registered.Vocabulary()
	if err != nil {
		t.Fatalf("get Go vocabulary: %v", err)
	}

	evidence := graph.FactEvidence{
		Span:       graph.SourceSpan{Path: "cmd/agent-wayfinder/main.go", StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 1},
		FileHash:   "sha256:fixture",
		Extractor:  "go",
		Provenance: "static",
		Confidence: graph.ConfidenceExtracted,
	}
	facts := graph.Facts{
		Nodes: []graph.Node{
			{ID: "file:main", Kind: "file", Evidence: evidence},
			{ID: "go:function:main", Kind: "go:function", Evidence: evidence},
		},
		Edges: []graph.Edge{{
			SourceID: "file:main",
			TargetID: "go:function:main",
			Relation: "defines",
			Evidence: evidence,
		}},
	}
	if err := vocabulary.Validate(facts); err != nil {
		t.Fatalf("validate Go facts: %v", err)
	}

	facts.Nodes[1].Kind = "typescript:function"
	if err := vocabulary.Validate(facts); err == nil {
		t.Fatal("validate Go facts accepted a TypeScript-only node kind")
	}
}
