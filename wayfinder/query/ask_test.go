package query_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"agent-wayfinder/graph"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
)

type graphPlanner struct {
	sources  []string
	err      error
	requests []query.GraphPlanningRequest
}

func (planner *graphPlanner) PlanGraphQueries(ctx context.Context, request query.GraphPlanningRequest) ([]string, error) {
	planner.requests = append(planner.requests, request)
	return planner.sources, planner.err
}

func TestAskSnapshotPlansAndReturnsSourceEvidence(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	evidence := graph.FactEvidence{Span: graph.SourceSpan{Path: "main.go", StartLine: 1, StartColumn: 1, EndLine: 2, EndColumn: 1}, FileHash: "hash", Extractor: "test", Provenance: "source", Confidence: graph.ConfidenceExtracted}
	snapshot, err := store.Publish(ctx, storage.PublishRequest{Workspace: "/workspace", WorkspaceFacts: graph.Facts{Nodes: []graph.Node{{ID: "main", Kind: "Function", Label: "main", Evidence: evidence}}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Publish(ctx, storage.PublishRequest{Workspace: "/workspace", WorkspaceFacts: graph.Facts{Nodes: []graph.Node{{ID: "new", Kind: "Class", Label: "NewKind"}}}}); err != nil {
		t.Fatal(err)
	}
	source := `MATCH (node:Function {name: "main"}) RETURN node LIMIT 1`
	planner := &graphPlanner{sources: []string{source}}
	limits := query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 10}
	result, err := query.AskSnapshot(ctx, store, snapshot, "What is the application entrypoint?", limits, query.AskOptions{Planner: planner})
	if err != nil {
		t.Fatal(err)
	}
	if len(planner.requests) != 1 {
		t.Fatalf("provider requests = %d, want one", len(planner.requests))
	}
	request := planner.requests[0]
	if request.Question != "What is the application entrypoint?" || request.MaxCandidates != 3 || request.Limits != limits || len(request.Schema.NodeKinds["Function"]) == 0 || len(request.Schema.NodeKinds["Class"]) != 0 || !request.Capabilities.Lexical || request.Capabilities.Vector || !strings.Contains(request.Grammar, "MATCH") || !strings.Contains(request.Grammar, "LIMIT") {
		t.Fatalf("planning request = %+v, want grammar, snapshot vocabulary, limits, and question", request)
	}
	if metadata := string(mustMarshal(t, request)); strings.Contains(metadata, "main.go") || strings.Contains(metadata, `"hash"`) {
		t.Fatalf("provider received source evidence: %s", metadata)
	}
	if result.SelectedSource != source || result.Snapshot != snapshot || len(result.Graph.Nodes) != 1 || result.Graph.Nodes[0].ID != "main" || len(result.Evidence) != 1 || result.Evidence[0] != evidence || result.Confidence <= 0 || len(result.ConfidenceBasis) == 0 {
		t.Fatalf("ask result = %+v, want selected source and snapshot evidence", result)
	}
}

func TestAskSnapshotSelectsCandidates(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	evidence := graph.FactEvidence{Span: graph.SourceSpan{Path: "main.go", StartLine: 1, StartColumn: 1, EndLine: 2, EndColumn: 1}, FileHash: "hash", Extractor: "test", Provenance: "source", Confidence: graph.ConfidenceExtracted}
	weaker := evidence
	weaker.Confidence = graph.ConfidenceInferred
	snapshot, err := store.Publish(ctx, storage.PublishRequest{Workspace: "/workspace", WorkspaceFacts: graph.Facts{Nodes: []graph.Node{
		{ID: "main", Kind: "Function", Label: "main", Evidence: evidence},
		{ID: "worker", Kind: "Function", Label: "worker", Evidence: weaker},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	main := `MATCH (node:Function {name: "main"}) RETURN node.name LIMIT 1`
	worker := `MATCH (node:Function {name: "worker"}) RETURN node.name LIMIT 1`
	empty := `MATCH (node:Function {name: "missing"}) RETURN node.name LIMIT 1`
	confidences := make(map[string]float64)
	for _, testCase := range []struct {
		name        string
		sources     []string
		providerErr error
		wantSource  string
		wantErr     string
		wantEmpty   bool
		wantBasis   string
	}{
		{name: "invalid syntax", sources: []string{"DELETE node", main}, wantSource: main, wantBasis: "1 of 1"},
		{name: "invalid schema", sources: []string{`MATCH (node:Missing) RETURN node LIMIT 1`, main}, wantSource: main, wantBasis: "1 of 1"},
		{name: "empty then answer", sources: []string{empty, main}, wantSource: main, wantBasis: "1 of 2"},
		{name: "agreement wins", sources: []string{worker, main, `MATCH (entry:Function {name: "main"}) RETURN entry.name LIMIT 1`}, wantSource: main, wantBasis: "2 of 3"},
		{name: "evidence breaks disagreement", sources: []string{worker, main}, wantSource: main, wantBasis: "1 of 2"},
		{name: "all empty", sources: []string{empty}, wantSource: empty, wantEmpty: true, wantBasis: "empty"},
		{name: "no candidates", wantErr: "one through three"},
		{name: "too many candidates", sources: []string{main, main, main, main}, wantErr: "one through three"},
		{name: "all invalid", sources: []string{"DELETE node", `MATCH (node:Missing) RETURN node LIMIT 1`}, wantErr: "no valid candidate"},
		{name: "provider unavailable", providerErr: errors.New("provider offline"), wantErr: "selected AI provider"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			planner := &graphPlanner{sources: testCase.sources, err: testCase.providerErr}
			result, err := query.AskSnapshot(ctx, store, snapshot, "Find the entrypoint", query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 10}, query.AskOptions{Planner: planner})
			if len(planner.requests) != 1 {
				t.Fatalf("provider requests = %d, want one", len(planner.requests))
			}
			if testCase.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
					t.Fatalf("error = %v, want %q", err, testCase.wantErr)
				}
				if testCase.providerErr != nil && !errors.Is(err, testCase.providerErr) {
					t.Fatal("provider error was not preserved")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.SelectedSource != testCase.wantSource || !strings.Contains(strings.Join(result.ConfidenceBasis, " "), testCase.wantBasis) {
				t.Fatalf("selection = %+v, want source %q and basis %q", result, testCase.wantSource, testCase.wantBasis)
			}
			confidences[testCase.name] = result.Confidence
			if testCase.wantEmpty {
				if len(result.Rows) != 0 || result.Confidence != 0 || len(result.Warnings) == 0 {
					t.Fatalf("empty result = %+v, want zero confidence and warning", result)
				}
			} else if len(result.Rows) != 1 || result.Rows[0][0] != "main" || result.Confidence <= 0 || result.Confidence > 1 {
				t.Fatalf("answer = %+v, want main with bounded confidence", result)
			}
		})
	}
	if confidences["agreement wins"] <= confidences["evidence breaks disagreement"] {
		t.Fatalf("confidence = %v, want candidate agreement to increase confidence", confidences)
	}
}

func TestGraphPlanningProviderContract(t *testing.T) {
	source := `MATCH (node) RETURN node LIMIT 1`
	request := query.GraphPlanningRequest{Question: "Find \"main\"", Grammar: "MATCH RETURN LIMIT", Schema: query.GraphQuerySchema{NodeKinds: map[string][]string{"Function": {"name"}}}, Limits: query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 10}, MaxCandidates: 3}
	prompt, err := query.GraphPlanningPrompt(request)
	if err != nil || !strings.Contains(prompt, `Find \"main\"`) || !strings.Contains(prompt, "Function") || !strings.Contains(prompt, "MATCH RETURN LIMIT") || !strings.Contains(prompt, "candidates") {
		t.Fatalf("prompt = %q, %v, want encoded metadata and response contract", prompt, err)
	}
	for _, testCase := range []struct {
		name     string
		response string
		wantErr  bool
	}{
		{name: "valid", response: `{"candidates":[` + string(mustMarshal(t, source)) + `]}`},
		{name: "empty", response: `{"candidates":[]}`, wantErr: true},
		{name: "missing", response: `{}`, wantErr: true},
		{name: "blank source", response: `{"candidates":[" "]}`, wantErr: true},
		{name: "too many", response: `{"candidates":["a","b","c","d"]}`, wantErr: true},
		{name: "self assessed confidence", response: `{"candidates":["a"],"confidence":1}`, wantErr: true},
		{name: "multiple values", response: `{"candidates":["a"]} {}`, wantErr: true},
		{name: "invalid JSON", response: "not JSON", wantErr: true},
		{name: "oversized", response: `{"candidates":["` + strings.Repeat("a", 8192) + `"]}`, wantErr: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			candidates, err := query.ParseGraphPlanningResponse([]byte(testCase.response))
			if (err != nil) != testCase.wantErr {
				t.Fatalf("candidates = %v, error = %v", candidates, err)
			}
			if !testCase.wantErr && (len(candidates) != 1 || candidates[0] != source) {
				t.Fatalf("candidates = %v, want source preserved", candidates)
			}
		})
	}
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestAskSnapshotRejectsInvalidLimitsBeforePlanning(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	snapshot, err := store.Publish(ctx, storage.PublishRequest{Workspace: "/workspace"})
	if err != nil {
		t.Fatal(err)
	}
	for _, limits := range []query.GraphQueryLimits{{MaxDepth: -1, MaxNodes: 10}, {MaxDepth: 5, MaxNodes: 0}} {
		planner := &graphPlanner{sources: []string{`MATCH (node) RETURN node LIMIT 1`}}
		_, err := query.AskSnapshot(ctx, store, snapshot, "Find main", limits, query.AskOptions{Planner: planner})
		if err == nil || !strings.Contains(err.Error(), "limits") || len(planner.requests) != 0 {
			t.Fatalf("invalid limits = %+v, error = %v, provider requests = %d", limits, err, len(planner.requests))
		}
	}
}

func TestAskSnapshotCatalogCapabilities(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	snapshot, err := store.Publish(ctx, storage.PublishRequest{Workspace: "/workspace", WorkspaceFacts: graph.Facts{Nodes: []graph.Node{{ID: "main", Kind: "Function", Label: "main"}}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.WriteCatalog(ctx, snapshot, storage.CatalogWriteRequest{Entries: []storage.CatalogEntry{{NodeID: "main", Name: "main", DeterministicSynopsis: "application entrypoint"}}}); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteCatalogEmbeddings(ctx, snapshot, storage.CatalogEmbeddingWriteRequest{Embeddings: []storage.CatalogEmbedding{{NodeID: "main", Source: storage.CatalogEmbeddingDeterministic, Text: "application entrypoint", Vector: []float32{1, 0}}}}); err != nil {
		t.Fatal(err)
	}
	lexical := `SEARCH LEXICAL "entrypoint" AS seed RETURN seed LIMIT 1`
	vector := `SEARCH VECTOR "entrypoint" AS seed RETURN seed LIMIT 1`
	for _, enabled := range []bool{false, true} {
		t.Run(fmt.Sprint(enabled), func(t *testing.T) {
			planner := &graphPlanner{sources: []string{vector, lexical}}
			options := query.AskOptions{Planner: planner}
			generator := &graphQueryEmbedding{}
			if enabled {
				options.EmbeddingGenerator = generator
			}
			result, err := query.AskSnapshot(ctx, store, snapshot, "Find the entrypoint", query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 10}, options)
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Graph.Nodes) != 1 || result.Graph.Nodes[0].ID != "main" || len(planner.requests) != 1 || planner.requests[0].Capabilities.Vector != enabled {
				t.Fatalf("result = %+v, provider requests = %+v", result, planner.requests)
			}
			if enabled && (result.SelectedSource != vector || len(generator.texts) != 1) || !enabled && (result.SelectedSource != lexical || len(generator.texts) != 0 || len(result.Warnings) == 0) {
				t.Fatalf("selected source = %s, embedding requests = %v, warnings = %v", result.SelectedSource, generator.texts, result.Warnings)
			}
		})
	}
}
