package catalog

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agent-wayfinder/cmd/agent-wayfinder/internal/claude"
	"agent-wayfinder/cmd/agent-wayfinder/internal/copilot"
	"agent-wayfinder/cmd/agent-wayfinder/internal/spending"
	"agent-wayfinder/index"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
	"agent-wayfinder/testkit"
)

type limitedSpendStore struct{}

func (limitedSpendStore) ReserveSpend(context.Context, storage.SpendReservationRequest) (storage.SpendReservation, error) {
	return storage.SpendReservation{}, storage.ErrSpendLimitExceeded
}

func (limitedSpendStore) SettleSpend(context.Context, int64, float64) error {
	return nil
}

type settlementSpendStore struct {
	settledReservationID int64
	settledAmount        float64
}

func (store *settlementSpendStore) ReserveSpend(context.Context, storage.SpendReservationRequest) (storage.SpendReservation, error) {
	return storage.SpendReservation{ID: 1, Amount: 30}, nil
}

func (store *settlementSpendStore) SettleSpend(_ context.Context, reservationID int64, amount float64) error {
	store.settledReservationID = reservationID
	store.settledAmount = amount
	return nil
}

func TestCatalogStatusReportsRefreshFailureWithoutChangingPublishedGraph(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json": `{"name":"fixture"}`,
		"src/token.ts": "export function validateAccessToken(token: string) { return token.length > 0; }",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	if err := os.MkdirAll(filepath.Dir(database), 0o755); err != nil {
		t.Fatalf("create catalog database directory: %v", err)
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open catalog database: %v", err)
	}
	result, err := index.Index(context.Background(), store, index.Request{Root: workspace.Root})
	if err != nil {
		_ = store.Close()
		t.Fatalf("index workspace: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close catalog database: %v", err)
	}
	if err := refreshCatalog(context.Background(), RefreshRequest{Database: database, Workspace: workspace.Root, Snapshot: result.Snapshot, PreviousSnapshot: result.Snapshot, ChangedPaths: []string{"../outside.ts"}}); err == nil {
		t.Fatal("refresh catalog error = nil, want invalid changed path")
	}

	standardOutput := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	exitCode := 0
	command := NewStatus(standardOutput, standardError, &exitCode)
	command.SetArgs([]string{"--format", "json", "--database", database, workspace.Root})
	if err := command.Execute(); err != nil {
		t.Fatalf("run catalog-status command: %v", err)
	}
	if exitCode != 0 {
		t.Fatalf("run catalog-status command: exit code %d, error %s", exitCode, standardError.String())
	}
	var envelope struct {
		Result struct {
			State        string               `json:"state"`
			GraphVersion storage.GraphVersion `json:"graphVersion"`
			Failure      string               `json:"failure"`
		} `json:"result"`
	}
	if err := json.Unmarshal(standardOutput.Bytes(), &envelope); err != nil {
		t.Fatalf("decode catalog status: %v\n%s", err, standardOutput.String())
	}
	if envelope.Result.State != string(storage.CatalogTaskFailed) || envelope.Result.GraphVersion != result.Snapshot.Version || envelope.Result.Failure == "" {
		t.Errorf("catalog status = %+v, want failed status for unchanged published graph", envelope.Result)
	}
}

func TestCatalogWriteOptionsUseConfiguredSynopsisProvider(t *testing.T) {
	for _, testCase := range []struct {
		name          string
		provider      index.CatalogSynopsisProvider
		files         map[string]string
		copilotConfig catalogCopilotConfiguration
	}{
		{name: "Copilot", provider: index.CatalogSynopsisProviderCopilot, files: map[string]string{"package.json": `{"name":"fixture"}`}, copilotConfig: catalogCopilotConfiguration{}},
		{name: "Ollama", provider: index.CatalogSynopsisProviderOllama, files: map[string]string{}},
		{name: "Claude", provider: index.CatalogSynopsisProviderClaude, files: map[string]string{}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			workspace := testkit.NewWorkspace(t, testCase.files)
			options, err := catalogWriteOptions(catalogConfiguration{
				Copilot: testCase.copilotConfig,
				Synopsis: catalogSynopsisConfiguration{
					Provider:    testCase.provider,
					SourceLimit: 512,
				},
			}, workspace.Root, nil)
			if err != nil {
				t.Fatalf("create catalog write options: %v", err)
			}
			if options.SynopsisGenerator == nil || options.SynopsisProvider != testCase.provider || options.SynopsisSourceLimit != 512 {
				t.Errorf("catalog write options = %+v, want configured %s synopsis provider", options, testCase.provider)
			}
		})
	}
}

func TestCatalogSynopsisGeneratorSkipsProviderWhenSpendingLimitIsReached(t *testing.T) {
	generator := spendingCatalogSynopsisGenerator{
		provider:             index.CatalogSynopsisProviderCopilot,
		configuration:        spending.Configuration{Copilot: spending.Limits{Daily: 30}},
		store:                limitedSpendStore{},
		copilotConfiguration: copilot.CatalogConfiguration{MaxAICredits: 30},
	}
	if _, err := generator.GenerateCatalogSynopsis(context.Background(), index.CatalogSynopsisInput{Name: "ValidateToken"}); !errors.Is(err, storage.ErrSpendLimitExceeded) {
		t.Errorf("generate limited Copilot synopsis error = %v, want spend limit exceeded", err)
	}
}

func TestCatalogSynopsisGeneratorSettlesExactCopilotCredits(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "copilot")
	script := "#!/bin/sh\nusage_file=''\nwhile [ $# -gt 0 ]; do\n  if [ \"$1\" = \"--usage-output-file\" ]; then usage_file=$2; shift 2; continue; fi\n  shift\ndone\nprintf '%s' 'Validates an access token.'\nprintf '{\"currentModel\":\"gpt-5\",\"totalPremiumRequestCost\":1,\"modelMetrics\":{\"gpt-5\":{\"usage\":{}}}}' > \"$usage_file\"\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write Copilot synopsis script: %v", err)
	}
	store := &settlementSpendStore{}
	generator := spendingCatalogSynopsisGenerator{
		provider:             index.CatalogSynopsisProviderCopilot,
		configuration:        spending.Configuration{Copilot: spending.Limits{Daily: 30}},
		store:                store,
		copilotConfiguration: copilot.CatalogConfiguration{Path: path, MaxAICredits: 30},
	}
	synopsis, err := generator.GenerateCatalogSynopsis(context.Background(), index.CatalogSynopsisInput{Name: "ValidateToken"})
	if err != nil {
		t.Fatalf("generate Copilot synopsis: %v", err)
	}
	if synopsis != "Validates an access token." || store.settledReservationID != 1 || store.settledAmount != 1 {
		t.Errorf("catalog synopsis = %q, settlement = %+v; want synopsis and one-credit settlement", synopsis, store)
	}
}

func TestCatalogSynopsisGeneratorSettlesExactClaudeCost(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "claude")
	script := `#!/bin/sh
printf '%s\n' '{"result":"Validates an access token.","total_cost_usd":1.5}'
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write Claude synopsis script: %v", err)
	}
	store := &settlementSpendStore{}
	generator := spendingCatalogSynopsisGenerator{
		provider:            index.CatalogSynopsisProviderClaude,
		configuration:       spending.Configuration{Claude: spending.Limits{Daily: 30}},
		store:               store,
		claudeConfiguration: claude.Configuration{Path: path, Model: "sonnet", MaxBudgetUSD: 30, Timeout: time.Second},
	}
	synopsis, err := generator.GenerateCatalogSynopsis(context.Background(), index.CatalogSynopsisInput{Name: "ValidateToken"})
	if err != nil {
		t.Fatalf("generate Claude synopsis: %v", err)
	}
	if synopsis != "Validates an access token." || store.settledReservationID != 1 || store.settledAmount != 1.5 {
		t.Errorf("catalog synopsis = %q, settlement = %+v; want synopsis and $1.50 settlement", synopsis, store)
	}
}

func TestCatalogWriteOptionsUseConfiguredOllamaSynopsisModelAndEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/generate" {
			t.Errorf("Ollama synopsis request path = %q, want /api/generate", request.URL.Path)
		}
		var body struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode Ollama synopsis request: %v", err)
		}
		if body.Model != "catalog-generation:8b" {
			t.Errorf("Ollama synopsis model = %q, want catalog-generation:8b", body.Model)
		}
		_, _ = response.Write([]byte(`{"response":"Validates an access token."}`))
	}))
	t.Cleanup(server.Close)

	options, err := catalogWriteOptions(catalogConfiguration{
		Synopsis: catalogSynopsisConfiguration{
			Provider:           index.CatalogSynopsisProviderOllama,
			SourceLimit:        512,
			OllamaProcessLimit: 2,
		},
		Ollama: catalogOllamaConfiguration{Model: "catalog-generation:8b", Endpoint: server.URL, Timeout: time.Second},
	}, t.TempDir(), nil)
	if err != nil {
		t.Fatalf("create Ollama catalog synopsis options: %v", err)
	}
	if options.SynopsisGenerator == nil {
		t.Fatal("Ollama catalog synopsis generator = nil")
	}
	if options.SynopsisProcessLimit != 2 {
		t.Errorf("Ollama catalog synopsis process limit = %d, want 2", options.SynopsisProcessLimit)
	}
	if _, err := options.SynopsisGenerator.GenerateCatalogSynopsis(context.Background(), index.CatalogSynopsisInput{Name: "ValidateToken"}); err != nil {
		t.Fatalf("generate Ollama catalog synopsis: %v", err)
	}
}

func TestCatalogStatusReportsFailedRefreshAfterCancellation(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		".agent-wayfinder/config.json": `{"embedding":{"provider":"ollama"}}`,
		"package.json":                 `{"name":"fixture"}`,
		"src/token.ts":                 "export function validateAccessToken(token: string) { return token.length > 0; }",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	if err := os.MkdirAll(filepath.Dir(database), 0o755); err != nil {
		t.Fatalf("create catalog database directory: %v", err)
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open catalog database: %v", err)
	}
	result, err := index.Index(context.Background(), store, index.Request{Root: workspace.Root})
	if err != nil {
		_ = store.Close()
		t.Fatalf("index workspace: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close catalog database: %v", err)
	}
	requestStarted := make(chan struct{}, 1)
	releaseRequest := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/generate" {
			return
		}
		if request.URL.Path != "/api/embed" {
			t.Errorf("embedding request path = %q, want /api/embed", request.URL.Path)
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		requestStarted <- struct{}{}
		<-releaseRequest
	}))
	t.Cleanup(server.Close)
	t.Setenv("OLLAMA_HOST", server.URL)
	refreshContext, cancelRefresh := context.WithCancel(context.Background())
	t.Cleanup(cancelRefresh)
	refreshErrors := make(chan error, 1)
	go func() {
		refreshErrors <- refreshCatalog(refreshContext, RefreshRequest{
			Database:         database,
			Workspace:        workspace.Root,
			Snapshot:         result.Snapshot,
			PreviousSnapshot: result.Snapshot,
			ChangedPaths:     []string{"src/token.ts"},
		})
	}()
	select {
	case <-requestStarted:
		cancelRefresh()
		close(releaseRequest)
	case <-time.After(time.Second):
		t.Fatal("catalog refresh did not start an embedding request")
	}
	if err := <-refreshErrors; !errors.Is(err, context.Canceled) {
		t.Fatalf("refresh catalog error = %v, want context canceled", err)
	}

	standardOutput := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	exitCode := 0
	command := NewStatus(standardOutput, standardError, &exitCode)
	command.SetArgs([]string{"--format", "json", "--database", database, workspace.Root})
	if err := command.Execute(); err != nil {
		t.Fatalf("run catalog-status command: %v", err)
	}
	if exitCode != 0 {
		t.Fatalf("run catalog-status command: exit code %d, error %s", exitCode, standardError.String())
	}
	var envelope struct {
		Result struct {
			State        string               `json:"state"`
			GraphVersion storage.GraphVersion `json:"graphVersion"`
			ChangedPaths []string             `json:"changedPaths"`
			Failure      string               `json:"failure"`
		} `json:"result"`
	}
	if err := json.Unmarshal(standardOutput.Bytes(), &envelope); err != nil {
		t.Fatalf("decode catalog status: %v\n%s", err, standardOutput.String())
	}
	if envelope.Result.State != string(storage.CatalogTaskFailed) || envelope.Result.GraphVersion != result.Snapshot.Version || envelope.Result.Failure == "" || len(envelope.Result.ChangedPaths) != 1 || envelope.Result.ChangedPaths[0] != "src/token.ts" {
		t.Errorf("catalog status = %+v, want failed status for canceled refresh", envelope.Result)
	}
}

func TestStartRefreshUsesBoundedContext(t *testing.T) {
	previousRunCatalogRefresh := runCatalogRefresh
	contexts := make(chan context.Context, 1)
	runCatalogRefresh = func(ctx context.Context, _ RefreshRequest) error {
		contexts <- ctx
		return nil
	}
	t.Cleanup(func() { runCatalogRefresh = previousRunCatalogRefresh })

	StartRefresh(RefreshRequest{})
	select {
	case ctx := <-contexts:
		deadline, exists := ctx.Deadline()
		if !exists {
			t.Fatal("catalog refresh context has no deadline")
		}
		remaining := time.Until(deadline)
		if remaining <= 0 || remaining > catalogRefreshTimeout || remaining < catalogRefreshTimeout-time.Second {
			t.Errorf("catalog refresh deadline is in %s, want approximately %s", remaining, catalogRefreshTimeout)
		}
	case <-time.After(time.Second):
		t.Fatal("catalog refresh worker did not start")
	}
}

func TestStartRefreshSerializesSameWorkspace(t *testing.T) {
	previousRunCatalogRefresh := runCatalogRefresh
	firstStarted := make(chan struct{}, 1)
	secondStarted := make(chan struct{}, 1)
	releaseFirst := make(chan struct{})
	runCatalogRefresh = func(_ context.Context, request RefreshRequest) error {
		switch request.Snapshot.Version {
		case 1:
			firstStarted <- struct{}{}
			<-releaseFirst
		case 2:
			secondStarted <- struct{}{}
		}
		return nil
	}
	t.Cleanup(func() { runCatalogRefresh = previousRunCatalogRefresh })

	first := RefreshRequest{Workspace: t.TempDir(), Snapshot: storage.Snapshot{Version: 1}}
	StartRefresh(first)
	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("first catalog refresh did not start")
	}

	StartRefresh(RefreshRequest{Workspace: first.Workspace, Snapshot: storage.Snapshot{Version: 2}})
	select {
	case <-secondStarted:
		t.Fatal("second catalog refresh started before the first completed")
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseFirst)
	select {
	case <-secondStarted:
	case <-time.After(time.Second):
		t.Fatal("second catalog refresh did not start after the first completed")
	}
}

func TestRefreshCatalogUsesLatestSnapshotForSupersededRequest(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"go.mod":                       "module example.com/fixture\n",
		"a.go":                         "package fixture\nfunc FirstToken() {}\n",
		"b.go":                         "package fixture\nfunc SecondToken() {}\n",
		"c.go":                         "package fixture\nfunc KeepToken() {}\n",
		".agent-wayfinder/config.json": `{"embedding":{"enabled":false},"synopsis":{"enabled":false}}`,
	})
	ctx := context.Background()
	database := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(ctx, database)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	first, err := index.Publish(ctx, store, index.Request{Root: workspace.Root})
	if err != nil {
		t.Fatal(err)
	}
	workspace.WriteFile(t, "a.go", "package fixture\nfunc UpdatedFirstToken() {}\n")
	queued, err := index.PublishBatch(ctx, store, index.BatchRequest{Root: workspace.Root, ChangedPaths: []string{"a.go"}})
	if err != nil {
		t.Fatal(err)
	}
	workspace.WriteFile(t, "b.go", "package fixture\nfunc UpdatedSecondToken() {}\n")
	latest, err := index.PublishBatch(ctx, store, index.BatchRequest{Root: workspace.Root, ChangedPaths: []string{"b.go"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := refreshCatalog(ctx, RefreshRequest{
		Database: database, Workspace: workspace.Root, Snapshot: queued,
		PreviousSnapshot: first, ChangedPaths: []string{"a.go"},
	}); err != nil {
		t.Fatalf("refresh superseded request: %v", err)
	}
	task, found, err := store.ReadCatalogTask(ctx, workspace.Root)
	if err != nil || !found || task.State != storage.CatalogTaskComplete || task.GraphVersion != latest.Version || len(task.ChangedPaths) != 0 {
		t.Fatalf("catalog task = %+v, found=%t, error %v", task, found, err)
	}
	matches, err := store.SearchCatalog(ctx, latest, storage.CatalogSearchRequest{Text: "token", Limit: 10})
	if err != nil || len(matches) != 3 {
		t.Fatalf("latest catalog matches = %v, error %v", matches, err)
	}
	for _, match := range matches {
		if match.Entry.Name != "UpdatedFirstToken" && match.Entry.Name != "UpdatedSecondToken" && match.Entry.Name != "KeepToken" {
			t.Fatalf("old catalog input used: %+v", match.Entry)
		}
	}
}

func TestStartRefreshPreservesUnchangedUnitsForLaterSnapshot(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"go.mod":             "module example.com/fixture\n",
		"validator/other.go": "package validator\n\nfunc KeepToken() error { return nil }\n",
		"validator/token.go": "package validator\n\nfunc ValidateToken() error { return nil }\n",
	})
	database := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open graph store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	first, err := index.Publish(context.Background(), store, index.Request{Root: workspace.Root})
	if err != nil {
		t.Fatalf("publish first graph: %v", err)
	}

	previousRunCatalogRefresh := runCatalogRefresh
	firstStarted := make(chan struct{}, 1)
	releaseFirst := make(chan struct{})
	completed := make(chan error, 1)
	runCatalogRefresh = func(ctx context.Context, request RefreshRequest) error {
		if request.Snapshot.Version == first.Version {
			firstStarted <- struct{}{}
			<-releaseFirst
		}
		err := previousRunCatalogRefresh(ctx, request)
		if request.Snapshot.Version != first.Version {
			completed <- err
		}
		return err
	}
	t.Cleanup(func() { runCatalogRefresh = previousRunCatalogRefresh })

	StartRefresh(RefreshRequest{Database: database, Workspace: workspace.Root, Snapshot: first})
	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("first catalog refresh did not start")
	}
	workspace.WriteFile(t, "validator/token.go", "package validator\n\n// ValidateToken verifies a signed token.\nfunc ValidateToken() error { return nil }\n")
	second, err := index.PublishBatch(context.Background(), store, index.BatchRequest{
		Root:         workspace.Root,
		ChangedPaths: []string{"validator/token.go"},
	})
	if err != nil {
		t.Fatalf("publish second graph: %v", err)
	}
	StartRefresh(RefreshRequest{
		Database:         database,
		Workspace:        workspace.Root,
		Snapshot:         second,
		PreviousSnapshot: first,
		ChangedPaths:     []string{"validator/token.go"},
	})
	close(releaseFirst)
	select {
	case err := <-completed:
		if err != nil {
			t.Fatalf("refresh later catalog snapshot: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("later catalog refresh did not complete")
	}

	matches, err := store.SearchCatalog(context.Background(), second, storage.CatalogSearchRequest{Text: "token", Limit: 10})
	if err != nil {
		t.Fatalf("search later catalog snapshot: %v", err)
	}
	if len(matches) != 2 {
		t.Fatalf("later catalog matches = %+v, want changed and unchanged units", matches)
	}
	for _, match := range matches {
		if match.Entry.Name == "ValidateToken" && !strings.Contains(match.Entry.DeterministicSynopsis, "verifies a signed token") {
			t.Errorf("changed catalog entry = %+v, want refreshed synopsis", match.Entry)
		}
	}
}

func TestStartRefreshRebuildsLaterSnapshotAfterPriorFailure(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"go.mod":             "module example.com/fixture\n",
		"validator/other.go": "package validator\n\nfunc KeepToken() error { return nil }\n",
		"validator/token.go": "package validator\n\nfunc ValidateToken() error { return nil }\n",
	})
	database := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open graph store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	first, err := index.Publish(context.Background(), store, index.Request{Root: workspace.Root})
	if err != nil {
		t.Fatalf("publish first graph: %v", err)
	}

	previousRunCatalogRefresh := runCatalogRefresh
	firstStarted := make(chan struct{}, 1)
	releaseFirst := make(chan struct{})
	completed := make(chan error, 1)
	runCatalogRefresh = func(ctx context.Context, request RefreshRequest) error {
		if request.Snapshot.Version == first.Version {
			firstStarted <- struct{}{}
			<-releaseFirst
			return errors.New("first catalog refresh failed")
		}
		err := previousRunCatalogRefresh(ctx, request)
		completed <- err
		return err
	}
	t.Cleanup(func() { runCatalogRefresh = previousRunCatalogRefresh })

	StartRefresh(RefreshRequest{Database: database, Workspace: workspace.Root, Snapshot: first})
	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("first catalog refresh did not start")
	}
	workspace.WriteFile(t, "validator/token.go", "package validator\n\n// ValidateToken verifies a signed token.\nfunc ValidateToken() error { return nil }\n")
	second, err := index.PublishBatch(context.Background(), store, index.BatchRequest{
		Root:         workspace.Root,
		ChangedPaths: []string{"validator/token.go"},
	})
	if err != nil {
		t.Fatalf("publish second graph: %v", err)
	}
	StartRefresh(RefreshRequest{
		Database:         database,
		Workspace:        workspace.Root,
		Snapshot:         second,
		PreviousSnapshot: first,
		ChangedPaths:     []string{"validator/token.go"},
	})
	close(releaseFirst)
	select {
	case err := <-completed:
		if err != nil {
			t.Fatalf("rebuild later catalog snapshot: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("later catalog refresh did not complete")
	}

	matches, err := store.SearchCatalog(context.Background(), second, storage.CatalogSearchRequest{Text: "token", Limit: 10})
	if err != nil {
		t.Fatalf("search rebuilt catalog snapshot: %v", err)
	}
	if len(matches) != 2 {
		t.Fatalf("rebuilt catalog matches = %+v, want changed and unchanged units", matches)
	}
}
