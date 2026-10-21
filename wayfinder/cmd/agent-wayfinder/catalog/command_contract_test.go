package catalog

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"agent-wayfinder/index"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
	"agent-wayfinder/testkit"
)

func indexWorkspace(t *testing.T, workspace, database string) storage.Snapshot {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(database), 0o755); err != nil {
		t.Fatalf("create catalog database directory: %v", err)
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open catalog database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	result, err := index.Index(context.Background(), store, index.Request{Root: workspace})
	if err != nil {
		t.Fatalf("index workspace: %v", err)
	}
	return result.Snapshot
}

func runCatalogCommand(t *testing.T, commandName string, arguments []string, standardOutput, standardError *bytes.Buffer) int {
	t.Helper()
	exitCode := 0
	var commandRunner interface {
		SetArgs([]string)
		Execute() error
	}
	if commandName == "catalog" {
		commandRunner = New(standardOutput, standardError, &exitCode)
	} else if commandName == "catalog-stop" {
		commandRunner = NewStop(standardOutput, standardError, &exitCode)
	} else {
		commandRunner = NewStatus(standardOutput, standardError, &exitCode)
	}
	commandRunner.SetArgs(arguments)
	if err := commandRunner.Execute(); err != nil {
		t.Fatalf("run %s command: %v", commandName, err)
	}
	return exitCode
}

func TestCatalogCommandRefreshesPublishedCatalogAndReportsRetrievalMethods(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"go.mod":             "module example.com/fixture\n",
		"validator/token.go": "package validator\n\nfunc ValidateToken(token string) error { return nil }\n",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	indexWorkspace(t, workspace.Root, database)

	output := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := runCatalogCommand(t, "catalog", []string{"--database", database, "--foreground", workspace.Root}, output, standardError); exitCode != 0 {
		t.Fatalf("catalog workspace exit code = %d, want 0; error %s", exitCode, standardError.String())
	}
	if !strings.Contains(standardError.String(), "Catalog progress: 1/1") {
		t.Errorf("catalog progress = %q, want unit progress", standardError.String())
	}
	if !strings.Contains(output.String(), "Retrieval methods: lexical") {
		t.Errorf("catalog output = %q, want lexical retrieval method", output.String())
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open graph store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	snapshot, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace.Root})
	if err != nil {
		t.Fatalf("open indexed snapshot: %v", err)
	}
	matches, err := store.SearchCatalog(context.Background(), snapshot, storage.CatalogSearchRequest{Text: "validate token", Limit: 10})
	if err != nil {
		t.Fatalf("search refreshed catalog: %v", err)
	}
	if len(matches) != 1 || matches[0].Entry.Name != "ValidateToken" {
		t.Errorf("refreshed catalog matches = %+v, want ValidateToken", matches)
	}
}

func TestCatalogWorkerDoesNotReportProgressToStandardError(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"go.mod":     "module example.com/fixture\n",
		"example.go": "package fixture\n\nfunc Example() {}\n",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	indexWorkspace(t, workspace.Root, database)

	output := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := runCatalogCommand(t, "catalog", []string{"--database", database, "--foreground", "--catalog-worker", workspace.Root}, output, standardError); exitCode != 0 {
		t.Fatalf("catalog worker exit code = %d, want 0; error %s", exitCode, standardError.String())
	}
	if standardError.Len() != 0 {
		t.Errorf("catalog worker standard error = %q, want empty", standardError.String())
	}
}

func TestCatalogUsesCurrentDirectoryWhenWorkspaceIsOmitted(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"go.mod":             "module example.com/fixture\n",
		"validator/token.go": "package validator\n\nfunc ValidateToken(token string) error { return nil }\n",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	indexWorkspace(t, workspace.Root, database)
	t.Chdir(workspace.Root)
	output := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := runCatalogCommand(t, "catalog", []string{"--database", database, "--foreground"}, output, standardError); exitCode != 0 {
		t.Fatalf("catalog current workspace exit code = %d, want 0; error %s", exitCode, standardError.String())
	}
	if !strings.Contains(output.String(), "Catalog units: 1") {
		t.Errorf("catalog output = %q, want catalog result", output.String())
	}
}

func TestCatalogCommandDetachesAndForwardsCatalogOptions(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"go.mod":             "module example.com/fixture\n",
		"validator/token.go": "package validator\n\nfunc ValidateToken(token string) error { return nil }\n",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	indexWorkspace(t, workspace.Root, database)
	previousStart := startDetachedCatalogProcess
	t.Cleanup(func() { startDetachedCatalogProcess = previousStart })
	requests := make(chan ProcessRequest, 1)
	startDetachedCatalogProcess = func(request ProcessRequest) error {
		requests <- request
		return nil
	}
	output := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := runCatalogCommand(t, "catalog", []string{"--database", database, "--catalog-synopsis-provider", "ollama", "--catalog-ollama-process-limit", "2", workspace.Root}, output, standardError); exitCode != 0 {
		t.Fatalf("detach catalog exit code = %d, want 0; error %s", exitCode, standardError.String())
	}
	select {
	case request := <-requests:
		if request.Database != database || request.Workspace != workspace.Root || !containsCatalogArgument(request.Arguments, "--catalog-synopsis-provider", "ollama") || !containsCatalogArgument(request.Arguments, "--catalog-ollama-process-limit", "2") {
			t.Errorf("detached catalog request = %+v, want workspace, database, and Ollama options", request)
		}
	case <-time.After(time.Second):
		t.Fatal("detached catalog process was not started")
	}
	if !strings.Contains(output.String(), "Catalog started in background") {
		t.Errorf("detach catalog output = %q, want background confirmation", output.String())
	}
}

func TestCatalogCommandRejectsDuplicateActiveTask(t *testing.T) {
	for _, state := range []storage.CatalogTaskState{storage.CatalogTaskQueued, storage.CatalogTaskRunning} {
		t.Run(string(state), func(t *testing.T) {
			workspace := testkit.NewWorkspace(t, map[string]string{
				"go.mod":             "module example.com/fixture\n",
				"validator/token.go": "package validator\n\nfunc ValidateToken(token string) error { return nil }\n",
			})
			database := filepath.Join(t.TempDir(), "state", "graph.db")
			snapshot := indexWorkspace(t, workspace.Root, database)
			store, err := sqlite.Open(context.Background(), database)
			if err != nil {
				t.Fatalf("open catalog database: %v", err)
			}
			if err := store.WriteCatalogTask(context.Background(), storage.CatalogTask{Workspace: workspace.Root, GraphVersion: snapshot.Version, State: state, ProcessID: 123, StartedAt: time.Now().UTC()}); err != nil {
				_ = store.Close()
				t.Fatalf("write active catalog task: %v", err)
			}
			if err := store.Close(); err != nil {
				t.Fatalf("close catalog database: %v", err)
			}
			previousStart := startDetachedCatalogProcess
			t.Cleanup(func() { startDetachedCatalogProcess = previousStart })
			started := false
			startDetachedCatalogProcess = func(ProcessRequest) error {
				started = true
				return nil
			}
			output := &bytes.Buffer{}
			standardError := &bytes.Buffer{}
			if exitCode := runCatalogCommand(t, "catalog", []string{"--database", database, workspace.Root}, output, standardError); exitCode == 0 {
				t.Fatal("duplicate catalog exit code = 0, want error")
			}
			if started || !strings.Contains(standardError.String(), "catalog already "+string(state)) {
				t.Errorf("duplicate catalog started = %t, error = %q, want rejected active task", started, standardError.String())
			}
		})
	}
}

func TestCatalogCommandDetachesWithAnEmptySynopsisProvider(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"go.mod":     "module example.com/fixture\n",
		"example.go": "package fixture\n\nfunc Example() {}\n",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	indexWorkspace(t, workspace.Root, database)
	previousStart := startDetachedCatalogProcess
	t.Cleanup(func() { startDetachedCatalogProcess = previousStart })
	requests := make(chan ProcessRequest, 1)
	startDetachedCatalogProcess = func(request ProcessRequest) error {
		requests <- request
		return nil
	}
	output := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := runCatalogCommand(t, "catalog", []string{"--database", database, "--catalog-synopsis-provider=", workspace.Root}, output, standardError); exitCode != 0 {
		t.Fatalf("detach catalog exit code = %d, want 0; error %s", exitCode, standardError.String())
	}
	select {
	case request := <-requests:
		if !slices.Contains(request.Arguments, "--catalog-synopsis-provider=") {
			t.Errorf("detached catalog arguments = %q, want empty synopsis provider option", request.Arguments)
		}
	case <-time.After(time.Second):
		t.Fatal("detached catalog process was not started")
	}
}

func TestCatalogCommandRecordsDetachedProcessStartupFailure(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"go.mod":     "module example.com/fixture\n",
		"example.go": "package fixture\n\nfunc Example() {}\n",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	indexWorkspace(t, workspace.Root, database)
	previousStart := startDetachedCatalogProcess
	t.Cleanup(func() { startDetachedCatalogProcess = previousStart })
	startDetachedCatalogProcess = func(ProcessRequest) error { return errors.New("permission denied") }
	output := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := runCatalogCommand(t, "catalog", []string{"--database", database, workspace.Root}, output, standardError); exitCode == 0 {
		t.Fatal("detach catalog exit code = 0, want startup failure")
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open catalog database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	task, found, err := store.ReadCatalogTask(context.Background(), workspace.Root)
	if err != nil {
		t.Fatalf("read catalog task: %v", err)
	}
	if !found || task.State != storage.CatalogTaskFailed || task.Failure != "permission denied" {
		t.Errorf("catalog task = %+v, want persisted startup failure", task)
	}
}

func TestCatalogStopMarksRunningTaskInterrupted(t *testing.T) {
	workspace := t.TempDir()
	database := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open catalog database: %v", err)
	}
	if err := store.WriteCatalogTask(context.Background(), storage.CatalogTask{
		Workspace: workspace, GraphVersion: 7, State: storage.CatalogTaskRunning, ProcessID: 123, StartedAt: time.Now().UTC(),
	}); err != nil {
		_ = store.Close()
		t.Fatalf("write running catalog task: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close catalog database: %v", err)
	}
	previousTerminate := terminateDetachedCatalogProcess
	t.Cleanup(func() { terminateDetachedCatalogProcess = previousTerminate })
	terminated := false
	terminateDetachedCatalogProcess = func(processID int, processWorkspace string) (bool, error) {
		terminated = processID == 123 && processWorkspace == workspace
		return true, nil
	}
	output := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	t.Chdir(workspace)
	if exitCode := runCatalogCommand(t, "catalog-stop", []string{"--database", database}, output, standardError); exitCode != 0 {
		t.Fatalf("catalog stop exit code = %d, want 0; error %s", exitCode, standardError.String())
	}
	if !terminated || !strings.Contains(output.String(), "Catalog stopped") {
		t.Errorf("catalog stop terminated = %t, output = %q, want termination confirmation", terminated, output.String())
	}
	store, err = sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("reopen catalog database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	task, found, err := store.ReadCatalogTask(context.Background(), workspace)
	if err != nil {
		t.Fatalf("read stopped catalog task: %v", err)
	}
	if !found || task.State != storage.CatalogTaskInterrupted || task.ProcessID != 0 {
		t.Errorf("stopped catalog task = %+v, want interrupted task without a process ID", task)
	}
}

func containsCatalogArgument(arguments []string, name, value string) bool {
	for _, argument := range arguments {
		if argument == name+"="+value {
			return true
		}
	}
	for index := 0; index+1 < len(arguments); index += 2 {
		if arguments[index] == name && arguments[index+1] == value {
			return true
		}
	}
	return false
}

func TestCatalogStatusReportsCompletedCatalogPass(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json": `{"name":"fixture"}`,
		"src/token.ts": "export function validateAccessToken(token: string) { return token.length > 0; }",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	standardOutput := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	indexWorkspace(t, workspace.Root, database)
	standardOutput.Reset()
	standardError.Reset()
	if exitCode := runCatalogCommand(t, "catalog", []string{"--database", database, "--foreground", workspace.Root}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run catalog command: exit code %d, error %s", exitCode, standardError.String())
	}
	standardOutput.Reset()
	standardError.Reset()
	if exitCode := runCatalogCommand(t, "catalog-status", []string{"--format", "json", "--database", database, workspace.Root}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run catalog-status command: exit code %d, error %s", exitCode, standardError.String())
	}
	var envelope struct {
		Result struct {
			State          string               `json:"state"`
			GraphVersion   storage.GraphVersion `json:"graphVersion"`
			StartedAt      time.Time            `json:"startedAt"`
			Elapsed        time.Duration        `json:"elapsed"`
			CompletedUnits int                  `json:"completedUnits"`
			TotalUnits     int                  `json:"totalUnits"`
		} `json:"result"`
	}
	if err := json.Unmarshal(standardOutput.Bytes(), &envelope); err != nil {
		t.Fatalf("decode catalog status: %v\n%s", err, standardOutput.String())
	}
	result := envelope.Result
	if result.State != "complete" || result.GraphVersion == 0 || result.StartedAt.IsZero() || result.Elapsed < 0 || result.TotalUnits == 0 || result.CompletedUnits != result.TotalUnits {
		t.Errorf("catalog status = %+v, want completed catalog task details", result)
	}
}

func TestCatalogStatusReportsOneShotCatalogSetupFailure(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json":                 `{"name":"fixture"}`,
		"src/token.ts":                 "export function validateAccessToken(token: string) { return token.length > 0; }",
		".agent-wayfinder/config.json": "{",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	standardOutput := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	indexWorkspace(t, workspace.Root, database)
	standardOutput.Reset()
	standardError.Reset()
	if exitCode := runCatalogCommand(t, "catalog", []string{"--database", database, "--foreground", workspace.Root}, standardOutput, standardError); exitCode == 0 {
		t.Fatal("run catalog command: exit code 0, want configuration failure")
	}
	standardOutput.Reset()
	standardError.Reset()
	if exitCode := runCatalogCommand(t, "catalog-status", []string{"--format", "json", "--database", database, workspace.Root}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run catalog-status command: exit code %d, error %s", exitCode, standardError.String())
	}
	var envelope struct {
		Result struct {
			State   string `json:"state"`
			Failure string `json:"failure"`
		} `json:"result"`
	}
	if err := json.Unmarshal(standardOutput.Bytes(), &envelope); err != nil {
		t.Fatalf("decode catalog status: %v\n%s", err, standardOutput.String())
	}
	if envelope.Result.State != string(storage.CatalogTaskFailed) || envelope.Result.Failure == "" {
		t.Errorf("catalog status = %+v, want failed one-shot catalog setup", envelope.Result)
	}
}

func TestCatalogStatusReportsRunningTaskProgress(t *testing.T) {
	workspace := t.TempDir()
	database := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open catalog database: %v", err)
	}
	if err := store.WriteCatalogTask(context.Background(), storage.CatalogTask{
		Workspace:      workspace,
		GraphVersion:   7,
		State:          storage.CatalogTaskRunning,
		ProcessID:      123,
		StartedAt:      time.Now().UTC(),
		CompletedUnits: 2,
		TotalUnits:     4,
		Stage:          "Generating catalog synopses",
	}); err != nil {
		_ = store.Close()
		t.Fatalf("write running catalog task: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close catalog database: %v", err)
	}
	standardOutput := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := runCatalogCommand(t, "catalog-status", []string{"--format", "json", "--database", database, workspace}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run catalog-status command: exit code %d, error %s", exitCode, standardError.String())
	}
	var envelope struct {
		Result struct {
			State          string `json:"state"`
			ProcessID      int    `json:"processId"`
			CompletedUnits int    `json:"completedUnits"`
			TotalUnits     int    `json:"totalUnits"`
			Processing     string `json:"processing"`
		} `json:"result"`
	}
	if err := json.Unmarshal(standardOutput.Bytes(), &envelope); err != nil {
		t.Fatalf("decode catalog status: %v\n%s", err, standardOutput.String())
	}
	if envelope.Result.State != string(storage.CatalogTaskRunning) || envelope.Result.ProcessID != 123 || envelope.Result.CompletedUnits != 2 || envelope.Result.TotalUnits != 4 || envelope.Result.Processing != "Generating catalog synopses" {
		t.Errorf("catalog status = %+v, want running task progress", envelope.Result)
	}
}

func TestCatalogStatusUsesCurrentDirectoryWhenWorkspaceIsOmitted(t *testing.T) {
	workspace := t.TempDir()
	database := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open catalog database: %v", err)
	}
	if err := store.WriteCatalogTask(context.Background(), storage.CatalogTask{
		Workspace: workspace, GraphVersion: 7, State: storage.CatalogTaskRunning, ProcessID: 123, StartedAt: time.Now().UTC(), TotalUnits: 4,
	}); err != nil {
		_ = store.Close()
		t.Fatalf("write running catalog task: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close catalog database: %v", err)
	}
	t.Chdir(workspace)
	standardOutput := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := runCatalogCommand(t, "catalog-status", []string{"--format", "json", "--database", database}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run catalog-status command: exit code %d, error %s", exitCode, standardError.String())
	}
	var envelope struct {
		Result struct {
			Workspace  string `json:"workspace"`
			Processing string `json:"processing"`
		} `json:"result"`
	}
	if err := json.Unmarshal(standardOutput.Bytes(), &envelope); err != nil {
		t.Fatalf("decode catalog status: %v\n%s", err, standardOutput.String())
	}
	if envelope.Result.Workspace != workspace || envelope.Result.Processing != "catalog unit 1 of 4" {
		t.Errorf("catalog status = %+v, want current workspace and active unit", envelope.Result)
	}
}

func TestCatalogStatusMarksLegacyRunningTaskInterrupted(t *testing.T) {
	workspace := t.TempDir()
	database := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open catalog database: %v", err)
	}
	if err := store.WriteCatalogTask(context.Background(), storage.CatalogTask{
		Workspace: workspace, GraphVersion: 7, State: storage.CatalogTaskRunning, StartedAt: time.Now().UTC(), CompletedUnits: 2, TotalUnits: 4,
	}); err != nil {
		_ = store.Close()
		t.Fatalf("write legacy running catalog task: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close catalog database: %v", err)
	}
	standardOutput := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := runCatalogCommand(t, "catalog-status", []string{"--format", "json", "--database", database, workspace}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run catalog-status command: exit code %d, error %s", exitCode, standardError.String())
	}
	var envelope struct {
		Result struct {
			State   string `json:"state"`
			Failure string `json:"failure"`
		} `json:"result"`
	}
	if err := json.Unmarshal(standardOutput.Bytes(), &envelope); err != nil {
		t.Fatalf("decode catalog status: %v\n%s", err, standardOutput.String())
	}
	if envelope.Result.State != string(storage.CatalogTaskInterrupted) || envelope.Result.Failure == "" {
		t.Errorf("catalog status = %+v, want interrupted legacy task", envelope.Result)
	}
}

func TestCatalogStatusDoesNotChangePIDBackedRunningTask(t *testing.T) {
	workspace := t.TempDir()
	database := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open catalog database: %v", err)
	}
	if err := store.WriteCatalogTask(context.Background(), storage.CatalogTask{
		Workspace: workspace, GraphVersion: 7, State: storage.CatalogTaskRunning, ProcessID: 123, StartedAt: time.Now().UTC(), TotalUnits: 4,
	}); err != nil {
		_ = store.Close()
		t.Fatalf("write running catalog task: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close catalog database: %v", err)
	}
	standardOutput := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := runCatalogCommand(t, "catalog-status", []string{"--format", "json", "--database", database, workspace}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run catalog-status command: exit code %d, error %s", exitCode, standardError.String())
	}
	var envelope struct {
		Result struct {
			State     string `json:"state"`
			ProcessID int    `json:"processId"`
			Failure   string `json:"failure"`
		} `json:"result"`
	}
	if err := json.Unmarshal(standardOutput.Bytes(), &envelope); err != nil {
		t.Fatalf("decode catalog status: %v\n%s", err, standardOutput.String())
	}
	if envelope.Result.State != string(storage.CatalogTaskRunning) || envelope.Result.ProcessID != 123 || envelope.Result.Failure != "" {
		t.Errorf("catalog status = %+v, want unchanged running process", envelope.Result)
	}
	store, err = sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("reopen catalog database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	task, found, err := store.ReadCatalogTask(context.Background(), workspace)
	if err != nil {
		t.Fatalf("read catalog task: %v", err)
	}
	if !found || task.State != storage.CatalogTaskRunning || task.ProcessID != 123 {
		t.Errorf("catalog task = %+v, want unchanged running task", task)
	}
}

func TestFormatCatalogStatusShowsLiveProcessUsage(t *testing.T) {
	status := formatCatalogStatusText(catalogStatusData{
		Workspace:      "workspace",
		State:          string(storage.CatalogTaskRunning),
		GraphVersion:   7,
		ProcessID:      123,
		Processing:     "catalog unit 3 of 4",
		StartedAt:      time.Date(2026, time.September, 25, 10, 0, 0, 0, time.UTC),
		Elapsed:        time.Second,
		CompletedUnits: 2,
		TotalUnits:     4,
		Usage:          &catalogProcessUsage{CPUPercent: 12.5, ResidentMemoryBytes: 3 * 1024 * 1024},
	})
	for _, want := range []string{"Process", "PID 123", "Processing", "catalog unit 3 of 4", "Catalog client CPU", "12.5%", "Catalog client memory", "3.0 MiB"} {
		if !strings.Contains(status, want) {
			t.Errorf("catalog status output = %q, want %q", status, want)
		}
	}
}

func TestFormatCatalogStatusShowsUnavailableLiveProcessUsage(t *testing.T) {
	status := formatCatalogStatusText(catalogStatusData{
		Workspace:    "workspace",
		State:        string(storage.CatalogTaskRunning),
		GraphVersion: 7,
		ProcessID:    123,
		StartedAt:    time.Date(2026, time.September, 25, 10, 0, 0, 0, time.UTC),
	})
	for _, want := range []string{"Catalog client CPU", "Catalog client memory", "unavailable"} {
		if !strings.Contains(status, want) {
			t.Errorf("catalog status output = %q, want %q", status, want)
		}
	}
}

func TestReadCatalogProcessUsageReadsLiveProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not support catalog process usage sampling")
	}
	usage := readCatalogProcessUsage(os.Getpid())
	if usage == nil || usage.CPUPercent < 0 || usage.ResidentMemoryBytes == 0 {
		t.Errorf("catalog process usage = %+v, want live process usage", usage)
	}
}

func TestCatalogStatusShowsNotStartedState(t *testing.T) {
	workspace := t.TempDir()
	database := filepath.Join(t.TempDir(), "graph.db")
	standardOutput := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := runCatalogCommand(t, "catalog-status", []string{"--format", "json", "--database", database, workspace}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run catalog-status command: exit code %d, error %s", exitCode, standardError.String())
	}
	var envelope struct {
		Result struct {
			State string `json:"state"`
		} `json:"result"`
	}
	if err := json.Unmarshal(standardOutput.Bytes(), &envelope); err != nil {
		t.Fatalf("decode catalog status: %v\n%s", err, standardOutput.String())
	}
	if envelope.Result.State != "not_started" {
		t.Errorf("catalog status = %+v, want not-started state", envelope.Result)
	}
}

func TestCatalogStatusFormatsFailedChangedFilePass(t *testing.T) {
	workspace := t.TempDir()
	database := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open catalog database: %v", err)
	}
	startedAt := time.Date(2026, time.March, 8, 12, 0, 0, 0, time.UTC)
	if err := store.WriteCatalogTask(context.Background(), storage.CatalogTask{
		Workspace:      workspace,
		GraphVersion:   7,
		State:          storage.CatalogTaskFailed,
		StartedAt:      startedAt,
		FinishedAt:     startedAt.Add(2 * time.Second),
		CompletedUnits: 1,
		TotalUnits:     2,
		ChangedPaths:   []string{"src/token.ts"},
		Failure:        "catalog configuration is invalid",
	}); err != nil {
		_ = store.Close()
		t.Fatalf("write failed catalog task: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close catalog database: %v", err)
	}
	standardOutput := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := runCatalogCommand(t, "catalog-status", []string{"--database", database, workspace}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run catalog-status command: exit code %d, error %s", exitCode, standardError.String())
	}
	for _, want := range []string{
		"Capability Catalog Status",
		"FIELD",
		"VALUE",
		"State",
		"Failed",
		workspace,
		"Graph version",
		"7",
		"Started",
		"2026-03-08T12:00:00Z",
		"Elapsed",
		"2s",
		"Progress",
		"1/2 catalog units",
		"Scope",
		"1 changed files",
		"Failure",
		"catalog configuration is invalid",
	} {
		if !strings.Contains(standardOutput.String(), want) {
			t.Errorf("catalog status output = %q, want %q", standardOutput.String(), want)
		}
	}
}

func TestCatalogWorkspaceArgumentUsesCurrentDirectoryAndRejectsExtraPaths(t *testing.T) {
	workspace, err := catalogWorkspaceArgument("catalog", nil)
	if err != nil || workspace != "." {
		t.Errorf("catalog workspace argument = %q, %v; want current directory", workspace, err)
	}
	if _, err := catalogWorkspaceArgument("catalog", []string{"one", "two"}); err == nil || !strings.Contains(err.Error(), "accepts at most one workspace path") {
		t.Errorf("catalog workspace argument error = %v, want an extra-path error", err)
	}
}

func TestCatalogCommandRejectsWorkspaceWithoutPublishedGraph(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"go.mod":             "module example.com/fixture\n",
		"validator/token.go": "package validator\n\nfunc ValidateToken(token string) error { return nil }\n",
	})
	output := &bytes.Buffer{}
	standardError := &bytes.Buffer{}

	if exitCode := runCatalogCommand(t, "catalog", []string{"--database", filepath.Join(t.TempDir(), "graph.db"), "--foreground", workspace.Root}, output, standardError); exitCode != 1 {
		t.Errorf("catalog exit code = %d, want 1", exitCode)
	}
	if !strings.Contains(standardError.String(), "no published graph is available") {
		t.Errorf("catalog error = %q, want missing published graph error", standardError.String())
	}
}
