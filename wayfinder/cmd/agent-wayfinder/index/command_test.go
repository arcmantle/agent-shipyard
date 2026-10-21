package index

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"agent-wayfinder/cmd/agent-wayfinder/catalog"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
	"agent-wayfinder/testkit"
)

func runIndexCommand(t *testing.T, arguments []string, standardOutput, standardError *strings.Builder) int {
	t.Helper()
	exitCode := 0
	command := New(standardOutput, standardError, &exitCode)
	command.SetOut(standardOutput)
	command.SetErr(standardError)
	command.SetArgs(arguments)
	if err := command.Execute(); err != nil {
		t.Fatalf("run index command: %v", err)
	}
	return exitCode
}

func runCatalogCommand(t *testing.T, arguments []string, standardOutput, standardError *strings.Builder) int {
	t.Helper()
	exitCode := 0
	command := catalog.New(standardOutput, standardError, &exitCode)
	command.SetOut(standardOutput)
	command.SetErr(standardError)
	command.SetArgs(arguments)
	if err := command.Execute(); err != nil {
		t.Fatalf("run catalog command: %v", err)
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

func TestIndexCommandHelpListsItsFlags(t *testing.T) {
	standardOutput := &strings.Builder{}
	standardError := &strings.Builder{}

	if exitCode := runIndexCommand(t, []string{"--help"}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run index help command: exit code %d, error %s", exitCode, standardError.String())
	}

	if output := standardOutput.String(); !strings.Contains(output, "--database") {
		t.Errorf("index help output = %q, want database flag", output)
	}
}

func TestIndexCommandPublishesWorkspaceGraph(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json": `{"name":"fixture"}`,
		"src/main.ts":  "export function main() { return 1; }",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")

	command := cliCommand("index", "--database", database, "--format", "json", workspace.Root)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("run index command: %v\n%s", err, output)
	}

	var result struct {
		GraphVersion int    `json:"graphVersion"`
		PublishedAt  string `json:"publishedAt"`
		Result       struct {
			Workspace string `json:"workspace"`
		} `json:"result"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatalf("decode index result: %v\n%s", err, output)
	}
	if result.GraphVersion != 1 {
		t.Errorf("graph version = %d, want 1", result.GraphVersion)
	}
	if result.PublishedAt == "" {
		t.Error("published time is empty")
	}
	if result.Result.Workspace != workspace.Root {
		t.Errorf("workspace = %q, want %q", result.Result.Workspace, workspace.Root)
	}
	if _, err := os.Stat(database); err != nil {
		t.Errorf("database %q does not exist: %v", database, err)
	}
}

func TestIndexCommandStartsLaterCatalogProcessAfterPublication(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"go.mod":             "module example.com/fixture\n",
		"validator/token.go": "package validator\n\nfunc ValidateToken() error { return nil }\n",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	previousStartCatalogProcess := startCatalogProcess
	started := make(chan catalog.ProcessRequest, 1)
	startCatalogProcess = func(request catalog.ProcessRequest) error {
		started <- request
		return nil
	}
	t.Cleanup(func() { startCatalogProcess = previousStartCatalogProcess })

	if exitCode := runIndexCommand(t, []string{"--database", database, workspace.Root}, &strings.Builder{}, &strings.Builder{}); exitCode != 0 {
		t.Fatalf("index workspace exit code = %d, want 0", exitCode)
	}
	select {
	case request := <-started:
		if request.Workspace != workspace.Root || request.Database != database {
			t.Errorf("catalog process request = %+v, want workspace %q and database %q", request, workspace.Root, database)
		}
	case <-time.After(time.Second):
		t.Fatal("index command did not start a later catalog process")
	}

	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open graph store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	snapshot, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace.Root})
	if err != nil {
		t.Fatalf("open published snapshot: %v", err)
	}
	if snapshot.Version != 1 {
		t.Errorf("published snapshot version = %d, want 1", snapshot.Version)
	}
	covered, err := store.CatalogUnitsCovered(context.Background(), snapshot)
	if err != nil || covered {
		t.Fatalf("background catalog coverage = %t, error %v", covered, err)
	}
	sources, err := store.SourceContributions(context.Background(), snapshot)
	if err != nil || len(sources) != 1 {
		t.Fatalf("background index sources = %v, error %v", sources, err)
	}
	if len(sources[0].CatalogUnits) != 0 {
		t.Fatal("background indexing retained catalog units without explicit retention")
	}
}

func TestIndexCommandCatalogRetentionIsExplicit(t *testing.T) {
	for _, settings := range []struct{ background, retain bool }{
		{false, false}, {false, true}, {true, false}, {true, true},
	} {
		t.Run(fmt.Sprintf("background-%t-retain-%t", settings.background, settings.retain), func(t *testing.T) {
			workspace := testkit.NewWorkspace(t, map[string]string{
				"package.json": `{"name":"fixture"}`,
				"src/main.ts":  "export function main() { return 1; }",
			})
			database := filepath.Join(t.TempDir(), "state", "graph.db")
			previousStartCatalogProcess := startCatalogProcess
			started := false
			startCatalogProcess = func(catalog.ProcessRequest) error { started = true; return nil }
			t.Cleanup(func() { startCatalogProcess = previousStartCatalogProcess })
			arguments := []string{fmt.Sprintf("--catalog-background=%t", settings.background), "--database", database, workspace.Root}
			if settings.retain {
				arguments = append(arguments, "--retain-catalog-units")
			}
			if exitCode := runIndexCommand(t, arguments, &strings.Builder{}, &strings.Builder{}); exitCode != 0 {
				t.Fatalf("index workspace exit code = %d, want 0", exitCode)
			}
			if started != settings.background {
				t.Errorf("catalog process started=%t, want %t", started, settings.background)
			}
			store, err := sqlite.Open(context.Background(), database)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = store.Close() })
			snapshot, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace.Root})
			if err != nil {
				t.Fatal(err)
			}
			sources, err := store.SourceContributions(context.Background(), snapshot)
			if err != nil || len(sources) != 1 {
				t.Fatalf("sources = %v, error %v", sources, err)
			}
			if sources[0].CatalogUnitsCovered != settings.retain || (len(sources[0].CatalogUnits) > 0) != settings.retain {
				t.Fatalf("catalog retention = %+v, want %t", sources[0], settings.retain)
			}
		})
	}
}

func TestIndexQueuesCatalogStatusWithoutDelayingPublication(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json": `{"name":"fixture"}`,
		"src/token.ts": "export function validateAccessToken(token: string) { return token.length > 0; }",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	originalStartCatalogProcess := startCatalogProcess
	startCatalogProcess = func(catalog.ProcessRequest) error { return nil }
	t.Cleanup(func() { startCatalogProcess = originalStartCatalogProcess })
	standardOutput := &strings.Builder{}
	standardError := &strings.Builder{}
	if exitCode := runIndexCommand(t, []string{"--database", database, workspace.Root}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run index command: exit code %d, error %s", exitCode, standardError.String())
	}
	standardOutput.Reset()
	standardError.Reset()
	if exitCode := runCatalogStatusCommand(t, []string{"--format", "json", "--database", database, workspace.Root}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run catalog-status command: exit code %d, error %s", exitCode, standardError.String())
	}
	var envelope struct {
		Result struct {
			State        string               `json:"state"`
			GraphVersion storage.GraphVersion `json:"graphVersion"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(standardOutput.String()), &envelope); err != nil {
		t.Fatalf("decode catalog status: %v\n%s", err, standardOutput.String())
	}
	if envelope.Result.State != string(storage.CatalogTaskQueued) || envelope.Result.GraphVersion == 0 {
		t.Errorf("catalog status = %+v, want queued task for published graph", envelope.Result)
	}
}

func TestIndexCommandWritesConfiguredOllamaEmbeddings(t *testing.T) {
	var model string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/generate" {
			return
		}
		if request.URL.Path != "/api/embed" {
			t.Errorf("Ollama request path = %q, want /api/embed", request.URL.Path)
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		var payload struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Errorf("decode Ollama request: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		model = payload.Model
		_, _ = writer.Write([]byte(`{"embeddings":[[0.25,0.75]]}`))
	}))
	defer server.Close()
	workspace := testkit.NewWorkspace(t, map[string]string{
		".agent-wayfinder/config.json": `{"embedding":{"provider":"ollama","ollama":{"model":"qwen3-embedding:8b","endpoint":"` + server.URL + `"}}}`,
		"go.mod":                       "module example.com/fixture\n",
		"validator/token.go":           "package validator\n\nfunc ValidateToken(token string) error { return nil }\n",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	output := &strings.Builder{}
	standardError := &strings.Builder{}
	if exitCode := runIndexCommand(t, []string{"--catalog-background=false", "--database", database, workspace.Root}, output, standardError); exitCode != 0 {
		t.Fatalf("index workspace exit code = %d, want 0; error %s", exitCode, standardError.String())
	}
	if exitCode := runCatalogCommand(t, []string{"--database", database, "--foreground", workspace.Root}, output, standardError); exitCode != 0 {
		t.Fatalf("catalog workspace exit code = %d, want 0; error %s", exitCode, standardError.String())
	}
	if model != "qwen3-embedding:8b" {
		t.Errorf("Ollama embedding model = %q, want qwen3-embedding:8b", model)
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
		t.Fatalf("search catalog: %v", err)
	}
	if len(matches) != 1 {
		t.Fatalf("catalog matches = %+v, want one ValidateToken entry", matches)
	}
	embeddings, err := store.ReadCatalogEmbeddings(context.Background(), snapshot, storage.CatalogEmbeddingReadRequest{NodeIDs: []string{matches[0].Entry.NodeID}})
	if err != nil {
		t.Fatalf("read catalog embeddings: %v", err)
	}
	if len(embeddings) != 1 || !reflect.DeepEqual(embeddings[0].Vector, []float32{0.25, 0.75}) {
		t.Errorf("catalog embeddings = %+v, want configured Ollama vector", embeddings)
	}
}

func TestIndexCommandUsesWorkspaceLocalDatabaseByDefault(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json": `{"name":"fixture"}`,
		"src/main.ts":  "export function main() { return 1; }",
	})

	command := cliCommand("index", workspace.Root)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("run index command: %v\n%s", err, output)
	}

	database := filepath.Join(workspace.Root, ".agent-wayfinder", "graph.db")
	if _, err := os.Stat(database); err != nil {
		t.Errorf("default database %q does not exist: %v", database, err)
	}
	deadline := time.Now().Add(time.Second)
	terminalStatusObserved := false
	for {
		output := &strings.Builder{}
		standardError := &strings.Builder{}
		if exitCode := runCatalogStatusCommand(t, []string{"--database", database, workspace.Root}, output, standardError); exitCode == 0 &&
			!strings.Contains(output.String(), string(storage.CatalogTaskQueued)) &&
			!strings.Contains(output.String(), string(storage.CatalogTaskRunning)) {
			if terminalStatusObserved {
				break
			}
			terminalStatusObserved = true
		} else {
			terminalStatusObserved = false
		}
		if time.Now().After(deadline) {
			t.Fatalf("catalog process did not finish before cleanup: %s", output.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
}
