package copilot

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"agent-wayfinder/index"
	"agent-wayfinder/storage"
)

type CatalogConfiguration struct {
	Path         string
	Model        string
	MaxAICredits int
}

type Runner func(context.Context, string, ...string) *exec.Cmd

type CatalogSynopsisGenerator struct {
	configuration CatalogConfiguration
	runner        Runner
}

type CatalogSynopsisRun struct {
	Synopsis              string
	PremiumRequestCredits storage.MetricValue
}

func NewCatalogSynopsisGenerator(path string, maxAICredits int, runner Runner) CatalogSynopsisGenerator {
	if maxAICredits <= 0 {
		maxAICredits = DefaultAICredits
	}
	return CatalogSynopsisGenerator{
		configuration: CatalogConfiguration{Path: path, MaxAICredits: maxAICredits},
		runner:        runner,
	}
}

func (generator CatalogSynopsisGenerator) GenerateCatalogSynopsis(ctx context.Context, input index.CatalogSynopsisInput) (string, error) {
	return RunCatalogSynopsis(ctx, generator.configuration, input, generator.runner)
}

func RunCatalogSynopsis(parent context.Context, configuration CatalogConfiguration, input index.CatalogSynopsisInput, runner Runner) (string, error) {
	run, err := RunCatalogSynopsisWithUsage(parent, configuration, input, runner)
	return run.Synopsis, err
}

func RunCatalogSynopsisWithUsage(parent context.Context, configuration CatalogConfiguration, input index.CatalogSynopsisInput, runner Runner) (CatalogSynopsisRun, error) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()

	commandPath := configuration.Path
	if commandPath == "" {
		commandPath = "copilot"
	}
	maxAICredits := configuration.MaxAICredits
	if maxAICredits <= 0 {
		maxAICredits = DefaultAICredits
	}
	usageFile, err := os.CreateTemp("", "agent-wayfinder-copilot-catalog-usage-*.json")
	if err != nil {
		return CatalogSynopsisRun{}, fmt.Errorf("create Copilot catalog synopsis usage file: %w", err)
	}
	usagePath := usageFile.Name()
	if err := usageFile.Close(); err != nil {
		_ = os.Remove(usagePath)
		return CatalogSynopsisRun{}, fmt.Errorf("close Copilot catalog synopsis usage file: %w", err)
	}
	defer os.Remove(usagePath)
	prompt := catalogSynopsisPrompt(input)
	arguments := []string{
		"--silent",
		"--output-format", "text",
		"--max-ai-credits", strconv.Itoa(maxAICredits),
		"--available-tools",
		"--disable-builtin-mcps",
		"--no-ask-user",
		"--no-custom-instructions",
		"--usage-output-file", usagePath,
		"--prompt", prompt,
	}
	if configuration.Model != "" {
		arguments = append(arguments, "--model", configuration.Model)
	}
	command := runner(ctx, commandPath, arguments...)
	response, err := command.StdoutPipe()
	if err != nil {
		return CatalogSynopsisRun{}, fmt.Errorf("open Copilot catalog synopsis output: %w", err)
	}
	if err := command.Start(); err != nil {
		return CatalogSynopsisRun{}, fmt.Errorf("start Copilot catalog synopsis: %w", err)
	}
	contents, readErr := ReadResponse(ctx, prompt, 4096, response)
	waitErr := command.Wait()
	run := CatalogSynopsisRun{PremiumRequestCredits: storage.MetricValue{Availability: storage.MetricValueUnavailable}}
	if usage, usageErr := readUsageFile(usagePath); usageErr == nil {
		run.PremiumRequestCredits = storage.ExactMetricValue(usage.PremiumRequestCredits)
	}
	if readErr != nil {
		return run, readErr
	}
	if waitErr != nil {
		return run, fmt.Errorf("run Copilot catalog synopsis: %w", waitErr)
	}
	run.Synopsis = strings.TrimSpace(string(contents))
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
