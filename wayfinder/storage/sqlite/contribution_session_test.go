package sqlite_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"

	_ "github.com/arcmantle/go-sqlite3"
)

func TestContributionSessionCommitPublishesOneCompleteSnapshot(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	session, err := store.BeginContributionSession(context.Background(), workspace)
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}

	contribution := sessionContribution(t, "src/main.ts", "function:main")
	stageSessionSource(t, session, contribution.SourcePath())
	if err := session.WriteContribution(context.Background(), contribution); err != nil {
		t.Fatalf("write contribution: %v", err)
	}

	if _, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace}); !errors.Is(err, storage.ErrWorkspaceNotFound) {
		t.Errorf("open snapshot before commit = %v, want workspace not found", err)
	}

	snapshot, err := session.Commit(context.Background(), storage.CommitRequest{})
	if err != nil {
		t.Fatalf("commit contribution session: %v", err)
	}
	if snapshot.Workspace != workspace || snapshot.Version != 1 {
		t.Errorf("committed snapshot = %+v, want workspace %q version 1", snapshot, workspace)
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace})
	if err != nil {
		t.Fatalf("open snapshot after commit: %v", err)
	}
	if current != snapshot {
		t.Errorf("current snapshot after commit = %+v, want %+v", current, snapshot)
	}
	matches, err := store.SearchNodes(context.Background(), current, storage.LexicalSearchRequest{Text: "main", Limit: 10})
	if err != nil {
		t.Fatalf("search committed lexical snapshot: %v", err)
	}
	if len(matches) != 1 || matches[0].Node.ID != "function:main" {
		t.Errorf("committed lexical matches = %+v, want function:main", matches)
	}

	target, found, err := store.ResolverTarget(context.Background(), current, extractor.ResolverTargetRequest{
		ProjectID:  "project:fixture",
		Language:   "typescript",
		SourcePath: "src/main.ts",
	})
	if err != nil {
		t.Fatalf("read resolver target: %v", err)
	}
	if !found {
		t.Fatal("resolver target for committed contribution was not found")
	}
	if !hasNodeKind(target.Nodes, "function") {
		t.Errorf("resolver target nodes = %+v, want function node", target.Nodes)
	}
}

func TestContributionSessionCommitClosesContributionsMissingFromStagedSources(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	initialUpdate, err := extractor.NewGraphUpdate([]extractor.Contribution{
		sessionContribution(t, "src/main.ts", "function:main"),
		sessionContribution(t, "src/deleted.ts", "function:deleted"),
	})
	if err != nil {
		t.Fatalf("create initial graph update: %v", err)
	}
	prior, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: workspace, Update: initialUpdate})
	if err != nil {
		t.Fatalf("publish initial snapshot: %v", err)
	}

	session, err := store.BeginContributionSession(context.Background(), workspace)
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	if err := session.StageSource(context.Background(), "src/main.ts"); err != nil {
		t.Fatalf("stage retained source: %v", err)
	}
	if err := session.WriteContribution(context.Background(), sessionContribution(t, "src/main.ts", "function:updated")); err != nil {
		t.Fatalf("write retained contribution: %v", err)
	}

	beforeCommit, err := store.SourceContributions(context.Background(), prior)
	if err != nil {
		t.Fatalf("read prior contributions before commit: %v", err)
	}
	if len(beforeCommit) != 2 {
		t.Fatalf("prior contributions before commit = %d, want 2", len(beforeCommit))
	}

	current, err := session.Commit(context.Background(), storage.CommitRequest{})
	if err != nil {
		t.Fatalf("commit replacement snapshot: %v", err)
	}
	afterCommit, err := store.SourceContributions(context.Background(), current)
	if err != nil {
		t.Fatalf("read replacement contributions: %v", err)
	}
	if len(afterCommit) != 1 || afterCommit[0].SourcePath != "src/main.ts" {
		t.Errorf("replacement contributions = %+v, want only src/main.ts", afterCommit)
	}
}

func TestContributionSessionStagedSourceDoesNotRequireContributionWrite(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	prior, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: workspace,
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	})
	if err != nil {
		t.Fatalf("publish initial snapshot: %v", err)
	}
	session, err := store.BeginContributionSession(context.Background(), workspace)
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	stageSessionSource(t, session, "src/main.ts")
	current, err := session.Commit(context.Background(), storage.CommitRequest{})
	if err != nil {
		t.Fatalf("commit staged source without contribution: %v", err)
	}
	if current.Version != prior.Version+1 {
		t.Errorf("replacement version = %d, want %d", current.Version, prior.Version+1)
	}
	contributions, err := store.SourceContributions(context.Background(), current)
	if err != nil {
		t.Fatalf("read replacement contributions: %v", err)
	}
	if len(contributions) != 1 || contributions[0].SourcePath != "src/main.ts" {
		t.Errorf("replacement contributions = %+v, want retained src/main.ts", contributions)
	}
}

func TestContributionSessionCommitDoesNotRetainContributionsInMemory(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	session, err := store.BeginContributionSession(context.Background(), "workspace")
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	for index := 0; index < 128; index++ {
		sourcePath := fmt.Sprintf("src/file-%03d.ts", index)
		nodeID := fmt.Sprintf("function:file-%03d", index)
		stageSessionSource(t, session, sourcePath)
		if err := session.WriteContribution(context.Background(), sessionContribution(t, sourcePath, nodeID)); err != nil {
			t.Fatalf("write contribution %d: %v", index, err)
		}
	}
	snapshot, err := session.Commit(context.Background(), storage.CommitRequest{})
	if err != nil {
		t.Fatalf("commit contribution session: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}

	if contributions, err := store.SourceContributions(context.Background(), snapshot); err == nil {
		t.Fatalf("read %d contributions from closed store, want database error", len(contributions))
	}
}

func TestContributionSessionSourceContributionsReadSQLiteAfterCommitAndReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}

	initial, err := sessionContribution(t, "src/main.ts", "function:main").WithDependencies([]extractor.Dependency{{
		SourcePath: "src/main.ts",
		TargetPath: "src/old.ts",
	}})
	if err != nil {
		t.Fatalf("create initial dependency: %v", err)
	}
	update, err := extractor.NewGraphUpdate([]extractor.Contribution{initial})
	if err != nil {
		t.Fatalf("create initial graph update: %v", err)
	}
	prior, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: "workspace", Update: update})
	if err != nil {
		t.Fatalf("publish initial contribution: %v", err)
	}

	session, err := store.BeginContributionSession(context.Background(), "workspace")
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	staged, err := sessionContribution(t, "src/main.ts", "function:updated").WithDependencies([]extractor.Dependency{{
		SourcePath: "src/main.ts",
		TargetPath: "src/staged.ts",
	}})
	if err != nil {
		t.Fatalf("create staged dependency: %v", err)
	}
	stageSessionSource(t, session, staged.SourcePath())
	if err := session.WriteContribution(context.Background(), staged); err != nil {
		t.Fatalf("write contribution: %v", err)
	}
	if err := session.SealContributions(context.Background()); err != nil {
		t.Fatalf("seal contributions: %v", err)
	}
	replacement, err := staged.WithDependencies([]extractor.Dependency{{
		SourcePath: "src/main.ts",
		TargetPath: "src/final.ts",
	}})
	if err != nil {
		t.Fatalf("create replacement dependency: %v", err)
	}
	if err := session.ReplaceContributionDependencies(context.Background(), []extractor.Contribution{replacement}); err != nil {
		t.Fatalf("replace contribution dependencies: %v", err)
	}

	beforeCommit, err := store.SourceContributions(context.Background(), prior)
	if err != nil {
		t.Fatalf("read prior contributions before commit: %v", err)
	}
	if got := beforeCommit[0].Dependencies[0].TargetPath; got != "src/old.ts" {
		t.Errorf("prior dependency before commit = %q, want %q", got, "src/old.ts")
	}

	current, err := session.Commit(context.Background(), storage.CommitRequest{})
	if err != nil {
		t.Fatalf("commit contribution session: %v", err)
	}
	afterCommit, err := store.SourceContributions(context.Background(), current)
	if err != nil {
		t.Fatalf("read current contributions after commit: %v", err)
	}
	if got := afterCommit[0].Dependencies[0].TargetPath; got != "src/final.ts" {
		t.Errorf("current dependency after commit = %q, want %q", got, "src/final.ts")
	}
	afterCommit[0].Dependencies[0].TargetPath = "mutated"
	secondRead, err := store.SourceContributions(context.Background(), current)
	if err != nil {
		t.Fatalf("read current contributions again: %v", err)
	}
	if got := secondRead[0].Dependencies[0].TargetPath; got != "src/final.ts" {
		t.Errorf("current dependency after caller mutation = %q, want %q", got, "src/final.ts")
	}

	if err := store.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}
	reopened, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("reopen database: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	restored, err := reopened.SourceContributions(context.Background(), current)
	if err != nil {
		t.Fatalf("read reopened contributions: %v", err)
	}
	if got := restored[0].Dependencies[0].TargetPath; got != "src/final.ts" {
		t.Errorf("reopened dependency = %q, want %q", got, "src/final.ts")
	}
}

func TestContributionSessionCommitReportsStagedTransactionMeasurement(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	session, err := store.BeginContributionSession(context.Background(), "workspace")
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	stageSessionSource(t, session, "src/main.ts")
	if err := session.WriteContribution(context.Background(), sessionContribution(t, "src/main.ts", "function:main")); err != nil {
		t.Fatalf("write contribution: %v", err)
	}

	measurements := make([]storage.PublishMeasurement, 0, 2)
	_, err = session.Commit(context.Background(), storage.CommitRequest{
		Measurement: func(measurement storage.PublishMeasurement) {
			measurements = append(measurements, measurement)
		},
	})
	if err != nil {
		t.Fatalf("commit contribution session: %v", err)
	}

	wantNames := []string{"commit", "staged_transaction"}
	if len(measurements) != len(wantNames) {
		t.Fatalf("measurements = %+v, want %d measurements", measurements, len(wantNames))
	}
	for measurementIndex, want := range wantNames {
		if measurements[measurementIndex].Name != want {
			t.Errorf("measurement %d name = %q, want %q", measurementIndex, measurements[measurementIndex].Name, want)
		}
		if measurements[measurementIndex].Duration < 0 {
			t.Errorf("measurement %q duration = %s, want non-negative", want, measurements[measurementIndex].Duration)
		}
	}
	if measurements[1].Duration < measurements[0].Duration {
		t.Errorf("staged_transaction duration = %s, want at least commit duration %s", measurements[1].Duration, measurements[0].Duration)
	}
}

func TestContributionSessionCommitReportsBatchedSQLiteWriteMeasurements(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	session, err := store.BeginContributionSession(context.Background(), "workspace")
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	stageSessionSource(t, session, "src/main.ts")
	if err := session.WriteContribution(context.Background(), sessionContribution(t, "src/main.ts", "function:main")); err != nil {
		t.Fatalf("write contribution: %v", err)
	}
	if err := session.SealContributions(context.Background()); err != nil {
		t.Fatalf("seal contributions: %v", err)
	}

	measurements := make([]storage.PublishMeasurement, 0)
	if _, err := session.Commit(context.Background(), storage.CommitRequest{
		SQLiteWriteMeasurement: func(measurement storage.PublishMeasurement) {
			if measurement.Name == "file_contributions" || strings.HasPrefix(measurement.Name, "contribution_") {
				measurements = append(measurements, measurement)
			}
		},
	}); err != nil {
		t.Fatalf("commit contribution session: %v", err)
	}

	wantNames := []string{
		"file_contributions",
		"contribution_nodes",
		"contribution_edges",
		"contribution_catalog_units",
		"contribution_catalog_unit_coverage",
		"contribution_extensions",
		"contribution_dependencies",
		"contribution_exported_surfaces",
		"contribution_diagnostics",
		"contribution_unresolved_references",
		"contribution_module_bindings",
		"contribution_symbol_references",
	}
	applicable := map[string]bool{
		"file_contributions":                 true,
		"contribution_nodes":                 true,
		"contribution_catalog_unit_coverage": true,
		"contribution_extensions":            true,
	}
	if len(measurements) != len(wantNames) {
		t.Fatalf("SQLite write measurements = %+v, want names %v", measurements, wantNames)
	}
	for index, want := range wantNames {
		if measurements[index].Name != want {
			t.Errorf("SQLite write measurement %d = %q, want %q", index, measurements[index].Name, want)
		}
		if measurements[index].NotApplicable == applicable[want] {
			t.Errorf("SQLite write measurement %q not applicable = %t, want %t", want, measurements[index].NotApplicable, !applicable[want])
		}
		if applicable[want] && measurements[index].Duration < 0 {
			t.Errorf("SQLite write measurement %q duration = %s, want non-negative", want, measurements[index].Duration)
		}
	}
}

func TestContributionSessionRollbackLeavesPriorSnapshotCurrent(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	published, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: workspace,
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	})
	if err != nil {
		t.Fatalf("publish initial snapshot: %v", err)
	}

	session, err := store.BeginContributionSession(context.Background(), workspace)
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	stageSessionSource(t, session, "src/other.ts")
	if err := session.WriteContribution(context.Background(), sessionContribution(t, "src/other.ts", "function:other")); err != nil {
		t.Fatalf("write contribution: %v", err)
	}
	if err := session.Rollback(context.Background()); err != nil {
		t.Fatalf("rollback contribution session: %v", err)
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace})
	if err != nil {
		t.Fatalf("open current snapshot: %v", err)
	}
	if current != published {
		t.Errorf("current snapshot after rollback = %+v, want %+v", current, published)
	}

	_, found, err := store.ResolverTarget(context.Background(), current, extractor.ResolverTargetRequest{
		ProjectID:  "project:fixture",
		Language:   "typescript",
		SourcePath: "src/other.ts",
	})
	if err != nil {
		t.Fatalf("read resolver target: %v", err)
	}
	if found {
		t.Error("resolver target exposes rolled back contribution")
	}
}

func TestContributionSessionDeletionStagingRollbackRemovesTemporarySources(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	initialUpdate, err := extractor.NewGraphUpdate([]extractor.Contribution{
		sessionContribution(t, "src/main.ts", "function:main"),
		sessionContribution(t, "src/other.ts", "function:other"),
	})
	if err != nil {
		t.Fatalf("create initial graph update: %v", err)
	}
	prior, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: workspace, Update: initialUpdate})
	if err != nil {
		t.Fatalf("publish initial snapshot: %v", err)
	}

	session, err := store.BeginContributionSession(context.Background(), workspace)
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	stageSessionSource(t, session, "src/main.ts")
	if err := session.Rollback(context.Background()); err != nil {
		t.Fatalf("rollback deletion staging: %v", err)
	}
	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace})
	if err != nil {
		t.Fatalf("open snapshot after rollback: %v", err)
	}
	if current != prior {
		t.Errorf("snapshot after rollback = %+v, want %+v", current, prior)
	}
	contributions, err := store.SourceContributions(context.Background(), current)
	if err != nil {
		t.Fatalf("read contributions after rollback: %v", err)
	}
	if len(contributions) != 2 {
		t.Errorf("contributions after rollback = %d, want 2", len(contributions))
	}

	replacement, err := store.BeginContributionSession(context.Background(), workspace)
	if err != nil {
		t.Fatalf("begin replacement session: %v", err)
	}
	stageSessionSource(t, replacement, "src/main.ts")
	if err := replacement.Rollback(context.Background()); err != nil {
		t.Fatalf("rollback replacement session: %v", err)
	}
}

func TestContributionSessionWriteFailureLeavesPriorSnapshotCurrent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	published, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: workspace,
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
		CREATE TRIGGER fail_session_node_batch
		BEFORE INSERT ON contribution_nodes
		WHEN NEW.node_id = 'function:fail'
		BEGIN
			SELECT RAISE(ABORT, 'injected session write failure');
		END`); err != nil {
		t.Fatalf("create failure trigger: %v", err)
	}

	session, err := store.BeginContributionSession(context.Background(), workspace)
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	stageSessionSource(t, session, "src/fail.ts")
	if err := session.WriteContribution(context.Background(), sessionContribution(t, "src/fail.ts", "function:fail")); err != nil {
		t.Fatalf("buffer contribution: %v", err)
	}
	if err := session.SealContributions(context.Background()); err == nil {
		t.Fatal("seal contribution batch with injected failure succeeded")
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace})
	if err != nil {
		t.Fatalf("open current snapshot: %v", err)
	}
	if current != published {
		t.Errorf("current snapshot after write failure = %+v, want %+v", current, published)
	}
}

func TestContributionSessionCancellationKeepsPriorSnapshotCurrent(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	published, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: workspace,
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	})
	if err != nil {
		t.Fatalf("publish initial snapshot: %v", err)
	}

	session, err := store.BeginContributionSession(context.Background(), workspace)
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	stageSessionSource(t, session, "src/other.ts")
	if err := session.WriteContribution(canceled, sessionContribution(t, "src/other.ts", "function:other")); !errors.Is(err, context.Canceled) {
		t.Errorf("write canceled contribution = %v, want context cancellation", err)
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace})
	if err != nil {
		t.Fatalf("open current snapshot: %v", err)
	}
	if current != published {
		t.Errorf("current snapshot after cancellation = %+v, want %+v", current, published)
	}
}

func TestContributionSessionBatchCancellationStopsBeforeBuffering(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	session, err := store.BeginContributionSession(context.Background(), "workspace")
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	stageSessionSource(t, session, "src/main.ts")
	if err := session.WriteContribution(canceled, sessionContribution(t, "src/main.ts", "function:main")); !errors.Is(err, context.Canceled) {
		t.Fatalf("write canceled contribution = %v, want context cancellation", err)
	}
	if err := session.SealContributions(context.Background()); !errors.Is(err, storage.ErrInvalidRequest) {
		t.Fatalf("seal canceled session = %v, want invalid request", err)
	}
}

func TestContributionSessionResolverReadsSeeUncommittedContributions(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	session, err := store.BeginContributionSession(context.Background(), workspace)
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	stageSessionSource(t, session, "src/main.ts")
	if err := session.WriteContribution(context.Background(), sessionContribution(t, "src/main.ts", "function:main")); err != nil {
		t.Fatalf("write contribution: %v", err)
	}
	request := extractor.ResolverTargetRequest{
		ProjectID:  "project:fixture",
		Language:   "typescript",
		SourcePath: "src/main.ts",
	}
	if _, _, err := session.ResolverTarget(context.Background(), storage.Snapshot{Workspace: workspace}, request); !errors.Is(err, storage.ErrInvalidRequest) {
		t.Fatalf("read staged resolver target before seal = %v, want invalid request", err)
	}
	if err := session.SealContributions(context.Background()); err != nil {
		t.Fatalf("seal contributions: %v", err)
	}

	target, found, err := session.ResolverTarget(context.Background(), storage.Snapshot{Workspace: workspace}, request)
	if err != nil {
		t.Fatalf("read staged resolver target: %v", err)
	}
	if !found {
		t.Fatal("staged resolver target for uncommitted contribution was not found")
	}
	if !hasNodeKind(target.Nodes, "function") {
		t.Errorf("staged resolver target nodes = %+v, want function node", target.Nodes)
	}

	if _, err := session.Commit(context.Background(), storage.CommitRequest{}); err != nil {
		t.Fatalf("commit contribution session: %v", err)
	}
}

func TestContributionSessionSealIsIdempotentAndRejectsWrites(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	session, err := store.BeginContributionSession(context.Background(), "workspace")
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	stageSessionSource(t, session, "src/main.ts")
	if err := session.WriteContribution(context.Background(), sessionContribution(t, "src/main.ts", "function:main")); err != nil {
		t.Fatalf("write contribution: %v", err)
	}
	if err := session.SealContributions(context.Background()); err != nil {
		t.Fatalf("seal contributions: %v", err)
	}
	if err := session.SealContributions(context.Background()); err != nil {
		t.Fatalf("seal contributions again: %v", err)
	}
	if err := session.WriteContribution(context.Background(), sessionContribution(t, "src/other.ts", "function:other")); !errors.Is(err, storage.ErrInvalidRequest) {
		t.Fatalf("write contribution after seal = %v, want invalid request", err)
	}
	if _, err := session.Commit(context.Background(), storage.CommitRequest{}); err != nil {
		t.Fatalf("commit sealed contribution session: %v", err)
	}
}

func TestContributionSessionResolverOperationsRequireSeal(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	contribution := sessionContribution(t, "src/main.ts", "function:main")
	session, err := store.BeginContributionSession(context.Background(), workspace)
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	stageSessionSource(t, session, contribution.SourcePath())
	if err := session.WriteContribution(context.Background(), contribution); err != nil {
		t.Fatalf("write contribution: %v", err)
	}
	snapshot := storage.Snapshot{Workspace: workspace}
	if _, err := session.ResolverProjectionPage(context.Background(), snapshot, storage.ResolverProjectionPageRequest{ProjectID: "project:fixture", Language: "typescript", Limit: 1}); !errors.Is(err, storage.ErrInvalidRequest) {
		t.Errorf("read resolver projection before seal = %v, want invalid request", err)
	}
	if _, err := session.ResolverPackagePage(context.Background(), snapshot, extractor.ResolverPackagePageRequest{ProjectID: "project:fixture", Language: "typescript", PackagePath: ".", Limit: 1}); !errors.Is(err, storage.ErrInvalidRequest) {
		t.Errorf("read resolver package before seal = %v, want invalid request", err)
	}
	if err := session.ReplaceContributionDependencies(context.Background(), []extractor.Contribution{contribution}); !errors.Is(err, storage.ErrInvalidRequest) {
		t.Errorf("replace contribution dependencies before seal = %v, want invalid request", err)
	}
}

func TestContributionSessionKeepsReadersOnPriorSnapshotUntilCommit(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	published, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: workspace,
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	})
	if err != nil {
		t.Fatalf("publish initial snapshot: %v", err)
	}

	session, err := store.BeginContributionSession(context.Background(), workspace)
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	stageSessionSource(t, session, "src/other.ts")
	if err := session.WriteContribution(context.Background(), sessionContribution(t, "src/other.ts", "function:other")); err != nil {
		t.Fatalf("write contribution: %v", err)
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace})
	if err != nil {
		t.Fatalf("open current snapshot during session: %v", err)
	}
	if current != published {
		t.Errorf("current snapshot during session = %+v, want %+v", current, published)
	}
	_, found, err := store.ResolverTarget(context.Background(), current, extractor.ResolverTargetRequest{
		ProjectID:  "project:fixture",
		Language:   "typescript",
		SourcePath: "src/other.ts",
	})
	if err != nil {
		t.Fatalf("read current resolver target during session: %v", err)
	}
	if found {
		t.Error("current snapshot exposes an uncommitted contribution")
	}

	committed, err := session.Commit(context.Background(), storage.CommitRequest{})
	if err != nil {
		t.Fatalf("commit contribution session: %v", err)
	}
	current, err = store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace})
	if err != nil {
		t.Fatalf("open current snapshot after commit: %v", err)
	}
	if current != committed {
		t.Errorf("current snapshot after commit = %+v, want %+v", current, committed)
	}
}

func TestContributionSessionStreamsWorkspaceFactPagesIntoOneSnapshot(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	ctx := context.Background()
	workspace := "workspace"
	prior, err := store.Publish(ctx, storage.PublishRequest{
		Workspace: workspace,
		Update:    graphUpdate(t, "src/prior.ts", "function:prior"),
	})
	if err != nil {
		t.Fatalf("publish prior snapshot: %v", err)
	}

	session, err := store.BeginContributionSession(ctx, workspace)
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	for _, source := range []struct {
		path   string
		nodeID string
	}{
		{path: "src/main.ts", nodeID: "function:main"},
		{path: "src/helper.ts", nodeID: "function:helper"},
		{path: "src/other.ts", nodeID: "function:other"},
	} {
		stageSessionSource(t, session, source.path)
		if err := session.WriteContribution(ctx, sessionContribution(t, source.path, source.nodeID)); err != nil {
			t.Fatalf("write contribution %q: %v", source.path, err)
		}
	}
	if err := session.SealContributions(ctx); err != nil {
		t.Fatalf("seal contributions: %v", err)
	}

	mainCallsHelper := graph.Edge{SourceID: "function:main", TargetID: "function:helper", Relation: "calls", Evidence: graph.FactEvidence{Span: graph.SourceSpan{Path: "src/main.ts"}}}
	helperCallsOther := graph.Edge{SourceID: "function:helper", TargetID: "function:other", Relation: "calls", Evidence: graph.FactEvidence{Span: graph.SourceSpan{Path: "src/helper.ts"}}}
	if err := session.WriteWorkspaceFacts(ctx, graph.Facts{Edges: []graph.Edge{mainCallsHelper}}); err != nil {
		t.Fatalf("write first workspace fact page: %v", err)
	}
	if err := session.WriteWorkspaceFacts(ctx, graph.Facts{Edges: []graph.Edge{mainCallsHelper, helperCallsOther}}); err != nil {
		t.Fatalf("write second workspace fact page: %v", err)
	}
	sealedCounts, err := session.SealWorkspaceFacts(ctx)
	if err != nil {
		t.Fatalf("seal workspace facts: %v", err)
	}
	if sealedCounts != (storage.FactCounts{Edges: 2}) {
		t.Errorf("sealed workspace fact counts = %+v, want 0 nodes and 2 edges", sealedCounts)
	}

	current, err := store.OpenSnapshot(ctx, storage.OpenSnapshotRequest{Workspace: workspace})
	if err != nil {
		t.Fatalf("open current snapshot before commit: %v", err)
	}
	if current != prior {
		t.Errorf("current snapshot before commit = %+v, want prior %+v", current, prior)
	}

	committed, err := session.Commit(ctx, storage.CommitRequest{})
	if err != nil {
		t.Fatalf("commit streamed workspace facts: %v", err)
	}
	counts, err := store.FactCounts(ctx, committed)
	if err != nil {
		t.Fatalf("count committed facts: %v", err)
	}
	if counts != (storage.FactCounts{Nodes: 3, Edges: 2}) {
		t.Errorf("committed fact counts = %+v, want 3 nodes and 2 edges", counts)
	}
}

func TestContributionSessionWorkspaceFactPageRollbackKeepsPriorSnapshot(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	ctx := context.Background()
	workspace := "workspace"
	prior, err := store.Publish(ctx, storage.PublishRequest{
		Workspace: workspace,
		Update:    graphUpdate(t, "src/prior.ts", "function:prior"),
	})
	if err != nil {
		t.Fatalf("publish prior snapshot: %v", err)
	}

	session, err := store.BeginContributionSession(ctx, workspace)
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	for _, source := range []struct {
		path   string
		nodeID string
	}{
		{path: "src/main.ts", nodeID: "function:main"},
		{path: "src/helper.ts", nodeID: "function:helper"},
	} {
		stageSessionSource(t, session, source.path)
		if err := session.WriteContribution(ctx, sessionContribution(t, source.path, source.nodeID)); err != nil {
			t.Fatalf("write contribution %q: %v", source.path, err)
		}
	}
	if err := session.SealContributions(ctx); err != nil {
		t.Fatalf("seal contributions: %v", err)
	}
	if err := session.WriteWorkspaceFacts(ctx, graph.Facts{Edges: []graph.Edge{{
		SourceID: "function:main",
		TargetID: "function:helper",
		Relation: "calls",
		Evidence: graph.FactEvidence{Span: graph.SourceSpan{Path: "src/main.ts"}},
	}}}); err != nil {
		t.Fatalf("write workspace fact page: %v", err)
	}
	if err := session.Rollback(ctx); err != nil {
		t.Fatalf("rollback contribution session: %v", err)
	}

	current, err := store.OpenSnapshot(ctx, storage.OpenSnapshotRequest{Workspace: workspace})
	if err != nil {
		t.Fatalf("open current snapshot after rollback: %v", err)
	}
	if current != prior {
		t.Errorf("current snapshot after rollback = %+v, want prior %+v", current, prior)
	}
	counts, err := store.FactCounts(ctx, current)
	if err != nil {
		t.Fatalf("count prior facts after rollback: %v", err)
	}
	if counts != (storage.FactCounts{Nodes: 1}) {
		t.Errorf("fact counts after rollback = %+v, want only the prior node", counts)
	}
}

func TestContributionSessionSerializesCompetingPublishers(t *testing.T) {
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	workspace := "workspace"
	if _, err := store.Publish(context.Background(), storage.PublishRequest{
		Workspace: workspace,
		Update:    graphUpdate(t, "src/main.ts", "function:main"),
	}); err != nil {
		t.Fatalf("publish initial snapshot: %v", err)
	}

	session, err := store.BeginContributionSession(context.Background(), workspace)
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	stageSessionSource(t, session, "src/other.ts")
	if err := session.WriteContribution(context.Background(), sessionContribution(t, "src/other.ts", "function:other")); err != nil {
		t.Fatalf("write contribution: %v", err)
	}

	type publishResult struct {
		snapshot storage.Snapshot
		err      error
	}
	started := make(chan struct{})
	finished := make(chan publishResult, 1)
	go func() {
		close(started)
		snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
			Workspace: workspace,
			Update:    graphUpdate(t, "src/third.ts", "function:third"),
		})
		finished <- publishResult{snapshot: snapshot, err: err}
	}()
	<-started

	select {
	case result := <-finished:
		t.Fatalf("competing publisher finished before session commit: snapshot=%+v error=%v", result.snapshot, result.err)
	case <-time.After(100 * time.Millisecond):
	}

	committed, err := session.Commit(context.Background(), storage.CommitRequest{})
	if err != nil {
		t.Fatalf("commit contribution session: %v", err)
	}
	select {
	case result := <-finished:
		if result.err != nil {
			t.Fatalf("complete competing publisher: %v", result.err)
		}
		if result.snapshot.Version != committed.Version+1 {
			t.Errorf("competing snapshot version = %d, want %d", result.snapshot.Version, committed.Version+1)
		}
	case <-time.After(time.Second):
		t.Fatal("competing publisher did not finish after session commit")
	}
}

func stageSessionSource(t *testing.T, session storage.ContributionSession, sourcePath string) {
	t.Helper()
	if err := session.StageSource(context.Background(), sourcePath); err != nil {
		t.Fatalf("stage source %q: %v", sourcePath, err)
	}
}

func sessionContribution(t *testing.T, sourcePath, nodeID string) extractor.Contribution {
	t.Helper()
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"function"}})
	if err != nil {
		t.Fatalf("create vocabulary: %v", err)
	}
	contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
		ProjectID:  "project:fixture",
		SourcePath: sourcePath,
		Metadata:   extractor.Metadata{Name: "typescript", Version: "1", Extensions: []string{".ts"}},
		Facts: graph.Facts{Nodes: []graph.Node{{
			ID:   nodeID,
			Kind: "function",
			Evidence: graph.FactEvidence{
				Span:       graph.SourceSpan{Path: sourcePath, StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 5},
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
	return contribution
}
