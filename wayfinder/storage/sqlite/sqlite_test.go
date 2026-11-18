package sqlite_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"agent-wayfinder/benchmark"
	"agent-wayfinder/extractor"
	goextractor "agent-wayfinder/extractors/go"
	"agent-wayfinder/extractors/typescript"
	"agent-wayfinder/graph"
	"agent-wayfinder/index"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
	"agent-wayfinder/testkit"

	_ "github.com/arcmantle/go-sqlite3"
)

type catalogGenerationCounter struct {
	synopses, embeddings int
}

func (counter *catalogGenerationCounter) GenerateCatalogSynopsis(_ context.Context, input index.CatalogSynopsisInput) (string, error) {
	counter.synopses++
	return "Synopsis for " + input.Name + ": " + input.DeclarationSource, nil
}

func (counter *catalogGenerationCounter) GenerateCatalogEmbedding(context.Context, string) ([]float32, error) {
	counter.embeddings++
	return []float32{1}, nil
}

func TestCatalogRetentionControlsStoredRows(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	specification, err := benchmark.ExactScaleCorpusSpec(20)
	if err != nil {
		t.Fatal(err)
	}
	corpus, err := benchmark.GenerateCorpus(root, specification)
	if err != nil {
		t.Fatal(err)
	}
	var graphOnlyFacts *factCollector
	var graphOnlyBytes int64
	for _, retain := range []bool{false, true} {
		t.Run(fmt.Sprintf("retain-%t", retain), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "graph.db")
			store, err := sqlite.Open(ctx, path)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = store.Close() })
			snapshot, err := index.Publish(ctx, store, index.Request{Root: root, RetainCatalogUnits: retain})
			if err != nil {
				t.Fatal(err)
			}
			counts, err := store.FactCounts(ctx, snapshot)
			if err != nil || counts.Nodes != corpus.ExpectedNodes || counts.Edges != corpus.ExpectedEdges {
				t.Fatalf("fact counts = %+v, error %v", counts, err)
			}
			facts := &factCollector{}
			if err := store.Export(ctx, snapshot, storage.ExportRequest{}, facts); err != nil {
				t.Fatal(err)
			}
			database, err := sql.Open("sqlite3", path)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = database.Close() })
			for _, table := range []string{"contribution_catalog_units", "contribution_catalog_unit_coverage"} {
				var count int
				if err := database.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table).Scan(&count); err != nil {
					t.Fatal(err)
				}
				want := 0
				if retain {
					want = corpus.FunctionCount
					if table == "contribution_catalog_unit_coverage" {
						want = corpus.SourceFiles
					}
				}
				if count != want {
					t.Fatalf("%s rows=%d, want %d", table, count, want)
				}
			}
			var pages, pageSize int64
			if err := database.QueryRowContext(ctx, "PRAGMA page_count").Scan(&pages); err != nil {
				t.Fatal(err)
			}
			if err := database.QueryRowContext(ctx, "PRAGMA page_size").Scan(&pageSize); err != nil {
				t.Fatal(err)
			}
			bytes := pages * pageSize
			t.Logf("retained=%t, database page bytes=%d, source files=%d, functions=%d, nodes=%d, edges=%d", retain, bytes, corpus.SourceFiles, corpus.FunctionCount, counts.Nodes, counts.Edges)
			if !retain {
				graphOnlyFacts = facts
				graphOnlyBytes = bytes
			} else {
				if !reflect.DeepEqual(facts, graphOnlyFacts) {
					t.Fatal("retention changed graph facts or evidence")
				}
				t.Logf("database page saving=%d bytes", bytes-graphOnlyBytes)
			}
		})
	}
}

func TestCatalogReusesFullReindexSynopsesAndEmbeddings(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"go.mod":             "module example.com/fixture\n",
		"validator/token.go": "package validator\n\nfunc ValidateToken() bool { return false }\n",
		"validator/other.go": "package validator\n\nfunc KeepToken() bool { return true }\n",
	})
	databasePath := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), databasePath)
	if err != nil {
		t.Fatalf("open graph store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	database, err := sql.Open("sqlite3", databasePath)
	if err != nil {
		t.Fatalf("open catalogue row counter: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	previousCounts := make(map[string]int)
	var historicalSnapshot storage.Snapshot
	var historicalEntries []storage.CatalogEntry
	for _, step := range []struct {
		name, source             string
		synopses, embeddings     int
		migrate, prune, rollback bool
	}{
		{name: "initial", synopses: 2, embeddings: 4},
		{name: "unchanged after migration", migrate: true},
		{name: "unchanged"},
		{name: "unchanged after pruning", prune: true},
		{name: "changed", source: "package validator\n\nfunc ValidateToken() bool { return !true }\n", synopses: 1, embeddings: 1},
		{name: "rollback", source: "package validator\n\nfunc ValidateToken() bool { return false }\n", rollback: true},
		{name: "unchanged again"},
		{name: "added and deleted", source: "package validator\n\nfunc NewToken() bool { return false }\n", synopses: 1, embeddings: 2},
	} {
		t.Run(step.name, func(t *testing.T) {
			if step.rollback {
				if _, err := store.Rollback(context.Background(), storage.RollbackRequest{Workspace: workspace.Root, Version: historicalSnapshot.Version}); err != nil {
					t.Fatalf("rollback catalogue change: %v", err)
				}
			}
			if step.migrate {
				if err := store.Close(); err != nil {
					t.Fatalf("close store before legacy migration: %v", err)
				}
				if _, err := database.Exec(`DROP INDEX catalog_entries_visible; DROP INDEX catalog_embeddings_visible;
					ALTER TABLE catalog_entries DROP COLUMN valid_to_version; ALTER TABLE catalog_entries DROP COLUMN unit_input;
					ALTER TABLE catalog_embeddings DROP COLUMN valid_to_version;
					DELETE FROM schema_migrations; INSERT INTO schema_migrations (version, applied_at) VALUES (25, '2026-10-03T00:00:00Z')`); err != nil {
					t.Fatalf("seed legacy catalogue: %v", err)
				}
				store, err = sqlite.Open(context.Background(), databasePath)
				if err != nil {
					t.Fatalf("migrate legacy catalogue: %v", err)
				}
			}
			if step.source != "" {
				workspace.WriteFile(t, "validator/token.go", step.source)
			}
			snapshot, err := index.Publish(context.Background(), store, index.Request{Root: workspace.Root})
			if err != nil {
				t.Fatalf("publish full graph: %v", err)
			}
			if step.prune {
				if _, err := store.Prune(context.Background(), storage.PruneRequest{Workspace: workspace.Root, BeforeVersion: snapshot.Version}); err != nil {
					t.Fatalf("prune origin graph versions: %v", err)
				}
			}
			counter := &catalogGenerationCounter{}
			result, err := index.Catalog(context.Background(), store, index.CatalogRequest{
				Root: workspace.Root,
				CatalogWriteOptions: index.CatalogWriteOptions{
					SynopsisGenerator: counter, SynopsisProvider: index.CatalogSynopsisProviderCopilot,
					SynopsisSourceLimit: 4096, EmbeddingGenerator: counter,
				},
			})
			if err != nil {
				t.Fatalf("build catalog: %v", err)
			}
			if counter.synopses != step.synopses || counter.embeddings != step.embeddings {
				t.Errorf("generation calls = %+v, want %d synopses and %d embeddings", counter, step.synopses, step.embeddings)
			}
			for _, table := range []string{"catalog_entries", "catalog_search", "catalog_embeddings", "catalog_embedding_vectors_1"} {
				var count int
				if err := database.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil {
					t.Fatalf("count %s: %v", table, err)
				}
				if strings.HasPrefix(step.name, "unchanged") && count != previousCounts[table] {
					t.Errorf("%s rows = %d, want unchanged count %d", table, count, previousCounts[table])
				}
				previousCounts[table] = count
			}
			matches, err := store.SearchCatalog(context.Background(), result.Snapshot, storage.CatalogSearchRequest{Text: "token", Limit: 10})
			if err != nil || len(matches) != 2 {
				t.Fatalf("catalog matches = %+v, error = %v, want two current nodes", matches, err)
			}
			vectors, err := store.SearchCatalogVectors(context.Background(), result.Snapshot, storage.CatalogVectorSearchRequest{Vector: []float32{1}, Limit: 10})
			if err != nil || len(vectors) != 2 {
				t.Fatalf("vector matches = %+v, error = %v, want two current nodes", vectors, err)
			}
			if step.prune {
				historicalSnapshot = result.Snapshot
				for _, match := range matches {
					historicalEntries = append(historicalEntries, match.Entry)
				}
			}
			if historicalSnapshot.Version != 0 {
				nodeIDs := make([]string, len(historicalEntries))
				for entryIndex, entry := range historicalEntries {
					nodeIDs[entryIndex] = entry.NodeID
				}
				entries, err := store.ReadCatalogEntries(context.Background(), historicalSnapshot, storage.CatalogEntryReadRequest{NodeIDs: nodeIDs})
				if err != nil || len(entries) != len(historicalEntries) {
					t.Fatalf("historical entries = %+v, error = %v", entries, err)
				}
				for _, entry := range entries {
					if entry.Name == "ValidateToken" && !strings.Contains(entry.CopilotSynopsis, "return false") {
						t.Errorf("historical synopsis changed: %+v", entry)
					}
				}
				for _, search := range []func() ([]storage.CatalogMatch, error){
					func() ([]storage.CatalogMatch, error) {
						return store.SearchCatalog(context.Background(), historicalSnapshot, storage.CatalogSearchRequest{Text: "token", Limit: 10})
					},
					func() ([]storage.CatalogMatch, error) {
						return store.SearchCatalogVectors(context.Background(), historicalSnapshot, storage.CatalogVectorSearchRequest{Vector: []float32{1}, Limit: 10})
					},
				} {
					oldMatches, err := search()
					if err != nil || len(oldMatches) != 2 {
						t.Fatalf("historical matches = %+v, error = %v", oldMatches, err)
					}
					for _, match := range oldMatches {
						if match.Entry.Name == "ValidateToken" && !strings.Contains(match.Entry.CopilotSynopsis, "return false") {
							t.Errorf("historical search synopsis changed: %+v", match.Entry)
						}
					}
				}
			}
			if step.name == "added and deleted" {
				for _, match := range append(matches, vectors...) {
					if match.Entry.Name == "ValidateToken" {
						t.Error("deleted node remains in catalog")
					}
				}
			}
		})
	}
}

func TestDelayedCatalogWritesRespectNewerSnapshotInputs(t *testing.T) {
	for _, oldFirst := range []bool{true, false} {
		t.Run(fmt.Sprintf("old-first-%t", oldFirst), func(t *testing.T) {
			workspace := testkit.NewWorkspace(t, map[string]string{
				"go.mod":   "module example.com/fixture\n",
				"token.go": "package fixture\n\nfunc Token() bool { return false }\n",
			})
			store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
			if err != nil {
				t.Fatalf("open store: %v", err)
			}
			t.Cleanup(func() { _ = store.Close() })
			first, err := index.Publish(context.Background(), store, index.Request{Root: workspace.Root, RetainCatalogUnits: true})
			if err != nil {
				t.Fatalf("publish initial snapshot: %v", err)
			}
			workspace.WriteFile(t, "token.go", "package fixture\n\nfunc Token() bool { return !true }\n")
			second, err := index.Publish(context.Background(), store, index.Request{Root: workspace.Root})
			if err != nil {
				t.Fatalf("publish changed snapshot: %v", err)
			}
			order := []storage.Snapshot{first, second}
			if !oldFirst {
				order = []storage.Snapshot{second, first}
			}
			for _, snapshot := range order {
				counter := &catalogGenerationCounter{}
				if _, err := index.Catalog(context.Background(), store, index.CatalogRequest{
					Root: workspace.Root, Snapshot: snapshot,
					CatalogWriteOptions: index.CatalogWriteOptions{SynopsisGenerator: counter,
						SynopsisProvider: index.CatalogSynopsisProviderCopilot, SynopsisSourceLimit: 4096, EmbeddingGenerator: counter},
				}); err != nil {
					t.Fatalf("catalog snapshot %d: %v", snapshot.Version, err)
				}
				if oldFirst && snapshot.Version == first.Version {
					matches, err := store.SearchCatalog(context.Background(), second, storage.CatalogSearchRequest{Text: "token", Limit: 10})
					if err != nil || len(matches) != 0 {
						t.Fatalf("stale catalogue matches = %+v, error = %v, want none", matches, err)
					}
				}
			}
			for _, snapshot := range []storage.Snapshot{first, second} {
				matches, err := store.SearchCatalogVectors(context.Background(), snapshot, storage.CatalogVectorSearchRequest{Vector: []float32{1}, Limit: 10})
				if err != nil || len(matches) != 1 {
					t.Fatalf("snapshot %d vector matches = %+v, error = %v", snapshot.Version, matches, err)
				}
				body := "return false"
				if snapshot.Version == second.Version {
					body = "return !true"
				}
				if !strings.Contains(matches[0].Entry.CopilotSynopsis, body) {
					t.Errorf("snapshot %d synopsis = %q, want %q", snapshot.Version, matches[0].Entry.CopilotSynopsis, body)
				}
			}
		})
	}
}

func TestOpenMigratesNewDatabaseAndReopensIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")

	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open new database: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close new database: %v", err)
	}

	store, err = sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("reopen migrated database: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close migrated database: %v", err)
	}
}

func TestReserveSpendAppliesPeriodLimits(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		limits storage.SpendLimits
	}{
		{name: "daily", limits: storage.SpendLimits{Daily: 30}},
		{name: "weekly", limits: storage.SpendLimits{Weekly: 30}},
		{name: "monthly", limits: storage.SpendLimits{Monthly: 30}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
			if err != nil {
				t.Fatalf("open database: %v", err)
			}
			t.Cleanup(func() { _ = store.Close() })
			request := storage.SpendReservationRequest{Provider: "copilot", Unit: "ai_credits", MaximumAmount: 30, MinimumAmount: 30, Limits: testCase.limits}
			if reservation, err := store.ReserveSpend(context.Background(), request); err != nil || reservation.Amount != 30 {
				t.Fatalf("reserve first request: reservation %+v, error %v; want 30 and no error", reservation, err)
			}
			if _, err := store.ReserveSpend(context.Background(), request); !errors.Is(err, storage.ErrSpendLimitExceeded) {
				t.Errorf("reserve second request error = %v, want spend limit exceeded", err)
			}
		})
	}
}

func TestReserveSpendUsesTheMostRestrictiveActivePeriod(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	request := storage.SpendReservationRequest{
		Provider:      "claude",
		Unit:          "usd",
		MaximumAmount: 30,
		MinimumAmount: 1,
		Limits:        storage.SpendLimits{Daily: 30, Weekly: 20, Monthly: 10},
	}
	if reservation, err := store.ReserveSpend(context.Background(), request); err != nil || reservation.Amount != 10 {
		t.Fatalf("reserve first request: reservation %+v, error %v; want 10 and no error", reservation, err)
	}
	if _, err := store.ReserveSpend(context.Background(), request); !errors.Is(err, storage.ErrSpendLimitExceeded) {
		t.Errorf("reserve second request error = %v, want spend limit exceeded", err)
	}
}

func TestReserveSpendResetsAtUTCBoundaries(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		start  time.Time
		next   time.Time
		limits storage.SpendLimits
	}{
		{
			name:   "daily",
			start:  time.Date(2026, time.September, 23, 23, 59, 59, 0, time.UTC),
			next:   time.Date(2026, time.September, 24, 0, 0, 0, 0, time.UTC),
			limits: storage.SpendLimits{Daily: 30},
		},
		{
			name:   "Monday weekly",
			start:  time.Date(2026, time.September, 27, 23, 59, 59, 0, time.UTC),
			next:   time.Date(2026, time.September, 28, 0, 0, 0, 0, time.UTC),
			limits: storage.SpendLimits{Weekly: 30},
		},
		{
			name:   "monthly",
			start:  time.Date(2026, time.September, 30, 23, 59, 59, 0, time.UTC),
			next:   time.Date(2026, time.October, 1, 0, 0, 0, 0, time.UTC),
			limits: storage.SpendLimits{Monthly: 30},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			currentTime := testCase.start
			store, err := sqlite.OpenWithOptions(context.Background(), filepath.Join(t.TempDir(), "graph.db"), sqlite.Options{
				Now: func() time.Time { return currentTime },
			})
			if err != nil {
				t.Fatalf("open database: %v", err)
			}
			t.Cleanup(func() { _ = store.Close() })
			request := storage.SpendReservationRequest{
				Provider:      "copilot",
				Unit:          "ai_credits",
				MaximumAmount: 30,
				MinimumAmount: 30,
				Limits:        testCase.limits,
			}
			if _, err := store.ReserveSpend(context.Background(), request); err != nil {
				t.Fatalf("reserve before boundary: %v", err)
			}
			currentTime = testCase.next
			if reservation, err := store.ReserveSpend(context.Background(), request); err != nil || reservation.Amount != 30 {
				t.Errorf("reserve after boundary: reservation %+v, error %v; want 30 and no error", reservation, err)
			}
		})
	}
}

func TestReserveSpendDoesNotExceedLimitForConcurrentRequests(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	request := storage.SpendReservationRequest{
		Provider:      "copilot",
		Unit:          "ai_credits",
		MaximumAmount: 30,
		MinimumAmount: 30,
		Limits:        storage.SpendLimits{Daily: 30},
	}
	start := make(chan struct{})
	errorsByRequest := make(chan error, 3)
	var requests sync.WaitGroup
	for range 3 {
		requests.Add(1)
		go func() {
			defer requests.Done()
			<-start
			_, err := store.ReserveSpend(context.Background(), request)
			errorsByRequest <- err
		}()
	}
	close(start)
	requests.Wait()
	close(errorsByRequest)

	successes := 0
	for err := range errorsByRequest {
		if err == nil {
			successes++
			continue
		}
		if !errors.Is(err, storage.ErrSpendLimitExceeded) {
			t.Errorf("concurrent reservation error = %v, want spend limit exceeded", err)
		}
	}
	if successes != 1 {
		t.Errorf("successful concurrent reservations = %d, want 1", successes)
	}
}

func TestSettleSpendReleasesUnusedReservedAmount(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	request := storage.SpendReservationRequest{
		Provider:      "claude",
		Unit:          "usd",
		MaximumAmount: 30,
		MinimumAmount: 1,
		Limits:        storage.SpendLimits{Daily: 30},
	}
	reservation, err := store.ReserveSpend(context.Background(), request)
	if err != nil {
		t.Fatalf("reserve spend: %v", err)
	}
	if err := store.SettleSpend(context.Background(), reservation.ID, 1); err != nil {
		t.Fatalf("settle spend: %v", err)
	}
	request.MaximumAmount = 30
	if reservation, err := store.ReserveSpend(context.Background(), request); err != nil || reservation.Amount != 29 {
		t.Errorf("reserve after settlement: reservation %+v, error %v; want 29 and no error", reservation, err)
	}
}

func TestSettleSpendRejectsInvalidOrIncreasedAmounts(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	request := storage.SpendReservationRequest{
		Provider:      "claude",
		Unit:          "usd",
		MaximumAmount: 30,
		MinimumAmount: 1,
		Limits:        storage.SpendLimits{Daily: 30},
	}
	reservation, err := store.ReserveSpend(context.Background(), request)
	if err != nil {
		t.Fatalf("reserve spend: %v", err)
	}
	for _, amount := range []float64{-1, math.Inf(1), math.NaN(), 31} {
		if err := store.SettleSpend(context.Background(), reservation.ID, amount); !errors.Is(err, storage.ErrInvalidRequest) {
			t.Errorf("settle spend amount %v error = %v, want invalid request", amount, err)
		}
	}
	if err := store.SettleSpend(context.Background(), 0, 1); !errors.Is(err, storage.ErrInvalidRequest) {
		t.Errorf("settle spend zero reservation ID error = %v, want invalid request", err)
	}
	if _, err := store.ReserveSpend(context.Background(), request); !errors.Is(err, storage.ErrSpendLimitExceeded) {
		t.Errorf("reserve after rejected settlement error = %v, want spend limit exceeded", err)
	}
}

func TestCatalogTaskDoesNotRegressToOlderGraphVersion(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	workspace := t.TempDir()
	startedAt := time.Now().UTC()
	if err := store.WriteCatalogTask(context.Background(), storage.CatalogTask{
		Workspace: workspace, GraphVersion: 2, State: storage.CatalogTaskRunning, StartedAt: startedAt,
	}); err != nil {
		t.Fatalf("write later catalog task: %v", err)
	}
	if err := store.WriteCatalogTask(context.Background(), storage.CatalogTask{
		Workspace: workspace, GraphVersion: 1, State: storage.CatalogTaskComplete, StartedAt: startedAt, FinishedAt: startedAt,
	}); err != nil {
		t.Fatalf("write older catalog task: %v", err)
	}
	task, found, err := store.ReadCatalogTask(context.Background(), workspace)
	if err != nil {
		t.Fatalf("read catalog task: %v", err)
	}
	if !found || task.GraphVersion != 2 || task.State != storage.CatalogTaskRunning {
		t.Errorf("catalog task = %+v, want running graph version 2", task)
	}
}

func TestCatalogTaskStoresProcessID(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	workspace := t.TempDir()
	if err := store.WriteCatalogTask(context.Background(), storage.CatalogTask{
		Workspace: workspace, GraphVersion: 1, State: storage.CatalogTaskRunning, ProcessID: 123, StartedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("write catalog task: %v", err)
	}
	task, found, err := store.ReadCatalogTask(context.Background(), workspace)
	if err != nil {
		t.Fatalf("read catalog task: %v", err)
	}
	if !found || task.ProcessID != 123 {
		t.Errorf("catalog task = %+v, want process ID 123", task)
	}
}

func TestCopilotPlannerMetricsAggregateExactEventValuesByDay(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	day := time.Date(2026, time.September, 19, 12, 0, 0, 0, time.UTC)
	if err := store.RecordCopilotPlannerMetric(context.Background(), storage.CopilotPlannerMetric{
		RecordedAt:              day,
		Model:                   "gpt-5",
		MaxAICredits:            30,
		Outcome:                 storage.CopilotPlannerOutcomeSuccess,
		Duration:                2 * time.Second,
		PromptBytes:             120,
		ResponseBytes:           96,
		ActualModel:             "gpt-5.3-codex",
		InputTokens:             storage.ExactMetricValue(15667),
		OutputTokens:            storage.ExactMetricValue(12),
		CacheReadTokens:         storage.ExactMetricValue(14848),
		CacheWriteTokens:        storage.ExactMetricValue(0),
		ReasoningTokens:         storage.ExactMetricValue(72),
		SessionTotalNanoAiu:     storage.ExactMetricValue(80),
		PremiumRequestCredits:   storage.ExactMetricValue(1),
		UserRequests:            storage.ExactMetricValue(1),
		APIDurationMilliseconds: storage.ExactMetricValue(2592),
	}); err != nil {
		t.Fatalf("record Copilot planner metric: %v", err)
	}

	aggregates, err := store.ReadCopilotPlannerDailyMetrics(context.Background(), storage.CopilotPlannerDailyMetricsRequest{Day: day})
	if err != nil {
		t.Fatalf("read Copilot planner daily metrics: %v", err)
	}
	if len(aggregates) != 1 {
		t.Fatalf("daily metrics = %+v, want one aggregate", aggregates)
	}
	got := aggregates[0]
	if got.Model != "gpt-5.3-codex" || got.ActualModel != "gpt-5.3-codex" || got.MaxAICredits != 30 || got.Successes != 1 || got.Duration != 2*time.Second || got.PromptBytes != 120 || got.ResponseBytes != 96 || got.InputTokens.Value != 15667 || got.OutputTokens.Value != 12 || got.CacheReadTokens.Value != 14848 || got.CacheWriteTokens.Value != 0 || got.ReasoningTokens.Value != 72 || got.OutputTokens.Availability != storage.MetricValueExact || got.SessionTotalNanoAiu.Value != 80 || got.SessionTotalNanoAiu.Availability != storage.MetricValueExact || got.PremiumRequestCredits.Value != 1 || got.UserRequests.Value != 1 || got.APIDurationMilliseconds.Value != 2592 || got.CostUSD.Value != 0.01 || got.CostUSD.Availability != storage.MetricValueEstimate || got.CostUSD.EstimateMethod != "used credits / 100" {
		t.Errorf("daily metric = %+v, want exact successful aggregate", got)
	}
}

func TestClaudePlannerMetricsAggregateNonContentValuesByDay(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	day := time.Date(2026, time.September, 19, 12, 0, 0, 0, time.UTC)
	if err := store.RecordClaudePlannerMetric(context.Background(), storage.ClaudePlannerMetric{
		RecordedAt:              day,
		Model:                   "sonnet",
		ActualModel:             "claude-sonnet-4-6",
		FallbackModel:           "haiku",
		MaxBudgetUSD:            0.75,
		Effort:                  "high",
		Outcome:                 storage.ClaudePlannerOutcomeSuccess,
		Duration:                2 * time.Second,
		PromptBytes:             120,
		ResponseBytes:           96,
		InputTokens:             storage.ExactMetricValue(15667),
		OutputTokens:            storage.ExactMetricValue(12),
		APIDurationMilliseconds: storage.ExactMetricValue(1500),
		CostUSD:                 storage.DollarValue{Value: 0.012, Availability: storage.MetricValueExact},
	}); err != nil {
		t.Fatalf("record Claude planner metric: %v", err)
	}
	if err := store.RecordClaudePlannerMetric(context.Background(), storage.ClaudePlannerMetric{
		RecordedAt:    day.Add(time.Second),
		Model:         "sonnet",
		ActualModel:   "claude-sonnet-4-6",
		FallbackModel: "haiku",
		MaxBudgetUSD:  0.75,
		Effort:        "high",
		Outcome:       storage.ClaudePlannerOutcomeModelUnavailable,
		Duration:      time.Second,
		PromptBytes:   120,
	}); err != nil {
		t.Fatalf("record unavailable Claude planner metric: %v", err)
	}

	metrics, err := store.ReadClaudePlannerDailyMetrics(context.Background(), storage.ClaudePlannerDailyMetricsRequest{Day: day})
	if err != nil {
		t.Fatalf("read Claude planner daily metrics: %v", err)
	}
	if len(metrics) != 1 {
		t.Fatalf("daily metrics = %+v, want one aggregate", metrics)
	}
	got := metrics[0]
	if got.Model != "sonnet" || got.ActualModel != "claude-sonnet-4-6" || got.FallbackModel != "haiku" || got.MaxBudgetUSD != 0.75 || got.Effort != "high" || got.Successes != 1 || got.ModelUnavailables != 1 || got.Duration != 3*time.Second || got.PromptBytes != 240 || got.ResponseBytes != 96 || got.InputTokens.Availability != storage.MetricValueUnavailable || got.OutputTokens.Availability != storage.MetricValueUnavailable || got.APIDurationMilliseconds.Availability != storage.MetricValueUnavailable || got.CostUSD.Availability != storage.MetricValueUnavailable {
		t.Errorf("daily Claude metric = %+v, want partial non-content aggregate", got)
	}
}

func TestCopilotPlannerMetricsReadMonthByDay(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	for _, day := range []time.Time{
		time.Date(2026, time.September, 2, 12, 0, 0, 0, time.UTC),
		time.Date(2026, time.September, 3, 12, 0, 0, 0, time.UTC),
	} {
		if err := store.RecordCopilotPlannerMetric(context.Background(), storage.CopilotPlannerMetric{
			RecordedAt:            day,
			Model:                 "auto",
			ActualModel:           "gpt-5.6-luna",
			MaxAICredits:          30,
			Outcome:               storage.CopilotPlannerOutcomeSuccess,
			OutputTokens:          storage.MetricValue{Availability: storage.MetricValueUnavailable},
			SessionTotalNanoAiu:   storage.MetricValue{Availability: storage.MetricValueUnavailable},
			PremiumRequestCredits: storage.ExactMetricValue(1),
		}); err != nil {
			t.Fatalf("record planner metric: %v", err)
		}
	}
	metrics, err := store.ReadCopilotPlannerMonthlyMetrics(context.Background(), storage.CopilotPlannerMonthlyMetricsRequest{
		Month: time.Date(2026, time.September, 1, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("read monthly metrics: %v", err)
	}
	if len(metrics) != 2 || metrics[0].Day.Day() != 2 || metrics[1].Day.Day() != 3 || metrics[0].ActualModel != "gpt-5.6-luna" || metrics[1].PremiumRequestCredits.Value != 1 {
		t.Errorf("monthly metrics = %+v, want daily Luna metrics", metrics)
	}
}

func TestCopilotPlannerMetricsSeparateActualModelsByDay(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	day := time.Date(2026, time.September, 19, 12, 0, 0, 0, time.UTC)
	for _, record := range []struct {
		model       string
		actualModel string
		maxCredits  int
	}{
		{"auto", "gpt-5.3-codex", 30},
		{"gpt-5.3-codex", "gpt-5.3-codex", 60},
		{"auto", "claude-sonnet-4", 30},
	} {
		if err := store.RecordCopilotPlannerMetric(context.Background(), storage.CopilotPlannerMetric{
			RecordedAt:              day,
			Model:                   record.model,
			ActualModel:             record.actualModel,
			MaxAICredits:            record.maxCredits,
			Outcome:                 storage.CopilotPlannerOutcomeSuccess,
			OutputTokens:            storage.ExactMetricValue(12),
			SessionTotalNanoAiu:     storage.ExactMetricValue(80),
			PremiumRequestCredits:   storage.ExactMetricValue(1),
			APIDurationMilliseconds: storage.ExactMetricValue(100),
		}); err != nil {
			t.Fatalf("record %s planner metric: %v", record.actualModel, err)
		}
	}
	metrics, err := store.ReadCopilotPlannerDailyMetrics(context.Background(), storage.CopilotPlannerDailyMetricsRequest{Day: day})
	if err != nil {
		t.Fatalf("read daily metrics: %v", err)
	}
	if len(metrics) != 2 || metrics[0].ActualModel != "claude-sonnet-4" || metrics[0].Successes != 1 || metrics[1].ActualModel != "gpt-5.3-codex" || metrics[1].Successes != 2 || metrics[1].PremiumRequestCredits.Value != 2 {
		t.Errorf("daily metrics = %+v, want aggregates grouped by actual model", metrics)
	}
}

func TestCopilotPlannerMetricsKeepUnavailableEventValuesUnavailable(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	day := time.Date(2026, time.September, 19, 12, 0, 0, 0, time.UTC)
	if err := store.RecordCopilotPlannerMetric(context.Background(), storage.CopilotPlannerMetric{
		RecordedAt:          day,
		Model:               "gpt-5",
		MaxAICredits:        30,
		Outcome:             storage.CopilotPlannerOutcomeTimeout,
		Duration:            time.Second,
		OutputTokens:        storage.MetricValue{Availability: storage.MetricValueUnavailable},
		SessionTotalNanoAiu: storage.MetricValue{Availability: storage.MetricValueUnavailable},
	}); err != nil {
		t.Fatalf("record timeout metric: %v", err)
	}
	metrics, err := store.ReadCopilotPlannerDailyMetrics(context.Background(), storage.CopilotPlannerDailyMetricsRequest{Day: day})
	if err != nil {
		t.Fatalf("read daily metrics: %v", err)
	}
	if len(metrics) != 1 || metrics[0].Timeouts != 1 || metrics[0].OutputTokens.Availability != storage.MetricValueUnavailable || metrics[0].SessionTotalNanoAiu.Availability != storage.MetricValueUnavailable {
		t.Errorf("timeout metric aggregate = %+v, want one timeout with unavailable event values", metrics)
	}
}

func TestCopilotPlannerMetricsDoNotExposePartialExactTotals(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	day := time.Date(2026, time.September, 19, 12, 0, 0, 0, time.UTC)
	for _, outputTokens := range []storage.MetricValue{
		storage.ExactMetricValue(12),
		{Availability: storage.MetricValueUnavailable},
	} {
		if err := store.RecordCopilotPlannerMetric(context.Background(), storage.CopilotPlannerMetric{
			RecordedAt:          day,
			Model:               "gpt-5",
			MaxAICredits:        30,
			Outcome:             storage.CopilotPlannerOutcomeSuccess,
			OutputTokens:        outputTokens,
			SessionTotalNanoAiu: storage.ExactMetricValue(80),
		}); err != nil {
			t.Fatalf("record planner metric: %v", err)
		}
	}
	metrics, err := store.ReadCopilotPlannerDailyMetrics(context.Background(), storage.CopilotPlannerDailyMetricsRequest{Day: day})
	if err != nil {
		t.Fatalf("read daily metrics: %v", err)
	}
	if len(metrics) != 1 || metrics[0].OutputTokens.Availability != storage.MetricValueUnavailable || metrics[0].OutputTokens.Value != 0 {
		t.Errorf("mixed output token aggregate = %+v, want unavailable value without partial total", metrics)
	}
}

func TestCopilotPlannerMetricsReportEstimateMethod(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	day := time.Date(2026, time.September, 19, 12, 0, 0, 0, time.UTC)
	if err := store.RecordCopilotPlannerMetric(context.Background(), storage.CopilotPlannerMetric{
		RecordedAt:          day,
		Model:               "gpt-5",
		MaxAICredits:        30,
		Outcome:             storage.CopilotPlannerOutcomeSuccess,
		OutputTokens:        storage.MetricValue{Value: 12, Availability: storage.MetricValueEstimate, EstimateMethod: "event-byte-ratio"},
		SessionTotalNanoAiu: storage.MetricValue{Value: 80, Availability: storage.MetricValueEstimate, EstimateMethod: "event-byte-ratio"},
	}); err != nil {
		t.Fatalf("record estimated planner metric: %v", err)
	}
	metrics, err := store.ReadCopilotPlannerDailyMetrics(context.Background(), storage.CopilotPlannerDailyMetricsRequest{Day: day})
	if err != nil {
		t.Fatalf("read daily metrics: %v", err)
	}
	if len(metrics) != 1 || metrics[0].OutputTokens.Availability != storage.MetricValueEstimate || metrics[0].OutputTokens.Value != 12 || metrics[0].OutputTokens.EstimateMethod != "event-byte-ratio" || metrics[0].SessionTotalNanoAiu.Availability != storage.MetricValueEstimate || metrics[0].SessionTotalNanoAiu.EstimateMethod != "event-byte-ratio" {
		t.Errorf("estimated metric aggregate = %+v, want labeled estimate values", metrics)
	}
}

func TestCopilotPlannerMetricsSchemaExcludesRequestContent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}
	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open raw database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	rows, err := database.Query("PRAGMA table_info(copilot_planner_metrics)")
	if err != nil {
		t.Fatalf("read planner metric schema: %v", err)
	}
	defer rows.Close()
	forbidden := map[string]struct{}{"prompt": {}, "response": {}, "source": {}, "credential": {}, "content": {}, "question": {}}
	for rows.Next() {
		var columnID, notNull, primaryKey int
		var name, columnType string
		var defaultValue any
		if err := rows.Scan(&columnID, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			t.Fatalf("scan planner metric column: %v", err)
		}
		if _, found := forbidden[name]; found {
			t.Errorf("planner metric schema contains forbidden content column %q", name)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate planner metric schema: %v", err)
	}
}

func TestCatalogSearchIsSnapshotScopedAndSeparateFromNodeSearch(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	first, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:validateToken"),
	})
	if err != nil {
		t.Fatalf("publish first snapshot: %v", err)
	}
	if err := store.WriteCatalog(context.Background(), first, storage.CatalogWriteRequest{
		Entries: []storage.CatalogEntry{{
			NodeID:                "function:validateToken",
			Name:                  "validate token",
			DeterministicSynopsis: "checks a ledger sentinel",
		}},
	}); err != nil {
		t.Fatalf("write first catalog: %v", err)
	}

	second, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:rotateCredentials"),
	})
	if err != nil {
		t.Fatalf("publish second snapshot: %v", err)
	}
	if err := store.WriteCatalog(context.Background(), second, storage.CatalogWriteRequest{
		Entries: []storage.CatalogEntry{{
			NodeID:                "function:rotateCredentials",
			Name:                  "rotate credentials",
			DeterministicSynopsis: "rotates authentication credentials",
		}},
	}); err != nil {
		t.Fatalf("write second catalog: %v", err)
	}
	other, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "other-workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:validateToken"),
	})
	if err != nil {
		t.Fatalf("publish other workspace snapshot: %v", err)
	}
	if err := store.WriteCatalog(context.Background(), other, storage.CatalogWriteRequest{
		Entries: []storage.CatalogEntry{{
			NodeID:                "function:validateToken",
			Name:                  "validate token",
			DeterministicSynopsis: "checks a ledger sentinel",
		}},
	}); err != nil {
		t.Fatalf("write other workspace catalog: %v", err)
	}

	firstMatches, err := store.SearchCatalog(context.Background(), first, storage.CatalogSearchRequest{Text: "validate token", Limit: 10})
	if err != nil {
		t.Fatalf("search first catalog: %v", err)
	}
	if len(firstMatches) != 1 || firstMatches[0].Node.ID != "function:validateToken" {
		t.Errorf("first catalog matches = %+v, want validate token", firstMatches)
	}

	secondMatches, err := store.SearchCatalog(context.Background(), second, storage.CatalogSearchRequest{Text: "validate token", Limit: 10})
	if err != nil {
		t.Fatalf("search second catalog: %v", err)
	}
	if len(secondMatches) != 0 {
		t.Errorf("second catalog matches = %+v, want no stale catalog entry", secondMatches)
	}

	nodeMatches, err := store.SearchNodes(context.Background(), first, storage.LexicalSearchRequest{Text: "ledger sentinel", Limit: 10})
	if err != nil {
		t.Fatalf("search node index: %v", err)
	}
	if len(nodeMatches) != 0 {
		t.Errorf("node search matches = %+v, want no catalog prose", nodeMatches)
	}
}

func TestCatalogEmbeddingsAreSnapshotScoped(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:validateToken"),
	})
	if err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}
	if err := store.WriteCatalog(context.Background(), snapshot, storage.CatalogWriteRequest{Entries: []storage.CatalogEntry{{
		NodeID:                "function:validateToken",
		Name:                  "validate token",
		DeterministicSynopsis: "checks a ledger sentinel",
		CopilotSynopsis:       "Validates access tokens.",
	}}}); err != nil {
		t.Fatalf("write catalog: %v", err)
	}
	if err := store.WriteCatalogEmbeddings(context.Background(), snapshot, storage.CatalogEmbeddingWriteRequest{Embeddings: []storage.CatalogEmbedding{
		{NodeID: "function:validateToken", Source: storage.CatalogEmbeddingDeterministic, Text: "checks a ledger sentinel", Vector: []float32{0.1, 0.2}},
		{NodeID: "function:validateToken", Source: storage.CatalogEmbeddingCopilot, Text: "Validates access tokens.", Vector: []float32{0.3, 0.4}},
	}}); err != nil {
		t.Fatalf("write catalog embeddings: %v", err)
	}

	embeddings, err := store.ReadCatalogEmbeddings(context.Background(), snapshot, storage.CatalogEmbeddingReadRequest{NodeIDs: []string{"function:validateToken"}})
	if err != nil {
		t.Fatalf("read catalog embeddings: %v", err)
	}
	if len(embeddings) != 2 || embeddings[0].Source != storage.CatalogEmbeddingDeterministic || embeddings[1].Source != storage.CatalogEmbeddingCopilot || !reflect.DeepEqual(embeddings[0].Vector, []float32{0.1, 0.2}) || !reflect.DeepEqual(embeddings[1].Vector, []float32{0.3, 0.4}) {
		t.Errorf("catalog embeddings = %+v, want snapshot-scoped deterministic and Copilot vectors", embeddings)
	}
	matches, err := store.SearchCatalogVectors(context.Background(), snapshot, storage.CatalogVectorSearchRequest{Vector: []float32{0.3, 0.4}, Limit: 10})
	if err != nil {
		t.Fatalf("search catalog vectors: %v", err)
	}
	if len(matches) != 1 || matches[0].Node.ID != "function:validateToken" {
		t.Errorf("catalog vector matches = %+v, want validate token", matches)
	}
}

func TestCatalogVectorSearchReturnsNoMatchesWithoutDimensionIndex(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: "workspace", Update: graphUpdate(t, "src/main.ts", "function:validateToken")})
	if err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}
	matches, err := store.SearchCatalogVectors(context.Background(), snapshot, storage.CatalogVectorSearchRequest{Vector: []float32{0.1, 0.2}, Limit: 10})
	if err != nil {
		t.Fatalf("search catalog vectors: %v", err)
	}
	if len(matches) != 0 {
		t.Errorf("catalog vector matches = %+v, want none", matches)
	}
}

func TestCatalogEmbeddingsFollowRollbackAndPrune(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	writeEmbedding := func(snapshot storage.Snapshot, nodeID string) {
		t.Helper()
		if err := store.WriteCatalogEmbeddings(context.Background(), snapshot, storage.CatalogEmbeddingWriteRequest{Embeddings: []storage.CatalogEmbedding{{
			NodeID: nodeID,
			Source: storage.CatalogEmbeddingDeterministic,
			Text:   nodeID,
			Vector: []float32{0.1, 0.2},
		}}}); err != nil {
			t.Fatalf("write catalog embedding: %v", err)
		}
	}

	first, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: "workspace", Update: graphUpdate(t, "src/first.ts", "function:first")})
	if err != nil {
		t.Fatalf("publish first snapshot: %v", err)
	}
	writeEmbedding(first, "function:first")
	second, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: "workspace", Update: graphUpdate(t, "src/second.ts", "function:second")})
	if err != nil {
		t.Fatalf("publish second snapshot: %v", err)
	}
	writeEmbedding(second, "function:second")
	if _, err := store.Rollback(context.Background(), storage.RollbackRequest{Workspace: "workspace", Version: first.Version}); err != nil {
		t.Fatalf("roll back snapshot: %v", err)
	}
	if embeddings, err := store.ReadCatalogEmbeddings(context.Background(), second, storage.CatalogEmbeddingReadRequest{NodeIDs: []string{"function:second"}}); err != nil || len(embeddings) != 0 {
		t.Errorf("rolled back catalog embeddings = %+v, error %v, want none", embeddings, err)
	}

	retained, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: "workspace", Update: graphUpdate(t, "src/retained.ts", "function:retained")})
	if err != nil {
		t.Fatalf("publish retained snapshot: %v", err)
	}
	writeEmbedding(retained, "function:retained")
	if _, err := store.Prune(context.Background(), storage.PruneRequest{Workspace: "workspace", BeforeVersion: retained.Version}); err != nil {
		t.Fatalf("prune snapshots: %v", err)
	}
	if embeddings, err := store.ReadCatalogEmbeddings(context.Background(), first, storage.CatalogEmbeddingReadRequest{NodeIDs: []string{"function:first"}}); err != nil || len(embeddings) != 0 {
		t.Errorf("pruned catalog embeddings = %+v, error %v, want none", embeddings, err)
	}
}

func TestOpenMigratesCatalogEmbeddingsIntoVectorIndex(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: "workspace", Update: graphUpdate(t, "src/main.ts", "function:validateToken")})
	if err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}
	if err := store.WriteCatalog(context.Background(), snapshot, storage.CatalogWriteRequest{Entries: []storage.CatalogEntry{{NodeID: "function:validateToken", Name: "validate token", DeterministicSynopsis: "checks access tokens"}}}); err != nil {
		t.Fatalf("write catalog: %v", err)
	}
	if err := store.WriteCatalogEmbeddings(context.Background(), snapshot, storage.CatalogEmbeddingWriteRequest{Embeddings: []storage.CatalogEmbedding{{NodeID: "function:validateToken", Source: storage.CatalogEmbeddingDeterministic, Text: "checks access tokens", Vector: []float32{0.1, 0.2}}}}); err != nil {
		t.Fatalf("write catalog embeddings: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}

	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open raw database: %v", err)
	}
	if _, err := database.Exec("DROP TABLE catalog_embedding_vectors_2; DELETE FROM schema_migrations; INSERT INTO schema_migrations (version, applied_at) VALUES (13, 'test')"); err != nil {
		_ = database.Close()
		t.Fatalf("seed version 13 database: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close raw database: %v", err)
	}

	store, err = sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("migrate database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	matches, err := store.SearchCatalogVectors(context.Background(), snapshot, storage.CatalogVectorSearchRequest{Vector: []float32{0.1, 0.2}, Limit: 10})
	if err != nil {
		t.Fatalf("search migrated catalog vectors: %v", err)
	}
	if len(matches) != 1 || matches[0].Node.ID != "function:validateToken" {
		t.Errorf("migrated catalog vector matches = %+v, want validate token", matches)
	}
}

func TestDeleteCatalogEntriesRemovesSnapshotEntries(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:validateToken"),
	})
	if err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}
	if err := store.WriteCatalog(context.Background(), snapshot, storage.CatalogWriteRequest{
		Entries: []storage.CatalogEntry{{
			NodeID:                "function:validateToken",
			Name:                  "validate token",
			DeterministicSynopsis: "checks a ledger sentinel",
		}},
	}); err != nil {
		t.Fatalf("write catalog: %v", err)
	}
	if err := store.WriteCatalogEmbeddings(context.Background(), snapshot, storage.CatalogEmbeddingWriteRequest{Embeddings: []storage.CatalogEmbedding{{
		NodeID: "function:validateToken",
		Source: storage.CatalogEmbeddingDeterministic,
		Text:   "checks a ledger sentinel",
		Vector: []float32{0.1, 0.2},
	}}}); err != nil {
		t.Fatalf("write catalog embedding: %v", err)
	}
	if err := store.DeleteCatalogEntries(context.Background(), snapshot, []string{"function:validateToken"}); err != nil {
		t.Fatalf("delete catalog entry: %v", err)
	}

	matches, err := store.SearchCatalog(context.Background(), snapshot, storage.CatalogSearchRequest{Text: "validate token", Limit: 10})
	if err != nil {
		t.Fatalf("search catalog after deletion: %v", err)
	}
	if len(matches) != 0 {
		t.Errorf("catalog matches after deletion = %+v, want none", matches)
	}
	embeddings, err := store.ReadCatalogEmbeddings(context.Background(), snapshot, storage.CatalogEmbeddingReadRequest{NodeIDs: []string{"function:validateToken"}})
	if err != nil {
		t.Fatalf("read catalog embeddings after deletion: %v", err)
	}
	if len(embeddings) != 0 {
		t.Errorf("catalog embeddings after deletion = %+v, want none", embeddings)
	}
}

func TestOpenRecordsCurrentSchemaVersion(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	version, err := store.SchemaVersion(context.Background())
	if err != nil {
		t.Fatalf("read schema version: %v", err)
	}
	if version != sqlite.CurrentSchemaVersion {
		t.Errorf("schema version = %d, want %d", version, sqlite.CurrentSchemaVersion)
	}
}

func TestOpenMigratesVersionTwentyOneCatalogFingerprint(t *testing.T) {
	path := filepath.Join(t.TempDir(), "version-twenty-one.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}

	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open version-twenty-one database: %v", err)
	}
	if _, err := database.Exec(`
		ALTER TABLE catalog_entries DROP COLUMN input_fingerprint;
		DELETE FROM schema_migrations;
		INSERT INTO schema_migrations (version, applied_at) VALUES (21, '2026-09-25T00:00:00Z')`); err != nil {
		_ = database.Close()
		t.Fatalf("seed version-twenty-one database: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close version-twenty-one database: %v", err)
	}

	store, err = sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("migrate version-twenty-one database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	version, err := store.SchemaVersion(context.Background())
	if err != nil {
		t.Fatalf("read migrated schema version: %v", err)
	}
	if version != sqlite.CurrentSchemaVersion {
		t.Errorf("migrated schema version = %d, want %d", version, sqlite.CurrentSchemaVersion)
	}
}

func TestOpenMigratesVersionTwentyFourCatalogSource(t *testing.T) {
	path := filepath.Join(t.TempDir(), "version-twenty-four.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}
	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open legacy database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if _, err := database.Exec(`
		ALTER TABLE contribution_catalog_units DROP COLUMN declaration_source;
		INSERT INTO graph_versions (workspace, version, published_at) VALUES ('fixture', 1, '2026-10-03T00:00:00Z');
		INSERT INTO contribution_catalog_units (workspace, source_path, valid_from_version, node_id, name, kind, owner, signature, comments, identifier_tokens)
		VALUES ('fixture', 'token.go', 1, 'token', 'Token', 'go:function', '', 'func Token()', '[]', '[]');
		INSERT INTO catalog_entries (workspace, version, node_id, name, input_fingerprint, deterministic_synopsis, copilot_synopsis, ollama_synopsis, claude_synopsis)
		VALUES ('fixture', 1, 'token', 'Token', 'fingerprint', 'Token function', 'Stored synopsis', '', '');
		DELETE FROM schema_migrations;
		INSERT INTO schema_migrations (version, applied_at) VALUES (24, '2026-10-03T00:00:00Z')`); err != nil {
		t.Fatalf("seed legacy database: %v", err)
	}
	store, err = sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("migrate legacy database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	version, err := store.SchemaVersion(context.Background())
	if err != nil || version != sqlite.CurrentSchemaVersion {
		t.Fatalf("schema version = %d, error = %v, want %d", version, err, sqlite.CurrentSchemaVersion)
	}
	var source string
	if err := database.QueryRow("SELECT declaration_source FROM contribution_catalog_units WHERE node_id = 'token'").Scan(&source); err != nil || source != "" {
		t.Fatalf("legacy declaration source = %q, error = %v, want empty source", source, err)
	}
	entries, err := store.ReadCatalogEntries(context.Background(), storage.Snapshot{Workspace: "fixture", Version: 1}, storage.CatalogEntryReadRequest{NodeIDs: []string{"token"}})
	if err != nil || len(entries) != 1 || entries[0].CopilotSynopsis != "Stored synopsis" || entries[0].InputFingerprint != "fingerprint" {
		t.Fatalf("migrated entries = %+v, error = %v, want preserved synopsis and fingerprint", entries, err)
	}
}

func TestOpenMigratesVersionTwentyTwoCatalogProcessID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "version-twenty-two.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}

	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open version-twenty-two database: %v", err)
	}
	if _, err := database.Exec(`
		ALTER TABLE catalog_tasks DROP COLUMN process_id;
		DELETE FROM schema_migrations;
		INSERT INTO schema_migrations (version, applied_at) VALUES (22, '2026-09-25T00:00:00Z')`); err != nil {
		_ = database.Close()
		t.Fatalf("seed version-twenty-two database: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close version-twenty-two database: %v", err)
	}

	store, err = sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("migrate version-twenty-two database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	workspace := t.TempDir()
	if err := store.WriteCatalogTask(context.Background(), storage.CatalogTask{
		Workspace: workspace, GraphVersion: 1, State: storage.CatalogTaskRunning, ProcessID: 123, StartedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("write migrated catalog task: %v", err)
	}
	task, found, err := store.ReadCatalogTask(context.Background(), workspace)
	if err != nil {
		t.Fatalf("read migrated catalog task: %v", err)
	}
	if !found || task.ProcessID != 123 {
		t.Errorf("migrated catalog task = %+v, want process ID 123", task)
	}
}

func TestOpenRecreatesMismatchedSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mismatched-schema.db")
	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open mismatched database: %v", err)
	}
	_, err = database.Exec(fmt.Sprintf(`
		CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
		CREATE TABLE old_graph_data (value TEXT NOT NULL);
		INSERT INTO schema_migrations (version, applied_at) VALUES (%d, '2026-08-14T00:00:00Z');
		INSERT INTO old_graph_data (value) VALUES ('stale');
	`, 10))
	if err != nil {
		t.Fatalf("seed mismatched schema version: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close mismatched database: %v", err)
	}

	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open mismatched schema database: %v", err)
	}
	t.Cleanup(func() {
		if closeErr := store.Close(); closeErr != nil {
			t.Errorf("close mismatched schema database store: %v", closeErr)
		}
	})

	version, err := store.SchemaVersion(context.Background())
	if err != nil {
		t.Fatalf("read recreated schema version: %v", err)
	}
	if version != sqlite.CurrentSchemaVersion {
		t.Errorf("recreated schema version = %d, want %d", version, sqlite.CurrentSchemaVersion)
	}
	if _, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace"}); !errors.Is(err, storage.ErrWorkspaceNotFound) {
		t.Errorf("open snapshot after schema reset error = %v, want workspace not found", err)
	}
}

func TestOpenMigratesRetainedLexicalSnapshotsInPlace(t *testing.T) {
	for _, schemaVersion := range []int{10, 26} {
		t.Run(fmt.Sprintf("schema_%d", schemaVersion), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "legacy.db")
			store, err := sqlite.Open(context.Background(), path)
			if err != nil {
				t.Fatalf("open database: %v", err)
			}
			oldNode := graph.Node{ID: "function:handler", Kind: "function", Label: "LegacyHandler", QualifiedName: "LegacyHandler", Evidence: evidence("src/handler.go")}
			first, err := store.Publish(context.Background(), storage.PublishRequest{
				Workspace: "workspace",
				Update:    graphUpdateWithFacts(t, "src/handler.go", graph.Facts{Nodes: []graph.Node{oldNode}}),
			})
			if err != nil {
				t.Fatalf("publish pre-migration snapshot: %v", err)
			}
			newNode := oldNode
			newNode.Label = "CurrentHandler"
			newNode.QualifiedName = "CurrentHandler"
			newNode.Evidence.FileHash = "new-content-hash"
			second, err := store.Publish(context.Background(), storage.PublishRequest{
				Workspace: "workspace",
				Update:    graphUpdateWithFacts(t, "src/handler.go", graph.Facts{Nodes: []graph.Node{newNode}}),
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := store.Close(); err != nil {
				t.Fatalf("close pre-migration store: %v", err)
			}

			database, err := sql.Open("sqlite3", path)
			if err != nil {
				t.Fatalf("open legacy database: %v", err)
			}
			if _, err := database.Exec(`DROP TABLE node_search; DELETE FROM schema_migrations; INSERT INTO schema_migrations (version, applied_at) VALUES (?, '2026-08-31T00:00:00Z')`, schemaVersion); err != nil {
				t.Fatalf("downgrade schema marker: %v", err)
			}
			if schemaVersion == 10 {
				if _, err := database.Exec(`DROP TABLE catalog_search; DROP TABLE catalog_entries`); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := database.Exec(`CREATE VIRTUAL TABLE node_search USING fts5(workspace UNINDEXED, version UNINDEXED, node_id UNINDEXED, label, qualified_name, span_path, kind, identifier_tokens, tokenize = 'unicode61 remove_diacritics 2');
			INSERT INTO node_search (workspace, version, node_id, label) VALUES ('workspace', 1, 'function:handler', 'LegacyHandler'), ('workspace', 2, 'function:handler', 'CurrentHandler')`); err != nil {
					t.Fatal(err)
				}
			}
			if err := database.Close(); err != nil {
				t.Fatalf("close legacy database: %v", err)
			}

			store, err = sqlite.Open(context.Background(), path)
			if err != nil {
				t.Fatalf("migrate legacy database: %v", err)
			}
			t.Cleanup(func() { _ = store.Close() })
			for _, scenario := range []struct {
				snapshot storage.Snapshot
				node     graph.Node
				absent   string
			}{
				{first, oldNode, "current"}, {second, newNode, "legacy"},
			} {
				matches, err := store.SearchNodes(context.Background(), scenario.snapshot, storage.LexicalSearchRequest{Text: scenario.node.Label, Limit: 10})
				if err != nil || len(matches) != 1 || matches[0].Node != scenario.node {
					t.Fatalf("snapshot %d migrated matches = %+v, error %v, want %+v", scenario.snapshot.Version, matches, err, scenario.node)
				}
				matches, err = store.SearchNodes(context.Background(), scenario.snapshot, storage.LexicalSearchRequest{Text: scenario.absent, Limit: 10})
				if err != nil || len(matches) != 0 {
					t.Fatalf("snapshot %d has stale matches = %+v, error %v", scenario.snapshot.Version, matches, err)
				}
			}
		})
	}
}

func TestOpenMigratesVersionEighteenWithoutCatalogUnitCoverage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "version-eighteen.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/handler.go", "function:Handler"),
	})
	if err != nil {
		t.Fatalf("publish pre-migration snapshot: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close pre-migration store: %v", err)
	}

	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open version-eighteen database: %v", err)
	}
	if _, err := database.Exec(`
		DROP TABLE contribution_catalog_unit_coverage;
		DELETE FROM contribution_catalog_units;
		DELETE FROM schema_migrations;
		INSERT INTO schema_migrations (version, applied_at) VALUES (18, '2026-09-21T00:00:00Z')`); err != nil {
		t.Fatalf("seed version-eighteen database: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close version-eighteen database: %v", err)
	}

	store, err = sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("migrate version-eighteen database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	covered, err := store.CatalogUnitsCovered(context.Background(), snapshot)
	if err != nil {
		t.Fatalf("read migrated catalog-unit coverage: %v", err)
	}
	if covered {
		t.Error("migrated version-eighteen snapshot has catalog-unit coverage, want full re-index requirement")
	}

	reindexed, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/handler.go", "function:Handler"),
	})
	if err != nil {
		t.Fatalf("publish re-indexed snapshot: %v", err)
	}
	covered, err = store.CatalogUnitsCovered(context.Background(), reindexed)
	if err != nil {
		t.Fatalf("read re-indexed catalog-unit coverage: %v", err)
	}
	if !covered {
		t.Error("re-indexed snapshot has no catalog-unit coverage")
	}
}

func TestPublishCreatesFirstWorkspaceSnapshot(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	})
	if err != nil {
		t.Fatalf("publish first workspace snapshot: %v", err)
	}
	if snapshot.Workspace != "workspace" {
		t.Errorf("snapshot workspace = %q, want %q", snapshot.Workspace, "workspace")
	}
	if snapshot.Version != 1 {
		t.Errorf("snapshot version = %d, want 1", snapshot.Version)
	}
	if snapshot.PublishedAt.IsZero() {
		t.Fatal("snapshot publication time is zero")
	}
}

func TestPublishReportsStablePhaseMeasurements(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	measurements := make([]storage.PublishMeasurement, 0, 3)
	_, err = store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
		Measurement: func(measurement storage.PublishMeasurement) {
			measurements = append(measurements, measurement)
		},
	})
	if err != nil {
		t.Fatalf("publish graph update: %v", err)
	}

	wantNames := []string{"publication_preparation", "sqlite_write", "commit"}
	if len(measurements) != len(wantNames) {
		t.Fatalf("measurements = %+v, want %d phases", measurements, len(wantNames))
	}
	for measurementIndex, want := range wantNames {
		if measurements[measurementIndex].Name != want {
			t.Errorf("measurement %d name = %q, want %q", measurementIndex, measurements[measurementIndex].Name, want)
		}
		if measurements[measurementIndex].Duration < 0 {
			t.Errorf("measurement %q duration = %s, want non-negative", want, measurements[measurementIndex].Duration)
		}
	}
}

func TestPublishIncludesWorkspaceVersionFacts(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateForSources(t,
			sourceFact{path: "src/main.ts", nodeID: "function:main"},
			sourceFact{path: "src/helper.ts", nodeID: "function:helper"},
		),
		WorkspaceFacts: graph.Facts{Edges: []graph.Edge{{
			SourceID: "function:main",
			TargetID: "function:helper",
			Relation: "calls",
			Evidence: evidence("src/main.ts"),
		}}},
	})
	if err != nil {
		t.Fatalf("publish workspace facts: %v", err)
	}

	collector := &factCollector{}
	if err := store.Export(context.Background(), snapshot, storage.ExportRequest{}, collector); err != nil {
		t.Fatalf("export workspace facts: %v", err)
	}
	if len(collector.edges) != 1 {
		t.Fatalf("exported edge count = %d, want 1", len(collector.edges))
	}
	if got := collector.edges[0]; got.SourceID != "function:main" || got.TargetID != "function:helper" || got.Relation != "calls" {
		t.Errorf("exported edge = %+v, want function:main calls function:helper", got)
	}
}

func TestExportDeduplicatesNodeIdentityWithWorkspaceFactPrecedence(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	contributionNode := graphNode("src/main.ts", "function:main")
	workspaceNode := contributionNode
	workspaceNode.Label = "resolved main"
	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace:      "workspace",
		Update:         graphUpdateWithFacts(t, "src/main.ts", graph.Facts{Nodes: []graph.Node{contributionNode}}),
		WorkspaceFacts: graph.Facts{Nodes: []graph.Node{workspaceNode}},
	})
	if err != nil {
		t.Fatalf("publish duplicate node identity: %v", err)
	}

	collector := &factCollector{}
	if err := store.Export(context.Background(), snapshot, storage.ExportRequest{}, collector); err != nil {
		t.Fatalf("export duplicate node identity: %v", err)
	}
	matching := make([]graph.Node, 0, 1)
	for _, node := range collector.nodes {
		if node.ID == contributionNode.ID {
			matching = append(matching, node)
		}
	}
	if len(matching) != 1 || matching[0].Label != workspaceNode.Label {
		t.Errorf("exported duplicate identity = %+v, want one workspace node", matching)
	}
}

func TestFactCountsReturnsVisibleUniqueFacts(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
			Nodes: []graph.Node{graphNode("src/main.ts", "function:main")},
			Edges: []graph.Edge{{SourceID: "function:main", TargetID: "function:main", Relation: "calls", Evidence: evidence("src/main.ts")}},
		}),
		WorkspaceFacts: graph.Facts{
			Nodes: []graph.Node{graphNode("src/main.ts", "function:main")},
			Edges: []graph.Edge{
				{SourceID: "function:main", TargetID: "function:main", Relation: "calls", Evidence: evidence("src/main.ts")},
				{SourceID: "function:main", TargetID: "function:main", Relation: "references", Evidence: evidence("src/main.ts")},
			},
		},
	})
	if err != nil {
		t.Fatalf("publish graph facts: %v", err)
	}

	replacement, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
			Nodes: []graph.Node{
				graphNode("src/main.ts", "function:replacement"),
				graphNode("src/main.ts", "function:helper"),
			},
			Edges: []graph.Edge{
				{SourceID: "function:replacement", TargetID: "function:helper", Relation: "calls", Evidence: evidence("src/main.ts")},
				{SourceID: "function:helper", TargetID: "function:replacement", Relation: "calls", Evidence: evidence("src/main.ts")},
			},
		}),
	})
	if err != nil {
		t.Fatalf("publish replacement graph: %v", err)
	}
	other, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "other",
		Update:    graphUpdate(t, "src/main.ts", "function:other"),
	})
	if err != nil {
		t.Fatalf("publish other workspace: %v", err)
	}
	empty, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: "empty"})
	if err != nil {
		t.Fatalf("publish empty graph: %v", err)
	}
	for _, test := range []struct {
		name     string
		snapshot storage.Snapshot
		want     storage.FactCounts
	}{
		{name: "retained unique facts", snapshot: snapshot, want: storage.FactCounts{Nodes: 1, Edges: 2}},
		{name: "replacement", snapshot: replacement, want: storage.FactCounts{Nodes: 2, Edges: 2}},
		{name: "other workspace", snapshot: other, want: storage.FactCounts{Nodes: 1}},
		{name: "empty graph", snapshot: empty},
	} {
		t.Run(test.name, func(t *testing.T) {
			counts, err := store.FactCounts(context.Background(), test.snapshot)
			if err != nil {
				t.Fatalf("count graph facts: %v", err)
			}
			if counts != test.want {
				t.Errorf("fact counts = %+v, want %+v", counts, test.want)
			}
		})
	}
}

func TestPublishStoresSourceAndWorkspaceFactsAsRelationalRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	if _, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
			Nodes: []graph.Node{
				graphNode("src/main.ts", "function:main"),
				graphNode("src/helper.ts", "function:helper"),
			},
			Edges: []graph.Edge{{
				SourceID: "function:main",
				TargetID: "function:helper",
				Relation: "calls",
				Evidence: evidence("src/main.ts"),
			}},
		}),
		WorkspaceFacts: graph.Facts{Edges: []graph.Edge{{
			SourceID: "function:main",
			TargetID: "function:helper",
			Relation: "resolved_calls",
			Evidence: evidence("src/main.ts"),
		}}},
	}); err != nil {
		t.Fatalf("publish normalized facts: %v", err)
	}

	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open database for verification: %v", err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close verification database: %v", err)
		}
	})

	var sourceNodes, sourceEdges, workspaceEdges int
	if err := database.QueryRow("SELECT COUNT(*) FROM contribution_nodes").Scan(&sourceNodes); err != nil {
		t.Fatalf("count normalized source nodes: %v", err)
	}
	if err := database.QueryRow("SELECT COUNT(*) FROM contribution_edges").Scan(&sourceEdges); err != nil {
		t.Fatalf("count normalized source edges: %v", err)
	}
	if err := database.QueryRow("SELECT COUNT(*) FROM workspace_edges WHERE resolved_fact_owner = ?", "src/main.ts").Scan(&workspaceEdges); err != nil {
		t.Fatalf("count normalized workspace edges: %v", err)
	}
	if sourceNodes != 2 || sourceEdges != 1 || workspaceEdges != 1 {
		t.Errorf("normalized fact counts = nodes:%d edges:%d workspaceEdges:%d, want 2, 1, 1", sourceNodes, sourceEdges, workspaceEdges)
	}
	var integrity string
	if err := database.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil {
		t.Fatalf("check database integrity: %v", err)
	}
	if integrity != "ok" {
		t.Errorf("database integrity = %q, want ok", integrity)
	}
}

func TestSourceContributionsReadRelationalResolverMetadata(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"function"}, Relations: []graph.RelationDefinition{{Kind: "references", Endpoints: []graph.EndpointRule{{Source: "function", Target: "function"}}}}})
	if err != nil {
		t.Fatalf("create vocabulary: %v", err)
	}
	contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
		SourcePath: "src/main.ts",
		Metadata:   extractor.Metadata{Name: "typescript", Version: "1", Extensions: []string{".ts"}},
		Facts:      graph.Facts{Nodes: []graph.Node{graphNode("src/main.ts", "function:main")}},
		UnresolvedReferences: []extractor.UnresolvedReference{{
			SourceID: "function:main",
			Target:   "./helper",
			Kind:     extractor.ModuleReferenceImport,
			Bindings: []extractor.ModuleBinding{{ImportedName: "helper", LocalName: "localHelper"}},
		}},
		SymbolReferences: []extractor.SymbolReference{{
			SourceID: "function:main",
			Target:   "helper",
			Relation: "references",
			Evidence: evidence("src/main.ts"),
		}},
		Diagnostics: []extractor.Diagnostic{{Severity: extractor.DiagnosticWarning, Message: "fixture warning"}},
	})
	if err != nil {
		t.Fatalf("create contribution: %v", err)
	}
	update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
	if err != nil {
		t.Fatalf("create graph update: %v", err)
	}

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: "workspace", Update: update})
	if err != nil {
		t.Fatalf("publish contribution metadata: %v", err)
	}
	contributions, err := store.SourceContributions(context.Background(), snapshot)
	if err != nil {
		t.Fatalf("read source contributions: %v", err)
	}
	if len(contributions) != 1 {
		t.Fatalf("source contribution count = %d, want 1", len(contributions))
	}
	got := contributions[0]
	if len(got.UnresolvedReferences) != 1 || got.UnresolvedReferences[0].Target != "./helper" || len(got.UnresolvedReferences[0].Bindings) != 1 || got.UnresolvedReferences[0].Bindings[0].LocalName != "localHelper" {
		t.Errorf("unresolved references = %+v, want ./helper", got.UnresolvedReferences)
	}
	if len(got.SymbolReferences) != 1 || got.SymbolReferences[0].Relation != "references" {
		t.Errorf("symbol references = %+v, want references", got.SymbolReferences)
	}
	if len(got.Diagnostics) != 1 || got.Diagnostics[0].Message != "fixture warning" {
		t.Errorf("diagnostics = %+v, want fixture warning", got.Diagnostics)
	}
}

func TestResolverProjectionsReadResolverDataWithoutGraphFacts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}

	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"function"}, Relations: []graph.RelationDefinition{{Kind: "references", Endpoints: []graph.EndpointRule{{Source: "function", Target: "function"}}}}})
	if err != nil {
		t.Fatalf("create vocabulary: %v", err)
	}
	contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Metadata:   extractor.Metadata{Name: "typescript", Version: "1", Extensions: []string{".ts"}},
		Facts:      graph.Facts{Nodes: []graph.Node{graphNode("src/main.ts", "function:main")}},
		UnresolvedReferences: []extractor.UnresolvedReference{{
			SourceID: "function:main",
			Target:   "./helper",
			Kind:     extractor.ModuleReferenceImport,
			Bindings: []extractor.ModuleBinding{{ImportedName: "helper", LocalName: "localHelper"}},
		}},
		SymbolReferences: []extractor.SymbolReference{{
			SourceID: "function:main",
			Target:   "helper",
			Relation: "references",
			Evidence: evidence("src/main.ts"),
		}},
		ExportedSurfaces: []extractor.ExportedSurface{{NodeID: "function:main", Name: "main"}},
		Dependencies:     []extractor.Dependency{{SourcePath: "src/main.ts", TargetPath: "src/helper.ts"}},
	})
	if err != nil {
		t.Fatalf("create contribution: %v", err)
	}
	update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
	if err != nil {
		t.Fatalf("create graph update: %v", err)
	}
	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: "workspace", Update: update})
	if err != nil {
		t.Fatalf("publish resolver projection: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}
	reopened, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("reopen database: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	projections, err := reopened.ResolverProjections(context.Background(), snapshot)
	if err != nil {
		t.Fatalf("read resolver projections: %v", err)
	}
	if len(projections) != 1 {
		t.Fatalf("resolver projection count = %d, want 1", len(projections))
	}
	got := projections[0]
	if got.ProjectID != "project:fixture" || got.SourcePath != "src/main.ts" || got.Metadata.Name != "typescript" {
		t.Errorf("resolver projection identity = %+v, want project:fixture src/main.ts typescript", got)
	}
	if len(got.UnresolvedReferences) != 1 || got.UnresolvedReferences[0].Target != "./helper" || len(got.UnresolvedReferences[0].Bindings) != 1 {
		t.Errorf("resolver projection unresolved references = %+v, want ./helper with binding", got.UnresolvedReferences)
	}
	if len(got.SymbolReferences) != 1 || got.SymbolReferences[0].Evidence.Span.Path != "src/main.ts" {
		t.Errorf("resolver projection symbol references = %+v, want evidence", got.SymbolReferences)
	}
	if len(got.ExportedSurfaces) != 1 || len(got.Dependencies) != 1 {
		t.Errorf("resolver projection surfaces and dependencies = %+v, %+v, want one each", got.ExportedSurfaces, got.Dependencies)
	}
}

func TestResolverProjectionPageFiltersAndOrdersSnapshotProjections(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	for _, sourcePath := range []string{"src/c.ts", "src/a.ts", "src/b.ts"} {
		contribution, err := typescript.Extract(extractor.Source{
			ProjectID:  "project:fixture",
			SourcePath: sourcePath,
			Contents:   []byte("export const value = 1;"),
		})
		if err != nil {
			t.Fatalf("extract %q: %v", sourcePath, err)
		}
		update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
		if err != nil {
			t.Fatalf("create update for %q: %v", sourcePath, err)
		}
		if _, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: workspace, Update: update}); err != nil {
			t.Fatalf("publish %q: %v", sourcePath, err)
		}
	}
	snapshot, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace})
	if err != nil {
		t.Fatalf("open snapshot: %v", err)
	}

	page, err := store.ResolverProjectionPage(context.Background(), snapshot, storage.ResolverProjectionPageRequest{
		ProjectID: "project:fixture",
		Language:  "typescript",
		Limit:     2,
	})
	if err != nil {
		t.Fatalf("read first projection page: %v", err)
	}
	if got := projectionPaths(page); !reflect.DeepEqual(got, []string{"src/a.ts", "src/b.ts"}) {
		t.Errorf("first projection page paths = %q, want src/a.ts then src/b.ts", got)
	}
	for projectionIndex, projection := range page {
		if len(projection.Nodes) == 0 {
			t.Errorf("projection %d for %q has no source nodes", projectionIndex, projection.SourcePath)
		}
	}

	page, err = store.ResolverProjectionPage(context.Background(), snapshot, storage.ResolverProjectionPageRequest{
		ProjectID:       "project:fixture",
		Language:        "typescript",
		AfterSourcePath: "src/b.ts",
		Limit:           2,
	})
	if err != nil {
		t.Fatalf("read next projection page: %v", err)
	}
	if got := projectionPaths(page); !reflect.DeepEqual(got, []string{"src/c.ts"}) {
		t.Errorf("next projection page paths = %q, want src/c.ts", got)
	}
}

func TestPublishStagedReadsOrderedResolverProjections(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	for _, sourcePath := range []string{"src/a.ts", "src/b.ts", "src/c.ts"} {
		contribution, err := typescript.Extract(extractor.Source{
			ProjectID:  "project:fixture",
			SourcePath: sourcePath,
			Contents:   []byte("export const value = 1;"),
		})
		if err != nil {
			t.Fatalf("extract %q: %v", sourcePath, err)
		}
		update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
		if err != nil {
			t.Fatalf("create update for %q: %v", sourcePath, err)
		}
		if _, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: workspace, Update: update}); err != nil {
			t.Fatalf("publish %q: %v", sourcePath, err)
		}
	}

	var got []string
	_, err = store.PublishStaged(context.Background(), storage.PublishRequest{
		Workspace: workspace,
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	}, func(ctx context.Context, stager storage.ResolverStager) (storage.PublishRequest, error) {
		if err := stager.StageResolverSources(ctx, []storage.ResolverStageSource{
			{ProjectID: "project:fixture", Language: "typescript", SourcePath: "src/c.ts"},
			{ProjectID: "project:fixture", Language: "typescript", SourcePath: "src/a.ts"},
		}); err != nil {
			return storage.PublishRequest{}, err
		}
		page, err := stager.ResolverProjectionPage(ctx, stager.Snapshot(), storage.ResolverProjectionPageRequest{ProjectID: "project:fixture", Language: "typescript", Limit: 2})
		if err != nil {
			return storage.PublishRequest{}, err
		}
		got = projectionPaths(page)
		return storage.PublishRequest{}, errors.New("roll back staged read")
	})
	if err == nil {
		t.Fatal("publish staged read succeeded")
	}
	if !reflect.DeepEqual(got, []string{"src/a.ts", "src/c.ts"}) {
		t.Errorf("staged projection paths = %q, want src/a.ts then src/c.ts", got)
	}
}

func TestPublishStagedDeduplicatesRepeatedSourcesAndReadsPackageTargets(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	for _, sourcePath := range []string{"src/a.ts", "src/b.ts"} {
		contribution, err := typescript.Extract(extractor.Source{
			ProjectID:  "project:fixture",
			SourcePath: sourcePath,
			Contents:   []byte("export const value = 1;"),
		})
		if err != nil {
			t.Fatalf("extract %q: %v", sourcePath, err)
		}
		update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
		if err != nil {
			t.Fatalf("create update for %q: %v", sourcePath, err)
		}
		if _, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: workspace, Update: update}); err != nil {
			t.Fatalf("publish %q: %v", sourcePath, err)
		}
	}

	var got []string
	_, err = store.PublishStaged(context.Background(), storage.PublishRequest{
		Workspace: workspace,
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	}, func(ctx context.Context, stager storage.ResolverStager) (storage.PublishRequest, error) {
		for _, sources := range [][]storage.ResolverStageSource{
			{{ProjectID: "project:fixture", Language: "typescript", SourcePath: "src/a.ts"}},
			{{ProjectID: "project:fixture", Language: "typescript", SourcePath: "src/a.ts"}},
		} {
			if err := stager.StageResolverSources(ctx, sources); err != nil {
				return storage.PublishRequest{}, err
			}
		}
		targets, err := stager.ResolverPackagePage(ctx, stager.Snapshot(), extractor.ResolverPackagePageRequest{
			ProjectID:   "project:fixture",
			Language:    "typescript",
			PackagePath: "src",
			Limit:       3,
		})
		if err != nil {
			return storage.PublishRequest{}, err
		}
		for _, target := range targets {
			got = append(got, target.SourcePath)
		}
		return storage.PublishRequest{}, errors.New("roll back staged package page")
	})
	if err == nil {
		t.Fatal("publish staged package page succeeded")
	}
	if !reflect.DeepEqual(got, []string{"src/a.ts", "src/b.ts"}) {
		t.Errorf("staged package target paths = %q, want src/a.ts then src/b.ts", got)
	}
}

func TestResolverProjectionPageStopsOnCancellation(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	contribution, err := typescript.Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("export const value = 1;"),
	})
	if err != nil {
		t.Fatalf("extract source: %v", err)
	}
	update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
	if err != nil {
		t.Fatalf("create graph update: %v", err)
	}
	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: "workspace", Update: update})
	if err != nil {
		t.Fatalf("publish source: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = store.ResolverProjectionPage(ctx, snapshot, storage.ResolverProjectionPageRequest{
		ProjectID: "project:fixture",
		Language:  "typescript",
		Limit:     1,
	})
	if !errors.Is(err, context.Canceled) {
		t.Errorf("read cancelled projection page error = %v, want context cancellation", err)
	}
}

func TestResolverTargetReadsSnapshotScopedFileDeclarationsAndSurfaces(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	contribution, err := typescript.Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("export function main() {}"),
	})
	if err != nil {
		t.Fatalf("extract source: %v", err)
	}
	update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
	if err != nil {
		t.Fatalf("create graph update: %v", err)
	}
	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: workspace, Update: update})
	if err != nil {
		t.Fatalf("publish source: %v", err)
	}

	target, found, err := store.ResolverTarget(context.Background(), snapshot, extractor.ResolverTargetRequest{
		ProjectID:  "project:fixture",
		Language:   "typescript",
		SourcePath: "src/main.ts",
	})
	if err != nil {
		t.Fatalf("read resolver target: %v", err)
	}
	if !found {
		t.Fatal("resolver target was not found")
	}
	if target.ProjectID != "project:fixture" || target.SourcePath != "src/main.ts" || target.Metadata.Name != "typescript" {
		t.Errorf("resolver target identity = %+v, want project:fixture src/main.ts typescript", target)
	}
	if !hasNodeKind(target.Nodes, "file") || !hasNodeKind(target.Nodes, typescript.FunctionNodeKind) {
		t.Errorf("resolver target nodes = %+v, want file and function declarations", target.Nodes)
	}
	if len(target.ExportedSurfaces) != 1 || target.ExportedSurfaces[0].Name != "main" {
		t.Errorf("resolver target surfaces = %+v, want main", target.ExportedSurfaces)
	}
	if len(target.UnresolvedReferences) != 0 || len(target.SymbolReferences) != 0 || len(target.Diagnostics) != 0 {
		t.Errorf("resolver target metadata = %+v, %+v, %+v, want no resolver references or diagnostics", target.UnresolvedReferences, target.SymbolReferences, target.Diagnostics)
	}
}

func TestResolverPackagePageReadsOrderedGoTargets(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	workspace := "workspace"
	for _, sourcePath := range []string{"service/c.go", "service/a.go", "other/ignored.go", "service/b.go"} {
		contribution, err := goextractor.Extract(extractor.Source{
			ProjectID:  "project:fixture",
			SourcePath: sourcePath,
			Contents:   []byte("package service\n\nfunc Run() {}\n"),
		})
		if err != nil {
			t.Fatalf("extract %q: %v", sourcePath, err)
		}
		update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
		if err != nil {
			t.Fatalf("create update for %q: %v", sourcePath, err)
		}
		if _, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: workspace, Update: update}); err != nil {
			t.Fatalf("publish %q: %v", sourcePath, err)
		}
	}
	snapshot, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace})
	if err != nil {
		t.Fatalf("open snapshot: %v", err)
	}
	page, err := store.ResolverPackagePage(context.Background(), snapshot, extractor.ResolverPackagePageRequest{
		ProjectID:   "project:fixture",
		Language:    "go",
		PackagePath: "service",
		Limit:       2,
	})
	if err != nil {
		t.Fatalf("read Go package page: %v", err)
	}
	if got := resolverTargetPaths(page); !reflect.DeepEqual(got, []string{"service/a.go", "service/b.go"}) {
		t.Errorf("Go package page paths = %q, want service/a.go then service/b.go", got)
	}
}

func resolverTargetPaths(targets []extractor.ResolverTarget) []string {
	paths := make([]string, 0, len(targets))
	for _, target := range targets {
		paths = append(paths, target.SourcePath)
	}
	return paths
}

func hasNodeKind(nodes []graph.Node, kind graph.NodeKind) bool {
	for _, node := range nodes {
		if node.Kind == kind {
			return true
		}
	}
	return false
}

func projectionPaths(projections []storage.ResolverProjection) []string {
	paths := make([]string, 0, len(projections))
	for _, projection := range projections {
		paths = append(paths, projection.SourcePath)
	}
	return paths
}

func TestResolverProjectionCacheReturnsDefensiveCopies(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    resolverProjectionUpdate(t, "project:fixture", "src/main.ts", "function:main", "main"),
	})
	if err != nil {
		t.Fatalf("publish resolver projection: %v", err)
	}

	first, err := store.ResolverProjections(context.Background(), snapshot)
	if err != nil {
		t.Fatalf("read resolver projections: %v", err)
	}
	first[0].Metadata.Extensions[0] = ".mutated"
	first[0].ExportedSurfaces[0].Name = "mutated"

	second, err := store.ResolverProjections(context.Background(), snapshot)
	if err != nil {
		t.Fatalf("read cached resolver projections: %v", err)
	}
	if second[0].Metadata.Extensions[0] != ".ts" || second[0].ExportedSurfaces[0].Name != "main" {
		t.Errorf("cached resolver projection changed through caller mutation: %+v", second[0])
	}
}

func TestResolverProjectionCacheServesPublishedSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.OpenWithOptions(context.Background(), path, sqlite.Options{MaxResolverProjectionCacheBytes: 1 << 20})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    resolverProjectionUpdate(t, "project:fixture", "src/main.ts", "function:main", "main"),
	})
	if err != nil {
		t.Fatalf("publish resolver projection: %v", err)
	}
	if _, err := store.ResolverProjections(context.Background(), snapshot); err != nil {
		t.Fatalf("read resolver projections: %v", err)
	}

	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open database for cache check: %v", err)
	}
	if _, err := database.Exec("DELETE FROM file_contributions WHERE workspace = ?", "workspace"); err != nil {
		_ = database.Close()
		t.Fatalf("remove backing projection row: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close database for cache check: %v", err)
	}

	projections, err := store.ResolverProjections(context.Background(), snapshot)
	if err != nil {
		t.Fatalf("read cached resolver projections: %v", err)
	}
	if len(projections) != 1 || projections[0].ExportedSurfaces[0].Name != "main" {
		t.Errorf("cached resolver projections = %+v, want main projection", projections)
	}
}

func TestResolverProjectionCacheDropsRolledBackAndPrunedVersions(t *testing.T) {
	store, err := sqlite.OpenWithOptions(context.Background(), filepath.Join(t.TempDir(), "graph.db"), sqlite.Options{MaxResolverProjectionCacheBytes: 1 << 20})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	first, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    resolverProjectionUpdate(t, "project:fixture", "src/main.ts", "function:main", "main"),
	})
	if err != nil {
		t.Fatalf("publish first resolver projection: %v", err)
	}
	second, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    resolverProjectionUpdate(t, "project:fixture", "src/main.ts", "function:replacement", "replacement"),
	})
	if err != nil {
		t.Fatalf("publish replacement resolver projection: %v", err)
	}
	if _, err := store.ResolverProjections(context.Background(), second); err != nil {
		t.Fatalf("cache replacement projection: %v", err)
	}

	if _, err := store.Rollback(context.Background(), storage.RollbackRequest{Workspace: "workspace", Version: first.Version}); err != nil {
		t.Fatalf("roll back resolver projection: %v", err)
	}
	projections, err := store.ResolverProjections(context.Background(), second)
	if err != nil {
		t.Fatalf("read removed rollback version: %v", err)
	}
	if len(projections) != 1 || projections[0].ExportedSurfaces[0].Name != "main" {
		t.Errorf("rolled back projection cache = %+v, want restored main projection", projections)
	}

	second, err = store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    resolverProjectionUpdate(t, "project:fixture", "src/main.ts", "function:replacement", "replacement"),
	})
	if err != nil {
		t.Fatalf("republish replacement resolver projection: %v", err)
	}
	if _, err := store.ResolverProjections(context.Background(), first); err != nil {
		t.Fatalf("cache pruned projection: %v", err)
	}
	if _, err := store.Prune(context.Background(), storage.PruneRequest{Workspace: "workspace", BeforeVersion: second.Version}); err != nil {
		t.Fatalf("prune resolver projection: %v", err)
	}
	projections, err = store.ResolverProjections(context.Background(), first)
	if err != nil {
		t.Fatalf("read removed pruned version: %v", err)
	}
	if len(projections) != 0 {
		t.Errorf("pruned projection cache = %+v, want no projections", projections)
	}
}

func TestResolverProjectionCacheEvictsOldestSnapshotAtBudget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.OpenWithOptions(context.Background(), path, sqlite.Options{MaxResolverProjectionCacheBytes: 256})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	first, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    resolverProjectionUpdate(t, "project:fixture", "src/main.ts", "function:main", "main"),
	})
	if err != nil {
		t.Fatalf("publish first resolver projection: %v", err)
	}
	second, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    resolverProjectionUpdate(t, "project:fixture", "src/main.ts", "function:replacement", "replacement"),
	})
	if err != nil {
		t.Fatalf("publish second resolver projection: %v", err)
	}
	if _, err := store.ResolverProjections(context.Background(), first); err != nil {
		t.Fatalf("cache first resolver projection: %v", err)
	}
	if _, err := store.ResolverProjections(context.Background(), second); err != nil {
		t.Fatalf("cache second resolver projection: %v", err)
	}

	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open database for eviction check: %v", err)
	}
	if _, err := database.Exec("DELETE FROM file_contributions WHERE workspace = ?", "workspace"); err != nil {
		_ = database.Close()
		t.Fatalf("remove backing projection rows: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close database for eviction check: %v", err)
	}

	projections, err := store.ResolverProjections(context.Background(), first)
	if err != nil {
		t.Fatalf("read evicted first projection: %v", err)
	}
	if len(projections) != 0 {
		t.Errorf("evicted first projection = %+v, want none", projections)
	}
	projections, err = store.ResolverProjections(context.Background(), second)
	if err != nil {
		t.Fatalf("read retained second projection: %v", err)
	}
	if len(projections) != 1 || projections[0].ExportedSurfaces[0].Name != "replacement" {
		t.Errorf("retained second projection = %+v, want replacement projection", projections)
	}
}

func TestResolverProjectionsFollowReplacementRollbackAndPruning(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	first, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    resolverProjectionUpdate(t, "project:fixture", "src/main.ts", "function:main", "main"),
	})
	if err != nil {
		t.Fatalf("publish first projection: %v", err)
	}
	second, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    resolverProjectionUpdate(t, "project:fixture", "src/main.ts", "function:replacement", "replacement"),
	})
	if err != nil {
		t.Fatalf("publish replacement projection: %v", err)
	}
	projections, err := store.ResolverProjections(context.Background(), second)
	if err != nil {
		t.Fatalf("read replacement projections: %v", err)
	}
	if len(projections) != 1 || projections[0].ExportedSurfaces[0].Name != "replacement" {
		t.Errorf("replacement projections = %+v, want replacement surface", projections)
	}

	rolledBack, err := store.Rollback(context.Background(), storage.RollbackRequest{Workspace: "workspace", Version: first.Version})
	if err != nil {
		t.Fatalf("roll back projection: %v", err)
	}
	projections, err = store.ResolverProjections(context.Background(), rolledBack)
	if err != nil {
		t.Fatalf("read rolled back projections: %v", err)
	}
	if len(projections) != 1 || projections[0].ExportedSurfaces[0].Name != "main" {
		t.Errorf("rolled back projections = %+v, want main surface", projections)
	}
	projections, err = store.ResolverProjections(context.Background(), second)
	if err != nil {
		t.Fatalf("read rolled back cached projection: %v", err)
	}
	if len(projections) != 1 || projections[0].ExportedSurfaces[0].Name != "main" {
		t.Errorf("rolled back cached projections = %+v, want main surface", projections)
	}

	for versionIndex := 2; versionIndex <= 3; versionIndex++ {
		if _, err := store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update:    resolverProjectionUpdate(t, "project:fixture", "src/main.ts", fmt.Sprintf("function:main-%d", versionIndex), "main"),
		}); err != nil {
			t.Fatalf("publish projection version %d: %v", versionIndex, err)
		}
	}
	if _, err := store.Prune(context.Background(), storage.PruneRequest{Workspace: "workspace", BeforeVersion: 2}); err != nil {
		t.Fatalf("prune projections: %v", err)
	}
	projections, err = store.ResolverProjections(context.Background(), first)
	if err != nil {
		t.Fatalf("read pruned cached projection: %v", err)
	}
	if len(projections) != 0 {
		t.Errorf("pruned cached projections = %+v, want none", projections)
	}
	retainedVersion := storage.GraphVersion(2)
	retained, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace", Version: &retainedVersion})
	if err != nil {
		t.Fatalf("open retained projection snapshot: %v", err)
	}
	projections, err = store.ResolverProjections(context.Background(), retained)
	if err != nil {
		t.Fatalf("read retained projections: %v", err)
	}
	if len(projections) != 1 || projections[0].ProjectID != "project:fixture" || projections[0].ExportedSurfaces[0].Name != "main" {
		t.Errorf("retained projections = %+v, want active projection", projections)
	}
}

func TestSourceContributionsReturnDefensiveCopiesAndReopenFromSQLite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdateWithDependency(t, "src/main.ts", "function:main", "src/helper.ts", []string{"main"}),
	})
	if err != nil {
		t.Fatalf("publish cached contribution: %v", err)
	}

	first, err := store.SourceContributions(context.Background(), snapshot)
	if err != nil {
		t.Fatalf("read cached source contributions: %v", err)
	}
	first[0].Facts.Nodes[0].ID = "mutated"
	first[0].Metadata.Extensions[0] = ".mutated"
	first[0].ExportedSurfaces[0].Name = "mutated"
	first[0].Dependencies[0].TargetPath = "mutated"
	second, err := store.SourceContributions(context.Background(), snapshot)
	if err != nil {
		t.Fatalf("read cached source contributions again: %v", err)
	}
	if second[0].Facts.Nodes[0].ID != "function:main" || second[0].Metadata.Extensions[0] != ".ts" || second[0].ExportedSurfaces[0].Name != "main" || second[0].Dependencies[0].TargetPath != "src/helper.ts" {
		t.Errorf("cached contribution changed through caller mutation: %+v", second[0])
	}

	if err := store.Close(); err != nil {
		t.Fatalf("close cached database: %v", err)
	}
	reopened, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("reopen database: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	restored, err := reopened.SourceContributions(context.Background(), snapshot)
	if err != nil {
		t.Fatalf("restore source contributions from SQLite: %v", err)
	}
	if len(restored) != 1 || restored[0].Facts.Nodes[0].ID != "function:main" || restored[0].ExportedSurfaces[0].Name != "main" {
		t.Errorf("restored contribution = %+v, want published contribution", restored)
	}
}

func TestOpenSnapshotReturnsLatestPublishedVersion(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	published, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	})
	if err != nil {
		t.Fatalf("publish workspace snapshot: %v", err)
	}

	snapshot, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace"})
	if err != nil {
		t.Fatalf("open latest snapshot: %v", err)
	}
	if snapshot != published {
		t.Errorf("latest snapshot = %+v, want %+v", snapshot, published)
	}
}

func TestLookupNodesUsesFactsActiveInSpecifiedSnapshot(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	first, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateForSources(t,
			sourceFact{path: "src/main.ts", nodeID: "function:main"},
			sourceFact{path: "src/helper.ts", nodeID: "function:helper"},
		),
	})
	if err != nil {
		t.Fatalf("publish first snapshot: %v", err)
	}
	if _, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:replacement"),
	}); err != nil {
		t.Fatalf("publish replacement snapshot: %v", err)
	}

	matches, err := store.LookupNodes(context.Background(), first, storage.NodeLookupRequest{
		Text:  "function:",
		Limit: 1,
	})
	if err != nil {
		t.Fatalf("look up nodes: %v", err)
	}
	if len(matches) != 1 {
		t.Fatalf("node match count = %d, want 1", len(matches))
	}
	if matches[0].Node.ID != "function:helper" {
		t.Errorf("matched node ID = %q, want function:helper", matches[0].Node.ID)
	}
}

func TestLookupNodesRanksMatchesWithinProjectScope(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "apps/app/src/main.ts", graph.Facts{
			Nodes: []graph.Node{
				{ID: "project:app", Kind: "project", Label: "app", QualifiedName: "apps/app", Evidence: evidence("apps/app/package.json")},
				{ID: "file:app", Kind: "file", Label: "main.ts", QualifiedName: "apps/app/src/main.ts", Evidence: evidence("apps/app/src/main.ts")},
				{ID: "function:exact", Kind: "function", Label: "target", QualifiedName: "apps/app/src/main.ts::target", Evidence: evidence("apps/app/src/main.ts")},
				{ID: "project:library", Kind: "project", Label: "library", QualifiedName: "packages/library", Evidence: evidence("packages/library/package.json")},
				{ID: "file:library", Kind: "file", Label: "helper.ts", QualifiedName: "packages/library/src/helper.ts", Evidence: evidence("packages/library/src/helper.ts")},
				{ID: "function:external", Kind: "function", Label: "target", QualifiedName: "packages/library/src/helper.ts::target", Evidence: evidence("packages/library/src/helper.ts")},
			},
			Edges: []graph.Edge{
				{SourceID: "project:app", TargetID: "file:app", Relation: "contains", Evidence: evidence("apps/app/package.json")},
				{SourceID: "file:app", TargetID: "function:exact", Relation: "contains", Evidence: evidence("apps/app/src/main.ts")},
				{SourceID: "project:library", TargetID: "file:library", Relation: "contains", Evidence: evidence("packages/library/package.json")},
				{SourceID: "file:library", TargetID: "function:external", Relation: "contains", Evidence: evidence("packages/library/src/helper.ts")},
			},
		}),
	})
	if err != nil {
		t.Fatalf("publish lookup fixture: %v", err)
	}

	matches, err := store.LookupNodes(context.Background(), snapshot, storage.NodeLookupRequest{
		Text:       "target",
		ProjectIDs: []string{"project:app"},
		Limit:      3,
	})
	if err != nil {
		t.Fatalf("look up scoped nodes: %v", err)
	}
	if len(matches) != 1 || matches[0].Node.ID != "function:exact" {
		t.Errorf("scoped matches = %+v, want function:exact", matches)
	}
}

func TestLookupExactNodesMatchesIDQualifiedNameAndFilePath(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	indexFile := graph.Node{ID: "file:index", Kind: "file", Label: "core-auth/src/index.ts", QualifiedName: "core-auth/src/index.ts", Evidence: evidence("core-auth/src/index.ts")}
	authInfo := graph.Node{ID: "function:auth-info", Kind: "function", Label: "AuthInfo", QualifiedName: "core-auth/src/auth-info.ts::AuthInfo", Evidence: evidence("core-auth/src/auth-info.ts")}
	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdateWithFacts(t, "core-auth/src/index.ts", graph.Facts{Nodes: []graph.Node{indexFile, authInfo}}),
	})
	if err != nil {
		t.Fatalf("publish exact lookup fixture: %v", err)
	}

	for _, test := range []struct {
		identifier string
		wantID     string
	}{
		{identifier: indexFile.ID, wantID: indexFile.ID},
		{identifier: authInfo.QualifiedName, wantID: authInfo.ID},
		{identifier: indexFile.Evidence.Span.Path, wantID: indexFile.ID},
	} {
		matches, err := store.LookupExactNodes(context.Background(), snapshot, test.identifier)
		if err != nil {
			t.Fatalf("look up exact node %q: %v", test.identifier, err)
		}
		if len(matches) != 1 || matches[0].Node.ID != test.wantID {
			t.Errorf("exact matches for %q = %+v, want %q", test.identifier, matches, test.wantID)
		}
	}
}

func TestSearchNodesUsesFTSAndReportsMatchedFields(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "storage/sqlite/lookup.go", graph.Facts{Nodes: []graph.Node{
			{ID: "go:method:lookup", Kind: "function", Label: "LookupExactNodes", QualifiedName: "storage/sqlite.Store.LookupExactNodes", Evidence: evidence("storage/sqlite/lookup.go")},
			{ID: "go:type:other", Kind: "class", Label: "Lookup", QualifiedName: "query.Lookup", Evidence: evidence("query/lookup.go")},
		}}),
	})
	if err != nil {
		t.Fatalf("publish lexical fixture: %v", err)
	}

	matches, err := store.SearchNodes(context.Background(), snapshot, storage.LexicalSearchRequest{
		TokenGroups: [][]string{{"lookup", "exact", "nodes"}},
		Limit:       10,
	})
	if err != nil {
		t.Fatalf("search nodes: %v", err)
	}
	if len(matches) == 0 || matches[0].Node.ID != "go:method:lookup" {
		t.Fatalf("lexical matches = %+v, want lookup method first", matches)
	}
	if !reflect.DeepEqual(matches[0].MatchedFields, []string{"label", "qualifiedName", "path", "identifierTokens"}) {
		t.Errorf("matched fields = %v, want label, qualifiedName, path, and identifierTokens", matches[0].MatchedFields)
	}
	if matches[0].Score <= 0 {
		t.Errorf("match score = %f, want positive relevance", matches[0].Score)
	}
}

func TestSearchNodesPrioritizesExactSymbolLabel(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "query/query.go", graph.Facts{Nodes: []graph.Node{
			{ID: "go:function:query-snapshot", Kind: "function", Label: "QuerySnapshot", QualifiedName: "query.QuerySnapshot", Evidence: evidence("query/query.go")},
			{ID: "go:variable:snapshot", Kind: "function", Label: "snapshot", QualifiedName: "query.QuerySnapshot::snapshot", Evidence: evidence("query/query_test.go")},
		}}),
	})
	if err != nil {
		t.Fatalf("publish exact-label fixture: %v", err)
	}

	matches, err := store.SearchNodes(context.Background(), snapshot, storage.LexicalSearchRequest{
		Text:        "QuerySnapshot",
		TokenGroups: [][]string{{"query", "snapshot"}},
		Limit:       2,
	})
	if err != nil {
		t.Fatalf("search exact-label fixture: %v", err)
	}
	if len(matches) != 2 || matches[0].Node.ID != "go:function:query-snapshot" {
		t.Fatalf("exact-label matches = %+v, want QuerySnapshot first", matches)
	}

	aliasMatches, err := store.SearchNodes(context.Background(), snapshot, storage.LexicalSearchRequest{
		Text:        "query_snapshot",
		TokenGroups: [][]string{{"query", "snapshot"}},
		Limit:       2,
	})
	if err != nil {
		t.Fatalf("search normalized-label fixture: %v", err)
	}
	if len(aliasMatches) != 2 || aliasMatches[0].Node.ID != "go:function:query-snapshot" {
		t.Fatalf("normalized-label matches = %+v, want QuerySnapshot first", aliasMatches)
	}
}

func TestSearchNodesAppliesWeightedBM25Ranking(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/search.ts", graph.Facts{Nodes: []graph.Node{
			{ID: "function:label", Kind: "function", Label: "Needle", QualifiedName: "search.LabelMatch", Evidence: evidence("src/search.ts")},
			{ID: "function:path", Kind: "function", Label: "Other", QualifiedName: "search.PathMatch", Evidence: evidence("src/needle.ts")},
		}}),
	})
	if err != nil {
		t.Fatalf("publish ranking fixture: %v", err)
	}
	matches, err := store.SearchNodes(context.Background(), snapshot, storage.LexicalSearchRequest{Phrases: []string{"needle"}, Limit: 10})
	if err != nil {
		t.Fatalf("search weighted fields: %v", err)
	}
	if len(matches) != 2 || matches[0].Node.ID != "function:label" || matches[0].Score <= matches[1].Score {
		t.Errorf("weighted matches = %+v, want label match above path match", matches)
	}
}

func TestSearchNodesTreatsRawTextAsDataAndTracksSnapshots(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	first, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.go", graph.Facts{Nodes: []graph.Node{
			{ID: "go:function:old", Kind: "function", Label: "OldHandler", QualifiedName: "src.OldHandler", Evidence: evidence("src/main.go")},
		}}),
	})
	if err != nil {
		t.Fatalf("publish first lexical snapshot: %v", err)
	}
	second, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.go", graph.Facts{Nodes: []graph.Node{
			{ID: "go:function:new", Kind: "function", Label: "NewHandler", QualifiedName: "src.NewHandler", Evidence: evidence("src/main.go")},
		}}),
	})
	if err != nil {
		t.Fatalf("publish replacement lexical snapshot: %v", err)
	}

	oldMatches, err := store.SearchNodes(context.Background(), first, storage.LexicalSearchRequest{Text: `old OR "unterminated`, Limit: 10})
	if err != nil {
		t.Fatalf("search first snapshot with syntax characters: %v", err)
	}
	if len(oldMatches) != 1 || oldMatches[0].Node.ID != "go:function:old" {
		t.Errorf("first snapshot matches = %+v, want old handler", oldMatches)
	}
	newMatches, err := store.SearchNodes(context.Background(), second, storage.LexicalSearchRequest{Text: "old", Limit: 10})
	if err != nil {
		t.Fatalf("search replacement snapshot: %v", err)
	}
	if len(newMatches) != 0 {
		t.Errorf("replacement snapshot matches = %+v, want no stale old handler", newMatches)
	}
}

func TestSearchNodesHonorsProjectAndKindFilters(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "apps/app/src/main.ts", graph.Facts{
			Nodes: []graph.Node{
				{ID: "project:app", Kind: "project", Label: "app", QualifiedName: "apps/app", Evidence: evidence("apps/app/package.json")},
				{ID: "file:app", Kind: "file", Label: "main.ts", QualifiedName: "apps/app/src/main.ts", Evidence: evidence("apps/app/src/main.ts")},
				{ID: "function:app-target", Kind: "function", Label: "SharedTarget", QualifiedName: "apps/app.SharedTarget", Evidence: evidence("apps/app/src/main.ts")},
				{ID: "project:library", Kind: "project", Label: "library", QualifiedName: "packages/library", Evidence: evidence("packages/library/package.json")},
				{ID: "file:library", Kind: "file", Label: "main.ts", QualifiedName: "packages/library/src/main.ts", Evidence: evidence("packages/library/src/main.ts")},
				{ID: "function:library-target", Kind: "function", Label: "SharedTarget", QualifiedName: "packages/library.SharedTarget", Evidence: evidence("packages/library/src/main.ts")},
			},
			Edges: []graph.Edge{
				{SourceID: "project:app", TargetID: "file:app", Relation: "contains", Evidence: evidence("apps/app/package.json")},
				{SourceID: "file:app", TargetID: "function:app-target", Relation: "contains", Evidence: evidence("apps/app/src/main.ts")},
				{SourceID: "project:library", TargetID: "file:library", Relation: "contains", Evidence: evidence("packages/library/package.json")},
				{SourceID: "file:library", TargetID: "function:library-target", Relation: "contains", Evidence: evidence("packages/library/src/main.ts")},
			},
		}),
	})
	if err != nil {
		t.Fatalf("publish filtered lexical fixture: %v", err)
	}

	matches, err := store.SearchNodes(context.Background(), snapshot, storage.LexicalSearchRequest{
		Text:       "shared target",
		Kinds:      []graph.NodeKind{"function"},
		ProjectIDs: []string{"project:app"},
		Limit:      10,
	})
	if err != nil {
		t.Fatalf("search filtered nodes: %v", err)
	}
	if len(matches) != 1 || matches[0].Node.ID != "function:app-target" {
		t.Errorf("filtered lexical matches = %+v, want app target", matches)
	}
}

func TestLexicalRowsFollowRebuildRollbackAndPrune(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	first, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: "workspace", Update: graphUpdate(t, "src/first.ts", "function:first")})
	if err != nil {
		t.Fatalf("publish first snapshot: %v", err)
	}
	second, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: "workspace", Update: graphUpdate(t, "src/second.ts", "function:second")})
	if err != nil {
		t.Fatalf("publish second snapshot: %v", err)
	}
	if err := store.RebuildLexicalIndex(context.Background(), "workspace"); err != nil {
		t.Fatalf("rebuild lexical index: %v", err)
	}
	if matches, err := store.SearchNodes(context.Background(), second, storage.LexicalSearchRequest{Text: "second", Limit: 10}); err != nil || len(matches) != 1 {
		t.Fatalf("rebuilt lexical matches = %+v, error %v, want second", matches, err)
	}

	if _, err := store.Rollback(context.Background(), storage.RollbackRequest{Workspace: "workspace", Version: first.Version}); err != nil {
		t.Fatalf("roll back lexical snapshot: %v", err)
	}
	if matches, err := store.SearchNodes(context.Background(), second, storage.LexicalSearchRequest{Text: "second", Limit: 10}); err != nil || len(matches) != 0 {
		t.Errorf("rolled back lexical matches = %+v, error %v, want none", matches, err)
	}

	retained, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: "workspace", Update: graphUpdate(t, "src/retained.ts", "function:retained")})
	if err != nil {
		t.Fatalf("publish retained snapshot: %v", err)
	}
	if _, err := store.Prune(context.Background(), storage.PruneRequest{Workspace: "workspace", BeforeVersion: retained.Version}); err != nil {
		t.Fatalf("prune lexical snapshots: %v", err)
	}
	if matches, err := store.SearchNodes(context.Background(), retained, storage.LexicalSearchRequest{Text: "first", Limit: 10}); err != nil || len(matches) != 1 {
		t.Fatalf("retained unchanged lexical matches = %+v, error %v, want first", matches, err)
	}
	if matches, err := store.SearchNodes(context.Background(), first, storage.LexicalSearchRequest{Text: "first", Limit: 10}); err != nil || len(matches) != 0 {
		t.Errorf("pruned lexical matches = %+v, error %v, want none", matches, err)
	}
}

func TestTraverseFollowsOutgoingEdgesAtSpecifiedSnapshot(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
			Nodes: []graph.Node{
				graphNode("src/main.ts", "function:main"),
				graphNode("src/main.ts", "function:helper"),
			},
			Edges: []graph.Edge{{
				SourceID: "function:main",
				TargetID: "function:helper",
				Relation: "calls",
				Evidence: evidence("src/main.ts"),
			}},
		}),
	})
	if err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}

	result, err := store.Traverse(context.Background(), snapshot, storage.TraversalRequest{
		StartNodeIDs: []string{"function:main"},
		Direction:    storage.TraverseOutgoing,
		MaxDepth:     1,
		MaxNodes:     2,
	})
	if err != nil {
		t.Fatalf("traverse graph: %v", err)
	}
	if len(result.Facts.Nodes) != 2 {
		t.Fatalf("traversed node count = %d, want 2", len(result.Facts.Nodes))
	}
	if result.Facts.Nodes[0].ID != "function:helper" || result.Facts.Nodes[1].ID != "function:main" {
		t.Errorf("traversed node IDs = %q, %q, want function:helper, function:main", result.Facts.Nodes[0].ID, result.Facts.Nodes[1].ID)
	}
	if len(result.Facts.Edges) != 1 || result.Facts.Edges[0].Relation != "calls" {
		t.Errorf("traversed edges = %+v, want one calls edge", result.Facts.Edges)
	}
}

func TestTraverseStopsAtExternalProjectBoundary(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
			Nodes: []graph.Node{
				{ID: "project:app", Kind: "project", Evidence: evidence("apps/app/package.json")},
				{ID: "file:app", Kind: "file", Evidence: evidence("apps/app/src/main.ts")},
				graphNode("apps/app/src/main.ts", "function:main"),
				{ID: "project:library", Kind: "project", Evidence: evidence("packages/library/package.json")},
				{ID: "file:library", Kind: "file", Evidence: evidence("packages/library/src/helper.ts")},
				graphNode("packages/library/src/helper.ts", "function:helper"),
				graphNode("packages/library/src/helper.ts", "function:internal"),
			},
			Edges: []graph.Edge{
				{SourceID: "project:app", TargetID: "file:app", Relation: "contains", Evidence: evidence("apps/app/package.json")},
				{SourceID: "file:app", TargetID: "function:main", Relation: "contains", Evidence: evidence("apps/app/src/main.ts")},
				{SourceID: "project:library", TargetID: "file:library", Relation: "contains", Evidence: evidence("packages/library/package.json")},
				{SourceID: "file:library", TargetID: "function:helper", Relation: "contains", Evidence: evidence("packages/library/src/helper.ts")},
				{SourceID: "file:library", TargetID: "function:internal", Relation: "contains", Evidence: evidence("packages/library/src/helper.ts")},
				{SourceID: "function:main", TargetID: "function:helper", Relation: "calls", Evidence: evidence("apps/app/src/main.ts")},
				{SourceID: "function:helper", TargetID: "function:internal", Relation: "calls", Evidence: evidence("packages/library/src/helper.ts")},
			},
		}),
	})
	if err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}

	result, err := store.Traverse(context.Background(), snapshot, storage.TraversalRequest{
		StartNodeIDs: []string{"function:main"},
		ProjectIDs:   []string{"project:app"},
		Direction:    storage.TraverseOutgoing,
		MaxDepth:     3,
		MaxNodes:     10,
	})
	if err != nil {
		t.Fatalf("traverse scoped graph: %v", err)
	}
	if len(result.Facts.Nodes) != 2 || result.Facts.Nodes[0].ID != "function:helper" || result.Facts.Nodes[1].ID != "function:main" {
		t.Errorf("traversed nodes = %+v, want helper boundary and main", result.Facts.Nodes)
	}
	if len(result.Facts.Edges) != 1 || result.Facts.Edges[0].SourceID != "function:main" || result.Facts.Edges[0].TargetID != "function:helper" {
		t.Errorf("traversed edges = %+v, want main-to-helper boundary", result.Facts.Edges)
	}
	if result.ScopeBoundary == nil || result.ScopeBoundary.ID != "function:helper" {
		t.Errorf("scope boundary = %+v, want function:helper", result.ScopeBoundary)
	}
}

func TestTraverseRejectsStartNodeOutsideProjectScope(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
			Nodes: []graph.Node{
				{ID: "project:app", Kind: "project", Evidence: evidence("apps/app/package.json")},
				{ID: "project:library", Kind: "project", Evidence: evidence("packages/library/package.json")},
				{ID: "file:library", Kind: "file", Evidence: evidence("packages/library/src/helper.ts")},
				graphNode("packages/library/src/helper.ts", "function:helper"),
			},
			Edges: []graph.Edge{
				{SourceID: "project:library", TargetID: "file:library", Relation: "contains", Evidence: evidence("packages/library/package.json")},
				{SourceID: "file:library", TargetID: "function:helper", Relation: "contains", Evidence: evidence("packages/library/src/helper.ts")},
			},
		}),
	})
	if err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}

	_, err = store.Traverse(context.Background(), snapshot, storage.TraversalRequest{
		StartNodeIDs: []string{"function:helper"},
		ProjectIDs:   []string{"project:app"},
		Direction:    storage.TraverseOutgoing,
		MaxDepth:     1,
		MaxNodes:     2,
	})
	if !errors.Is(err, storage.ErrInvalidRequest) {
		t.Errorf("traverse error = %v, want invalid request", err)
	}
}

func TestTraverseSelectsNeighborsDeterministicallyAtNodeLimit(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
			Nodes: []graph.Node{
				graphNode("src/main.ts", "function:main"),
				graphNode("src/alpha.ts", "function:alpha"),
				graphNode("src/zeta.ts", "function:zeta"),
			},
			Edges: []graph.Edge{
				{SourceID: "function:main", TargetID: "function:zeta", Relation: "calls", Evidence: evidence("src/main.ts")},
				{SourceID: "function:main", TargetID: "function:alpha", Relation: "calls", Evidence: evidence("src/main.ts")},
			},
		}),
	})
	if err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}

	result, err := store.Traverse(context.Background(), snapshot, storage.TraversalRequest{
		StartNodeIDs: []string{"function:main"},
		Direction:    storage.TraverseOutgoing,
		MaxDepth:     1,
		MaxNodes:     2,
	})
	if err != nil {
		t.Fatalf("traverse graph: %v", err)
	}
	if len(result.Facts.Nodes) != 2 || result.Facts.Nodes[0].ID != "function:alpha" || result.Facts.Nodes[1].ID != "function:main" {
		t.Errorf("traversed nodes = %+v, want alpha and main", result.Facts.Nodes)
	}
	if len(result.Facts.Edges) != 1 || result.Facts.Edges[0].TargetID != "function:alpha" {
		t.Errorf("traversed edges = %+v, want main-to-alpha", result.Facts.Edges)
	}
	if len(result.TruncationReasons) != 1 || result.TruncationReasons[0] != storage.TruncatedByNodeLimit {
		t.Errorf("truncation reasons = %q, want node limit", result.TruncationReasons)
	}
}

func TestTraverseRestrictsFactsToExactRelationFilter(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
			Nodes: []graph.Node{
				graphNode("src/main.ts", "function:main"),
				graphNode("src/helper.ts", "function:helper"),
				graphNode("src/other.ts", "function:other"),
			},
			Edges: []graph.Edge{
				{SourceID: "function:main", TargetID: "function:helper", Relation: "calls", Evidence: evidence("src/main.ts")},
				{SourceID: "function:main", TargetID: "function:other", Relation: "references", Evidence: evidence("src/main.ts")},
			},
		}),
	})
	if err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}

	result, err := store.Traverse(context.Background(), snapshot, storage.TraversalRequest{
		StartNodeIDs: []string{"function:main"},
		Direction:    storage.TraverseOutgoing,
		Relations:    []graph.RelationKind{"calls"},
		MaxDepth:     1,
		MaxNodes:     3,
	})
	if err != nil {
		t.Fatalf("traverse graph: %v", err)
	}
	if len(result.Facts.Nodes) != 2 || result.Facts.Nodes[0].ID != "function:helper" || result.Facts.Nodes[1].ID != "function:main" {
		t.Errorf("traversed nodes = %+v, want helper and main", result.Facts.Nodes)
	}
	if len(result.Facts.Edges) != 1 || result.Facts.Edges[0].Relation != "calls" {
		t.Errorf("traversed edges = %+v, want calls edge only", result.Facts.Edges)
	}
}

func TestTraverseFollowsIncomingEdges(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
			Nodes: []graph.Node{
				graphNode("src/main.ts", "function:main"),
				graphNode("src/helper.ts", "function:helper"),
			},
			Edges: []graph.Edge{{
				SourceID: "function:main",
				TargetID: "function:helper",
				Relation: "calls",
				Evidence: evidence("src/main.ts"),
			}},
		}),
	})
	if err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}

	result, err := store.Traverse(context.Background(), snapshot, storage.TraversalRequest{
		StartNodeIDs: []string{"function:helper"},
		Direction:    storage.TraverseIncoming,
		MaxDepth:     1,
		MaxNodes:     2,
	})
	if err != nil {
		t.Fatalf("traverse graph: %v", err)
	}
	if len(result.Facts.Nodes) != 2 || result.Facts.Nodes[0].ID != "function:helper" || result.Facts.Nodes[1].ID != "function:main" {
		t.Errorf("traversed nodes = %+v, want helper and main", result.Facts.Nodes)
	}
	if len(result.Facts.Edges) != 1 || result.Facts.Edges[0].SourceID != "function:main" || result.Facts.Edges[0].TargetID != "function:helper" {
		t.Errorf("traversed edges = %+v, want main-to-helper", result.Facts.Edges)
	}
}

func TestTraverseReportsDepthLimitDeterministically(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
			Nodes: []graph.Node{
				graphNode("src/main.ts", "function:main"),
				graphNode("src/helper.ts", "function:helper"),
				graphNode("src/leaf.ts", "function:leaf"),
			},
			Edges: []graph.Edge{
				{SourceID: "function:main", TargetID: "function:helper", Relation: "calls", Evidence: evidence("src/main.ts")},
				{SourceID: "function:helper", TargetID: "function:leaf", Relation: "calls", Evidence: evidence("src/helper.ts")},
			},
		}),
	})
	if err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}

	result, err := store.Traverse(context.Background(), snapshot, storage.TraversalRequest{
		StartNodeIDs: []string{"function:main"},
		Direction:    storage.TraverseOutgoing,
		MaxDepth:     1,
		MaxNodes:     3,
	})
	if err != nil {
		t.Fatalf("traverse graph: %v", err)
	}
	if len(result.Facts.Nodes) != 2 || result.Facts.Nodes[0].ID != "function:helper" || result.Facts.Nodes[1].ID != "function:main" {
		t.Errorf("traversed nodes = %+v, want helper and main", result.Facts.Nodes)
	}
	if len(result.TruncationReasons) != 1 || result.TruncationReasons[0] != storage.TruncatedByDepthLimit {
		t.Errorf("truncation reasons = %q, want depth limit", result.TruncationReasons)
	}
}

func TestExplainReturnsNodeAndIncidentFactsAtSpecifiedSnapshot(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
			Nodes: []graph.Node{
				graphNode("src/main.ts", "function:main"),
				graphNode("src/main.ts", "function:helper"),
			},
			Edges: []graph.Edge{{
				SourceID: "function:main",
				TargetID: "function:helper",
				Relation: "calls",
				Evidence: evidence("src/main.ts"),
			}},
		}),
	})
	if err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}

	explanation, err := store.Explain(context.Background(), snapshot, storage.ExplainRequest{NodeID: "function:helper"})
	if err != nil {
		t.Fatalf("explain graph node: %v", err)
	}
	if explanation.Node.ID != "function:helper" || explanation.Node.Evidence.Extractor != "typescript@1" {
		t.Errorf("explained node = %+v, want function:helper with extractor evidence", explanation.Node)
	}
	if len(explanation.SupportingFacts.Nodes) != 2 || len(explanation.SupportingFacts.Edges) != 1 {
		t.Errorf("supporting facts = %+v, want two nodes and one edge", explanation.SupportingFacts)
	}
}

func TestExportStreamsFilteredFactsAtSpecifiedSnapshot(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
			Nodes: []graph.Node{
				graphNode("src/main.ts", "function:main"),
				graphNode("src/main.ts", "function:helper"),
				{ID: "class:ignored", Kind: "class", Evidence: evidence("src/main.ts")},
			},
			Edges: []graph.Edge{{
				SourceID: "function:main",
				TargetID: "function:helper",
				Relation: "calls",
				Evidence: evidence("src/main.ts"),
			}},
		}),
	})
	if err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}

	var sink factCollector
	err = store.Export(context.Background(), snapshot, storage.ExportRequest{
		NodeKinds: []graph.NodeKind{"function"},
		Relations: []graph.RelationKind{"calls"},
	}, &sink)
	if err != nil {
		t.Fatalf("export graph: %v", err)
	}
	if len(sink.nodes) != 2 || sink.nodes[0].ID != "function:helper" || sink.nodes[1].ID != "function:main" {
		t.Errorf("exported nodes = %+v, want function nodes in ID order", sink.nodes)
	}
	if len(sink.edges) != 1 || sink.edges[0].Relation != "calls" {
		t.Errorf("exported edges = %+v, want one calls edge", sink.edges)
	}
}

func TestRollbackMakesEarlierSnapshotCurrent(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	first, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	})
	if err != nil {
		t.Fatalf("publish first snapshot: %v", err)
	}
	if _, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:main-v2"),
	}); err != nil {
		t.Fatalf("publish replacement snapshot: %v", err)
	}

	rolledBack, err := store.Rollback(context.Background(), storage.RollbackRequest{
		Workspace: "workspace",
		Version:   first.Version,
	})
	if err != nil {
		t.Fatalf("roll back graph version: %v", err)
	}
	if rolledBack != first {
		t.Errorf("rollback snapshot = %+v, want %+v", rolledBack, first)
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace"})
	if err != nil {
		t.Fatalf("open current snapshot after rollback: %v", err)
	}
	if current != first {
		t.Errorf("current snapshot after rollback = %+v, want %+v", current, first)
	}
}

func TestPruneRemovesVersionsBeforeRetentionBoundary(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	var latest storage.Snapshot
	for versionIndex := 1; versionIndex <= 22; versionIndex++ {
		latest, err = store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update:    graphUpdate(t, "src/main.ts", "function:main"),
		})
		if err != nil {
			t.Fatalf("publish snapshot %d: %v", versionIndex, err)
		}
	}

	result, err := store.Prune(context.Background(), storage.PruneRequest{
		Workspace:     "workspace",
		BeforeVersion: 2,
	})
	if err != nil {
		t.Fatalf("prune graph versions: %v", err)
	}
	if result.PrunedVersions != 1 {
		t.Errorf("pruned versions = %d, want 1", result.PrunedVersions)
	}

	prunedVersion := storage.GraphVersion(1)
	_, err = store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{
		Workspace: "workspace",
		Version:   &prunedVersion,
	})
	if !errors.Is(err, storage.ErrGraphVersionPruned) {
		t.Errorf("open pruned snapshot error = %v, want %v", err, storage.ErrGraphVersionPruned)
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace"})
	if err != nil {
		t.Fatalf("open current snapshot after prune: %v", err)
	}
	if current != latest {
		t.Errorf("current snapshot after prune = %+v, want %+v", current, latest)
	}
}

func TestPublishRetainsTheNewestTwentyFiveGraphVersions(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	var latest storage.Snapshot
	for versionIndex := 1; versionIndex <= 26; versionIndex++ {
		latest, err = store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update:    graphUpdate(t, "src/main.ts", fmt.Sprintf("function:main-%d", versionIndex)),
		})
		if err != nil {
			t.Fatalf("publish snapshot %d: %v", versionIndex, err)
		}
	}

	firstVersion := storage.GraphVersion(1)
	_, err = store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{
		Workspace: "workspace",
		Version:   &firstVersion,
	})
	if !errors.Is(err, storage.ErrGraphVersionPruned) {
		t.Errorf("open first retained snapshot error = %v, want %v", err, storage.ErrGraphVersionPruned)
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace"})
	if err != nil {
		t.Fatalf("open current snapshot after retention: %v", err)
	}
	if current != latest {
		t.Errorf("current snapshot after retention = %+v, want %+v", current, latest)
	}
}

func TestPublishPreservesPriorSnapshotWhenTheNewVersionExceedsTheDatabaseBudget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	first, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	})
	if err != nil {
		t.Fatalf("publish first snapshot: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close database after first snapshot: %v", err)
	}

	fileInfo, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat database: %v", err)
	}
	store, err = sqlite.OpenWithOptions(context.Background(), path, sqlite.Options{MaxDatabaseBytes: fileInfo.Size()})
	if err != nil {
		t.Fatalf("reopen database with budget: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	_, err = store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{Nodes: []graph.Node{{
			ID:            "function:replacement",
			Kind:          "function",
			Label:         strings.Repeat("replacement", 10_000),
			QualifiedName: "src/main.ts::replacement",
			Evidence:      evidence("src/main.ts"),
		}}}),
	})
	if err == nil {
		t.Fatal("publish version over the database budget succeeded")
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace"})
	if err != nil {
		t.Fatalf("open current snapshot after rejected publication: %v", err)
	}
	if current != first {
		t.Errorf("current snapshot after rejected publication = %+v, want %+v", current, first)
	}
}

func TestPruneRebasesUnchangedContributionAtRetentionBoundary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	if _, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateForSources(t,
			sourceFact{path: "src/main.ts", nodeID: "function:main"},
			sourceFact{path: "src/util.ts", nodeID: "function:util"},
		),
	}); err != nil {
		t.Fatalf("publish first snapshot: %v", err)
	}
	if _, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:main-v2"),
	}); err != nil {
		t.Fatalf("publish second snapshot: %v", err)
	}

	if _, err := store.Prune(context.Background(), storage.PruneRequest{
		Workspace:     "workspace",
		BeforeVersion: 2,
	}); err != nil {
		t.Fatalf("prune graph versions: %v", err)
	}

	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open database for verification: %v", err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close verification database: %v", err)
		}
	})
	var validFrom int
	var validTo sql.NullInt64
	if err := database.QueryRow(`
		SELECT valid_from_version, valid_to_version
		FROM file_contributions
		WHERE workspace = ? AND source_path = ?`, "workspace", "src/util.ts").Scan(&validFrom, &validTo); err != nil {
		t.Fatalf("read rebased utility contribution: %v", err)
	}
	if validFrom != 2 || validTo.Valid {
		t.Errorf("rebased utility contribution = {validFrom: %d, validTo: %+v}, want active from version 2", validFrom, validTo)
	}
}

func TestPublishReplacesChangedSourceAndSharesUnchangedSources(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	first, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateForSources(t,
			sourceFact{path: "src/main.ts", nodeID: "function:main"},
			sourceFact{path: "src/util.ts", nodeID: "function:util"},
		),
	})
	if err != nil {
		t.Fatalf("publish first snapshot: %v", err)
	}
	second, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:main-v2"),
	})
	if err != nil {
		t.Fatalf("publish replacement snapshot: %v", err)
	}
	if second.Version != first.Version+1 {
		t.Errorf("second snapshot version = %d, want %d", second.Version, first.Version+1)
	}

	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open database for verification: %v", err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close verification database: %v", err)
		}
	})
	rows, err := database.Query(`
		SELECT source_path, valid_from_version, valid_to_version
		FROM file_contributions
		WHERE workspace = ?
		ORDER BY source_path, valid_from_version`, "workspace")
	if err != nil {
		t.Fatalf("read stored contributions: %v", err)
	}
	defer rows.Close()

	type contributionVersion struct {
		sourcePath string
		validFrom  int
		validTo    sql.NullInt64
	}
	var contributions []contributionVersion
	for rows.Next() {
		var contribution contributionVersion
		if err := rows.Scan(&contribution.sourcePath, &contribution.validFrom, &contribution.validTo); err != nil {
			t.Fatalf("scan stored contribution: %v", err)
		}
		contributions = append(contributions, contribution)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate stored contributions: %v", err)
	}
	if len(contributions) != 3 {
		t.Fatalf("stored contribution count = %d, want 3", len(contributions))
	}
	if got := contributions[0]; got.sourcePath != "src/main.ts" || got.validFrom != 1 || !got.validTo.Valid || got.validTo.Int64 != 1 {
		t.Errorf("closed main contribution = %+v, want source src/main.ts at version 1", got)
	}
	if got := contributions[1]; got.sourcePath != "src/main.ts" || got.validFrom != 2 || got.validTo.Valid {
		t.Errorf("replacement main contribution = %+v, want active source src/main.ts at version 2", got)
	}
	if got := contributions[2]; got.sourcePath != "src/util.ts" || got.validFrom != 1 || got.validTo.Valid {
		t.Errorf("shared utility contribution = %+v, want active source src/util.ts from version 1", got)
	}
}

func TestAffectedSourcesIncludesDependentsWhenExportedSurfaceChanges(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	if _, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdateWithDependency(t, "src/main.ts", "function:main", "src/support.ts", nil),
	}); err != nil {
		t.Fatalf("publish dependent source: %v", err)
	}
	second, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdateWithDependency(t, "src/support.ts", "function:support", "", []string{"support"}),
	})
	if err != nil {
		t.Fatalf("publish exported source: %v", err)
	}

	affected, err := store.AffectedSources(context.Background(), second, storage.AffectedSourcesRequest{
		Update: graphUpdateWithDependency(t, "src/support.ts", "function:support-v2", "", []string{"replacement"}),
	})
	if err != nil {
		t.Fatalf("find affected sources: %v", err)
	}
	if len(affected) != 1 || affected[0] != "src/main.ts" {
		t.Errorf("affected sources = %q, want src/main.ts", affected)
	}
}

func TestAffectedSourcesIgnoresImplementationOnlyChanges(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	if _, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdateWithDependency(t, "src/main.ts", "function:main", "src/support.ts", nil),
	}); err != nil {
		t.Fatalf("publish dependent source: %v", err)
	}
	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdateWithDependency(t, "src/support.ts", "function:support", "", []string{"support"}),
	})
	if err != nil {
		t.Fatalf("publish exported source: %v", err)
	}

	affected, err := store.AffectedSources(context.Background(), snapshot, storage.AffectedSourcesRequest{
		Update: graphUpdateWithDependency(t, "src/support.ts", "function:support", "", []string{"support"}),
	})
	if err != nil {
		t.Fatalf("find affected sources: %v", err)
	}
	if len(affected) != 0 {
		t.Errorf("affected sources = %q, want none", affected)
	}
}

func TestAffectedSourcesPreservesSurfaceStateAfterPrune(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	if _, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdateWithDependency(t, "src/main.ts", "function:main", "src/support.ts", nil),
	}); err != nil {
		t.Fatalf("publish dependent source: %v", err)
	}
	if _, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdateWithDependency(t, "src/support.ts", "function:support", "", []string{"support"}),
	}); err != nil {
		t.Fatalf("publish original export: %v", err)
	}
	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdateWithDependency(t, "src/support.ts", "function:replacement", "", []string{"replacement"}),
	})
	if err != nil {
		t.Fatalf("publish replacement export: %v", err)
	}
	if _, err := store.Prune(context.Background(), storage.PruneRequest{Workspace: "workspace", BeforeVersion: snapshot.Version}); err != nil {
		t.Fatalf("prune earlier snapshots: %v", err)
	}

	affected, err := store.AffectedSources(context.Background(), snapshot, storage.AffectedSourcesRequest{
		Update: graphUpdateWithDependency(t, "src/support.ts", "function:replacement", "", []string{"replacement"}),
	})
	if err != nil {
		t.Fatalf("find affected sources after prune: %v", err)
	}
	if len(affected) != 0 {
		t.Errorf("affected sources after prune = %q, want none", affected)
	}
}

func TestAffectedSourcesUsesRestoredSurfaceStateAfterRollback(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	if _, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdateWithDependency(t, "src/main.ts", "function:main", "src/support.ts", nil),
	}); err != nil {
		t.Fatalf("publish dependent source: %v", err)
	}
	original, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdateWithDependency(t, "src/support.ts", "function:support", "", []string{"support"}),
	})
	if err != nil {
		t.Fatalf("publish original export: %v", err)
	}
	if _, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdateWithDependency(t, "src/support.ts", "function:replacement", "", []string{"replacement"}),
	}); err != nil {
		t.Fatalf("publish replacement export: %v", err)
	}
	if _, err := store.Rollback(context.Background(), storage.RollbackRequest{Workspace: "workspace", Version: original.Version}); err != nil {
		t.Fatalf("roll back replacement export: %v", err)
	}

	affected, err := store.AffectedSources(context.Background(), original, storage.AffectedSourcesRequest{
		Update: graphUpdateWithDependency(t, "src/support.ts", "function:support", "", []string{"support"}),
	})
	if err != nil {
		t.Fatalf("find affected sources after rollback: %v", err)
	}
	if len(affected) != 0 {
		t.Errorf("affected sources after rollback = %q, want none", affected)
	}
}

func TestPublishCancellationKeepsPriorSnapshotCurrent(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	published, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	})
	if err != nil {
		t.Fatalf("publish initial snapshot: %v", err)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Publish(canceled, storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:main-v2"),
	}); err == nil {
		t.Fatal("publish canceled update succeeded")
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace"})
	if err != nil {
		t.Fatalf("open current snapshot: %v", err)
	}
	if current != published {
		t.Errorf("current snapshot after cancellation = %+v, want %+v", current, published)
	}
}

func TestPublishStagedFailureKeepsPriorSnapshotCurrent(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	published, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	})
	if err != nil {
		t.Fatalf("publish initial snapshot: %v", err)
	}

	stageFailure := errors.New("stage resolver paths")
	_, err = store.PublishStaged(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:replacement"),
	}, func(context.Context, storage.ResolverStager) (storage.PublishRequest, error) {
		return storage.PublishRequest{}, stageFailure
	})
	if !errors.Is(err, stageFailure) {
		t.Errorf("publish staged failure = %v, want stage failure", err)
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace"})
	if err != nil {
		t.Fatalf("open current snapshot: %v", err)
	}
	if current != published {
		t.Errorf("current snapshot after staged failure = %+v, want %+v", current, published)
	}
}

func TestPublishStagedRemovesTemporaryRecordsAfterCommitRollbackAndReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}

	publishStaged := func(callback func(context.Context, storage.ResolverStager) (storage.PublishRequest, error)) error {
		_, err := store.PublishStaged(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update:    graphUpdate(t, "src/main.ts", "function:main"),
		}, callback)
		return err
	}
	stage := func(ctx context.Context, stager storage.ResolverStager) (storage.PublishRequest, error) {
		if err := stager.StageResolverSources(ctx, []storage.ResolverStageSource{{
			ProjectID: "project:fixture", Language: "typescript", SourcePath: "src/main.ts",
		}}); err != nil {
			return storage.PublishRequest{}, err
		}
		return storage.PublishRequest{
			Workspace: "workspace",
			Update:    graphUpdate(t, "src/main.ts", "function:main"),
		}, nil
	}
	if err := publishStaged(stage); err != nil {
		t.Fatalf("publish staged commit: %v", err)
	}
	if err := publishStaged(func(ctx context.Context, stager storage.ResolverStager) (storage.PublishRequest, error) {
		if err := stager.StageResolverSources(ctx, []storage.ResolverStageSource{{
			ProjectID: "project:fixture", Language: "typescript", SourcePath: "src/main.ts",
		}}); err != nil {
			return storage.PublishRequest{}, err
		}
		return storage.PublishRequest{}, errors.New("roll back temporary staging")
	}); err == nil {
		t.Fatal("publish staged rollback succeeded")
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}
	store, err = sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("reopen database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := publishStaged(stage); err != nil {
		t.Fatalf("publish staged after reopen: %v", err)
	}
}

func TestPublishStagedCancellationKeepsPriorSnapshotCurrent(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	published, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	})
	if err != nil {
		t.Fatalf("publish initial snapshot: %v", err)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = store.PublishStaged(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:replacement"),
	}, func(_ context.Context, stager storage.ResolverStager) (storage.PublishRequest, error) {
		return storage.PublishRequest{}, stager.StageResolverSources(canceled, []storage.ResolverStageSource{{
			ProjectID: "project:fixture", Language: "typescript", SourcePath: "src/main.ts",
		}})
	})
	if !errors.Is(err, context.Canceled) {
		t.Errorf("publish staged cancellation = %v, want context cancellation", err)
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace"})
	if err != nil {
		t.Fatalf("open current snapshot: %v", err)
	}
	if current != published {
		t.Errorf("current snapshot after staged cancellation = %+v, want %+v", current, published)
	}
}

func TestPublishBatchFailureKeepsPriorSnapshotCurrent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	published, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	})
	if err != nil {
		t.Fatalf("publish initial snapshot: %v", err)
	}
	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open verification database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if _, err := database.Exec(`
		CREATE TRIGGER fail_source_node_batch
		BEFORE INSERT ON contribution_nodes
		WHEN NEW.node_id = 'function:fail'
		BEGIN
			SELECT RAISE(ABORT, 'injected batch failure');
		END`); err != nil {
		t.Fatalf("create failure trigger: %v", err)
	}

	_, err = store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update: graphUpdateForSources(t,
			sourceFact{path: "src/one.ts", nodeID: "function:one"},
			sourceFact{path: "src/fail.ts", nodeID: "function:fail"},
		),
	})
	if err == nil {
		t.Fatal("publish with injected batch failure succeeded")
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace"})
	if err != nil {
		t.Fatalf("open current snapshot: %v", err)
	}
	if current != published {
		t.Errorf("current snapshot after batch failure = %+v, want %+v", current, published)
	}
}

func TestPublishManyContributionsKeepsAllFactsAvailable(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})

	sources := make([]sourceFact, 0, 128)
	for sourceIndex := 0; sourceIndex < cap(sources); sourceIndex++ {
		sources = append(sources, sourceFact{
			path:   fmt.Sprintf("src/module-%03d.ts", sourceIndex),
			nodeID: fmt.Sprintf("function:module-%03d", sourceIndex),
		})
	}
	snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: "workspace",
		Update:    graphUpdateForSources(t, sources...),
	})
	if err != nil {
		t.Fatalf("publish many source contributions: %v", err)
	}

	collector := &factCollector{}
	if err := store.Export(context.Background(), snapshot, storage.ExportRequest{}, collector); err != nil {
		t.Fatalf("export many source contributions: %v", err)
	}
	if len(collector.nodes) != len(sources) {
		t.Errorf("exported node count = %d, want %d", len(collector.nodes), len(sources))
	}
	for sourceIndex, node := range collector.nodes {
		want := fmt.Sprintf("function:module-%03d", sourceIndex)
		if node.ID != want {
			t.Errorf("exported node %d = %q, want %q", sourceIndex, node.ID, want)
		}
	}
}

func graphUpdate(t *testing.T, path, nodeID string) extractor.GraphUpdate {
	return graphUpdateForSources(t, sourceFact{path: path, nodeID: nodeID})
}

type sourceFact struct {
	path   string
	nodeID string
}

func graphUpdateForSources(t *testing.T, sourceFacts ...sourceFact) extractor.GraphUpdate {
	t.Helper()
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"function"}})
	if err != nil {
		t.Fatalf("create vocabulary: %v", err)
	}
	contributions := make([]extractor.Contribution, 0, len(sourceFacts))
	for _, source := range sourceFacts {
		contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
			SourcePath: source.path,
			Metadata:   extractor.Metadata{Name: "typescript", Version: "1", Extensions: []string{".ts"}},
			Facts: graph.Facts{Nodes: []graph.Node{{
				ID:   source.nodeID,
				Kind: "function",
				Evidence: graph.FactEvidence{
					Span:       graph.SourceSpan{Path: source.path, StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 5},
					FileHash:   "content-hash",
					Extractor:  "typescript@1",
					Provenance: "syntax",
					Confidence: graph.ConfidenceExtracted,
				},
			}}},
		})
		if err != nil {
			t.Fatalf("create contribution: %v", err)
		}
		contributions = append(contributions, contribution)
	}
	update, err := extractor.NewGraphUpdate(contributions)
	if err != nil {
		t.Fatalf("create graph update: %v", err)
	}
	return update
}

func graphUpdateWithDependency(t *testing.T, sourcePath, nodeID, dependencyPath string, exportedNames []string) extractor.GraphUpdate {
	t.Helper()
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"function"}})
	if err != nil {
		t.Fatalf("create vocabulary: %v", err)
	}
	surfaces := make([]extractor.ExportedSurface, 0, len(exportedNames))
	for _, name := range exportedNames {
		surfaces = append(surfaces, extractor.ExportedSurface{NodeID: nodeID, Name: name})
	}
	dependencies := make([]extractor.Dependency, 0, 1)
	if dependencyPath != "" {
		dependencies = append(dependencies, extractor.Dependency{SourcePath: sourcePath, TargetPath: dependencyPath})
	}
	contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
		SourcePath:       sourcePath,
		Metadata:         extractor.Metadata{Name: "typescript", Version: "1", Extensions: []string{".ts"}},
		Facts:            graph.Facts{Nodes: []graph.Node{graphNode(sourcePath, nodeID)}},
		ExportedSurfaces: surfaces,
		Dependencies:     dependencies,
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

func resolverProjectionUpdate(t *testing.T, projectID, sourcePath, nodeID, exportedName string) extractor.GraphUpdate {
	t.Helper()
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"function"}})
	if err != nil {
		t.Fatalf("create vocabulary: %v", err)
	}
	contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
		ProjectID:        projectID,
		SourcePath:       sourcePath,
		Metadata:         extractor.Metadata{Name: "typescript", Version: "1", Extensions: []string{".ts"}},
		Facts:            graph.Facts{Nodes: []graph.Node{graphNode(sourcePath, nodeID)}},
		ExportedSurfaces: []extractor.ExportedSurface{{NodeID: nodeID, Name: exportedName}},
	})
	if err != nil {
		t.Fatalf("create resolver projection contribution: %v", err)
	}
	update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
	if err != nil {
		t.Fatalf("create resolver projection update: %v", err)
	}
	return update
}

func graphUpdateWithFacts(t *testing.T, path string, facts graph.Facts) extractor.GraphUpdate {
	t.Helper()
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"project", "file", "function", "class"},
		Relations: []graph.RelationDefinition{
			{
				Kind: "contains",
				Endpoints: []graph.EndpointRule{
					{Source: "project", Target: "file"},
					{Source: "file", Target: "function"},
				},
			},
			{
				Kind: "calls",
				Endpoints: []graph.EndpointRule{{
					Source: "function",
					Target: "function",
				}},
			},
			{
				Kind: "references",
				Endpoints: []graph.EndpointRule{{
					Source: "function",
					Target: "function",
				}},
			},
		},
	})
	if err != nil {
		t.Fatalf("create vocabulary: %v", err)
	}
	contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
		SourcePath: path,
		Metadata:   extractor.Metadata{Name: "typescript", Version: "1", Extensions: []string{".ts"}},
		Facts:      facts,
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

func graphNode(path, nodeID string) graph.Node {
	return graph.Node{ID: nodeID, Kind: "function", Evidence: evidence(path)}
}

func evidence(path string) graph.FactEvidence {
	return graph.FactEvidence{
		Span:       graph.SourceSpan{Path: path, StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 5},
		FileHash:   "content-hash",
		Extractor:  "typescript@1",
		Provenance: "syntax",
		Confidence: graph.ConfidenceExtracted,
	}
}

type factCollector struct {
	nodes []graph.Node
	edges []graph.Edge
}

func (collector *factCollector) WriteNode(node graph.Node) error {
	collector.nodes = append(collector.nodes, node)
	return nil
}

func (collector *factCollector) WriteEdge(edge graph.Edge) error {
	collector.edges = append(collector.edges, edge)
	return nil
}
