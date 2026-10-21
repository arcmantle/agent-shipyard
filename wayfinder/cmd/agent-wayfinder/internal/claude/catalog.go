package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"agent-wayfinder/index"
	"agent-wayfinder/storage"
)

const catalogSynopsisMaxResponseBytes = 4096

type CatalogSynopsisGenerator struct {
	configuration Configuration
	runner        Runner
}

type CatalogSynopsisRun struct {
	Synopsis string
	CostUSD  storage.DollarValue
}

func NewCatalogSynopsisGenerator(configuration Configuration, runner Runner) CatalogSynopsisGenerator {
	return CatalogSynopsisGenerator{configuration: configuration, runner: runner}
}

func (generator CatalogSynopsisGenerator) GenerateCatalogSynopsis(parent context.Context, unit index.CatalogSynopsisInput) (string, error) {
	run, err := RunCatalogSynopsis(parent, generator.configuration, unit, generator.runner)
	return run.Synopsis, err
}

func RunCatalogSynopsis(parent context.Context, configuration Configuration, unit index.CatalogSynopsisInput, runner Runner) (CatalogSynopsisRun, error) {
	ctx, cancel := context.WithTimeout(parent, configuration.Timeout)
	defer cancel()

	prompt := catalogSynopsisPrompt(unit)
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
	arguments = append(arguments, "--no-session-persistence")
	command := runner(ctx, configuration.Path, arguments...)
	var standardError bytes.Buffer
	command.Stderr = &standardError
	response, err := command.StdoutPipe()
	if err != nil {
		return CatalogSynopsisRun{}, fmt.Errorf("open Claude catalog synopsis output: %w", err)
	}
	if err := command.Start(); err != nil {
		return CatalogSynopsisRun{}, fmt.Errorf("start Claude catalog synopsis: %w", err)
	}
	contents, readErr := io.ReadAll(io.LimitReader(response, catalogSynopsisMaxResponseBytes+1))
	closeErr := response.Close()
	waitErr := command.Wait()
	if readErr != nil {
		return CatalogSynopsisRun{}, fmt.Errorf("read Claude catalog synopsis: %w", readErr)
	}
	if closeErr != nil {
		return CatalogSynopsisRun{}, fmt.Errorf("close Claude catalog synopsis output: %w", closeErr)
	}
	if len(contents) > catalogSynopsisMaxResponseBytes {
		return CatalogSynopsisRun{}, fmt.Errorf("read Claude catalog synopsis: exceeds %d bytes", catalogSynopsisMaxResponseBytes)
	}
	if waitErr != nil {
		message := strings.TrimSpace(standardError.String())
		if message == "" {
			return CatalogSynopsisRun{}, fmt.Errorf("run Claude catalog synopsis: %w", waitErr)
		}
		return CatalogSynopsisRun{}, fmt.Errorf("run Claude catalog synopsis: %w: %s", waitErr, message)
	}
	var result struct {
		Result       string   `json:"result"`
		IsError      bool     `json:"is_error"`
		TotalCostUSD *float64 `json:"total_cost_usd"`
	}
	if err := json.Unmarshal(contents, &result); err != nil {
		return CatalogSynopsisRun{}, fmt.Errorf("parse Claude catalog synopsis: %w", err)
	}
	run := CatalogSynopsisRun{CostUSD: storage.DollarValue{Availability: storage.MetricValueUnavailable}}
	if result.TotalCostUSD != nil {
		run.CostUSD = storage.DollarValue{Value: *result.TotalCostUSD, Availability: storage.MetricValueExact}
	}
	if result.IsError || strings.TrimSpace(result.Result) == "" {
		return run, fmt.Errorf("parse Claude catalog synopsis: missing result")
	}
	run.Synopsis = strings.TrimSpace(result.Result)
	return run, nil
}

func catalogSynopsisPrompt(unit index.CatalogSynopsisInput) string {
	return "Write one concise factual capability synopsis based only on the supplied catalog unit. Do not make claims that the input does not support. Do not use tools. Return synopsis text only.\n" +
		"Name: " + unit.Name + "\n" +
		"Kind: " + string(unit.Kind) + "\n" +
		"Owner: " + unit.Owner + "\n" +
		"Signature: " + unit.Signature + "\n" +
		"Comments: " + strings.Join(unit.Comments, " ") + "\n" +
		"Identifiers: " + strings.Join(unit.IdentifierTokens, " ") + "\n" +
		"Declaration source:\n" + unit.DeclarationSource
}
