package query_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
)

func TestExecuteGraphQuerySnapshotExactLookup(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	evidence := graph.FactEvidence{Span: graph.SourceSpan{Path: "main.go", StartLine: 1, StartColumn: 1, EndLine: 2, EndColumn: 1}, FileHash: "hash", Extractor: "test", Provenance: "source", Confidence: graph.ConfidenceExtracted}
	oldNode := graph.Node{ID: "old", Kind: "Function", Label: "main", QualifiedName: "app.main", Evidence: evidence}
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"Function"}})
	if err != nil {
		t.Fatal(err)
	}
	input := extractor.ContributionInput{SourcePath: "main.go", Metadata: extractor.Metadata{Name: "test", Version: "1", Extensions: []string{".go"}}, Facts: graph.Facts{Nodes: []graph.Node{oldNode}}}
	contribution, err := extractor.NewContribution(vocabulary, input)
	if err != nil {
		t.Fatal(err)
	}
	update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
	if err != nil {
		t.Fatal(err)
	}
	oldSnapshot, err := store.Publish(ctx, storage.PublishRequest{Workspace: "/workspace", Update: update, WorkspaceFacts: graph.Facts{Edges: []graph.Edge{{SourceID: "old", TargetID: "old", Relation: "calls", Evidence: evidence}}}})
	if err != nil {
		t.Fatal(err)
	}
	newNode := oldNode
	newNode.ID = "new"
	newNode.Kind = "Class"
	newNode.Label = `main' OR 1=1 --`
	input.Facts = graph.Facts{}
	contribution, err = extractor.NewContribution(vocabulary, input)
	if err != nil {
		t.Fatal(err)
	}
	update, err = extractor.NewGraphUpdate([]extractor.Contribution{contribution})
	if err != nil {
		t.Fatal(err)
	}
	newSnapshot, err := store.Publish(ctx, storage.PublishRequest{Workspace: "/workspace", Update: update, WorkspaceFacts: graph.Facts{Nodes: []graph.Node{newNode}, Edges: []graph.Edge{{SourceID: "new", TargetID: "new", Relation: "owns", Evidence: evidence}}}})
	if err != nil {
		t.Fatal(err)
	}
	otherNode := oldNode
	otherNode.ID, otherNode.Kind, otherNode.Label = "other", "File", "other"
	otherSnapshot, err := store.Publish(ctx, storage.PublishRequest{Workspace: "/other-workspace", WorkspaceFacts: graph.Facts{Nodes: []graph.Node{otherNode}, Edges: []graph.Edge{{SourceID: "other", TargetID: "other", Relation: "contains", Evidence: evidence}}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, testCase := range []struct {
		name     string
		snapshot storage.Snapshot
		text     string
		wantID   string
		kind     string
		relation string
		wantErr  string
	}{
		{name: "old snapshot", snapshot: oldSnapshot, text: "main", wantID: "old", kind: "Function", relation: "calls"},
		{name: "other workspace same version", snapshot: otherSnapshot, text: "other", wantID: "other", kind: "File", relation: "contains"},
		{name: "original workspace same version", snapshot: oldSnapshot, text: "main", wantID: "old", kind: "Function", relation: "calls"},
		{name: "bound value", snapshot: newSnapshot, text: newNode.Label, wantID: "new", kind: "Class", relation: "owns"},
		{name: "absent in new snapshot", snapshot: newSnapshot, text: "main", kind: "Class", relation: "owns"},
		{name: "new kind absent in old snapshot", snapshot: oldSnapshot, kind: "Class", relation: "calls", wantErr: "unknown node kind"},
		{name: "deleted kind absent in new snapshot", snapshot: newSnapshot, kind: "Function", relation: "owns", wantErr: "unknown node kind"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			schema, err := store.GraphQuerySchema(ctx, testCase.snapshot)
			if err != nil || len(schema.RelationshipTypes) != 1 || len(schema.RelationshipTypes[testCase.relation]) == 0 {
				t.Fatalf("snapshot relationship schema = %+v, error %v", schema, err)
			}
			parsed, err := query.ParseGraphQuery(fmt.Sprintf("MATCH (node:%s {name: %q}) RETURN node.name LIMIT 10", testCase.kind, testCase.text))
			if err != nil {
				t.Fatal(err)
			}
			result, err := query.ExecuteGraphQuerySnapshot(ctx, store, testCase.snapshot, parsed, query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 10}, query.GraphQueryOptions{})
			if testCase.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
					t.Fatalf("validation error = %v, want %s", err, testCase.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.Snapshot != testCase.snapshot {
				t.Fatalf("snapshot = %+v, want %+v", result.Snapshot, testCase.snapshot)
			}
			if testCase.wantID == "" {
				if len(result.Graph.Nodes) != 0 || len(result.Rows) != 0 {
					t.Fatalf("unexpected result: %+v", result)
				}
				return
			}
			if len(result.Graph.Nodes) != 1 || result.Graph.Nodes[0].ID != testCase.wantID || len(result.Rows) != 1 || result.Rows[0][0] != testCase.text {
				t.Fatalf("result = %+v, want node %s and name %q", result, testCase.wantID, testCase.text)
			}
			if result.Graph.Nodes[0].Evidence != evidence || len(result.Evidence) != 1 {
				t.Fatalf("source evidence = %+v", result)
			}
		})
	}
}

func TestGraphQueryStorageRejectsInvalidExecution(t *testing.T) {
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
	for _, testCase := range []struct {
		name    string
		source  string
		version storage.GraphVersion
		depth   int
		cancel  bool
		wantErr string
	}{
		{name: "unknown kind", source: `MATCH (node:Missing) RETURN node LIMIT 1`, depth: 5, wantErr: "unknown node kind"},
		{name: "unknown property", source: `MATCH (node) RETURN node.missing LIMIT 1`, depth: 5, wantErr: "unknown property"},
		{name: "depth cap", source: `MATCH (source)-[:calls*2]->(target) RETURN target LIMIT 1`, depth: 1, wantErr: "depth cap"},
		{name: "missing version", source: `MATCH (node) RETURN node LIMIT 1`, version: 999, depth: 5, wantErr: "version not found"},
		{name: "cancelled request", source: `MATCH (node) RETURN node LIMIT 1`, depth: 5, cancel: true, wantErr: "context canceled"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, err := query.ParseGraphQuery(testCase.source)
			if err != nil {
				t.Fatal(err)
			}
			selected := snapshot
			if testCase.version != 0 {
				selected.Version = testCase.version
			}
			requestCtx, cancel := context.WithCancel(ctx)
			defer cancel()
			if testCase.cancel {
				cancel()
			}
			_, err = store.ExecuteGraphQuery(requestCtx, selected, storage.GraphQueryRequest{Query: parsed, Limits: query.GraphQueryLimits{MaxDepth: testCase.depth, MaxNodes: 10}})
			if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("error = %v, want %q", err, testCase.wantErr)
			}
		})
	}
}

type graphQueryEmbedding struct {
	err   error
	texts []string
}

func (generator *graphQueryEmbedding) GenerateCatalogEmbedding(ctx context.Context, text string) ([]float32, error) {
	generator.texts = append(generator.texts, text)
	return []float32{1, 0}, generator.err
}

func TestExecuteGraphQuerySnapshotSearch(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	evidence := graph.FactEvidence{Span: graph.SourceSpan{Path: "main.go", StartLine: 1, StartColumn: 1, EndLine: 2, EndColumn: 1}, FileHash: "hash", Extractor: "test", Provenance: "source", Confidence: graph.ConfidenceExtracted}
	nodes := []graph.Node{
		{ID: "entry", Kind: "Function", Label: "entry", Evidence: evidence},
		{ID: "worker", Kind: "Function", Label: "worker", Evidence: evidence},
	}
	snapshot, err := store.Publish(ctx, storage.PublishRequest{Workspace: "/workspace", WorkspaceFacts: graph.Facts{Nodes: nodes, Edges: []graph.Edge{{SourceID: "entry", TargetID: "worker", Relation: "calls", Evidence: evidence}}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.WriteCatalog(ctx, snapshot, storage.CatalogWriteRequest{Entries: []storage.CatalogEntry{
		{NodeID: "entry", Name: "entry", DeterministicSynopsis: "application entrypoint"},
		{NodeID: "worker", Name: "worker", DeterministicSynopsis: "background worker"},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteCatalogEmbeddings(ctx, snapshot, storage.CatalogEmbeddingWriteRequest{Embeddings: []storage.CatalogEmbedding{
		{NodeID: "entry", Source: storage.CatalogEmbeddingDeterministic, Text: "application entrypoint", Vector: []float32{1, 0}},
		{NodeID: "worker", Source: storage.CatalogEmbeddingDeterministic, Text: "background worker", Vector: []float32{0, 1}},
	}}); err != nil {
		t.Fatal(err)
	}
	for _, testCase := range []struct {
		name            string
		source          string
		generator       *graphQueryEmbedding
		want            []string
		wantErr         string
		wantNoEmbedding bool
	}{
		{name: "lexical", source: `SEARCH LEXICAL "entrypoint" AS seed RETURN seed.name LIMIT 1`, want: []string{"entry"}},
		{name: "lexical traversal", source: `SEARCH LEXICAL "entrypoint" AS seed MATCH (seed)-[:calls]->(target) RETURN target.name LIMIT 10`, want: []string{"worker"}},
		{name: "vector", source: `SEARCH VECTOR "entrypoint" AS seed WHERE seed.name = "entry" RETURN seed.name LIMIT 1`, generator: &graphQueryEmbedding{}, want: []string{"entry"}},
		{name: "vector traversal", source: `SEARCH VECTOR "entrypoint" AS seed MATCH (seed {name: "entry"})-[:calls]->(target) RETURN target.name LIMIT 10`, generator: &graphQueryEmbedding{}, want: []string{"worker"}},
		{name: "search alias in last node", source: `SEARCH LEXICAL "entrypoint" AS seed MATCH (target)<-[:calls]-(seed) RETURN target.name LIMIT 10`, want: []string{"worker"}},
		{name: "missing lexical result", source: `SEARCH LEXICAL "absent" AS seed RETURN seed LIMIT 10`},
		{name: "no vector configuration", source: `SEARCH VECTOR "entrypoint" AS seed RETURN seed LIMIT 10`, wantErr: "embedding generator"},
		{name: "vector provider failure", source: `SEARCH VECTOR "entrypoint" AS seed RETURN seed LIMIT 10`, generator: &graphQueryEmbedding{err: errors.New("provider unavailable")}, wantErr: "provider unavailable"},
		{name: "invalid vector kind", source: `SEARCH VECTOR "entrypoint" AS seed MATCH (seed:Missing) RETURN seed LIMIT 1`, generator: &graphQueryEmbedding{}, wantErr: "unknown node kind", wantNoEmbedding: true},
		{name: "invalid vector property", source: `SEARCH VECTOR "entrypoint" AS seed WHERE seed.missing = "value" RETURN seed LIMIT 1`, generator: &graphQueryEmbedding{}, wantErr: "unknown property", wantNoEmbedding: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, err := query.ParseGraphQuery(testCase.source)
			if err != nil {
				t.Fatal(err)
			}
			options := query.GraphQueryOptions{}
			if testCase.generator != nil {
				options.EmbeddingGenerator = testCase.generator
			}
			result, err := query.ExecuteGraphQuerySnapshot(ctx, store, snapshot, parsed, query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 10}, options)
			if testCase.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
					t.Fatalf("error = %v, want %s", err, testCase.wantErr)
				}
				if testCase.wantNoEmbedding && len(testCase.generator.texts) != 0 {
					t.Fatal("invalid query reached the embedding generator")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var names []string
			for _, row := range result.Rows {
				names = append(names, row[0].(string))
			}
			if !reflect.DeepEqual(names, testCase.want) {
				t.Fatalf("rows = %v, want %v", names, testCase.want)
			}
			if testCase.generator != nil && !reflect.DeepEqual(testCase.generator.texts, []string{"entrypoint"}) {
				t.Fatalf("embedding requests = %v", testCase.generator.texts)
			}
			if len(result.Rows) > 0 && (len(result.Evidence) == 0 || result.Graph.Nodes[0].Evidence != evidence) {
				t.Fatalf("missing source evidence: %+v", result)
			}
		})
	}
}

func TestExecuteGraphQuerySnapshotPaths(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	evidence := graph.FactEvidence{Span: graph.SourceSpan{Path: "calls.go", StartLine: 1, StartColumn: 1, EndLine: 2, EndColumn: 1}, FileHash: "hash", Extractor: "test", Provenance: "source", Confidence: graph.ConfidenceExtracted}
	nodes := []graph.Node{}
	for _, name := range []string{"alpha", "beta", "gamma", "foreign"} {
		nodes = append(nodes, graph.Node{ID: name, Kind: "Function", Label: name, QualifiedName: "app." + name, Evidence: evidence})
	}
	edges := []graph.Edge{
		{SourceID: "alpha", TargetID: "beta", Relation: "calls", Evidence: evidence},
		{SourceID: "beta", TargetID: "gamma", Relation: "calls", Evidence: evidence},
		{SourceID: "gamma", TargetID: "alpha", Relation: "calls", Evidence: evidence},
	}
	edges[2].Evidence.Confidence = graph.ConfidenceInferred
	snapshot, err := store.Publish(ctx, storage.PublishRequest{Workspace: "/workspace", WorkspaceFacts: graph.Facts{Nodes: nodes[:3], Edges: edges}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Publish(ctx, storage.PublishRequest{Workspace: "/other", WorkspaceFacts: graph.Facts{Nodes: nodes[3:]}}); err != nil {
		t.Fatal(err)
	}
	for _, testCase := range []struct {
		name        string
		source      string
		want        []string
		maxNodes    int
		wantWarning bool
		wantSecond  any
	}{
		{name: "outgoing", source: `MATCH (source {name: "alpha"})-[call:calls]->(target) RETURN target.name, call.confidence LIMIT 10`, want: []string{"beta"}, wantSecond: "extracted"},
		{name: "incoming", source: `MATCH (source {name: "gamma"})<-[:calls]-(target) RETURN target.name LIMIT 10`, want: []string{"beta"}},
		{name: "bounded ordered path", source: `MATCH (source {name: "alpha"})-[:calls*1..2]->(target) RETURN target.name ORDER BY target.name DESC LIMIT 10`, want: []string{"gamma", "beta"}},
		{name: "exact path length", source: `MATCH (source {name: "alpha"})-[:calls*2]->(target) RETURN target.name LIMIT 10`, want: []string{"gamma"}},
		{name: "chained path and predicate", source: `MATCH (source {name: "alpha"})-[:calls]->(middle)-[call:calls]->(target) WHERE target.name = "gamma" AND call.confidence = "extracted" RETURN target.name LIMIT 10`, want: []string{"gamma"}},
		{name: "repeated alias cycle", source: `MATCH (source {name: "alpha"})-[:calls*3]->(source) RETURN source.name LIMIT 10`, want: []string{"alpha"}},
		{name: "multi-hop property predicate", source: `MATCH (source {name: "alpha"})-[path:calls*3]->(target) WHERE path.confidence = "extracted" RETURN target.name LIMIT 10`},
		{name: "multi-hop property projection", source: `MATCH (source {name: "alpha"})-[path:calls*2]->(target) RETURN target.name, path.confidence LIMIT 10`, want: []string{"gamma"}, wantSecond: []any{"extracted", "extracted"}},
		{name: "node cap", source: `MATCH (source {name: "alpha"})-[:calls*2]->(target) RETURN target.name LIMIT 10`, maxNodes: 2, wantWarning: true},
		{name: "result cap", source: `MATCH (source {name: "alpha"})-[:calls*1..2]->(target) RETURN target.name ORDER BY target.name LIMIT 1`, want: []string{"beta"}, wantWarning: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, err := query.ParseGraphQuery(testCase.source)
			if err != nil {
				t.Fatal(err)
			}
			maxNodes := testCase.maxNodes
			if maxNodes == 0 {
				maxNodes = 10
			}
			result, err := query.ExecuteGraphQuerySnapshot(ctx, store, snapshot, parsed, query.GraphQueryLimits{MaxDepth: 5, MaxNodes: maxNodes}, query.GraphQueryOptions{})
			if err != nil {
				t.Fatal(err)
			}
			var names []string
			for _, row := range result.Rows {
				names = append(names, row[0].(string))
				if testCase.wantSecond != nil && !reflect.DeepEqual(row[1], testCase.wantSecond) {
					t.Fatalf("relationship property = %v, want %v", row[1], testCase.wantSecond)
				}
			}
			if !reflect.DeepEqual(names, testCase.want) || (len(result.Warnings) > 0) != testCase.wantWarning || len(result.Graph.Nodes) > maxNodes {
				t.Fatalf("result = %+v, want names %v, warning %v", result, testCase.want, testCase.wantWarning)
			}
			for _, node := range result.Graph.Nodes {
				if node.ID == "foreign" || node.Evidence != evidence {
					t.Fatalf("unexpected node: %+v", node)
				}
			}
			for _, edge := range result.Graph.Edges {
				found := false
				for _, expected := range edges {
					if edge == expected {
						found = true
					}
				}
				if !found {
					t.Fatalf("unexpected edge: %+v", edge)
				}
			}
			if len(result.Rows) > 0 && len(result.Graph.Edges) == 0 {
				t.Fatal("path result has no edge evidence")
			}
		})
	}
}

func TestExecuteGraphQuerySnapshotBoundsRecursiveWork(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	nodes, edges := []graph.Node{}, []graph.Edge{}
	for index := range 16 {
		name := fmt.Sprintf("dense%02d", index)
		nodes = append(nodes, graph.Node{ID: name, Kind: "Function", Label: name})
	}
	for _, source := range nodes {
		for _, target := range nodes {
			if source.ID != target.ID {
				edges = append(edges, graph.Edge{SourceID: source.ID, TargetID: target.ID, Relation: "calls"})
			}
		}
	}
	for _, name := range []string{"z_source", "z_middle", "z_target"} {
		nodes = append(nodes, graph.Node{ID: name, Kind: "Function", Label: name})
	}
	edges = append(edges, graph.Edge{SourceID: "z_source", TargetID: "z_middle", Relation: "calls"}, graph.Edge{SourceID: "z_middle", TargetID: "z_target", Relation: "calls"})
	nodes = append(nodes, graph.Node{ID: "parallel0", Kind: "Function", Label: "parallel0"})
	previous := []string{"parallel0"}
	for level := 1; level <= 5; level++ {
		current := []string{}
		for index := range 30 {
			name := fmt.Sprintf("parallel%d_%02d", level, index)
			nodes = append(nodes, graph.Node{ID: name, Kind: "Function", Label: name})
			current = append(current, name)
			for _, source := range previous {
				edges = append(edges, graph.Edge{SourceID: source, TargetID: name, Relation: "calls"})
			}
		}
		previous = current
	}
	snapshot, err := store.Publish(ctx, storage.PublishRequest{Workspace: "/workspace", WorkspaceFacts: graph.Facts{Nodes: nodes, Edges: edges}})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, source string
		want         string
		warning      bool
		maxNodes     int
	}{
		{name: "bounded empty result", source: `MATCH (source {name: 'dense00'})-[:calls*1..5]->(target {name: 'missing'}) RETURN target.name LIMIT 1`, warning: true},
		{name: "inline start", source: `MATCH (source {name: 'z_source'})-[:calls*2]->(target) RETURN target.name LIMIT 1`, want: "z_target"},
		{name: "WHERE start", source: `MATCH (source)-[:calls*2]->(target) WHERE source.name = 'z_source' RETURN target.name LIMIT 1`, want: "z_target"},
		{name: "incoming start", source: `MATCH (source {name: 'z_target'})<-[:calls*2]-(target) RETURN target.name LIMIT 1`, want: "z_source"},
		{name: "chained start", source: `MATCH (source {name: 'z_source'})-[:calls]->(middle)-[:calls]->(target) RETURN target.name LIMIT 1`, want: "z_target"},
		{name: "parallel chained paths", source: `MATCH (source {name: 'parallel0'})-[:calls]->(first)-[:calls]->(second)-[:calls]->(third)-[:calls]->(fourth)-[:calls]->(target) RETURN target.name ORDER BY target.name LIMIT 1`, want: "parallel5_00", warning: true, maxNodes: 1000},
	} {
		t.Run(test.name, func(t *testing.T) {
			parsed, err := query.ParseGraphQuery(test.source)
			if err != nil {
				t.Fatal(err)
			}
			boundedContext, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			maxNodes := test.maxNodes
			if maxNodes == 0 {
				maxNodes = 8
			}
			result, err := query.ExecuteGraphQuerySnapshot(boundedContext, store, snapshot, parsed, query.GraphQueryLimits{MaxDepth: 5, MaxNodes: maxNodes}, query.GraphQueryOptions{Diagnostics: true})
			if err != nil {
				t.Fatal(err)
			}
			if (len(result.Warnings) > 0) != test.warning || len(result.Graph.Nodes) > 8 {
				t.Fatalf("result = %+v, want bounded work warning %t", result, test.warning)
			}
			if test.want == "" && len(result.Rows) != 0 || test.want != "" && (len(result.Rows) != 1 || result.Rows[0][0] != test.want) {
				t.Fatalf("rows = %v, want %q", result.Rows, test.want)
			}
		})
	}
}
