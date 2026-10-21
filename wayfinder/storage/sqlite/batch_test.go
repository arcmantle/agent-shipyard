package sqlite

import (
	"context"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
	"agent-wayfinder/storage"

	sqlite3 "github.com/arcmantle/go-sqlite3"
)

func TestInsertRowsAdaptsToSQLiteVariableLimit(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	transaction, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("start transaction: %v", err)
	}
	t.Cleanup(func() { _ = transaction.Rollback() })
	if _, err := transaction.ExecContext(ctx, "CREATE TEMP TABLE batch_fixture (name TEXT NOT NULL, value INTEGER NOT NULL)"); err != nil {
		t.Fatalf("create batch fixture: %v", err)
	}

	rows := [][]any{{"one", 1}, {"two", 2}, {"three", 3}, {"four", 4}, {"five", 5}}
	if err := insertRows(ctx, transaction, 6, 500, "INSERT INTO batch_fixture (name, value) VALUES ", rows); err != nil {
		t.Fatalf("insert adaptive batches: %v", err)
	}

	var count int
	if err := transaction.QueryRowContext(ctx, "SELECT COUNT(*) FROM batch_fixture").Scan(&count); err != nil {
		t.Fatalf("count inserted rows: %v", err)
	}
	if count != len(rows) {
		t.Errorf("inserted row count = %d, want %d", count, len(rows))
	}
}

func TestPublicationWorkerCountStaysWithinContributionAndConfiguredBounds(t *testing.T) {
	for _, contributionCount := range []int{0, 1, 2, maximumPublicationWorkers + 1} {
		workerCount := publicationWorkerCount(contributionCount)
		if workerCount > contributionCount {
			t.Errorf("worker count for %d contributions = %d, exceeds contribution count", contributionCount, workerCount)
		}
		if workerCount > maximumPublicationWorkers {
			t.Errorf("worker count for %d contributions = %d, exceeds configured maximum %d", contributionCount, workerCount, maximumPublicationWorkers)
		}
	}
}

func TestContributionSessionProjectionBatchesPreserveVisibleData(t *testing.T) {
	for _, variableLimit := range []int{0, 24} {
		t.Run(fmt.Sprintf("variable_limit_%d", variableLimit), func(t *testing.T) {
			ctx := context.Background()
			store, err := Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = store.Close() })
			vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"function"}, Relations: []graph.RelationDefinition{{Kind: "references", Endpoints: []graph.EndpointRule{{Source: "function", Target: "function"}}}}})
			if err != nil {
				t.Fatal(err)
			}
			var contributions []extractor.Contribution
			for sourceIndex := range 30 {
				sourcePath := fmt.Sprintf("src/file-%03d.ts", sourceIndex)
				node := testNode("function:main", sourcePath)
				contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
					ProjectID: "project:fixture", SourcePath: sourcePath,
					Metadata: extractor.Metadata{Name: "typescript", Version: "1", Extensions: []string{".mts", ".ts"}},
					Facts:    graph.Facts{Nodes: []graph.Node{node}, Edges: []graph.Edge{{SourceID: node.ID, TargetID: node.ID, Relation: "references", Evidence: node.Evidence}}},
					UnresolvedReferences: []extractor.UnresolvedReference{
						{SourceID: node.ID, Target: "./helper", Kind: extractor.ModuleReferenceImport, Bindings: []extractor.ModuleBinding{{ImportedName: "helper", LocalName: sourcePath}}},
						{SourceID: node.ID, Target: "./helper", Kind: extractor.ModuleReferenceReExport, Bindings: []extractor.ModuleBinding{{ImportedName: "helper", ExportedName: sourcePath}}},
						{SourceID: node.ID, Target: "./other", Kind: extractor.ModuleReferenceImport, Ambiguous: true},
					},
					SymbolReferences: []extractor.SymbolReference{{SourceID: node.ID, Target: "helper", Relation: "references", Evidence: node.Evidence}},
					ExportedSurfaces: []extractor.ExportedSurface{{NodeID: node.ID, Name: sourcePath}},
					Dependencies:     []extractor.Dependency{{SourcePath: sourcePath, TargetPath: "src/helper.ts"}},
					Diagnostics:      []extractor.Diagnostic{{Severity: extractor.DiagnosticWarning, Message: sourcePath}},
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
			snapshot, err := store.Publish(ctx, storage.PublishRequest{Workspace: "workspace", Update: update})
			if err != nil {
				t.Fatal(err)
			}
			expected, err := store.ResolverProjectionPage(ctx, snapshot, storage.ResolverProjectionPageRequest{ProjectID: "project:fixture", Language: "typescript", Limit: 30})
			if err != nil || len(expected) != 30 {
				t.Fatalf("reference projections: %d, %v", len(expected), err)
			}
			expected = expected[:29]
			for projectionIndex := range expected {
				expected[projectionIndex].Edges = nil
			}
			store.database.SetMaxOpenConns(1)
			connection, err := store.database.Conn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			nodeReads := 0
			if err := connection.Raw(func(driverConnection any) error {
				driver := driverConnection.(*sqlite3.SQLiteConn)
				if variableLimit != 0 {
					driver.SetLimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, variableLimit)
					store.variableLimit = variableLimit
				}
				driver.RegisterAuthorizer(func(operation int, table, column, database string) int {
					if operation == sqlite3.SQLITE_READ && table == "contribution_nodes" && column == "label" {
						nodeReads++
					}
					return sqlite3.SQLITE_OK
				})
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if err := connection.Close(); err != nil {
				t.Fatal(err)
			}
			session, err := store.BeginContributionSession(ctx, "workspace")
			if err != nil {
				t.Fatal(err)
			}
			defer session.Rollback(ctx)
			for _, contribution := range contributions[:29] {
				if err := session.StageSource(ctx, contribution.SourcePath()); err != nil {
					t.Fatal(err)
				}
			}
			expected[0].Metadata.Version = "2"
			expected[0].Diagnostics[0].Message = "pending diagnostic"
			pending := expected[0]
			replacement, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
				ProjectID: pending.ProjectID, SourcePath: pending.SourcePath, Metadata: pending.Metadata,
				Facts: graph.Facts{Nodes: pending.Nodes}, UnresolvedReferences: pending.UnresolvedReferences,
				SymbolReferences: pending.SymbolReferences, ExportedSurfaces: pending.ExportedSurfaces,
				Dependencies: pending.Dependencies, Diagnostics: pending.Diagnostics,
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := session.WriteContribution(ctx, replacement); err != nil {
				t.Fatal(err)
			}
			if err := session.SealContributions(ctx); err != nil {
				t.Fatal(err)
			}
			var actual []storage.ResolverProjection
			request := storage.ResolverProjectionPageRequest{ProjectID: "project:fixture", Language: "typescript", Limit: 23}
			for {
				nodeReads = 0
				page, err := session.ResolverProjectionPage(ctx, snapshot, request)
				if err != nil {
					t.Fatal(err)
				}
				maximumPaths := store.variableLimit - 3
				if want := (len(page) + maximumPaths - 1) / maximumPaths; nodeReads != want {
					t.Fatalf("node reads = %d, want %d for %d sources", nodeReads, want, len(page))
				}
				if len(page) == 0 {
					break
				}
				actual = append(actual, page...)
				request.AfterSourcePath = page[len(page)-1].SourcePath
			}
			if !reflect.DeepEqual(actual, expected) {
				t.Fatalf("session projections differ from reference: got %+v, want %+v", actual, expected)
			}
		})
	}
}
