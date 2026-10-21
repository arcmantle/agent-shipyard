package sqlite

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
	"agent-wayfinder/query/graph_query"
	"agent-wayfinder/storage"

	"github.com/arcmantle/go-sqlite3"
)

func TestGraphQuerySchemaReusesSnapshotWithCallerOwnedResults(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"function"}})
	if err != nil {
		t.Fatal(err)
	}
	contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
		SourcePath: "src/cache.ts", Metadata: extractor.Metadata{Name: "typescript", Version: "1", Extensions: []string{".ts"}},
		Facts: graph.Facts{Nodes: []graph.Node{testNode("function:cache", "src/cache.ts")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.Publish(ctx, storage.PublishRequest{Workspace: "workspace", Update: update, WorkspaceFacts: graph.Facts{Edges: []graph.Edge{{SourceID: "function:cache", TargetID: "function:cache", Relation: "calls"}}}})
	if err != nil {
		t.Fatal(err)
	}
	connection, err := store.database.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	allowFactReads := true
	err = connection.Raw(func(driverConnection any) error {
		driverConnection.(*sqlite3.SQLiteConn).RegisterAuthorizer(func(operation int, table, column, database string) int {
			if operation == sqlite3.SQLITE_READ && (table == "contribution_nodes" || table == "workspace_nodes" || table == "contribution_edges" || table == "workspace_edges") {
				if !allowFactReads || column == "node_id" || column == "source_id" || column == "target_id" || column == "file_hash" {
					return sqlite3.SQLITE_DENY
				}
			}
			return sqlite3.SQLITE_OK
		})
		return nil
	})
	_ = connection.Close()
	if err != nil {
		t.Fatal(err)
	}
	schema, err := store.GraphQuerySchema(ctx, snapshot)
	if err != nil || len(schema.NodeKinds["function"]) == 0 {
		t.Fatalf("initial schema = %+v, error %v", schema, err)
	}
	schema.NodeKinds["function"][0] = "altered"
	schema.NodeKinds["ghost"] = []string{"name"}
	schema.RelationshipTypes["calls"][0] = "altered"
	schema.RelationshipTypes["ghost"] = []string{"name"}
	allowFactReads = false
	reused, err := store.GraphQuerySchema(ctx, snapshot)
	if err != nil {
		t.Fatalf("schema reread snapshot facts: %v", err)
	}
	if len(reused.NodeKinds) != 1 || len(reused.NodeKinds["function"]) == 0 || len(reused.RelationshipTypes) != 1 {
		t.Fatalf("caller changed cached kinds: %+v", reused)
	}
	for _, property := range reused.NodeKinds["function"] {
		if property == "altered" {
			t.Fatal("caller changed cached properties")
		}
	}
	for _, property := range reused.RelationshipTypes["calls"] {
		if property == "altered" {
			t.Fatal("caller changed cached relationship properties")
		}
	}
	if _, err := store.database.ExecContext(ctx, "DELETE FROM graph_versions WHERE workspace = ? AND version = ?", snapshot.Workspace, snapshot.Version); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GraphQuerySchema(ctx, snapshot); !errors.Is(err, storage.ErrGraphVersionNotFound) {
		t.Fatalf("cached schema accepted a missing snapshot: %v", err)
	}
}

func TestNodeGraphQueryFiltersBeforeVisibleUnion(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	node := testNode("function:lookup", "src/lookup.ts")
	unrelated := node
	unrelated.ID = "function:unrelated"
	unrelated.Label = strings.Repeat("large", 2000)
	snapshot, err := store.Publish(ctx, storage.PublishRequest{Workspace: "workspace", WorkspaceFacts: graph.Facts{Nodes: []graph.Node{node, unrelated}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.GraphQuerySchema(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	connection, err := store.database.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	err = connection.Raw(func(driverConnection any) error {
		driverConnection.(*sqlite3.SQLiteConn).SetLimit(sqlite3.SQLITE_LIMIT_LENGTH, 4096)
		return nil
	})
	_ = connection.Close()
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := graph_query.Parse(`MATCH (node {id: "function:lookup"}) RETURN node LIMIT 1`)
	if err != nil {
		t.Fatal(err)
	}
	result, err := store.ExecuteGraphQuery(ctx, snapshot, storage.GraphQueryRequest{Query: parsed, Limits: graph_query.Limits{MaxDepth: 1, MaxNodes: 1}})
	if err != nil {
		t.Fatalf("node lookup processed an unrelated oversized row: %v", err)
	}
	if len(result.Facts.Nodes) != 1 || result.Facts.Nodes[0] != node || len(result.Facts.Edges) != 0 {
		t.Fatalf("node-only result changed: %+v", result)
	}
}

func TestDiagnosticPublicationCanOmitNodeFTS(t *testing.T) {
	for _, disabled := range []bool{false, true} {
		t.Run(fmt.Sprintf("disabled_%t", disabled), func(t *testing.T) {
			ctx := context.Background()
			store, err := OpenWithOptions(ctx, filepath.Join(t.TempDir(), "graph.db"), Options{DisableNodeFTS: disabled})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = store.Close() })
			vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"function"}})
			if err != nil {
				t.Fatal(err)
			}
			contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
				SourcePath: "src/token.ts", Metadata: extractor.Metadata{Name: "typescript", Version: "1", Extensions: []string{".ts"}},
				Facts: graph.Facts{Nodes: []graph.Node{testNode("function:token", "src/token.ts")}},
			})
			if err != nil {
				t.Fatal(err)
			}
			update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
			if err != nil {
				t.Fatal(err)
			}
			first, err := store.Publish(ctx, storage.PublishRequest{Workspace: "workspace", Update: update})
			if err != nil {
				t.Fatal(err)
			}
			session, err := store.BeginContributionSession(ctx, "workspace")
			if err != nil {
				t.Fatal(err)
			}
			defer session.Rollback(ctx)
			if err := session.StageSource(ctx, contribution.SourcePath()); err != nil {
				t.Fatal(err)
			}
			if err := session.WriteContribution(ctx, contribution); err != nil {
				t.Fatal(err)
			}
			if err := session.SealContributions(ctx); err != nil {
				t.Fatal(err)
			}
			if _, err := session.SealWorkspaceFacts(ctx); err != nil {
				t.Fatal(err)
			}
			second, err := session.Commit(ctx, storage.CommitRequest{})
			if err != nil {
				t.Fatal(err)
			}
			for _, snapshot := range []storage.Snapshot{first, second} {
				counts, err := store.FactCounts(ctx, snapshot)
				if err != nil || counts.Nodes != 1 {
					t.Fatalf("graph counts=%+v, error %v", counts, err)
				}
				matches, err := store.SearchNodes(ctx, snapshot, storage.LexicalSearchRequest{Text: "token", Limit: 10})
				if err != nil {
					t.Fatal(err)
				}
				want := 1
				if disabled {
					want = 0
				}
				if len(matches) != want {
					t.Fatalf("node FTS matches=%d, want %d", len(matches), want)
				}
			}
		})
	}
}

func TestLexicalBatchesPreserveVisibleRowsAndSnapshots(t *testing.T) {
	for _, limits := range []factBatchLimits{
		{maximumRows: 500, maximumBytes: 4 << 20},
		{maximumRows: 3, maximumBytes: 4 << 20},
		{maximumRows: 500, maximumBytes: 512},
	} {
		t.Run(fmt.Sprintf("rows_%d_bytes_%d", limits.maximumRows, limits.maximumBytes), func(t *testing.T) {
			ctx := context.Background()
			store, err := Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = store.Close() })
			store.lexicalBatchLimits = limits
			if limits.maximumRows == 500 && limits.maximumBytes == 4<<20 {
				store.database.SetMaxOpenConns(1)
				connection, err := store.database.Conn(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if err := connection.Raw(func(driverConnection any) error {
					driverConnection.(*sqlite3.SQLiteConn).SetLimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 24)
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				if err := connection.Close(); err != nil {
					t.Fatal(err)
				}
				store.variableLimit = 24
			}
			vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"function"}})
			if err != nil {
				t.Fatal(err)
			}
			var contributions []extractor.Contribution
			for _, path := range []string{"src/first.ts", "src/second.ts"} {
				nodes := []graph.Node{testNode("function:shared", path)}
				if path == "src/first.ts" {
					for number := range 503 {
						node := testNode(fmt.Sprintf("function:boundary:%04d", number), path)
						node.Label = fmt.Sprintf("BoundaryNeedle%04d", number)
						nodes = append(nodes, node)
					}
				}
				contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
					ProjectID: "project:fixture", SourcePath: path,
					Metadata: extractor.Metadata{Name: "typescript", Version: "1", Extensions: []string{".ts"}},
					Facts:    graph.Facts{Nodes: nodes},
				})
				if err != nil {
					t.Fatal(err)
				}
				contributions = append(contributions, contribution)
			}
			update, err := extractor.NewGraphUpdate(contributions)
			if err != nil {
				t.Fatal(err)
			}
			first, err := store.Publish(ctx, storage.PublishRequest{Workspace: "workspace", Update: update})
			if err != nil {
				t.Fatal(err)
			}
			session, err := store.BeginContributionSession(ctx, "workspace")
			if err != nil {
				t.Fatal(err)
			}
			defer session.Rollback(ctx)
			for _, contribution := range contributions {
				if err := session.StageSource(ctx, contribution.SourcePath()); err != nil {
					t.Fatal(err)
				}
			}
			if err := session.SealContributions(ctx); err != nil {
				t.Fatal(err)
			}
			if err := session.WriteWorkspaceFacts(ctx, graph.Facts{Nodes: []graph.Node{testNode("function:shared", "src/workspace.ts"), testNode("function:shared", "src/first.ts")}}); err != nil {
				t.Fatal(err)
			}
			if _, err := session.SealWorkspaceFacts(ctx); err != nil {
				t.Fatal(err)
			}
			second, err := session.Commit(ctx, storage.CommitRequest{})
			if err != nil {
				t.Fatal(err)
			}
			var storedRows int
			if err := store.database.QueryRow(`SELECT count(*) FROM node_search`).Scan(&storedRows); err != nil {
				t.Fatal(err)
			}
			if storedRows != 506 {
				t.Fatalf("shared lexical rows = %d, want 506 graph node rows", storedRows)
			}
			if err := store.RebuildLexicalIndex(ctx, "workspace"); err != nil {
				t.Fatal(err)
			}
			for _, snapshot := range []storage.Snapshot{first, second} {
				matches, err := store.SearchNodes(ctx, snapshot, storage.LexicalSearchRequest{Text: "boundary needle", Limit: 1000})
				if err != nil || len(matches) != 503 {
					t.Fatalf("snapshot %d matches = %d, error %v, want 503", snapshot.Version, len(matches), err)
				}
				for _, match := range matches {
					if match.Node.Evidence != testNode(match.Node.ID, "src/first.ts").Evidence {
						t.Fatalf("changed evidence: %+v", match.Node)
					}
				}
			}
			emptySession, err := store.BeginContributionSession(ctx, "workspace")
			if err != nil {
				t.Fatal(err)
			}
			defer emptySession.Rollback(ctx)
			empty, err := emptySession.Commit(ctx, storage.CommitRequest{})
			if err != nil {
				t.Fatal(err)
			}
			matches, err := store.SearchNodes(ctx, empty, storage.LexicalSearchRequest{Text: "boundary needle", Limit: 1000})
			if err != nil || len(matches) != 0 {
				t.Fatalf("empty snapshot matches = %d, error %v, want none", len(matches), err)
			}
		})
	}
}

func TestLexicalByteLimitFailureKeepsPriorSnapshot(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	prior, err := store.Publish(ctx, storage.PublishRequest{Workspace: "workspace", Update: workspaceFactTestUpdate(t)})
	if err != nil {
		t.Fatal(err)
	}
	store.lexicalBatchLimits.maximumBytes = 1
	if _, err := store.Publish(ctx, storage.PublishRequest{Workspace: "workspace", Update: workspaceFactTestUpdate(t)}); err == nil || !strings.Contains(err.Error(), "byte limit") {
		t.Fatalf("publish with lexical byte limit = %v, want failure", err)
	}
	current, err := store.OpenSnapshot(ctx, storage.OpenSnapshotRequest{Workspace: "workspace"})
	if err != nil || current != prior {
		t.Fatalf("current snapshot = %+v, error %v, want %+v", current, err, prior)
	}
	matches, err := store.SearchNodes(ctx, prior, storage.LexicalSearchRequest{Text: "prior", Limit: 10})
	if err != nil || len(matches) != 1 {
		t.Fatalf("prior lexical matches = %+v, error %v", matches, err)
	}
}

func TestContributionSessionRejectsWorkspaceFactLargerThanByteLimit(t *testing.T) {
	store, err := Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	store.workspaceFactBatchLimits = factBatchLimits{maximumRows: 100, maximumBytes: 64}

	ctx := context.Background()
	prior, err := store.Publish(ctx, storage.PublishRequest{Workspace: "workspace", Update: workspaceFactTestUpdate(t)})
	if err != nil {
		t.Fatalf("publish prior snapshot: %v", err)
	}

	session, err := store.BeginContributionSession(ctx, "workspace")
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	if err := session.SealContributions(ctx); err != nil {
		t.Fatalf("seal contributions: %v", err)
	}
	oversized := testNode("function:oversized", "src/oversized.ts")
	oversized.Label = strings.Repeat("x", 128)
	if err := session.WriteWorkspaceFacts(ctx, graph.Facts{Nodes: []graph.Node{oversized}}); err == nil || !strings.Contains(err.Error(), "64 byte limit") {
		t.Fatalf("write oversized workspace fact = %v, want byte-limit error", err)
	}

	current, err := store.OpenSnapshot(ctx, storage.OpenSnapshotRequest{Workspace: "workspace"})
	if err != nil {
		t.Fatalf("open current snapshot: %v", err)
	}
	if current != prior {
		t.Errorf("current snapshot after oversized fact = %+v, want prior %+v", current, prior)
	}
}

func workspaceFactTestUpdate(t *testing.T) extractor.GraphUpdate {
	t.Helper()
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"function"}})
	if err != nil {
		t.Fatalf("create vocabulary: %v", err)
	}
	contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
		ProjectID:  "project:fixture",
		SourcePath: "src/prior.ts",
		Metadata:   extractor.Metadata{Name: "typescript", Version: "1", Extensions: []string{".ts"}},
		Facts:      graph.Facts{Nodes: []graph.Node{testNode("function:prior", "src/prior.ts")}},
	})
	if err != nil {
		t.Fatalf("create contribution: %v", err)
	}
	update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
	if err != nil {
		t.Fatalf("create graph update: %v", err)
	}
	return update
}

func testNode(nodeID, sourcePath string) graph.Node {
	return graph.Node{
		ID:   nodeID,
		Kind: "function",
		Evidence: graph.FactEvidence{
			Span:       graph.SourceSpan{Path: sourcePath, StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 2},
			FileHash:   "hash",
			Extractor:  "test@1",
			Provenance: "syntax",
			Confidence: graph.ConfidenceExtracted,
		},
	}
}
