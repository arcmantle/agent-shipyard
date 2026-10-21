package copilot

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"agent-wayfinder/query"
	"agent-wayfinder/storage"
)

const defaultLunaReasoningEffort = "high"

var ErrPlannerModelUnavailable = errors.New("Copilot planner model is unavailable")

type PlannerUsage struct {
	ActualModel           string
	InputTokens           int64
	OutputTokens          int64
	CacheReadTokens       int64
	CacheWriteTokens      int64
	ReasoningTokens       int64
	TotalNanoAiu          int64
	PremiumRequestCredits int64
	UserRequests          int64
	APIDuration           time.Duration
}

type PlannerRun struct {
	RecordedAt          time.Time
	Response            []byte
	Duration            time.Duration
	PromptBytes         int64
	ResponseBytes       int64
	OutputTokens        storage.MetricValue
	SessionTotalNanoAiu storage.MetricValue
	Usage               PlannerUsage
	UsageAvailable      bool
}

func ParseUsageReport(reader io.Reader) (PlannerUsage, error) {
	var report struct {
		CurrentModel            string `json:"currentModel"`
		TotalNanoAiu            int64  `json:"totalNanoAiu"`
		TotalPremiumRequestCost int64  `json:"totalPremiumRequestCost"`
		TotalUserRequests       int64  `json:"totalUserRequests"`
		TotalAPIDurationMS      int64  `json:"totalApiDurationMs"`
		ModelMetrics            map[string]struct {
			Usage struct {
				InputTokens      int64 `json:"inputTokens"`
				OutputTokens     int64 `json:"outputTokens"`
				CacheReadTokens  int64 `json:"cacheReadTokens"`
				CacheWriteTokens int64 `json:"cacheWriteTokens"`
				ReasoningTokens  int64 `json:"reasoningTokens"`
			} `json:"usage"`
		} `json:"modelMetrics"`
	}
	if err := json.NewDecoder(reader).Decode(&report); err != nil {
		return PlannerUsage{}, fmt.Errorf("decode Copilot usage report: %w", err)
	}
	modelMetrics, found := report.ModelMetrics[report.CurrentModel]
	if report.CurrentModel == "" || !found {
		return PlannerUsage{}, fmt.Errorf("decode Copilot usage report: current model usage is missing")
	}
	return PlannerUsage{
		ActualModel:           report.CurrentModel,
		InputTokens:           modelMetrics.Usage.InputTokens,
		OutputTokens:          modelMetrics.Usage.OutputTokens,
		CacheReadTokens:       modelMetrics.Usage.CacheReadTokens,
		CacheWriteTokens:      modelMetrics.Usage.CacheWriteTokens,
		ReasoningTokens:       modelMetrics.Usage.ReasoningTokens,
		TotalNanoAiu:          report.TotalNanoAiu,
		PremiumRequestCredits: report.TotalPremiumRequestCost,
		UserRequests:          report.TotalUserRequests,
		APIDuration:           time.Duration(report.TotalAPIDurationMS) * time.Millisecond,
	}, nil
}

func RunGraphPlanner(parent context.Context, configuration Configuration, request query.GraphPlanningRequest, runner Runner) (PlannerRun, error) {
	prompt, err := query.GraphPlanningPrompt(request)
	if err != nil {
		return PlannerRun{}, err
	}
	return runPlannerPrompt(parent, configuration, prompt, runner)
}

func runPlannerPrompt(parent context.Context, configuration Configuration, prompt string, runner Runner) (PlannerRun, error) {
	started := time.Now()
	result := PlannerRun{
		RecordedAt:          started.UTC(),
		OutputTokens:        storage.MetricValue{Availability: storage.MetricValueUnavailable},
		SessionTotalNanoAiu: storage.MetricValue{Availability: storage.MetricValueUnavailable},
	}
	ctx, cancel := context.WithTimeout(parent, configuration.Timeout)
	defer cancel()

	result.PromptBytes = int64(len(prompt))
	if EstimateTokens(prompt) >= configuration.TokenBudget {
		result.Duration = time.Since(started)
		return result, ErrPromptBudgetExceeded
	}
	usageFile, err := os.CreateTemp("", "agent-wayfinder-copilot-usage-*.json")
	if err != nil {
		result.Duration = time.Since(started)
		return result, fmt.Errorf("create Copilot usage file: %w", err)
	}
	usagePath := usageFile.Name()
	if err := usageFile.Close(); err != nil {
		_ = os.Remove(usagePath)
		result.Duration = time.Since(started)
		return result, fmt.Errorf("close Copilot usage file: %w", err)
	}
	defer os.Remove(usagePath)
	arguments := []string{
		"--silent",
		"--output-format", "json",
		"--available-tools",
		"--disable-builtin-mcps",
		"--no-ask-user",
		"--no-custom-instructions",
	}
	if configuration.Model != AutomaticModel {
		arguments = append(arguments, "--model", configuration.Model)
	}
	if configuration.Model == DefaultModel {
		arguments = append(arguments, "--reasoning-effort", defaultLunaReasoningEffort)
	}
	arguments = append(arguments, "--max-ai-credits", strconv.Itoa(configuration.MaxAICredits), "--usage-output-file", usagePath, "--prompt", prompt)
	command := runner(ctx, "copilot", arguments...)
	var standardError bytes.Buffer
	command.Stderr = &standardError
	response, err := command.StdoutPipe()
	if err != nil {
		result.Duration = time.Since(started)
		return result, fmt.Errorf("open Copilot planner output: %w", err)
	}
	if err := command.Start(); err != nil {
		result.Duration = time.Since(started)
		return result, fmt.Errorf("start Copilot planner: %w", err)
	}
	events, readErr := readPlannerEvents(ctx, response)
	result.ResponseBytes = events.responseBytes
	result.OutputTokens = events.outputTokens
	result.SessionTotalNanoAiu = events.sessionTotalNanoAiu
	if readErr == nil {
		result.Response, readErr = ReadResponse(ctx, prompt, configuration.TokenBudget, io.NopCloser(bytes.NewReader(events.response)))
	}
	waitErr := command.Wait()
	result.Duration = time.Since(started)
	if usage, usageErr := readUsageFile(usagePath); usageErr == nil {
		result.Usage = usage
		result.UsageAvailable = true
		result.OutputTokens = storage.ExactMetricValue(usage.OutputTokens)
		result.SessionTotalNanoAiu = storage.ExactMetricValue(usage.TotalNanoAiu)
	}
	if readErr != nil && errors.Is(readErr, ErrPlannerTimeout) {
		return result, readErr
	}
	if waitErr != nil {
		if plannerModelUnavailable(standardError.String()) {
			return result, fmt.Errorf("%w: %s", ErrPlannerModelUnavailable, strings.TrimSpace(standardError.String()))
		}
		return result, fmt.Errorf("run Copilot planner: %w", waitErr)
	}
	if readErr != nil {
		return result, readErr
	}
	return result, nil
}

func NewPlannerMetric(configuration Configuration, run PlannerRun, outcome storage.CopilotPlannerOutcome) storage.CopilotPlannerMetric {
	return storage.CopilotPlannerMetric{
		RecordedAt:              run.RecordedAt,
		Model:                   configuration.Model,
		ActualModel:             run.Usage.ActualModel,
		MaxAICredits:            configuration.MaxAICredits,
		Outcome:                 outcome,
		Duration:                run.Duration,
		PromptBytes:             run.PromptBytes,
		ResponseBytes:           run.ResponseBytes,
		InputTokens:             usageMetricValue(run.UsageAvailable, run.Usage.InputTokens),
		OutputTokens:            run.OutputTokens,
		CacheReadTokens:         usageMetricValue(run.UsageAvailable, run.Usage.CacheReadTokens),
		CacheWriteTokens:        usageMetricValue(run.UsageAvailable, run.Usage.CacheWriteTokens),
		ReasoningTokens:         usageMetricValue(run.UsageAvailable, run.Usage.ReasoningTokens),
		SessionTotalNanoAiu:     run.SessionTotalNanoAiu,
		PremiumRequestCredits:   usageMetricValue(run.UsageAvailable, run.Usage.PremiumRequestCredits),
		UserRequests:            usageMetricValue(run.UsageAvailable, run.Usage.UserRequests),
		APIDurationMilliseconds: usageMetricValue(run.UsageAvailable, run.Usage.APIDuration.Milliseconds()),
	}
}

func plannerModelUnavailable(standardError string) bool {
	message := strings.ToLower(standardError)
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

func readUsageFile(path string) (PlannerUsage, error) {
	file, err := os.Open(path)
	if err != nil {
		return PlannerUsage{}, fmt.Errorf("open Copilot usage file: %w", err)
	}
	defer file.Close()
	return ParseUsageReport(file)
}

func usageMetricValue(available bool, value int64) storage.MetricValue {
	if !available {
		return storage.MetricValue{Availability: storage.MetricValueUnavailable}
	}
	return storage.ExactMetricValue(value)
}

type plannerEvents struct {
	response            []byte
	responseBytes       int64
	outputTokens        storage.MetricValue
	sessionTotalNanoAiu storage.MetricValue
}

type countingReadCloser struct {
	io.ReadCloser
	count int64
}

func (reader *countingReadCloser) Read(contents []byte) (int, error) {
	count, err := reader.ReadCloser.Read(contents)
	reader.count += int64(count)
	return count, err
}

func readPlannerEvents(ctx context.Context, response io.ReadCloser) (plannerEvents, error) {
	events := plannerEvents{
		outputTokens:        storage.MetricValue{Availability: storage.MetricValueUnavailable},
		sessionTotalNanoAiu: storage.MetricValue{Availability: storage.MetricValueUnavailable},
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = response.Close()
		case <-done:
		}
	}()
	defer close(done)
	defer response.Close()

	countedResponse := &countingReadCloser{ReadCloser: response}
	scanner := bufio.NewScanner(countedResponse)
	scanner.Buffer(make([]byte, 1024), 64*1024)
	for scanner.Scan() {
		var event struct {
			Type string `json:"type"`
			Data struct {
				Content      string `json:"content"`
				OutputTokens *int64 `json:"outputTokens"`
				TotalNanoAiu *int64 `json:"totalNanoAiu"`
			} `json:"data"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			return events, fmt.Errorf("read Copilot planner event: %w", err)
		}
		if event.Data.OutputTokens != nil {
			events.outputTokens = storage.ExactMetricValue(*event.Data.OutputTokens)
		}
		if event.Data.TotalNanoAiu != nil {
			events.sessionTotalNanoAiu = storage.ExactMetricValue(*event.Data.TotalNanoAiu)
		}
		if event.Type != "assistant.message" && event.Type != "assistant_message" {
			continue
		}
		events.response = append([]byte(nil), event.Data.Content...)
	}
	events.responseBytes = countedResponse.count
	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return events, fmt.Errorf("%w: %w", ErrPlannerTimeout, ctx.Err())
		}
		return events, fmt.Errorf("read Copilot planner event: %w", err)
	}
	if ctx.Err() != nil {
		return events, fmt.Errorf("%w: %w", ErrPlannerTimeout, ctx.Err())
	}
	if len(events.response) == 0 {
		return events, fmt.Errorf("read Copilot planner event: assistant response is missing")
	}
	return events, nil
}
