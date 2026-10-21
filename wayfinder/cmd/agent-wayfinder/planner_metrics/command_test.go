package planner_metrics

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agent-wayfinder/cli"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
	"agent-wayfinder/testkit"

	"github.com/spf13/cobra"
)

func run(arguments []string, standardOutput, standardError *bytes.Buffer) int {
	if len(arguments) == 0 {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("expected planner metrics command"))
	}
	exitCode := 0
	var command *cobra.Command
	switch arguments[0] {
	case "copilot-metrics":
		command = NewCopilot(standardOutput, standardError, &exitCode)
	case "claude-metrics":
		command = NewClaude(standardOutput, standardError, &exitCode)
	default:
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("expected planner metrics command"))
	}
	command.SetOut(standardOutput)
	command.SetErr(standardError)
	command.SetArgs(arguments[1:])
	if err := command.Execute(); err != nil {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError(err.Error()))
	}
	return exitCode
}

func TestCopilotMetricsCommandShowsDailyLocalAggregates(t *testing.T) {
	workspace := testkit.NewWorkspace(t, nil)
	database := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := store.RecordCopilotPlannerMetric(context.Background(), storage.CopilotPlannerMetric{
		RecordedAt:            time.Now().UTC(),
		Model:                 "gpt-5",
		MaxAICredits:          30,
		Outcome:               storage.CopilotPlannerOutcomeSuccess,
		Duration:              time.Second,
		PromptBytes:           120,
		ResponseBytes:         96,
		OutputTokens:          storage.ExactMetricValue(12),
		SessionTotalNanoAiu:   storage.ExactMetricValue(80),
		PremiumRequestCredits: storage.ExactMetricValue(1),
	}); err != nil {
		t.Fatalf("record planner metric: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}

	standardOutput := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := run([]string{"copilot-metrics", "--database", database, "--format", "json", workspace.Root}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run copilot metrics: exit %d, stderr %s", exitCode, standardError.String())
	}
	var result struct {
		GraphVersion *storage.GraphVersion `json:"graphVersion"`
		PublishedAt  *string               `json:"publishedAt"`
		Result       struct {
			Metrics []storage.CopilotPlannerDailyMetrics `json:"metrics"`
		} `json:"result"`
	}
	if err := json.Unmarshal(standardOutput.Bytes(), &result); err != nil {
		t.Fatalf("decode copilot metrics output: %v", err)
	}
	if result.GraphVersion != nil || result.PublishedAt != nil {
		t.Errorf("copilot metrics JSON = %s, must omit graph metadata", standardOutput.Bytes())
	}
	if len(result.Result.Metrics) != 1 || result.Result.Metrics[0].Successes != 1 || result.Result.Metrics[0].OutputTokens.Availability != storage.MetricValueExact || result.Result.Metrics[0].OutputTokens.Value != 12 {
		t.Errorf("copilot metric output = %+v, want exact daily success aggregate", result.Result.Metrics)
	}
	textOutput := &bytes.Buffer{}
	textError := &bytes.Buffer{}
	if exitCode := run([]string{"copilot-metrics", "--database", database, workspace.Root}, textOutput, textError); exitCode != 0 {
		t.Fatalf("run text copilot metrics: exit %d, stderr %s", exitCode, textError.String())
	}
	for _, want := range []string{"DAY", "MODEL", "REQUESTS", "CREDITS", "COST", "MONTH TOTAL", "gpt-5", "1", "$0.01", "┌", "└"} {
		if !strings.Contains(textOutput.String(), want) {
			t.Errorf("text copilot metrics = %q, want %q", textOutput.String(), want)
		}
	}
	for _, unwanted := range []string{"INPUT", "OUTPUT", "CACHE READ", "REASON", "AIU", "PROMPT B", "RESPONSE B"} {
		if strings.Contains(textOutput.String(), unwanted) {
			t.Errorf("text copilot metrics = %q, must hide %q without --verbose", textOutput.String(), unwanted)
		}
	}
	if strings.Contains(textOutput.String(), "Graph version:") || strings.Contains(textOutput.String(), "Published at:") {
		t.Errorf("text copilot metrics = %q, must omit graph metadata", textOutput.String())
	}
}

func TestClaudeMetricsCommandShowsTotalsAndVerboseDetails(t *testing.T) {
	workspace := testkit.NewWorkspace(t, nil)
	database := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := store.RecordClaudePlannerMetric(context.Background(), storage.ClaudePlannerMetric{
		RecordedAt:              time.Now().UTC(),
		Model:                   "sonnet",
		ActualModel:             "sonnet",
		MaxBudgetUSD:            0.75,
		Outcome:                 storage.ClaudePlannerOutcomeSuccess,
		Duration:                time.Second,
		PromptBytes:             120,
		ResponseBytes:           96,
		InputTokens:             storage.ExactMetricValue(24),
		OutputTokens:            storage.ExactMetricValue(12),
		APIDurationMilliseconds: storage.ExactMetricValue(200),
		CostUSD:                 storage.DollarValue{Value: 0.02, Availability: storage.MetricValueExact},
	}); err != nil {
		t.Fatalf("record Claude planner metric: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}

	standardOutput := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := run([]string{"claude-metrics", "--database", database, "--format", "json", workspace.Root}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run Claude metrics: exit %d, stderr %s", exitCode, standardError.String())
	}
	var result struct {
		Result claudeMetricsData `json:"result"`
	}
	if err := json.Unmarshal(standardOutput.Bytes(), &result); err != nil {
		t.Fatalf("decode Claude metrics output: %v", err)
	}
	if result.Result.Total.Requests != 1 || result.Result.Total.InputTokens.Value != 24 || result.Result.Total.OutputTokens.Value != 12 || result.Result.Total.CostUSD.Value != 0.02 {
		t.Errorf("Claude metric total = %+v, want exact daily total", result.Result.Total)
	}
	textOutput := &bytes.Buffer{}
	if exitCode := run([]string{"claude-metrics", "--database", database, workspace.Root}, textOutput, standardError); exitCode != 0 {
		t.Fatalf("run Claude text metrics: exit %d, stderr %s", exitCode, standardError.String())
	}
	for _, want := range []string{"DAY", "MODEL", "REQUESTS", "BUDGET", "COST", "MONTH TOTAL", "sonnet", "TOTAL", "$0.02"} {
		if !strings.Contains(textOutput.String(), want) {
			t.Errorf("Claude text metrics = %q, want %q", textOutput.String(), want)
		}
	}
	for _, unwanted := range []string{"INPUT", "OUTPUT", "PROMPT B", "RESPONSE B"} {
		if strings.Contains(textOutput.String(), unwanted) {
			t.Errorf("Claude text metrics = %q, must hide %q without --verbose", textOutput.String(), unwanted)
		}
	}
	verboseOutput := &bytes.Buffer{}
	if exitCode := run([]string{"claude-metrics", "--database", database, "--verbose", workspace.Root}, verboseOutput, standardError); exitCode != 0 {
		t.Fatalf("run verbose Claude metrics: exit %d, stderr %s", exitCode, standardError.String())
	}
	for _, want := range []string{"INPUT", "OUTPUT", "PROMPT B", "RESPONSE B", "UNAVAILABLE"} {
		if !strings.Contains(verboseOutput.String(), want) {
			t.Errorf("verbose Claude metrics = %q, want %q", verboseOutput.String(), want)
		}
	}
}

func TestCopilotMetricsCommandShowsMonthlyCreditTable(t *testing.T) {
	workspace := testkit.NewWorkspace(t, nil)
	database := filepath.Join(t.TempDir(), "graph.db")
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	for _, day := range []time.Time{
		time.Date(2026, time.September, 2, 12, 0, 0, 0, time.UTC),
		time.Date(2026, time.September, 3, 12, 0, 0, 0, time.UTC),
	} {
		if err := store.RecordCopilotPlannerMetric(context.Background(), storage.CopilotPlannerMetric{
			RecordedAt:              day,
			Model:                   "auto",
			ActualModel:             "gpt-5.6-luna",
			MaxAICredits:            30,
			Outcome:                 storage.CopilotPlannerOutcomeSuccess,
			OutputTokens:            storage.ExactMetricValue(12),
			SessionTotalNanoAiu:     storage.ExactMetricValue(80),
			PremiumRequestCredits:   storage.ExactMetricValue(1),
			APIDurationMilliseconds: storage.ExactMetricValue(100),
		}); err != nil {
			t.Fatalf("record planner metric: %v", err)
		}
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}

	textOutput := &bytes.Buffer{}
	textError := &bytes.Buffer{}
	arguments := []string{"copilot-metrics", "--database", database, "--month", "2026-09", workspace.Root}
	if exitCode := run(arguments, textOutput, textError); exitCode != 0 {
		t.Fatalf("run monthly copilot metrics: exit %d, stderr %s", exitCode, textError.String())
	}
	for _, want := range []string{"2026-09-02", "2026-09-03", "MONTH TOTAL", "CREDITS", "COST", "2", "$0.02"} {
		if !strings.Contains(textOutput.String(), want) {
			t.Errorf("monthly copilot metrics = %q, want %q", textOutput.String(), want)
		}
	}
	for _, unwanted := range []string{"INPUT", "OUTPUT", "CACHE READ", "REASON", "AIU", "PROMPT B", "RESPONSE B"} {
		if strings.Contains(textOutput.String(), unwanted) {
			t.Errorf("monthly copilot metrics = %q, must hide %q without --verbose", textOutput.String(), unwanted)
		}
	}

	verboseOutput := &bytes.Buffer{}
	if exitCode := run(append([]string{"copilot-metrics", "--database", database, "--month", "2026-09", "--verbose"}, workspace.Root), verboseOutput, textError); exitCode != 0 {
		t.Fatalf("run verbose monthly copilot metrics: exit %d, stderr %s", exitCode, textError.String())
	}
	if !strings.Contains(verboseOutput.String(), "INPUT") || !strings.Contains(verboseOutput.String(), "OUTPUT") {
		t.Errorf("verbose monthly copilot metrics = %q, want detail columns", verboseOutput.String())
	}
}

func TestMetricsWithFinalUsageExcludesIncompleteRecords(t *testing.T) {
	metrics := metricsWithFinalUsage([]storage.CopilotPlannerDailyMetrics{
		{Successes: 3, PremiumRequestCredits: storage.MetricValue{Availability: storage.MetricValueUnavailable}},
		{Successes: 30, PremiumRequestCredits: storage.ExactMetricValue(30)},
	})
	if len(metrics) != 1 || metrics[0].Successes != 30 || metrics[0].PremiumRequestCredits.Value != 30 {
		t.Errorf("filtered metrics = %+v, want only final usage records", metrics)
	}
}

func TestCopilotMetricsTextOmitsIncompleteMonthlyCreditRecords(t *testing.T) {
	metrics := []storage.CopilotPlannerDailyMetrics{
		{Day: time.Date(2026, time.September, 2, 0, 0, 0, 0, time.UTC), ActualModel: "auto", Successes: 3, PremiumRequestCredits: storage.MetricValue{Availability: storage.MetricValueUnavailable}},
		{Day: time.Date(2026, time.September, 3, 0, 0, 0, 0, time.UTC), ActualModel: "gpt-5.6-luna", Successes: 30, PremiumRequestCredits: storage.ExactMetricValue(30)},
	}
	metrics = metricsWithFinalUsage(metrics)
	text := formatCopilotMetricsText(copilotMetricsData{Month: "2026-09", Metrics: metrics, Total: summarizeCopilotMetrics(metrics)}, false)
	for _, want := range []string{"2026-09-03", "MONTH TOTAL", "│       30 │ 30      │ $0.30"} {
		if !strings.Contains(text, want) {
			t.Errorf("monthly metric text = %q, want %q", text, want)
		}
	}
	for _, unwanted := range []string{"2026-09-02", "?", "unavailable final usage data"} {
		if strings.Contains(text, unwanted) {
			t.Errorf("monthly metric text = %q, must not include %q", text, unwanted)
		}
	}
}

func TestCopilotMetricsCommandUsesCurrentDirectoryByDefault(t *testing.T) {
	workspace := testkit.NewWorkspace(t, nil)
	database := filepath.Join(workspace.Root, ".agent-wayfinder", "graph.db")
	if err := os.MkdirAll(filepath.Dir(database), 0o755); err != nil {
		t.Fatalf("create metrics directory: %v", err)
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := store.RecordCopilotPlannerMetric(context.Background(), storage.CopilotPlannerMetric{
		RecordedAt:            time.Now().UTC(),
		Model:                 "gpt-5",
		ActualModel:           "gpt-5",
		MaxAICredits:          30,
		Outcome:               storage.CopilotPlannerOutcomeSuccess,
		OutputTokens:          storage.ExactMetricValue(12),
		SessionTotalNanoAiu:   storage.ExactMetricValue(80),
		PremiumRequestCredits: storage.ExactMetricValue(1),
	}); err != nil {
		t.Fatalf("record planner metric: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatalf("get working directory: %v", err)
	}
	if err := os.Chdir(workspace.Root); err != nil {
		t.Fatalf("change working directory: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(workingDirectory) })

	standardOutput := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := run([]string{"copilot-metrics", "--format", "json"}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run default copilot metrics: exit %d, stderr %s", exitCode, standardError.String())
	}
	var result struct {
		Result struct {
			Metrics []storage.CopilotPlannerDailyMetrics `json:"metrics"`
		} `json:"result"`
	}
	if err := json.Unmarshal(standardOutput.Bytes(), &result); err != nil {
		t.Fatalf("decode default copilot metrics output: %v", err)
	}
	if len(result.Result.Metrics) != 1 || result.Result.Metrics[0].Successes != 1 {
		t.Errorf("default copilot metrics = %+v, want current workspace aggregate", result.Result.Metrics)
	}
}
