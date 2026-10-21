package claude

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	configpath "agent-wayfinder/cmd/agent-wayfinder/internal/configuration"
	"agent-wayfinder/cmd/agent-wayfinder/internal/planning"

	"github.com/spf13/cobra"
)

const (
	DefaultPlannerPath  = "claude"
	DefaultPlannerModel = "sonnet"
	maximumTimeout      = 30 * time.Second
)

var modelPattern = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)

type configurationFile struct {
	Path          *string         `json:"path"`
	Model         *string         `json:"model"`
	FallbackModel *string         `json:"fallbackModel"`
	MaxBudgetUSD  *float64        `json:"maxBudgetUsd"`
	Effort        *string         `json:"effort"`
	Timeout       json.RawMessage `json:"timeout"`
}

type ConfigurationReport struct {
	Enabled       bool                 `json:"enabled"`
	Path          string               `json:"path"`
	Model         string               `json:"model"`
	FallbackModel string               `json:"fallbackModel,omitempty"`
	MaxBudgetUSD  float64              `json:"maxBudgetUsd,omitempty"`
	Effort        string               `json:"effort,omitempty"`
	Timeout       string               `json:"timeout"`
	Sources       ConfigurationSources `json:"sources"`
}

func (report ConfigurationReport) PlannerConfiguration() (Configuration, error) {
	timeout, err := time.ParseDuration(report.Timeout)
	if err != nil {
		return Configuration{}, fmt.Errorf("parse effective Claude timeout: %w", err)
	}
	return Configuration{Enabled: report.Enabled, Path: report.Path, Model: report.Model, FallbackModel: report.FallbackModel, MaxBudgetUSD: report.MaxBudgetUSD, Effort: report.Effort, Timeout: timeout}, nil
}

type ConfigurationSources struct {
	Enabled       string `json:"enabled"`
	Path          string `json:"path"`
	Model         string `json:"model"`
	FallbackModel string `json:"fallbackModel"`
	MaxBudgetUSD  string `json:"maxBudgetUsd"`
	Effort        string `json:"effort"`
	Timeout       string `json:"timeout"`
}

func ReadConfiguration(workspaceRoot string) (Configuration, error) {
	configuration := Configuration{Path: DefaultPlannerPath, Model: DefaultPlannerModel, Timeout: maximumTimeout}
	paths := configpath.Paths(workspaceRoot)
	for _, path := range paths {
		fileConfiguration, err := readConfigurationFile(path)
		if err != nil {
			return Configuration{}, err
		}
		applyFileConfiguration(&configuration, fileConfiguration)
		if len(fileConfiguration.Timeout) != 0 {
			configuration.Timeout, err = parseJSONTimeout(fileConfiguration.Timeout)
			if err != nil {
				return Configuration{}, fmt.Errorf("invalid planning.claude.timeout: %w", err)
			}
		}
	}
	provider, err := planning.ReadProvider(workspaceRoot)
	if err != nil {
		return Configuration{}, err
	}
	configuration.Enabled = provider == planning.ProviderClaude
	if err := applyEnvironment(&configuration); err != nil {
		return Configuration{}, err
	}
	if err := ValidateConfiguration(configuration); err != nil {
		return Configuration{}, err
	}
	return configuration, nil
}

func ResolveConfiguration(command *cobra.Command, workspaceRoot string) (Configuration, error) {
	report, err := ResolveConfigurationReport(command, workspaceRoot)
	if err != nil {
		return Configuration{}, err
	}
	return report.PlannerConfiguration()
}

func ResolveConfigurationReport(command *cobra.Command, workspaceRoot string) (ConfigurationReport, error) {
	configuration, err := ReadConfiguration(workspaceRoot)
	if err != nil {
		return ConfigurationReport{}, err
	}
	sources, err := configurationSources(workspaceRoot)
	if err != nil {
		return ConfigurationReport{}, err
	}
	flags := command.Flags()
	if flags.Changed("claude") {
		configuration.Enabled, err = flags.GetBool("claude")
		sources.Enabled = "flag"
	}
	if err == nil && flags.Changed("claude-path") {
		configuration.Path, err = flags.GetString("claude-path")
		sources.Path = "flag"
	}
	if err == nil && flags.Changed("claude-model") {
		configuration.Model, err = flags.GetString("claude-model")
		sources.Model = "flag"
	}
	if err == nil && flags.Changed("claude-fallback-model") {
		configuration.FallbackModel, err = flags.GetString("claude-fallback-model")
		sources.FallbackModel = "flag"
	}
	if err == nil && flags.Changed("claude-max-budget-usd") {
		configuration.MaxBudgetUSD, err = flags.GetFloat64("claude-max-budget-usd")
		sources.MaxBudgetUSD = "flag"
	}
	if err == nil && flags.Changed("claude-effort") {
		configuration.Effort, err = flags.GetString("claude-effort")
		sources.Effort = "flag"
	}
	if err == nil && flags.Changed("claude-timeout") {
		var timeout string
		timeout, err = flags.GetString("claude-timeout")
		if err == nil {
			configuration.Timeout, err = parseTimeout(timeout)
			sources.Timeout = "flag"
		}
	}
	if err != nil {
		return ConfigurationReport{}, err
	}
	if err := ValidateConfiguration(configuration); err != nil {
		return ConfigurationReport{}, err
	}
	return ConfigurationReport{Enabled: configuration.Enabled, Path: configuration.Path, Model: configuration.Model, FallbackModel: configuration.FallbackModel, MaxBudgetUSD: configuration.MaxBudgetUSD, Effort: configuration.Effort, Timeout: configuration.Timeout.String(), Sources: sources}, nil
}

func applyFileConfiguration(configuration *Configuration, file configurationFile) {
	if file.Path != nil {
		configuration.Path = *file.Path
	}
	if file.Model != nil {
		configuration.Model = *file.Model
	}
	if file.FallbackModel != nil {
		configuration.FallbackModel = *file.FallbackModel
	}
	if file.MaxBudgetUSD != nil {
		configuration.MaxBudgetUSD = *file.MaxBudgetUSD
	}
	if file.Effort != nil {
		configuration.Effort = *file.Effort
	}
}

func configurationSources(workspaceRoot string) (ConfigurationSources, error) {
	sources := ConfigurationSources{Enabled: "default", Path: "default", Model: "default", FallbackModel: "default", MaxBudgetUSD: "default", Effort: "default", Timeout: "default"}
	providerSource, err := planning.ReadProviderSource(workspaceRoot)
	if err != nil {
		return ConfigurationSources{}, err
	}
	sources.Enabled = providerSource
	paths := configpath.Paths(workspaceRoot)
	for index, path := range paths {
		configuration, err := readConfigurationFile(path)
		if err != nil {
			return ConfigurationSources{}, err
		}
		source := "user"
		if index == len(paths)-1 {
			source = "workspace"
		}
		if configuration.Path != nil {
			sources.Path = source
		}
		if configuration.Model != nil {
			sources.Model = source
		}
		if configuration.FallbackModel != nil {
			sources.FallbackModel = source
		}
		if configuration.MaxBudgetUSD != nil {
			sources.MaxBudgetUSD = source
		}
		if configuration.Effort != nil {
			sources.Effort = source
		}
		if len(configuration.Timeout) > 0 {
			sources.Timeout = source
		}
	}
	for variable, apply := range map[string]func(){
		"WAYFINDER_CLAUDE_ENABLED":        func() { sources.Enabled = "environment" },
		"WAYFINDER_CLAUDE_PATH":           func() { sources.Path = "environment" },
		"WAYFINDER_CLAUDE_MODEL":          func() { sources.Model = "environment" },
		"WAYFINDER_CLAUDE_FALLBACK_MODEL": func() { sources.FallbackModel = "environment" },
		"WAYFINDER_CLAUDE_MAX_BUDGET_USD": func() { sources.MaxBudgetUSD = "environment" },
		"WAYFINDER_CLAUDE_EFFORT":         func() { sources.Effort = "environment" },
		"WAYFINDER_CLAUDE_TIMEOUT":        func() { sources.Timeout = "environment" },
	} {
		if _, exists := os.LookupEnv(variable); exists {
			apply()
		}
	}
	return sources, nil
}

func applyEnvironment(configuration *Configuration) error {
	if value, exists := os.LookupEnv("WAYFINDER_CLAUDE_ENABLED"); exists {
		if value != "true" && value != "false" {
			return fmt.Errorf("invalid WAYFINDER_CLAUDE_ENABLED: use true or false")
		}
		configuration.Enabled = value == "true"
	}
	if value, exists := os.LookupEnv("WAYFINDER_CLAUDE_PATH"); exists {
		configuration.Path = value
	}
	if value, exists := os.LookupEnv("WAYFINDER_CLAUDE_MODEL"); exists {
		configuration.Model = value
	}
	if value, exists := os.LookupEnv("WAYFINDER_CLAUDE_FALLBACK_MODEL"); exists {
		configuration.FallbackModel = value
	}
	if value, exists := os.LookupEnv("WAYFINDER_CLAUDE_MAX_BUDGET_USD"); exists {
		budget, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return fmt.Errorf("invalid WAYFINDER_CLAUDE_MAX_BUDGET_USD: %w", err)
		}
		configuration.MaxBudgetUSD = budget
	}
	if value, exists := os.LookupEnv("WAYFINDER_CLAUDE_EFFORT"); exists {
		configuration.Effort = value
	}
	if value, exists := os.LookupEnv("WAYFINDER_CLAUDE_TIMEOUT"); exists {
		timeout, err := parseTimeout(value)
		if err != nil {
			return fmt.Errorf("invalid WAYFINDER_CLAUDE_TIMEOUT: %w", err)
		}
		configuration.Timeout = timeout
	}
	return nil
}

func readConfigurationFile(path string) (configurationFile, error) {
	contents, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return configurationFile{}, nil
	}
	if err != nil {
		return configurationFile{}, fmt.Errorf("read Claude planner configuration: %w", err)
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(contents, &root); err != nil {
		return configurationFile{}, fmt.Errorf("parse Claude planner configuration: %w", err)
	}
	planning, exists := root["planning"]
	if !exists {
		return configurationFile{}, nil
	}
	var planningContents map[string]json.RawMessage
	if err := json.Unmarshal(planning, &planningContents); err != nil {
		return configurationFile{}, fmt.Errorf("parse Claude planner configuration: %w", err)
	}
	planner, exists := planningContents["claude"]
	if !exists {
		return configurationFile{}, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(planner))
	decoder.DisallowUnknownFields()
	var configuration configurationFile
	if err := decoder.Decode(&configuration); err != nil {
		return configurationFile{}, fmt.Errorf("parse Claude planner configuration: %w", err)
	}
	return configuration, nil
}

func parseJSONTimeout(value json.RawMessage) (time.Duration, error) {
	var duration string
	if err := json.Unmarshal(value, &duration); err == nil {
		return parseTimeout(duration)
	}
	var seconds int
	if err := json.Unmarshal(value, &seconds); err != nil {
		return 0, fmt.Errorf("use a duration string or integer seconds")
	}
	return parseTimeout(strconv.Itoa(seconds))
}

func parseTimeout(value string) (time.Duration, error) {
	if strings.TrimSpace(value) != value || value == "" {
		return 0, fmt.Errorf("use a duration or integer seconds")
	}
	if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second, nil
	}
	duration, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("use a duration or integer seconds")
	}
	return duration, nil
}

func ValidateConfiguration(configuration Configuration) error {
	if strings.TrimSpace(configuration.Path) == "" {
		return fmt.Errorf("invalid Claude planner path")
	}
	if strings.TrimSpace(configuration.Model) == "" || !modelPattern.MatchString(configuration.Model) {
		return fmt.Errorf("invalid Claude planner model %q", configuration.Model)
	}
	if configuration.FallbackModel != "" && !modelPattern.MatchString(configuration.FallbackModel) {
		return fmt.Errorf("invalid Claude planner fallback model %q", configuration.FallbackModel)
	}
	if math.IsNaN(configuration.MaxBudgetUSD) || math.IsInf(configuration.MaxBudgetUSD, 0) || configuration.MaxBudgetUSD < 0 {
		return fmt.Errorf("invalid Claude planner maximum budget: use zero or a finite positive amount")
	}
	if configuration.Effort != "" {
		switch configuration.Effort {
		case "low", "medium", "high", "xhigh", "max":
		default:
			return fmt.Errorf("invalid Claude planner effort %q", configuration.Effort)
		}
	}
	if configuration.Timeout <= 0 || configuration.Timeout > maximumTimeout {
		return fmt.Errorf("invalid Claude planner timeout: use a duration from 1ns through 30s")
	}
	return nil
}
