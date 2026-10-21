package planner_metrics

import (
	"context"
	"fmt"
	"io"
	"path/filepath"
	"strconv"
	"time"

	"agent-wayfinder/cli"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"

	"github.com/jedib0t/go-pretty/v6/table"
	"github.com/spf13/cobra"
)

func NewCopilot(standardOutput, standardError io.Writer, exitCode *int) *cobra.Command {
	return cmd.NewLeaf("copilot-metrics [WORKSPACE]", "Show local Copilot planner metrics", configure, runCopilotMetrics, standardOutput, standardError, exitCode)
}

func NewClaude(standardOutput, standardError io.Writer, exitCode *int) *cobra.Command {
	return cmd.NewLeaf("claude-metrics [WORKSPACE]", "Show local Claude planner metrics", configure, runClaudeMetrics, standardOutput, standardError, exitCode)
}

func configure(command *cobra.Command) {
	cmd.DatabaseAndFormatFlags(command)
	command.Flags().String("day", "", "UTC day in YYYY-MM-DD format")
	command.Flags().String("month", "", "UTC month in YYYY-MM format; defaults to the current month")
	command.Flags().Bool("verbose", false, "show token, cache, timing, and byte details")
}

type copilotMetricsData struct {
	Day     string                               `json:"day,omitempty"`
	Month   string                               `json:"month,omitempty"`
	Metrics []storage.CopilotPlannerDailyMetrics `json:"metrics"`
	Total   copilotMetricsTotal                  `json:"total"`
}

type claudeMetricsData struct {
	Day     string                              `json:"day,omitempty"`
	Month   string                              `json:"month,omitempty"`
	Metrics []storage.ClaudePlannerDailyMetrics `json:"metrics"`
	Total   claudeMetricsTotal                  `json:"total"`
}

type claudeMetricsTotal struct {
	Requests     int                 `json:"requests"`
	InputTokens  storage.MetricValue `json:"inputTokens"`
	OutputTokens storage.MetricValue `json:"outputTokens"`
	CostUSD      storage.DollarValue `json:"costUsd"`
}

func runClaudeMetrics(command *cobra.Command, arguments []string, standardOutput, standardError io.Writer) int {
	if len(arguments) > 1 {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("claude-metrics accepts at most one workspace path"))
	}
	format, err := cmd.Format(command)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	workspace := "."
	if len(arguments) == 1 {
		workspace = arguments[0]
	}
	workspaceRoot, err := filepath.Abs(workspace)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve Claude metrics workspace path: %w", err))
	}
	database, err := cmd.DatabasePathForCommand(command, workspaceRoot)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve Claude metrics database path: %w", err))
	}
	dayValue, err := command.Flags().GetString("day")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	monthValue, err := command.Flags().GetString("month")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	if dayValue != "" && monthValue != "" {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("--day and --month cannot be used together"))
	}
	verbose, err := command.Flags().GetBool("verbose")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	data := claudeMetricsData{}
	now := time.Now().UTC()
	var day, month time.Time
	if dayValue != "" {
		day, err = time.Parse(time.DateOnly, dayValue)
		if err != nil {
			return cmd.WriteError(standardError, cli.NewInvalidArgumentError("--day must use YYYY-MM-DD format"))
		}
		data.Day = day.Format(time.DateOnly)
	} else {
		month = now
		if monthValue != "" {
			month, err = time.Parse("2006-01", monthValue)
			if err != nil {
				return cmd.WriteError(standardError, cli.NewInvalidArgumentError("--month must use YYYY-MM format"))
			}
		}
		data.Month = month.Format("2006-01")
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("open Claude metrics database: %w", err))
	}
	defer store.Close()
	if dayValue != "" {
		data.Metrics, err = store.ReadClaudePlannerDailyMetrics(context.Background(), storage.ClaudePlannerDailyMetricsRequest{Day: day})
	} else {
		data.Metrics, err = store.ReadClaudePlannerMonthlyMetrics(context.Background(), storage.ClaudePlannerMonthlyMetricsRequest{Month: month})
	}
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	data.Total = summarizeClaudeMetrics(data.Metrics)
	if err := cli.Render(standardOutput, cli.Result{OmitSnapshot: true, Text: formatClaudeMetricsText(data, verbose), Data: data}, format); err != nil {
		return cmd.WriteError(standardError, err)
	}
	return 0
}

func formatClaudeMetricsText(data claudeMetricsData, verbose bool) string {
	period := data.Month
	if period == "" {
		period = data.Day
	}
	if len(data.Metrics) == 0 {
		return fmt.Sprintf("Claude planner metrics: %s\n\nNo metrics recorded.", period)
	}
	summary := table.NewWriter()
	summary.SetStyle(table.StyleLight)
	summary.AppendHeader(table.Row{"DAY", "MODEL", "REQUESTS", "BUDGET", "COST"})
	for _, metric := range data.Metrics {
		summary.AppendRow(table.Row{
			metric.Day.Format(time.DateOnly),
			displayActualModel(metric.ActualModel),
			claudeMetricRequests(metric),
			displayDollarValue(storage.DollarValue{Value: metric.MaxBudgetUSD, Availability: storage.MetricValueExact}),
			displayDollarValue(metric.CostUSD),
		})
	}
	footer := "TOTAL"
	if data.Month != "" {
		footer = "MONTH TOTAL"
	}
	summary.AppendFooter(table.Row{footer, "", data.Total.Requests, "", displayDollarValue(data.Total.CostUSD)})
	if !verbose {
		return fmt.Sprintf("Claude planner metrics: %s\n\n%s", period, summary.Render())
	}
	details := table.NewWriter()
	details.SetStyle(table.StyleLight)
	details.AppendHeader(table.Row{"DAY", "MODEL", "CAP", "OK", "FB", "TO", "BUDGET", "UNAVAILABLE", "WALL", "API", "INPUT", "OUTPUT", "PROMPT B", "RESPONSE B"})
	for _, metric := range data.Metrics {
		details.AppendRow(table.Row{
			metric.Day.Format(time.DateOnly),
			displayActualModel(metric.ActualModel),
			displayDollarValue(storage.DollarValue{Value: metric.MaxBudgetUSD, Availability: storage.MetricValueExact}),
			metric.Successes,
			metric.Fallbacks,
			metric.Timeouts,
			metric.BudgetFailures,
			metric.ModelUnavailables,
			metric.Unavailables,
			metric.Duration.Round(time.Millisecond),
			displayMilliseconds(metric.APIDurationMilliseconds),
			displayMetricValue(metric.InputTokens),
			displayMetricValue(metric.OutputTokens),
			metric.PromptBytes,
			metric.ResponseBytes,
		})
	}
	return fmt.Sprintf("Claude planner metrics: %s\n\n%s\nDetails\n%s", period, summary.Render(), details.Render())
}

func summarizeClaudeMetrics(metrics []storage.ClaudePlannerDailyMetrics) claudeMetricsTotal {
	total := claudeMetricsTotal{
		InputTokens:  storage.MetricValue{Availability: storage.MetricValueUnavailable},
		OutputTokens: storage.MetricValue{Availability: storage.MetricValueUnavailable},
		CostUSD:      storage.DollarValue{Availability: storage.MetricValueUnavailable},
	}
	if len(metrics) == 0 {
		return total
	}
	var inputTokens, outputTokens int64
	var costUSD float64
	allInputTokens, allOutputTokens, allCosts := true, true, true
	for _, metric := range metrics {
		total.Requests += claudeMetricRequests(metric)
		if metric.InputTokens.Availability == storage.MetricValueExact {
			inputTokens += metric.InputTokens.Value
		} else {
			allInputTokens = false
		}
		if metric.OutputTokens.Availability == storage.MetricValueExact {
			outputTokens += metric.OutputTokens.Value
		} else {
			allOutputTokens = false
		}
		if metric.CostUSD.Availability == storage.MetricValueExact {
			costUSD += metric.CostUSD.Value
		} else {
			allCosts = false
		}
	}
	if allInputTokens {
		total.InputTokens = storage.ExactMetricValue(inputTokens)
	}
	if allOutputTokens {
		total.OutputTokens = storage.ExactMetricValue(outputTokens)
	}
	if allCosts {
		total.CostUSD = storage.DollarValue{Value: costUSD, Availability: storage.MetricValueExact}
	}
	return total
}

func claudeMetricRequests(metric storage.ClaudePlannerDailyMetrics) int {
	return metric.Successes + metric.Fallbacks + metric.Timeouts + metric.BudgetFailures + metric.ModelUnavailables + metric.Unavailables
}

type copilotMetricsTotal struct {
	Requests              int                 `json:"requests"`
	PremiumRequestCredits storage.MetricValue `json:"premiumRequestCredits"`
	CostUSD               storage.DollarValue `json:"costUsd"`
}

func runCopilotMetrics(command *cobra.Command, arguments []string, standardOutput, standardError io.Writer) int {
	if len(arguments) > 1 {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("copilot-metrics accepts at most one workspace path"))
	}
	format, err := cmd.Format(command)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	workspace := "."
	if len(arguments) == 1 {
		workspace = arguments[0]
	}
	workspaceRoot, err := filepath.Abs(workspace)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve metrics workspace path: %w", err))
	}
	database, err := cmd.DatabasePathForCommand(command, workspaceRoot)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve metrics database path: %w", err))
	}
	now := time.Now().UTC()
	dayValue, err := command.Flags().GetString("day")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	monthValue, err := command.Flags().GetString("month")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	verbose, err := command.Flags().GetBool("verbose")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	if dayValue != "" && monthValue != "" {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("--day and --month cannot be used together"))
	}
	var data copilotMetricsData
	var metrics []storage.CopilotPlannerDailyMetrics
	var day, month time.Time
	if dayValue != "" {
		day, err = time.Parse(time.DateOnly, dayValue)
		if err != nil {
			return cmd.WriteError(standardError, cli.NewInvalidArgumentError("--day must use YYYY-MM-DD format"))
		}
		data.Day = day.Format(time.DateOnly)
	} else {
		month = now
		if monthValue != "" {
			month, err = time.Parse("2006-01", monthValue)
			if err != nil {
				return cmd.WriteError(standardError, cli.NewInvalidArgumentError("--month must use YYYY-MM format"))
			}
		}
		data.Month = month.Format("2006-01")
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("open metrics database: %w", err))
	}
	defer store.Close()
	if dayValue != "" {
		metrics, err = store.ReadCopilotPlannerDailyMetrics(context.Background(), storage.CopilotPlannerDailyMetricsRequest{Day: day})
	} else {
		metrics, err = store.ReadCopilotPlannerMonthlyMetrics(context.Background(), storage.CopilotPlannerMonthlyMetricsRequest{Month: month})
	}
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	metrics = metricsWithFinalUsage(metrics)
	data.Metrics = metrics
	data.Total = summarizeCopilotMetrics(metrics)
	if err := cli.Render(standardOutput, cli.Result{
		OmitSnapshot: true,
		Text:         formatCopilotMetricsText(data, verbose),
		Data:         data,
	}, format); err != nil {
		return cmd.WriteError(standardError, err)
	}
	return 0
}

func formatCopilotMetricsText(data copilotMetricsData, verbose bool) string {
	period := data.Month
	if period == "" {
		period = data.Day
	}
	if len(data.Metrics) == 0 {
		return fmt.Sprintf("Copilot planner metrics: %s\n\nNo metrics recorded.", period)
	}
	metricsTable := table.NewWriter()
	metricsTable.SetStyle(table.StyleLight)
	metricsTable.AppendHeader(table.Row{"DAY", "MODEL", "REQUESTS", "CREDITS", "COST"})
	for _, metric := range data.Metrics {
		model := displayActualModel(metric.ActualModel)
		metricsTable.AppendRow(table.Row{
			metric.Day.Format(time.DateOnly),
			model,
			metric.Successes + metric.Failures + metric.Timeouts,
			displayMetricValue(metric.PremiumRequestCredits),
			displayDollarValue(metric.CostUSD),
		})
	}
	footer := "TOTAL"
	if data.Month != "" {
		footer = "MONTH TOTAL"
	}
	metricsTable.AppendFooter(table.Row{footer, "", data.Total.Requests, displayMetricValue(data.Total.PremiumRequestCredits), displayDollarValue(data.Total.CostUSD)})
	summary := metricsTable.Render()
	if !verbose {
		return fmt.Sprintf("Copilot planner metrics: %s\n\n%s", period, summary)
	}
	details := table.NewWriter()
	details.SetStyle(table.StyleLight)
	details.AppendHeader(table.Row{"DAY", "MODEL", "CAP", "OK", "FAILED", "TO", "WALL", "API", "INPUT", "OUTPUT", "CACHE READ", "CACHE WRITE", "REASON", "AIU", "PROMPT B", "RESPONSE B"})
	for _, metric := range data.Metrics {
		details.AppendRow(table.Row{
			metric.Day.Format(time.DateOnly),
			displayActualModel(metric.ActualModel),
			metric.MaxAICredits,
			metric.Successes,
			metric.Failures,
			metric.Timeouts,
			metric.Duration.Round(time.Millisecond),
			displayMilliseconds(metric.APIDurationMilliseconds),
			displayMetricValue(metric.InputTokens),
			displayMetricValue(metric.OutputTokens),
			displayMetricValue(metric.CacheReadTokens),
			displayMetricValue(metric.CacheWriteTokens),
			displayMetricValue(metric.ReasoningTokens),
			displayMetricValue(metric.SessionTotalNanoAiu),
			metric.PromptBytes,
			metric.ResponseBytes,
		})
	}
	return fmt.Sprintf("Copilot planner metrics: %s\n\n%s\nDetails\n%s", period, summary, details.Render())
}

func summarizeCopilotMetrics(metrics []storage.CopilotPlannerDailyMetrics) copilotMetricsTotal {
	total := copilotMetricsTotal{PremiumRequestCredits: storage.MetricValue{Availability: storage.MetricValueUnavailable}, CostUSD: storage.DollarValue{Availability: storage.MetricValueUnavailable}}
	if len(metrics) == 0 {
		return total
	}
	credits := int64(0)
	for _, metric := range metrics {
		requests := metric.Successes + metric.Failures + metric.Timeouts
		total.Requests += requests
		credits += metric.PremiumRequestCredits.Value
	}
	total.PremiumRequestCredits = storage.ExactMetricValue(credits)
	total.CostUSD = storage.DollarValue{Value: float64(credits) / 100, Availability: storage.MetricValueEstimate, EstimateMethod: "used credits / 100"}
	return total
}

func metricsWithFinalUsage(metrics []storage.CopilotPlannerDailyMetrics) []storage.CopilotPlannerDailyMetrics {
	filtered := make([]storage.CopilotPlannerDailyMetrics, 0, len(metrics))
	for _, metric := range metrics {
		if metric.PremiumRequestCredits.Availability == storage.MetricValueExact {
			filtered = append(filtered, metric)
		}
	}
	return filtered
}

func displayActualModel(model string) string {
	if model == "" {
		return "-"
	}
	return model
}

func displayMilliseconds(value storage.MetricValue) string {
	if value.Availability == storage.MetricValueUnavailable {
		return "-"
	}
	return (time.Duration(value.Value) * time.Millisecond).String()
}

func displayMetricValue(value storage.MetricValue) string {
	if value.Availability == storage.MetricValueUnavailable {
		return "-"
	}
	return strconv.FormatInt(value.Value, 10)
}

func displayDollarValue(value storage.DollarValue) string {
	if value.Availability == storage.MetricValueUnavailable {
		return "-"
	}
	return fmt.Sprintf("$%.2f", value.Value)
}
