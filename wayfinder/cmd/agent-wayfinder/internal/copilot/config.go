package copilot

import (
	"bytes"
	"encoding/json"
	"fmt"
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
	DefaultModel       = "gpt-5.6-luna"
	AutomaticModel     = "auto"
	MinimumAICredits   = 30
	DefaultAICredits   = MinimumAICredits
	DefaultTokenBudget = 4096
	DefaultTimeout     = 30 * time.Second
	maximumTimeout     = 30 * time.Second
)

var modelPattern = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)

type Configuration struct {
	Enabled      bool
	Model        string
	MaxAICredits int
	TokenBudget  int
	Timeout      time.Duration
}

type ConfigurationReport struct {
	Enabled      bool                 `json:"enabled"`
	Model        string               `json:"model"`
	MaxAICredits int                  `json:"maxAiCredits"`
	TokenBudget  int                  `json:"tokenBudget"`
	Timeout      string               `json:"timeout"`
	Sources      ConfigurationSources `json:"sources"`
}

func (report ConfigurationReport) PlannerConfiguration() (Configuration, error) {
	timeout, err := time.ParseDuration(report.Timeout)
	if err != nil {
		return Configuration{}, fmt.Errorf("parse effective Copilot timeout: %w", err)
	}
	return Configuration{
		Enabled:      report.Enabled,
		Model:        report.Model,
		MaxAICredits: report.MaxAICredits,
		TokenBudget:  report.TokenBudget,
		Timeout:      timeout,
	}, nil
}

type ConfigurationSources struct {
	Enabled      string `json:"enabled"`
	Model        string `json:"model"`
	MaxAICredits string `json:"maxAiCredits"`
	TokenBudget  string `json:"tokenBudget"`
	Timeout      string `json:"timeout"`
}

func ResolveConfiguration(command *cobra.Command, workspaceRoot string) (ConfigurationReport, error) {
	configuration, err := ReadConfiguration(workspaceRoot)
	if err != nil {
		return ConfigurationReport{}, err
	}
	sources, err := configurationSources(workspaceRoot)
	if err != nil {
		return ConfigurationReport{}, err
	}
	flags := command.Flags()
	if flags.Changed("copilot") {
		configuration.Enabled, err = flags.GetBool("copilot")
		sources.Enabled = "flag"
	}
	if err == nil && flags.Changed("copilot-model") {
		configuration.Model, err = flags.GetString("copilot-model")
		sources.Model = "flag"
	}
	if err == nil && flags.Changed("copilot-max-ai-credits") {
		configuration.MaxAICredits, err = flags.GetInt("copilot-max-ai-credits")
		sources.MaxAICredits = "flag"
	}
	if err == nil && flags.Changed("copilot-token-budget") {
		configuration.TokenBudget, err = flags.GetInt("copilot-token-budget")
		sources.TokenBudget = "flag"
	}
	if err == nil && flags.Changed("copilot-timeout") {
		var timeout string
		timeout, err = flags.GetString("copilot-timeout")
		if err == nil {
			configuration.Timeout, err = parseTimeout(timeout)
			sources.Timeout = "flag"
		}
	}
	if err != nil {
		return ConfigurationReport{}, err
	}
	if err := validateConfiguration(configuration); err != nil {
		return ConfigurationReport{}, err
	}
	return ConfigurationReport{Enabled: configuration.Enabled, Model: configuration.Model, MaxAICredits: configuration.MaxAICredits, TokenBudget: configuration.TokenBudget, Timeout: configuration.Timeout.String(), Sources: sources}, nil
}

type configurationFile struct {
	Model        *string         `json:"model"`
	MaxAICredits *int            `json:"maxAiCredits"`
	TokenBudget  *int            `json:"tokenBudget"`
	Timeout      json.RawMessage `json:"timeout"`
}

func ReadConfiguration(workspaceRoot string) (Configuration, error) {
	configuration := Configuration{
		Model:        DefaultModel,
		MaxAICredits: DefaultAICredits,
		TokenBudget:  DefaultTokenBudget,
		Timeout:      DefaultTimeout,
	}
	paths := configpath.Paths(workspaceRoot)
	for _, path := range paths {
		fileConfiguration, err := readConfigurationFile(path)
		if err != nil {
			return Configuration{}, err
		}
		if err := applyFileConfiguration(&configuration, fileConfiguration); err != nil {
			return Configuration{}, err
		}
	}
	provider, err := planning.ReadProvider(workspaceRoot)
	if err != nil {
		return Configuration{}, err
	}
	configuration.Enabled = provider == planning.ProviderCopilot
	if err := applyEnvironment(&configuration); err != nil {
		return Configuration{}, err
	}
	if err := validateConfiguration(configuration); err != nil {
		return Configuration{}, err
	}
	return configuration, nil
}

func configurationSources(workspaceRoot string) (ConfigurationSources, error) {
	sources := ConfigurationSources{Enabled: "default", Model: "default", MaxAICredits: "default", TokenBudget: "default", Timeout: "default"}
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
		if configuration.Model != nil {
			sources.Model = source
		}
		if configuration.MaxAICredits != nil {
			sources.MaxAICredits = source
		}
		if configuration.TokenBudget != nil {
			sources.TokenBudget = source
		}
		if len(configuration.Timeout) > 0 {
			sources.Timeout = source
		}
	}
	for variable, apply := range map[string]func(){
		"WAYFINDER_COPILOT_ENABLED":        func() { sources.Enabled = "environment" },
		"WAYFINDER_COPILOT_MODEL":          func() { sources.Model = "environment" },
		"WAYFINDER_COPILOT_MAX_AI_CREDITS": func() { sources.MaxAICredits = "environment" },
		"WAYFINDER_COPILOT_TOKEN_BUDGET":   func() { sources.TokenBudget = "environment" },
		"WAYFINDER_COPILOT_TIMEOUT":        func() { sources.Timeout = "environment" },
	} {
		if _, exists := os.LookupEnv(variable); exists {
			apply()
		}
	}
	return sources, nil
}

func applyFileConfiguration(configuration *Configuration, file configurationFile) error {
	if file.Model != nil {
		configuration.Model = *file.Model
	}
	if file.MaxAICredits != nil {
		configuration.MaxAICredits = *file.MaxAICredits
	}
	if file.TokenBudget != nil {
		configuration.TokenBudget = *file.TokenBudget
	}
	if len(file.Timeout) != 0 {
		timeout, err := parseJSONTimeout(file.Timeout)
		if err != nil {
			return fmt.Errorf("invalid planning.copilot.timeout: %w", err)
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
		return configurationFile{}, fmt.Errorf("read Copilot configuration: %w", err)
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(contents, &root); err != nil {
		return configurationFile{}, fmt.Errorf("parse Copilot configuration: %w", err)
	}
	planning, exists := root["planning"]
	if !exists {
		return configurationFile{}, nil
	}
	var planningContents map[string]json.RawMessage
	if err := json.Unmarshal(planning, &planningContents); err != nil {
		return configurationFile{}, fmt.Errorf("parse Copilot planner configuration: %w", err)
	}
	planner, exists := planningContents["copilot"]
	if !exists {
		return configurationFile{}, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(planner))
	decoder.DisallowUnknownFields()
	var configuration configurationFile
	if err := decoder.Decode(&configuration); err != nil {
		return configurationFile{}, fmt.Errorf("parse Copilot planner configuration: %w", err)
	}
	return configuration, nil
}

func applyEnvironment(configuration *Configuration) error {
	if value, exists := os.LookupEnv("WAYFINDER_COPILOT_ENABLED"); exists {
		if value != "true" && value != "false" {
			return fmt.Errorf("invalid WAYFINDER_COPILOT_ENABLED: use true or false")
		}
		configuration.Enabled = value == "true"
	}
	if value, exists := os.LookupEnv("WAYFINDER_COPILOT_MODEL"); exists {
		configuration.Model = value
	}
	if value, exists := os.LookupEnv("WAYFINDER_COPILOT_MAX_AI_CREDITS"); exists {
		parsed, err := parsePositiveInteger(value)
		if err != nil {
			return fmt.Errorf("invalid WAYFINDER_COPILOT_MAX_AI_CREDITS: %w", err)
		}
		configuration.MaxAICredits = parsed
	}
	if value, exists := os.LookupEnv("WAYFINDER_COPILOT_TOKEN_BUDGET"); exists {
		parsed, err := parsePositiveInteger(value)
		if err != nil {
			return fmt.Errorf("invalid WAYFINDER_COPILOT_TOKEN_BUDGET: %w", err)
		}
		configuration.TokenBudget = parsed
	}
	if value, exists := os.LookupEnv("WAYFINDER_COPILOT_TIMEOUT"); exists {
		parsed, err := parseTimeout(value)
		if err != nil {
			return fmt.Errorf("invalid WAYFINDER_COPILOT_TIMEOUT: %w", err)
		}
		configuration.Timeout = parsed
	}
	return nil
}

func validateConfiguration(configuration Configuration) error {
	if !modelPattern.MatchString(configuration.Model) {
		return fmt.Errorf("invalid Copilot model %q", configuration.Model)
	}
	if configuration.MaxAICredits < MinimumAICredits {
		return fmt.Errorf("invalid max AI credits: use an integer of at least %d", MinimumAICredits)
	}
	if configuration.TokenBudget <= 0 {
		return fmt.Errorf("invalid token budget: use a positive integer")
	}
	if configuration.Timeout <= 0 || configuration.Timeout > maximumTimeout {
		return fmt.Errorf("invalid timeout: use a duration from 1ns through 30s")
	}
	return nil
}

func parsePositiveInteger(value string) (int, error) {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("use a positive integer")
	}
	return parsed, nil
}

func parseTimeout(value string) (time.Duration, error) {
	if strings.TrimSpace(value) != value || value == "" {
		return 0, fmt.Errorf("use a duration or integer seconds")
	}
	if seconds, err := parsePositiveInteger(value); err == nil {
		return time.Duration(seconds) * time.Second, nil
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("use a duration or integer seconds")
	}
	return parsed, nil
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
