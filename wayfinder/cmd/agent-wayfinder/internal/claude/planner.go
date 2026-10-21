package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"agent-wayfinder/query"
	"agent-wayfinder/storage"
)

const plannerMaxResponseBytes = 8 * 1024

var (
	ErrTimeout          = errors.New("Claude planner timed out")
	ErrBudgetExceeded   = errors.New("Claude planner exceeded its budget")
	ErrModelUnavailable = errors.New("Claude planner model is unavailable")
)

type Configuration struct {
	Enabled       bool
	Path          string
	Model         string
	FallbackModel string
	MaxBudgetUSD  float64
	Effort        string
	Timeout       time.Duration
}

type Runner func(context.Context, string, ...string) *exec.Cmd

type RunResult struct {
	RecordedAt              time.Time
	Response                []byte
	Duration                time.Duration
	PromptBytes             int64
	ResponseBytes           int64
	Model                   string
	ActualModel             string
	FallbackModel           string
	UsedFallbackModel       bool
	InputTokens             storage.MetricValue
	OutputTokens            storage.MetricValue
	APIDurationMilliseconds storage.MetricValue
	CostUSD                 storage.DollarValue
}

func RunGraphPlanner(parent context.Context, configuration Configuration, request query.GraphPlanningRequest, runner Runner) (RunResult, error) {
	prompt, err := query.GraphPlanningPrompt(request)
	if err != nil {
		return RunResult{}, err
	}
	configuration.FallbackModel = ""
	return runPlannerPrompt(parent, configuration, prompt, query.GraphPlanningResponseSchema, runner)
}

func runPlannerPrompt(parent context.Context, configuration Configuration, prompt, schema string, runner Runner) (RunResult, error) {
	started := time.Now()
	run := RunResult{
		RecordedAt:              started.UTC(),
		Model:                   configuration.Model,
		FallbackModel:           configuration.FallbackModel,
		InputTokens:             storage.MetricValue{Availability: storage.MetricValueUnavailable},
		OutputTokens:            storage.MetricValue{Availability: storage.MetricValueUnavailable},
		APIDurationMilliseconds: storage.MetricValue{Availability: storage.MetricValueUnavailable},
		CostUSD:                 storage.DollarValue{Availability: storage.MetricValueUnavailable},
	}
	ctx, cancel := context.WithTimeout(parent, configuration.Timeout)
	defer cancel()

	run.PromptBytes = int64(len(prompt))
	arguments := []string{"-p", prompt, "--output-format", "json", "--bare", "--tools", "", "--model", configuration.Model}
	if configuration.FallbackModel != "" {
		arguments = append(arguments, "--fallback-model", configuration.FallbackModel)
	}
	if configuration.MaxBudgetUSD > 0 {
		arguments = append(arguments, "--max-budget-usd", strconv.FormatFloat(configuration.MaxBudgetUSD, 'f', -1, 64))
	}
	if configuration.Effort != "" {
		arguments = append(arguments, "--effort", configuration.Effort)
	}
	arguments = append(arguments, "--json-schema", schema, "--no-session-persistence")
	command := runner(ctx, configuration.Path, arguments...)
	var standardError bytes.Buffer
	command.Stderr = &standardError
	response, err := command.StdoutPipe()
	if err != nil {
		run.Duration = time.Since(started)
		return run, fmt.Errorf("open Claude planner output: %w", err)
	}
	if err := command.Start(); err != nil {
		run.Duration = time.Since(started)
		return run, fmt.Errorf("start Claude planner: %w", err)
	}
	contents, readErr := io.ReadAll(io.LimitReader(response, plannerMaxResponseBytes+1))
	closeErr := response.Close()
	waitErr := command.Wait()
	run.Duration = time.Since(started)
	run.ResponseBytes = int64(len(contents))
	if readErr != nil {
		if ctx.Err() != nil {
			return run, fmt.Errorf("%w: %w", ErrTimeout, ctx.Err())
		}
		return run, fmt.Errorf("read Claude planner response: %w", readErr)
	}
	if closeErr != nil {
		return run, fmt.Errorf("close Claude planner output: %w", closeErr)
	}
	if len(contents) > plannerMaxResponseBytes {
		return run, fmt.Errorf("read Claude planner response: exceeds %d bytes", plannerMaxResponseBytes)
	}
	if ctx.Err() != nil {
		return run, fmt.Errorf("%w: %w", ErrTimeout, ctx.Err())
	}
	if waitErr != nil {
		message := strings.TrimSpace(standardError.String())
		if strings.Contains(strings.ToLower(message), "budget") {
			return run, fmt.Errorf("%w: %s", ErrBudgetExceeded, message)
		}
		if modelUnavailable(message) {
			return run, fmt.Errorf("%w: %s", ErrModelUnavailable, message)
		}
		if message == "" {
			return run, fmt.Errorf("run Claude planner: %w", waitErr)
		}
		return run, fmt.Errorf("run Claude planner: %w: %s", waitErr, message)
	}

	var result struct {
		StructuredOutput json.RawMessage `json:"structured_output"`
		Result           string          `json:"result"`
		IsError          bool            `json:"is_error"`
		Model            string          `json:"model"`
		DurationAPIMS    int64           `json:"duration_api_ms"`
		TotalCostUSD     *float64        `json:"total_cost_usd"`
		Usage            struct {
			InputTokens  int64 `json:"input_tokens"`
			OutputTokens int64 `json:"output_tokens"`
		} `json:"usage"`
		ModelUsage map[string]struct {
			InputTokens  int64 `json:"inputTokens"`
			OutputTokens int64 `json:"outputTokens"`
		} `json:"modelUsage"`
	}
	if err := json.Unmarshal(contents, &result); err != nil {
		return run, fmt.Errorf("parse Claude planner response: %w", err)
	}
	if result.IsError {
		if modelUnavailable(string(contents)) {
			return run, fmt.Errorf("%w: returned an error result", ErrModelUnavailable)
		}
		return run, fmt.Errorf("run Claude planner: returned an error result")
	}
	run.ActualModel = result.Model
	if run.ActualModel == "" {
		if _, exists := result.ModelUsage[configuration.Model]; exists {
			run.ActualModel = configuration.Model
		} else if configuration.FallbackModel != "" {
			if _, exists := result.ModelUsage[configuration.FallbackModel]; exists {
				run.ActualModel = configuration.FallbackModel
			}
		}
		if run.ActualModel == "" && len(result.ModelUsage) == 1 {
			for model := range result.ModelUsage {
				run.ActualModel = model
			}
		}
	}
	run.UsedFallbackModel = run.ActualModel != "" && run.ActualModel != configuration.Model
	if result.Usage.InputTokens > 0 {
		run.InputTokens = storage.ExactMetricValue(result.Usage.InputTokens)
	} else if usage, exists := result.ModelUsage[run.ActualModel]; exists && usage.InputTokens > 0 {
		run.InputTokens = storage.ExactMetricValue(usage.InputTokens)
	}
	if result.Usage.OutputTokens > 0 {
		run.OutputTokens = storage.ExactMetricValue(result.Usage.OutputTokens)
	} else if usage, exists := result.ModelUsage[run.ActualModel]; exists && usage.OutputTokens > 0 {
		run.OutputTokens = storage.ExactMetricValue(usage.OutputTokens)
	}
	if result.DurationAPIMS > 0 {
		run.APIDurationMilliseconds = storage.ExactMetricValue(result.DurationAPIMS)
	}
	if result.TotalCostUSD != nil {
		run.CostUSD = storage.DollarValue{Value: *result.TotalCostUSD, Availability: storage.MetricValueExact}
	}
	if len(result.StructuredOutput) > 0 && string(result.StructuredOutput) != "null" {
		run.Response = result.StructuredOutput
	} else if strings.TrimSpace(result.Result) == "" {
		return run, fmt.Errorf("parse Claude planner response: missing result")
	} else {
		run.Response = []byte(result.Result)
	}
	return run, nil
}

func NewPlannerMetric(configuration Configuration, run RunResult, outcome storage.ClaudePlannerOutcome) storage.ClaudePlannerMetric {
	return storage.ClaudePlannerMetric{
		RecordedAt:              run.RecordedAt,
		Model:                   configuration.Model,
		ActualModel:             run.ActualModel,
		FallbackModel:           configuration.FallbackModel,
		MaxBudgetUSD:            configuration.MaxBudgetUSD,
		Effort:                  configuration.Effort,
		Outcome:                 outcome,
		Duration:                run.Duration,
		PromptBytes:             run.PromptBytes,
		ResponseBytes:           run.ResponseBytes,
		InputTokens:             run.InputTokens,
		OutputTokens:            run.OutputTokens,
		APIDurationMilliseconds: run.APIDurationMilliseconds,
		CostUSD:                 run.CostUSD,
	}
}

func modelUnavailable(message string) bool {
	message = strings.ToLower(message)
	if !strings.Contains(message, "model") {
		return false
	}
	for _, marker := range []string{"not available", "unavailable", "not found", "unsupported", "not supported", "invalid"} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}
