package ollama

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"agent-wayfinder/index"
	"agent-wayfinder/query"
	"agent-wayfinder/testkit"
)

func TestRunGraphPlannerUsesSnapshotMetadata(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls++
		if request.URL.Path != "/api/chat" {
			t.Errorf("provider path = %q", request.URL.Path)
		}
		var body struct {
			Model     string           `json:"model"`
			Stream    bool             `json:"stream"`
			Think     bool             `json:"think"`
			KeepAlive string           `json:"keep_alive"`
			Messages  []plannerMessage `json:"messages"`
			Format    json.RawMessage  `json:"format"`
			Options   plannerOptions   `json:"options"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if len(body.Messages) != 2 || !strings.Contains(body.Messages[0].Content, "candidates") || !strings.Contains(body.Messages[1].Content, "Function") || !strings.Contains(body.Messages[1].Content, "Find main") || !strings.Contains(string(body.Format), "candidates") || body.Options.NumCtx != PlannerContextTokens || body.Options.NumPredict != PlannerPredictionTokens {
			t.Errorf("graph planner request = %+v, want snapshot vocabulary and graph response contract", body)
		}
		if body.Model != "qwen3:8b" || body.Stream || body.Think || body.KeepAlive != "0" || body.Options.NumThread != PlannerThreadLimit {
			t.Errorf("graph planner request = %+v, want bounded non-streaming request", body)
		}
		_, _ = io.WriteString(response, `{"message":{"content":"{\"candidates\":[\"MATCH (node) RETURN node LIMIT 1\"]}"}}`)
	}))
	t.Cleanup(server.Close)
	response, err := RunGraphPlanner(context.Background(), Configuration{Model: "qwen3:8b", Timeout: time.Second}, query.GraphPlanningRequest{Question: "Find main", Grammar: "MATCH RETURN LIMIT", Schema: query.GraphQuerySchema{NodeKinds: map[string][]string{"Function": {"name"}}}, MaxCandidates: 3}, server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := query.ParseGraphPlanningResponse(response)
	if err != nil || len(candidates) != 1 || candidates[0] != "MATCH (node) RETURN node LIMIT 1" || calls != 1 {
		t.Fatalf("candidates = %v, error = %v, requests = %d", candidates, err, calls)
	}
}

func TestReadConfigurationUsesWorkspaceValuesAndDisabledDefaults(t *testing.T) {
	user := testkit.NewWorkspace(t, map[string]string{})
	t.Setenv("HOME", user.Root)
	t.Setenv("USERPROFILE", user.Root)
	t.Setenv("OLLAMA_HOST", "")

	configured := testkit.NewWorkspace(t, map[string]string{
		".agent-wayfinder/config.json": `{"planning":{"provider":"ollama","ollama":{"model":"qwen3:8b","endpoint":"http://localhost:11435","timeout":"12s"}}}`,
	})
	configuration, err := ReadConfiguration(configured.Root)
	if err != nil {
		t.Fatalf("read configured Ollama planner configuration: %v", err)
	}
	if !configuration.Enabled || configuration.Model != "qwen3:8b" || configuration.Endpoint != "http://localhost:11435" || configuration.Timeout != 12*time.Second {
		t.Errorf("Ollama planner configuration = %+v, want workspace values", configuration)
	}

	defaults := testkit.NewWorkspace(t, map[string]string{
		"package.json": `{"name":"fixture"}`,
	})
	configuration, err = ReadConfiguration(defaults.Root)
	if err != nil {
		t.Fatalf("read default Ollama planner configuration: %v", err)
	}
	if configuration.Enabled || configuration.Model != "qwen3:8b" || configuration.Endpoint != defaultEndpoint || configuration.Timeout != 30*time.Second {
		t.Errorf("default Ollama planner configuration = %+v, want disabled qwen3:8b defaults", configuration)
	}

	legacy := testkit.NewWorkspace(t, map[string]string{
		".wayfinder": `{"planning":{"provider":"ollama","ollama":{"model":"qwen3:8b"}}}`,
	})
	configuration, err = ReadConfiguration(legacy.Root)
	if err != nil {
		t.Fatalf("read legacy Ollama planner configuration: %v", err)
	}
	if configuration.Enabled || configuration.Model != "qwen3:8b" || configuration.Endpoint != defaultEndpoint || configuration.Timeout != 30*time.Second {
		t.Errorf("legacy Ollama configuration = %+v, want ignored old configuration file", configuration)
	}
}

func TestReadConfigurationMergesUserAndWorkspaceValues(t *testing.T) {
	user := testkit.NewWorkspace(t, map[string]string{})
	user.WriteFile(t, ".agent-wayfinder/config.json", `{"planning":{"provider":"ollama","ollama":{"model":"user-model","timeout":"7s"}}}`)
	t.Setenv("HOME", user.Root)
	t.Setenv("USERPROFILE", user.Root)
	workspace := testkit.NewWorkspace(t, map[string]string{
		".agent-wayfinder/config.json": `{"planning":{"ollama":{"model":"workspace-model","timeout":"8s"}}}`,
	})

	configuration, err := ReadConfiguration(workspace.Root)
	if err != nil {
		t.Fatalf("read layered Ollama configuration: %v", err)
	}
	if !configuration.Enabled || configuration.Model != "workspace-model" || configuration.Timeout != 8*time.Second {
		t.Errorf("Ollama configuration = %+v, want workspace values to override user values", configuration)
	}
}

func TestRunReturnsErrorForUnavailableService(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	_, err := RunGraphPlanner(context.Background(), Configuration{Model: "qwen3:4b", Timeout: time.Second}, query.GraphPlanningRequest{Question: "Which code invokes runQuery?"}, server.URL, server.Client())
	if err == nil || !strings.Contains(err.Error(), "unexpected HTTP status 503") {
		t.Errorf("Ollama unavailable error = %v, want HTTP 503 error", err)
	}
}

func TestRunRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(response, strings.Repeat("x", PlannerMaxResponseBytes+1))
	}))
	defer server.Close()

	_, err := RunGraphPlanner(context.Background(), Configuration{Model: "qwen3:4b", Timeout: time.Second}, query.GraphPlanningRequest{Question: "Which code invokes runQuery?"}, server.URL, server.Client())
	if err == nil || !strings.Contains(err.Error(), "exceeds 8192 bytes") {
		t.Errorf("oversized Ollama response error = %v, want response size error", err)
	}
}

func TestCatalogSynopsisUsesBoundedLocalGeneration(t *testing.T) {
	var requests []struct {
		KeepAlive string
		Prompt    string
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/generate" {
			t.Errorf("Ollama catalog path = %q, want /api/generate", request.URL.Path)
		}
		var body struct {
			Model     string `json:"model"`
			Stream    bool   `json:"stream"`
			Think     bool   `json:"think"`
			KeepAlive string `json:"keep_alive"`
			Prompt    string `json:"prompt"`
			Options   struct {
				NumCtx     int `json:"num_ctx"`
				NumPredict int `json:"num_predict"`
				NumThread  int `json:"num_thread"`
			} `json:"options"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode Ollama catalog request: %v", err)
		}
		requests = append(requests, struct {
			KeepAlive string
			Prompt    string
		}{KeepAlive: body.KeepAlive, Prompt: body.Prompt})
		if body.KeepAlive == "0" {
			return
		}
		if body.Model != "qwen3:8b" || body.Stream || body.Think || body.Options.NumCtx != catalogSynopsisContextTokens || body.Options.NumPredict != catalogSynopsisPredictionTokens || body.Options.NumThread != catalogSynopsisThreadLimit || body.KeepAlive != catalogSynopsisKeepAlive || !strings.Contains(body.Prompt, "Name: ValidateToken") || !strings.Contains(body.Prompt, "Declaration source: func ValidateToken(token string) error { return nil }") {
			t.Errorf("Ollama catalog request = %+v, want bounded synopsis request", body)
		}
		_, _ = response.Write([]byte(`{"response":"Validates an access token."}`))
	}))
	defer server.Close()

	generator := NewCatalogSynopsisGenerator(CatalogSynopsisConfiguration{Model: "qwen3:8b", Timeout: time.Second}, server.URL, server.Client())
	synopsis, err := generator.GenerateCatalogSynopsis(context.Background(), index.CatalogSynopsisInput{
		Name:              "ValidateToken",
		DeclarationSource: "func ValidateToken(token string) error { return nil }",
	})
	if err != nil {
		t.Fatalf("generate Ollama catalog synopsis: %v", err)
	}
	if synopsis != "Validates an access token." {
		t.Errorf("Ollama catalog synopsis = %q, want generated text", synopsis)
	}
	if err := generator.ReleaseCatalogSynopsisModel(context.Background()); err != nil {
		t.Fatalf("release Ollama catalog synopsis model: %v", err)
	}
	if len(requests) != 2 || requests[0].KeepAlive != catalogSynopsisKeepAlive || requests[1].KeepAlive != "0" || requests[1].Prompt != "" {
		t.Errorf("Ollama catalog requests = %+v, want retained generation and release", requests)
	}
}

func TestCatalogSynopsisRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(response, strings.Repeat("x", catalogSynopsisMaxResponseBytes+1))
	}))
	t.Cleanup(server.Close)

	generator := NewCatalogSynopsisGenerator(CatalogSynopsisConfiguration{Model: "qwen3:8b", Timeout: time.Second}, server.URL, server.Client())
	_, err := generator.GenerateCatalogSynopsis(context.Background(), index.CatalogSynopsisInput{Name: "ValidateToken"})
	if err == nil || !strings.Contains(err.Error(), "exceeds 4096 bytes") {
		t.Errorf("Ollama catalog synopsis error = %v, want response size error", err)
	}
}

func TestCatalogSynopsisPromptBoundsUntrustedFields(t *testing.T) {
	prompt := catalogSynopsisPrompt(index.CatalogSynopsisInput{
		Name:             "ValidateToken",
		Comments:         []string{strings.Repeat("comment ", catalogSynopsisMaxPromptBytes)},
		IdentifierTokens: []string{strings.Repeat("identifier ", catalogSynopsisMaxPromptBytes)},
	})
	if len(prompt) > catalogSynopsisMaxPromptBytes {
		t.Errorf("catalog synopsis prompt length = %d, want at most %d", len(prompt), catalogSynopsisMaxPromptBytes)
	}
	if !utf8.ValidString(prompt) {
		t.Errorf("catalog synopsis prompt = %q, want valid UTF-8", prompt)
	}
}
