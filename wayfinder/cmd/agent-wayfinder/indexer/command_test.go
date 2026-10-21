package indexer

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"agent-wayfinder/cmd/agent-wayfinder/catalog"
	indexcommand "agent-wayfinder/cmd/agent-wayfinder/index"
	serviceindexer "agent-wayfinder/indexer"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
	"agent-wayfinder/testkit"
)

func runIndexerCommand(t *testing.T, arguments []string, standardOutput, standardError *strings.Builder) int {
	t.Helper()
	exitCode := 0
	command := New(standardOutput, standardError, &exitCode)
	command.SetOut(standardOutput)
	command.SetErr(standardError)
	command.SetArgs(arguments)
	if err := command.Execute(); err != nil {
		t.Fatalf("run indexer command: %v", err)
	}
	return exitCode
}

func runIndexCommand(t *testing.T, arguments []string, standardOutput, standardError *strings.Builder) int {
	t.Helper()
	exitCode := 0
	command := indexcommand.New(standardOutput, standardError, &exitCode)
	command.SetOut(standardOutput)
	command.SetErr(standardError)
	command.SetArgs(arguments)
	if err := command.Execute(); err != nil {
		t.Fatalf("run index command: %v", err)
	}
	return exitCode
}

func runCatalogStatusCommand(t *testing.T, arguments []string, standardOutput, standardError *strings.Builder) int {
	t.Helper()
	exitCode := 0
	command := catalog.NewStatus(standardOutput, standardError, &exitCode)
	command.SetOut(standardOutput)
	command.SetErr(standardError)
	command.SetArgs(arguments)
	if err := command.Execute(); err != nil {
		t.Fatalf("run catalog-status command: %v", err)
	}
	return exitCode
}

func TestIndexerCommandHelpListsItsActions(t *testing.T) {
	standardOutput := &strings.Builder{}
	standardError := &strings.Builder{}

	if exitCode := runIndexerCommand(t, []string{"--help"}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run indexer help command: exit code %d, error %s", exitCode, standardError.String())
	}

	output := standardOutput.String()
	for _, action := range []string{"serve", "start", "status", "stop"} {
		if !strings.Contains(output, action) {
			t.Errorf("indexer help output = %q, want action %q", output, action)
		}
	}
}

func TestIndexerQueuesChangedPathCatalogStatus(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json": `{"name":"fixture"}`,
		"src/token.ts": "export function validateAccessToken(token: string) { return token.length > 0; }",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	standardOutput := &strings.Builder{}
	standardError := &strings.Builder{}
	if exitCode := runIndexCommand(t, []string{"--database", database, workspace.Root}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run index command: exit code %d, error %s", exitCode, standardError.String())
	}
	originalStartCatalogRefresh := startCatalogRefresh
	startCatalogRefresh = func(catalog.RefreshRequest) {}
	t.Cleanup(func() { startCatalogRefresh = originalStartCatalogRefresh })
	if err := newIndexerPublisher(database)(serviceindexer.Batch{Workspace: workspace.Root, Paths: []string{"src/token.ts"}}); err != nil {
		t.Fatalf("publish indexer batch: %v", err)
	}
	standardOutput.Reset()
	standardError.Reset()
	if exitCode := runCatalogStatusCommand(t, []string{"--format", "json", "--database", database, workspace.Root}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run catalog-status command: exit code %d, error %s", exitCode, standardError.String())
	}
	var envelope struct {
		Result struct {
			State        string   `json:"state"`
			ChangedPaths []string `json:"changedPaths"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(standardOutput.String()), &envelope); err != nil {
		t.Fatalf("decode catalog status: %v\n%s", err, standardOutput.String())
	}
	if envelope.Result.State != string(storage.CatalogTaskQueued) || !reflect.DeepEqual(envelope.Result.ChangedPaths, []string{"src/token.ts"}) {
		t.Errorf("catalog status = %+v, want queued changed-file refresh", envelope.Result)
	}
}

func TestIndexerPublisherSchedulesIncrementalCatalogRefreshAfterBatchPublication(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"go.mod":             "module example.com/fixture\n",
		"validator/token.go": "package validator\n\nfunc ValidateToken() error { return nil }\n",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	if exitCode := runIndexCommand(t, []string{"--database", database, workspace.Root}, &strings.Builder{}, &strings.Builder{}); exitCode != 0 {
		t.Fatalf("index workspace exit code = %d, want 0", exitCode)
	}

	refreshes := make(chan catalog.RefreshRequest, 1)
	previousStartCatalogRefresh := startCatalogRefresh
	startCatalogRefresh = func(request catalog.RefreshRequest) { refreshes <- request }
	t.Cleanup(func() { startCatalogRefresh = previousStartCatalogRefresh })
	workspace.WriteFile(t, "validator/token.go", "package validator\n\nfunc ValidateToken() error { return nil }\n")
	if err := newIndexerPublisher(database)(serviceindexer.Batch{Workspace: workspace.Root, Paths: []string{"validator/token.go"}}); err != nil {
		t.Fatalf("publish indexer batch: %v", err)
	}

	select {
	case request := <-refreshes:
		if request.PreviousSnapshot.Version != 1 || !reflect.DeepEqual(request.ChangedPaths, []string{"validator/token.go"}) {
			t.Errorf("catalog refresh request = %+v, want prior snapshot and changed path", request)
		}
	case <-time.After(time.Second):
		t.Fatal("indexer publisher did not schedule a catalog refresh")
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open graph store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	snapshot, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace.Root})
	if err != nil {
		t.Fatalf("open published batch snapshot: %v", err)
	}
	if snapshot.Version != 2 {
		t.Errorf("published batch snapshot version = %d, want 2", snapshot.Version)
	}
	sources, err := store.SourceContributions(context.Background(), snapshot)
	if err != nil || len(sources) != 1 {
		t.Fatalf("indexer sources = %v, error %v", sources, err)
	}
	if sources[0].CatalogUnitsCovered || len(sources[0].CatalogUnits) != 0 {
		t.Fatal("continuous indexing retained catalog units")
	}
}

func TestIndexerLifecycleCommandsControlBackgroundService(t *testing.T) {
	workspace, err := os.MkdirTemp("", "ag-")
	if err != nil {
		t.Fatalf("create short workspace path: %v", err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(workspace); err != nil {
			t.Errorf("remove workspace: %v", err)
		}
	})
	binary := filepath.Join(t.TempDir(), "agent-wayfinder")
	build := exec.Command("go", "build", "-o", binary, "..")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build command binary: %v\n%s", err, output)
	}
	request := func(arguments ...string) ([]byte, error) {
		return exec.Command(binary, arguments...).CombinedOutput()
	}

	output, err := request("indexer", "--format", "json", "start", workspace)
	if err != nil {
		t.Fatalf("start workspace indexer: %v\n%s", err, output)
	}
	var started struct {
		Workspace   string   `json:"workspace"`
		Running     bool     `json:"running"`
		QueuedPaths []string `json:"queuedPaths"`
	}
	if err := json.Unmarshal(output, &started); err != nil {
		t.Fatalf("decode started indexer status: %v\n%s", err, output)
	}
	if started.Workspace != workspace || !started.Running || started.QueuedPaths == nil {
		t.Errorf("started status = %+v, want running workspace with queued paths", started)
	}

	output, err = request("indexer", "--format", "json", "status", workspace)
	if err != nil {
		t.Fatalf("get workspace indexer status: %v\n%s", err, output)
	}
	var status map[string]any
	if err := json.Unmarshal(output, &status); err != nil {
		t.Fatalf("decode indexer status: %v\n%s", err, output)
	}
	for _, field := range []string{"workspace", "activity", "progress", "queuedPaths", "version", "error", "idleDeadline"} {
		if _, found := status[field]; !found {
			t.Errorf("status fields = %v, missing %q", status, field)
		}
	}

	output, err = request("indexer", "stop", workspace)
	if err != nil {
		t.Fatalf("stop workspace indexer: %v\n%s", err, output)
	}
	if _, err := request("indexer", "status", workspace); err == nil {
		t.Error("status after stop succeeded, want connection failure")
	}
}
