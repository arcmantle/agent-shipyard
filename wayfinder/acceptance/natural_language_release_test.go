package acceptance_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	askcommand "agent-wayfinder/cmd/agent-wayfinder/ask"
	"agent-wayfinder/graph"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
	"agent-wayfinder/testkit"
)

func TestAskReleaseCorpus(t *testing.T) {
	mainSource := `MATCH (node {name: 'main'}) RETURN node.name LIMIT 1`
	workerSource := `MATCH (node {name: 'worker'}) RETURN node.name LIMIT 1`
	emptySource := `MATCH (node {name: 'missing'}) RETURN node.name LIMIT 1`
	confidences := make(map[string]float64)
	for _, test := range []struct {
		name             string
		question         string
		candidates       []string
		diagnostics      bool
		warning          string
		wantError        string
		providerStatus   int
		empty            bool
		selected         string
		text             bool
		currentDirectory bool
	}{
		{name: "entrypoint", question: "What is the application entrypoint?", candidates: []string{mainSource}, currentDirectory: true},
		{name: "diagnostics", question: "Show the entrypoint query", candidates: []string{mainSource}, diagnostics: true},
		{name: "invalid candidate", question: "Which function starts the application?", candidates: []string{"DELETE node", mainSource}, warning: "candidate 1"},
		{name: "agreement", question: "Where does execution start?", candidates: []string{workerSource, mainSource, `MATCH (entry {name: 'main'}) RETURN entry.name LIMIT 1`}, warning: "disagree"},
		{name: "disagreement", question: "Identify the application entry function", candidates: []string{workerSource, mainSource}, warning: "disagree"},
		{name: "empty then answer", question: "Find the startup function", candidates: []string{emptySource, mainSource}},
		{name: "all empty", question: "Find a missing function", candidates: []string{emptySource}, empty: true, selected: emptySource, warning: "empty results"},
		{name: "all invalid", question: "Find startup", candidates: []string{"DELETE node"}, wantError: "no valid candidate"},
		{name: "provider failure", question: "Find the entrypoint", providerStatus: http.StatusServiceUnavailable, wantError: "selected AI provider"},
		{name: "text diagnostics", question: "Show startup evidence", candidates: []string{mainSource}, text: true, diagnostics: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			provider := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				calls++
				if test.providerStatus != 0 {
					response.WriteHeader(test.providerStatus)
					return
				}
				if request.URL.Path != "/api/chat" {
					t.Errorf("provider path = %q", request.URL.Path)
				}
				var body struct {
					Messages []struct {
						Content string `json:"content"`
					} `json:"messages"`
				}
				if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				if len(body.Messages) != 2 || !strings.Contains(body.Messages[1].Content, test.question) || !strings.Contains(body.Messages[1].Content, "MATCH") || strings.Contains(body.Messages[1].Content, "main.go") {
					t.Errorf("planning metadata = %+v", body)
				}
				content, _ := json.Marshal(map[string]any{"candidates": test.candidates})
				_ = json.NewEncoder(response).Encode(map[string]any{"message": map[string]string{"content": string(content)}})
			}))
			t.Cleanup(provider.Close)
			configuration, _ := json.Marshal(map[string]any{
				"planning":  map[string]any{"provider": "ollama", "ollama": map[string]any{"endpoint": provider.URL}},
				"embedding": map[string]any{"enabled": false},
				"synopsis":  map[string]any{"enabled": false},
			})
			workspace := testkit.NewWorkspace(t, map[string]string{".agent-wayfinder/config.json": string(configuration), "main.go": "package main\nfunc main() {}\nfunc worker() {}\n"})
			t.Setenv("HOME", t.TempDir())
			t.Setenv("USERPROFILE", t.TempDir())
			database := filepath.Join(t.TempDir(), "graph.db")
			store, err := sqlite.Open(context.Background(), database)
			if err != nil {
				t.Fatal(err)
			}
			evidence := graph.FactEvidence{Span: graph.SourceSpan{Path: "main.go", StartLine: 2, StartColumn: 1, EndLine: 2, EndColumn: 15}, FileHash: "fixture-hash", Extractor: "fixture", Provenance: "source", Confidence: graph.ConfidenceExtracted}
			weaker := evidence
			weaker.Confidence = graph.ConfidenceInferred
			snapshot, err := store.Publish(context.Background(), storage.PublishRequest{Workspace: workspace.Root, WorkspaceFacts: graph.Facts{Nodes: []graph.Node{{ID: "main", Kind: "go:function", Label: "main", Evidence: evidence}, {ID: "worker", Kind: "go:function", Label: "worker", Evidence: weaker}}}})
			if err != nil {
				t.Fatal(err)
			}
			if err := store.Close(); err != nil {
				t.Fatal(err)
			}
			var output, errors bytes.Buffer
			exitCode := 0
			command := askcommand.New(&output, &errors, &exitCode)
			arguments := []string{"--path", workspace.Root, "--database", database, "--format", "json"}
			if test.currentDirectory {
				t.Chdir(workspace.Root)
				arguments = []string{"--database", database, "--format", "json"}
			}
			if test.text {
				arguments = []string{"--path", workspace.Root, "--database", database}
			}
			if test.diagnostics {
				arguments = append(arguments, "--diagnostics")
			}
			command.SetArgs(append(arguments, "--", test.question))
			if err := command.Execute(); err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Fatalf("provider calls = %d, want one", calls)
			}
			if test.wantError != "" {
				if exitCode != 1 || output.Len() != 0 || !strings.Contains(errors.String(), test.wantError) {
					t.Fatalf("ask exit %d, output %s, error %s", exitCode, &output, &errors)
				}
				return
			}
			if exitCode != 0 {
				t.Fatalf("ask exit %d, error %s", exitCode, &errors)
			}
			if test.text {
				for _, content := range []string{mainSource, "Row: [main]", "Confidence:", "main.go:2", "SQL:", "Parameters:"} {
					if !strings.Contains(output.String(), content) {
						t.Errorf("text result missing %q: %s", content, &output)
					}
				}
				return
			}
			var envelope struct {
				Result query.AskResult `json:"result"`
			}
			if err := json.Unmarshal(output.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			result := envelope.Result
			selected := mainSource
			if test.selected != "" {
				selected = test.selected
			}
			if result.SelectedSource != selected || result.Snapshot != snapshot || len(result.ConfidenceBasis) == 0 || result.Limits.MaxNodes != 100 {
				t.Fatalf("ask result = %+v, provider calls = %d", result, calls)
			}
			if test.empty {
				if len(result.Rows) != 0 || len(result.Graph.Nodes) != 0 || result.Confidence != 0 {
					t.Fatalf("empty answer = %+v", result)
				}
			} else if len(result.Rows) != 1 || result.Rows[0][0] != "main" || result.Confidence <= 0 || result.Confidence > 1 || len(result.Evidence) != 1 || result.Evidence[0] != evidence {
				t.Fatalf("source-backed answer = %+v", result)
			}
			confidences[test.name] = result.Confidence
			if test.warning != "" && !strings.Contains(strings.Join(result.Warnings, " "), test.warning) {
				t.Fatalf("warnings = %v, want %q", result.Warnings, test.warning)
			}
			if hasSQL := strings.Contains(output.String(), `"sql":`); hasSQL != test.diagnostics {
				t.Fatalf("diagnostic output = %s, want SQL present: %t", &output, test.diagnostics)
			}
			if test.diagnostics && (!strings.Contains(output.String(), `"parameters":`) || !strings.Contains(output.String(), "visible_nodes")) {
				t.Fatalf("diagnostic output = %s, want translated SQL and parameters", &output)
			}
			if test.diagnostics {
				parameterizedName := false
				for _, parameter := range result.Diagnostics.Parameters {
					if name, ok := parameter.(string); ok && name == "main" {
						parameterizedName = true
					}
				}
				if strings.Contains(result.Diagnostics.SQL, "'main'") || !parameterizedName {
					t.Fatalf("diagnostics = %+v, want parameterized name", result.Diagnostics)
				}
			}
		})
	}
	if confidences["agreement"] <= confidences["disagreement"] {
		t.Fatalf("confidences = %v, want agreement to increase confidence", confidences)
	}
}
