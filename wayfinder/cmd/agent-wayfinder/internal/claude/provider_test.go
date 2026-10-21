package claude

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"agent-wayfinder/index"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
	"agent-wayfinder/testkit"

	"github.com/spf13/cobra"
)

func TestRunGraphPlannerUsesStructuredCandidates(t *testing.T) {
	for _, envelope := range []string{
		`{"structured_output":{"candidates":["MATCH (node) RETURN node LIMIT 1"]},"result":"Query candidates generated."}`,
		`{"result":"{\"candidates\":[\"MATCH (node) RETURN node LIMIT 1\"]}"}`,
	} {
		t.Run(envelope, func(t *testing.T) {
			calls := 0
			runner := func(ctx context.Context, name string, arguments ...string) *exec.Cmd {
				calls++
				joined := strings.Join(arguments, " ")
				if name != "claude-custom" || !strings.Contains(joined, "Find main") || !strings.Contains(joined, "Function") || !strings.Contains(joined, "candidates") || strings.Contains(joined, "--fallback-model") {
					t.Errorf("graph planner command = %s %v", name, arguments)
				}
				return exec.CommandContext(ctx, "printf", "%s\n", envelope)
			}
			run, err := RunGraphPlanner(context.Background(), Configuration{Path: "claude-custom", Model: "sonnet", FallbackModel: "haiku", Timeout: time.Second}, query.GraphPlanningRequest{Question: "Find main", Grammar: "MATCH RETURN LIMIT", Schema: query.GraphQuerySchema{NodeKinds: map[string][]string{"Function": {"name"}}}, MaxCandidates: 3}, runner)
			if err != nil {
				t.Fatal(err)
			}
			candidates, err := query.ParseGraphPlanningResponse(run.Response)
			if err != nil || len(candidates) != 1 || candidates[0] != "MATCH (node) RETURN node LIMIT 1" || calls != 1 {
				t.Fatalf("candidates = %v, error = %v, requests = %d", candidates, err, calls)
			}
		})
	}
}

func TestReadConfigurationUsesWorkspaceValuesAndDisabledDefaults(t *testing.T) {
	configured := testkit.NewWorkspace(t, map[string]string{".agent-wayfinder/config.json": `{"planning":{"provider":"claude","claude":{"path":"/opt/bin/claude","model":"opus","fallbackModel":"haiku","maxBudgetUsd":0.75,"effort":"high","timeout":"12s"}}}`})
	configuration, err := ReadConfiguration(configured.Root)
	if err != nil {
		t.Fatalf("read configured Claude planner configuration: %v", err)
	}
	if !configuration.Enabled || configuration.Path != "/opt/bin/claude" || configuration.Model != "opus" || configuration.FallbackModel != "haiku" || configuration.MaxBudgetUSD != 0.75 || configuration.Effort != "high" || configuration.Timeout != 12*time.Second {
		t.Errorf("Claude planner configuration = %+v, want workspace values", configuration)
	}

	defaults := testkit.NewWorkspace(t, map[string]string{"package.json": `{"name":"fixture"}`})
	configuration, err = ReadConfiguration(defaults.Root)
	if err != nil {
		t.Fatalf("read default Claude planner configuration: %v", err)
	}
	if configuration.Enabled || configuration.Path != DefaultPlannerPath || configuration.Model != DefaultPlannerModel || configuration.FallbackModel != "" || configuration.MaxBudgetUSD != 0 || configuration.Effort != "" || configuration.Timeout != 30*time.Second {
		t.Errorf("default Claude planner configuration = %+v, want disabled defaults", configuration)
	}

	legacy := testkit.NewWorkspace(t, map[string]string{".wayfinder": `{"planning":{"provider":"claude","claude":{"path":"/opt/bin/claude","model":"opus"}}}`})
	configuration, err = ReadConfiguration(legacy.Root)
	if err != nil {
		t.Fatalf("read legacy Claude planner configuration: %v", err)
	}
	if configuration.Enabled || configuration.Path != DefaultPlannerPath || configuration.Model != DefaultPlannerModel || configuration.FallbackModel != "" || configuration.MaxBudgetUSD != 0 || configuration.Effort != "" || configuration.Timeout != 30*time.Second {
		t.Errorf("legacy Claude planner configuration = %+v, want ignored old configuration file", configuration)
	}
}

func TestReadConfigurationMergesUserAndWorkspaceValues(t *testing.T) {
	user := testkit.NewWorkspace(t, map[string]string{})
	user.WriteFile(t, ".agent-wayfinder/config.json", `{"planning":{"provider":"claude","claude":{"path":"user-claude","model":"user-model","fallbackModel":"user-fallback","maxBudgetUsd":0.5,"effort":"medium","timeout":"7s"}}}`)
	t.Setenv("HOME", user.Root)
	t.Setenv("USERPROFILE", user.Root)
	workspace := testkit.NewWorkspace(t, map[string]string{
		".agent-wayfinder/config.json": `{"planning":{"claude":{"model":"workspace-model","timeout":"8s"}}}`,
	})

	configuration, err := ReadConfiguration(workspace.Root)
	if err != nil {
		t.Fatalf("read layered Claude configuration: %v", err)
	}
	if !configuration.Enabled || configuration.Path != "user-claude" || configuration.Model != "workspace-model" || configuration.FallbackModel != "user-fallback" || configuration.MaxBudgetUSD != 0.5 || configuration.Effort != "medium" || configuration.Timeout != 8*time.Second {
		t.Errorf("Claude configuration = %+v, want workspace values to override user values", configuration)
	}

	report, err := ResolveConfigurationReport(newConfigurationCommand(), workspace.Root)
	if err != nil {
		t.Fatalf("resolve layered Claude configuration: %v", err)
	}
	wantSources := ConfigurationSources{Enabled: "user", Path: "user", Model: "workspace", FallbackModel: "user", MaxBudgetUSD: "user", Effort: "user", Timeout: "workspace"}
	if !reflect.DeepEqual(report.Sources, wantSources) {
		t.Errorf("Claude configuration sources = %+v, want %+v", report.Sources, wantSources)
	}
}

func TestResolveConfigurationUsesFlagPrecedence(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{".agent-wayfinder/config.json": `{"planning":{"provider":"claude","claude":{"path":"workspace-claude","model":"workspace-model","fallbackModel":"workspace-fallback","maxBudgetUsd":0.25,"effort":"low","timeout":"5s"}}}`})
	t.Setenv("WAYFINDER_CLAUDE_ENABLED", "false")
	t.Setenv("WAYFINDER_CLAUDE_PATH", "environment-claude")
	t.Setenv("WAYFINDER_CLAUDE_MODEL", "environment-model")
	t.Setenv("WAYFINDER_CLAUDE_FALLBACK_MODEL", "environment-fallback")
	t.Setenv("WAYFINDER_CLAUDE_MAX_BUDGET_USD", "0.5")
	t.Setenv("WAYFINDER_CLAUDE_EFFORT", "medium")
	t.Setenv("WAYFINDER_CLAUDE_TIMEOUT", "10s")
	command := newConfigurationCommand()
	for name, value := range map[string]string{"claude": "true", "claude-path": "flag-claude", "claude-model": "flag-model", "claude-fallback-model": "flag-fallback", "claude-max-budget-usd": "0.75", "claude-effort": "high", "claude-timeout": "15s"} {
		if err := command.Flags().Set(name, value); err != nil {
			t.Fatalf("set %s: %v", name, err)
		}
	}

	configuration, err := ResolveConfiguration(command, workspace.Root)
	if err != nil {
		t.Fatalf("resolve Claude planner configuration: %v", err)
	}
	if !configuration.Enabled || configuration.Path != "flag-claude" || configuration.Model != "flag-model" || configuration.FallbackModel != "flag-fallback" || configuration.MaxBudgetUSD != 0.75 || configuration.Effort != "high" || configuration.Timeout != 15*time.Second {
		t.Errorf("Claude planner configuration = %+v, want flag values", configuration)
	}
}

func TestResolveConfigurationReportTracksSettingSources(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{".agent-wayfinder/config.json": `{"planning":{"provider":"claude","claude":{"path":"workspace-claude","model":"workspace-model","fallbackModel":"workspace-fallback","maxBudgetUsd":0.25,"effort":"low","timeout":"5s"}}}`})
	t.Setenv("WAYFINDER_CLAUDE_PATH", "environment-claude")
	t.Setenv("WAYFINDER_CLAUDE_MODEL", "environment-model")
	command := newConfigurationCommand()
	for name, value := range map[string]string{"claude": "true", "claude-max-budget-usd": "0.75", "claude-timeout": "15s"} {
		if err := command.Flags().Set(name, value); err != nil {
			t.Fatalf("set %s: %v", name, err)
		}
	}

	report, err := ResolveConfigurationReport(command, workspace.Root)
	if err != nil {
		t.Fatalf("resolve Claude planner configuration report: %v", err)
	}
	want := ConfigurationSources{Enabled: "flag", Path: "environment", Model: "environment", FallbackModel: "workspace", MaxBudgetUSD: "flag", Effort: "workspace", Timeout: "flag"}
	if !reflect.DeepEqual(report.Sources, want) {
		t.Errorf("Claude planner configuration sources = %+v, want %+v", report.Sources, want)
	}
}

func TestReadConfigurationRejectsInvalidValues(t *testing.T) {
	for _, testCase := range []struct{ name, configuration, wantError string }{
		{name: "unknown property", configuration: `{"planning":{"claude":{"apiKey":"not-a-secret"}}}`, wantError: "unknown field"},
		{name: "invalid model", configuration: `{"planning":{"claude":{"model":"invalid model"}}}`, wantError: "invalid Claude planner model"},
		{name: "invalid effort", configuration: `{"planning":{"claude":{"effort":"extreme"}}}`, wantError: "invalid Claude planner effort"},
		{name: "timeout exceeds maximum", configuration: `{"planning":{"claude":{"timeout":"31s"}}}`, wantError: "invalid Claude planner timeout"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			workspace := testkit.NewWorkspace(t, map[string]string{".agent-wayfinder/config.json": testCase.configuration})
			_, err := ReadConfiguration(workspace.Root)
			if err == nil || !strings.Contains(err.Error(), testCase.wantError) {
				t.Fatalf("configuration error = %v, want %q", err, testCase.wantError)
			}
			if strings.Contains(err.Error(), "not-a-secret") {
				t.Errorf("configuration error = %q, must not expose configuration values", err)
			}
		})
	}
}

func TestRunUsesStructuredOutputWithoutTools(t *testing.T) {
	var commandName string
	var arguments []string
	runner := func(_ context.Context, name string, args ...string) *exec.Cmd {
		commandName = name
		arguments = append([]string(nil), args...)
		return exec.Command("printf", "%s\n", `{"type":"result","result":"{\"candidates\":[\"MATCH (node) RETURN node LIMIT 1\"]}"}`)
	}

	request := query.GraphPlanningRequest{Question: "Which code invokes runQuery?"}
	run, err := RunGraphPlanner(context.Background(), Configuration{Enabled: true, Path: "claude-custom", Model: "sonnet", FallbackModel: "haiku", MaxBudgetUSD: 0.75, Effort: "high", Timeout: time.Second}, request, runner)
	if err != nil {
		t.Fatalf("run Claude planner: %v", err)
	}
	if commandName != "claude-custom" {
		t.Errorf("Claude planner command = %q, want claude-custom", commandName)
	}
	prompt, err := query.GraphPlanningPrompt(request)
	if err != nil {
		t.Fatal(err)
	}
	wantArguments := []string{"-p", prompt, "--output-format", "json", "--bare", "--tools", "", "--model", "sonnet", "--max-budget-usd", "0.75", "--effort", "high", "--json-schema", query.GraphPlanningResponseSchema, "--no-session-persistence"}
	if !reflect.DeepEqual(arguments, wantArguments) {
		t.Errorf("Claude planner arguments = %q, want %q", arguments, wantArguments)
	}
	want := `{"candidates":["MATCH (node) RETURN node LIMIT 1"]}`
	if string(run.Response) != want {
		t.Errorf("Claude planner contents = %s, want %s", run.Response, want)
	}
}

func TestCatalogSynopsisUsesConfiguredCLIWithoutTools(t *testing.T) {
	var commandName string
	var arguments []string
	runner := func(_ context.Context, name string, args ...string) *exec.Cmd {
		commandName = name
		arguments = append([]string(nil), args...)
		return exec.Command("printf", "%s\n", `{"result":"Validates an access token."}`)
	}

	input := index.CatalogSynopsisInput{
		Name:              "ValidateToken",
		Kind:              "go:function",
		Owner:             "Validator",
		Signature:         "func (Validator) ValidateToken(token string) error",
		Comments:          []string{"ValidateToken checks a signed access token."},
		IdentifierTokens:  []string{"validate", "token"},
		DeclarationSource: "func (validator Validator) ValidateToken(token string) error { return nil }",
	}
	generator := NewCatalogSynopsisGenerator(Configuration{Enabled: true, Path: "claude-custom", Model: "sonnet", FallbackModel: "haiku", MaxBudgetUSD: 0.75, Effort: "high", Timeout: time.Second}, runner)
	synopsis, err := generator.GenerateCatalogSynopsis(context.Background(), input)
	if err != nil {
		t.Fatalf("run Claude catalog synopsis: %v", err)
	}
	if commandName != "claude-custom" {
		t.Errorf("Claude catalog command = %q, want claude-custom", commandName)
	}
	wantArguments := []string{"-p", catalogSynopsisPrompt(input), "--output-format", "json", "--bare", "--tools", "", "--model", "sonnet", "--fallback-model", "haiku", "--max-budget-usd", "0.75", "--effort", "high", "--no-session-persistence"}
	if !reflect.DeepEqual(arguments, wantArguments) {
		t.Errorf("Claude catalog arguments = %q, want %q", arguments, wantArguments)
	}
	for _, want := range []string{
		"Name: " + input.Name,
		"Kind: " + input.Kind,
		"Owner: " + input.Owner,
		"Signature: " + input.Signature,
		"Comments: " + input.Comments[0],
		"Identifiers: " + strings.Join(input.IdentifierTokens, " "),
		"Declaration source:\n" + input.DeclarationSource,
	} {
		if !strings.Contains(arguments[1], want) {
			t.Errorf("Claude catalog prompt = %q, want %q", arguments[1], want)
		}
	}
	if synopsis != "Validates an access token." {
		t.Errorf("Claude catalog synopsis = %q, want generated text", synopsis)
	}
}

func TestRunReportsProviderUsageMetadataAndBuildsMetric(t *testing.T) {
	envelope, err := json.Marshal(map[string]any{"type": "result", "model": "haiku", "duration_api_ms": 1500, "total_cost_usd": 0.012, "usage": map[string]int64{"input_tokens": 15667, "output_tokens": 12}, "result": `{"candidates":["MATCH (node) RETURN node LIMIT 1"]}`})
	if err != nil {
		t.Fatalf("encode Claude result: %v", err)
	}
	configuration := Configuration{Model: "sonnet", FallbackModel: "haiku", MaxBudgetUSD: 0.75, Effort: "high", Timeout: time.Second}
	run, err := RunGraphPlanner(context.Background(), configuration, query.GraphPlanningRequest{Question: "Which code locates main?"}, func(_ context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.Command("printf", "%s\n", string(envelope))
	})
	if err != nil {
		t.Fatalf("run Claude planner with metadata: %v", err)
	}
	if run.ActualModel != "haiku" || !run.UsedFallbackModel || run.InputTokens.Value != 15667 || run.OutputTokens.Value != 12 || run.APIDurationMilliseconds.Value != 1500 || run.CostUSD.Value != 0.012 {
		t.Errorf("Claude planner run = %+v, want provider metadata", run)
	}
	metric := NewPlannerMetric(configuration, run, storage.ClaudePlannerOutcomeSuccess)
	if metric.ActualModel != "haiku" || metric.FallbackModel != "haiku" || metric.MaxBudgetUSD != 0.75 || metric.Effort != "high" || metric.InputTokens.Value != 15667 || metric.OutputTokens.Value != 12 || metric.APIDurationMilliseconds.Value != 1500 || metric.CostUSD.Value != 0.012 {
		t.Errorf("Claude planner metric = %+v, want provider metric fields", metric)
	}
}

func TestRunCatalogSynopsisReportsExactCost(t *testing.T) {
	envelope, err := json.Marshal(map[string]any{"result": "Validates an access token.", "total_cost_usd": 0.012})
	if err != nil {
		t.Fatalf("encode Claude catalog result: %v", err)
	}
	run, err := RunCatalogSynopsis(context.Background(), Configuration{Model: "sonnet", Timeout: time.Second}, index.CatalogSynopsisInput{Name: "ValidateToken"}, func(_ context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.Command("printf", "%s\n", string(envelope))
	})
	if err != nil {
		t.Fatalf("run Claude catalog synopsis with cost: %v", err)
	}
	if run.Synopsis != "Validates an access token." || run.CostUSD.Availability != storage.MetricValueExact || run.CostUSD.Value != 0.012 {
		t.Errorf("Claude catalog synopsis run = %+v, want synopsis and exact cost", run)
	}
}

func TestRunUsesModelUsageWhenTopLevelUsageIsMissing(t *testing.T) {
	envelope, err := json.Marshal(map[string]any{"type": "result", "modelUsage": map[string]map[string]int64{"sonnet": {"inputTokens": 15667, "outputTokens": 12}}, "result": `{"candidates":["MATCH (node) RETURN node LIMIT 1"]}`})
	if err != nil {
		t.Fatalf("encode Claude result: %v", err)
	}
	run, err := RunGraphPlanner(context.Background(), Configuration{Model: "sonnet", Timeout: time.Second}, query.GraphPlanningRequest{Question: "Which code locates main?"}, func(_ context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.Command("printf", "%s\n", string(envelope))
	})
	if err != nil {
		t.Fatalf("run Claude planner with model usage: %v", err)
	}
	if run.ActualModel != "sonnet" || run.InputTokens.Value != 15667 || run.InputTokens.Availability != storage.MetricValueExact || run.OutputTokens.Value != 12 || run.OutputTokens.Availability != storage.MetricValueExact {
		t.Errorf("Claude planner run = %+v, want model usage token metadata", run)
	}
}

func TestRunClassifiesUnavailableModel(t *testing.T) {
	_, err := RunGraphPlanner(context.Background(), Configuration{Model: "sonnet", Timeout: time.Second}, query.GraphPlanningRequest{Question: "Which code locates main?"}, func(_ context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.Command("sh", "-c", "printf '%s' 'model not available' >&2; exit 1")
	})
	if !errors.Is(err, ErrModelUnavailable) {
		t.Errorf("Claude planner error = %v, want unavailable model error", err)
	}
}

func newConfigurationCommand() *cobra.Command {
	command := &cobra.Command{}
	flags := command.Flags()
	flags.Bool("claude", false, "")
	flags.String("claude-path", "", "")
	flags.String("claude-model", "", "")
	flags.String("claude-fallback-model", "", "")
	flags.Float64("claude-max-budget-usd", 0, "")
	flags.String("claude-effort", "", "")
	flags.String("claude-timeout", "", "")
	return command
}
