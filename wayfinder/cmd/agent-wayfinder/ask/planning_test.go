package ask

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agent-wayfinder/graph"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
	"agent-wayfinder/testkit"
)

func TestNewPlannerUsesOnlySelectedProvider(t *testing.T) {
	user := testkit.NewWorkspace(t, map[string]string{})
	t.Setenv("HOME", user.Root)
	t.Setenv("USERPROFILE", user.Root)
	for _, testCase := range []struct {
		name    string
		status  int
		wantErr string
	}{
		{name: "answer", status: http.StatusOK},
		{name: "provider unavailable", status: http.StatusServiceUnavailable, wantErr: "selected AI provider"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				calls++
				var body struct {
					Messages []struct {
						Content string `json:"content"`
					} `json:"messages"`
				}
				if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if len(body.Messages) != 2 || !strings.Contains(body.Messages[1].Content, "Function") {
					t.Errorf("provider did not receive the snapshot vocabulary: %+v", body)
				}
				response.WriteHeader(testCase.status)
				_ = json.NewEncoder(response).Encode(map[string]any{"message": map[string]string{"content": `{"candidates":["MATCH (node:Function {name: 'main'}) RETURN node LIMIT 1"]}`}})
			}))
			t.Cleanup(server.Close)
			workspace := testkit.NewWorkspace(t, map[string]string{".agent-wayfinder/config.json": fmt.Sprintf(`{"planning":{"provider":"ollama","ollama":{"endpoint":%q},"claude":{"timeout":"invalid"},"copilot":{"tokenBudget":-1}}}`, server.URL)})
			ctx := context.Background()
			store, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = store.Close() })
			snapshot, err := store.Publish(ctx, storage.PublishRequest{Workspace: workspace.Root, WorkspaceFacts: graph.Facts{Nodes: []graph.Node{{ID: "main", Kind: "Function", Label: "main"}}}})
			if err != nil {
				t.Fatal(err)
			}
			planner, err := NewPlanner(workspace.Root, store)
			if err != nil {
				t.Fatal(err)
			}
			result, err := query.AskSnapshot(ctx, store, snapshot, "Find the entrypoint", query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 10}, query.AskOptions{Planner: planner})
			if calls != 1 {
				t.Fatalf("provider requests = %d, want one", calls)
			}
			if testCase.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
					t.Fatalf("error = %v, want %q", err, testCase.wantErr)
				}
			} else if err != nil || len(result.Graph.Nodes) != 1 || result.Graph.Nodes[0].ID != "main" {
				t.Fatalf("result = %+v, error = %v", result, err)
			}
		})
	}
}

func TestNewPlannerPaidProvidersHonorSpendingLimits(t *testing.T) {
	user := testkit.NewWorkspace(t, map[string]string{})
	t.Setenv("HOME", user.Root)
	t.Setenv("USERPROFILE", user.Root)
	for _, provider := range []string{"claude", "copilot"} {
		for _, exhausted := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/exhausted=%t", provider, exhausted), func(t *testing.T) {
				workspace := testkit.NewWorkspace(t, map[string]string{
					"claude": "#!/bin/sh\nprintf '%s\\n' '{\"structured_output\":{\"candidates\":[\"MATCH (node) RETURN node LIMIT 1\"]},\"total_cost_usd\":0.25,\"model\":\"sonnet\"}'\n",
					"copilot": `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--usage-output-file" ]; then
    shift
	printf '%s' '{"currentModel":"gpt-5","totalPremiumRequestCost":1,"modelMetrics":{"gpt-5":{"usage":{}}}}' > "$1"
  fi
  shift
done
printf '%s\n' '{"type":"assistant.message","data":{"content":"{\"candidates\":[\"MATCH (node) RETURN node LIMIT 1\"]}"}}'
`,
				})
				for _, executable := range []string{"claude", "copilot"} {
					if err := os.Chmod(filepath.Join(workspace.Root, executable), 0700); err != nil {
						t.Fatal(err)
					}
				}
				t.Setenv("PATH", workspace.Root+string(os.PathListSeparator)+os.Getenv("PATH"))
				workspace.WriteFile(t, ".agent-wayfinder/config.json", fmt.Sprintf(`{"planning":{"provider":%q,"claude":{"path":%q,"maxBudgetUsd":0.75},"copilot":{"model":"gpt-5","maxAiCredits":30,"tokenBudget":8192}},"spending":{"claude":{"dailyUsd":1},"copilot":{"dailyAiCredits":100}}}`, provider, filepath.Join(workspace.Root, "claude")))
				ctx := context.Background()
				store, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = store.Close() })
				if exhausted {
					amount, unit := 1.0, "usd"
					if provider == "copilot" {
						amount, unit = 100, "ai_credits"
					}
					_, err := store.ReserveSpend(ctx, storage.SpendReservationRequest{Provider: provider, Unit: unit, MaximumAmount: amount, MinimumAmount: amount, Limits: storage.SpendLimits{Daily: amount}})
					if err != nil {
						t.Fatal(err)
					}
				}
				planner, err := NewPlanner(workspace.Root, store)
				if err != nil {
					t.Fatal(err)
				}
				candidates, err := planner.PlanGraphQueries(ctx, query.GraphPlanningRequest{Question: "Find main", Grammar: "MATCH RETURN LIMIT", MaxCandidates: 3})
				if exhausted {
					if err == nil || !strings.Contains(err.Error(), "spending limit") {
						t.Fatalf("candidates = %v, error = %v, want spending error", candidates, err)
					}
					return
				}
				if err != nil || len(candidates) != 1 || candidates[0] != "MATCH (node) RETURN node LIMIT 1" {
					t.Fatalf("candidates = %v, error = %v", candidates, err)
				}
				if provider == "claude" {
					metrics, err := store.ReadClaudePlannerDailyMetrics(ctx, storage.ClaudePlannerDailyMetricsRequest{Day: time.Now().UTC()})
					if err != nil || len(metrics) != 1 || metrics[0].Successes != 1 || metrics[0].CostUSD.Value != 0.25 {
						t.Fatalf("Claude metrics = %+v, error = %v", metrics, err)
					}
				} else {
					metrics, err := store.ReadCopilotPlannerDailyMetrics(ctx, storage.CopilotPlannerDailyMetricsRequest{Day: time.Now().UTC()})
					if err != nil || len(metrics) != 1 || metrics[0].Successes != 1 || metrics[0].PremiumRequestCredits.Value != 1 {
						t.Fatalf("Copilot metrics = %+v, error = %v", metrics, err)
					}
				}
				daily, remaining, unit := 1.0, 0.75, "usd"
				if provider == "copilot" {
					daily, remaining, unit = 100, 99, "ai_credits"
				}
				reservation, err := store.ReserveSpend(ctx, storage.SpendReservationRequest{Provider: provider, Unit: unit, MaximumAmount: daily, MinimumAmount: remaining, Limits: storage.SpendLimits{Daily: daily}})
				if err != nil || reservation.Amount != remaining {
					t.Fatalf("remaining reservation = %+v, error = %v, want exact usage settled", reservation, err)
				}
			})
		}
	}
}

func TestNewPlannerRequiresProviderAndSpendingStore(t *testing.T) {
	user := testkit.NewWorkspace(t, map[string]string{})
	t.Setenv("HOME", user.Root)
	t.Setenv("USERPROFILE", user.Root)
	for _, testCase := range []struct{ name, config, wantErr string }{
		{name: "no provider", config: `{}`, wantErr: "planning.provider"},
		{name: "spending without store", config: `{"planning":{"provider":"copilot"},"spending":{"copilot":{"dailyAiCredits":100}}}`, wantErr: "spending store"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			workspace := testkit.NewWorkspace(t, map[string]string{".agent-wayfinder/config.json": testCase.config})
			_, err := NewPlanner(workspace.Root, nil)
			if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("error = %v, want %q", err, testCase.wantErr)
			}
		})
	}
}

func TestNewPlannerRecordsFailedCopilotRequests(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())
	workspace := testkit.NewWorkspace(t, map[string]string{
		"copilot":                      "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"assistant.message\",\"data\":{\"content\":\"invalid\"}}'\n",
		".agent-wayfinder/config.json": `{"planning":{"provider":"copilot","copilot":{"model":"gpt-5","tokenBudget":8192}}}`,
	})
	if err := os.Chmod(filepath.Join(workspace.Root, "copilot"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", workspace.Root+string(os.PathListSeparator)+os.Getenv("PATH"))
	ctx := context.Background()
	store, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	planner, err := NewPlanner(workspace.Root, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := planner.PlanGraphQueries(ctx, query.GraphPlanningRequest{Question: "Find main", MaxCandidates: 3}); err == nil {
		t.Fatal("invalid provider response succeeded")
	}
	metrics, err := store.ReadCopilotPlannerDailyMetrics(ctx, storage.CopilotPlannerDailyMetricsRequest{Day: time.Now().UTC()})
	if err != nil || len(metrics) != 1 {
		t.Fatalf("metrics = %+v, error = %v", metrics, err)
	}
	content, err := json.Marshal(metrics[0])
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(content, &fields); err != nil {
		t.Fatal(err)
	}
	if fields["failures"] != float64(1) || fields["successes"] != float64(0) || fields["fallbacks"] != nil {
		t.Fatalf("failed-request metrics = %s; want one failure and no fallback contract", content)
	}
}
