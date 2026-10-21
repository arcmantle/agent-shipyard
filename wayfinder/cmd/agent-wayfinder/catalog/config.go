package catalog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"time"

	"agent-wayfinder/cmd/agent-wayfinder/internal/claude"
	configpath "agent-wayfinder/cmd/agent-wayfinder/internal/configuration"
	"agent-wayfinder/cmd/agent-wayfinder/internal/copilot"
	"agent-wayfinder/cmd/agent-wayfinder/internal/ollama"
	"agent-wayfinder/extractor"
	"agent-wayfinder/index"

	"github.com/spf13/cobra"
)

type catalogConfiguration struct {
	Copilot   catalogCopilotConfiguration
	Ollama    catalogOllamaConfiguration
	Claude    claude.Configuration
	Synopsis  catalogSynopsisConfiguration
	Embedding catalogEmbeddingConfiguration
}

type catalogCopilotConfiguration struct {
	Model        string
	MaxAICredits int
	ProcessLimit int
	Path         string
}

type catalogOllamaConfiguration struct {
	Model    string
	Endpoint string
	Timeout  time.Duration
}

type catalogSynopsisConfiguration struct {
	Enabled            *bool
	Provider           index.CatalogSynopsisProvider
	SourceLimit        int
	OllamaProcessLimit int
}

type catalogEmbeddingConfiguration struct {
	Enabled      *bool
	Provider     string
	Ollama       catalogOllamaConfiguration
	ProcessLimit int
}

type catalogConfigurationFileContents struct {
	Schema    *string                                    `json:"$schema"`
	Planning  json.RawMessage                            `json:"planning"`
	Spending  json.RawMessage                            `json:"spending"`
	Sources   json.RawMessage                            `json:"sources"`
	Synopsis  *catalogSynopsisConfigurationFileContents  `json:"synopsis"`
	Embedding *catalogEmbeddingConfigurationFileContents `json:"embedding"`
}

type catalogCopilotConfigurationFileContents struct {
	Model        *string `json:"model"`
	MaxAICredits *int    `json:"maxAiCredits"`
	ProcessLimit *int    `json:"processLimit"`
	Path         *string `json:"path"`
}

type catalogOllamaConfigurationFileContents struct {
	Model        *string         `json:"model"`
	Endpoint     *string         `json:"endpoint"`
	Timeout      json.RawMessage `json:"timeout"`
	ProcessLimit *int            `json:"processLimit"`
}

type catalogSynopsisConfigurationFileContents struct {
	Enabled     *bool                                    `json:"enabled"`
	Provider    *string                                  `json:"provider"`
	SourceLimit *int                                     `json:"sourceLimit"`
	Copilot     *catalogCopilotConfigurationFileContents `json:"copilot"`
	Ollama      *catalogOllamaConfigurationFileContents  `json:"ollama"`
	Claude      *catalogClaudeConfigurationFileContents  `json:"claude"`
}

type catalogClaudeConfigurationFileContents struct {
	Path          *string         `json:"path"`
	Model         *string         `json:"model"`
	FallbackModel *string         `json:"fallbackModel"`
	MaxBudgetUSD  *float64        `json:"maxBudgetUsd"`
	Effort        *string         `json:"effort"`
	Timeout       json.RawMessage `json:"timeout"`
}

type catalogEmbeddingConfigurationFileContents struct {
	Enabled      *bool                                   `json:"enabled"`
	Provider     *string                                 `json:"provider"`
	Ollama       *catalogOllamaConfigurationFileContents `json:"ollama"`
	ProcessLimit *int                                    `json:"processLimit"`
}

func readCatalogConfiguration(workspaceRoot string) (catalogConfiguration, error) {
	configuration := catalogConfiguration{
		Copilot:  catalogCopilotConfiguration{MaxAICredits: copilot.DefaultAICredits, ProcessLimit: 1},
		Ollama:   catalogOllamaConfiguration{Model: "qwen3:8b", Endpoint: ollama.DefaultEndpoint(), Timeout: 30 * time.Second},
		Claude:   claude.Configuration{Path: claude.DefaultPlannerPath, Model: claude.DefaultPlannerModel, Timeout: 30 * time.Second},
		Synopsis: catalogSynopsisConfiguration{Enabled: catalogFeatureEnabledValue(true), SourceLimit: extractor.DefaultCatalogDeclarationSourceLimit, OllamaProcessLimit: index.DefaultSynopsisProcessLimit},
		Embedding: catalogEmbeddingConfiguration{
			Enabled:      catalogFeatureEnabledValue(true),
			Ollama:       catalogOllamaConfiguration{Model: index.DefaultOllamaCatalogEmbeddingModel, Endpoint: ollama.DefaultEndpoint(), Timeout: index.DefaultOllamaCatalogEmbeddingTimeout},
			ProcessLimit: index.DefaultEmbeddingProcessLimit,
		},
	}
	paths := configpath.Paths(workspaceRoot)
	for _, path := range paths {
		fileConfiguration, err := readCatalogConfigurationFile(path)
		if err != nil {
			return catalogConfiguration{}, err
		}
		if err := applyCatalogConfiguration(&configuration, fileConfiguration); err != nil {
			return catalogConfiguration{}, err
		}
	}
	if configuration.Copilot.ProcessLimit <= 0 {
		return catalogConfiguration{}, fmt.Errorf("invalid catalog Copilot process limit: use a positive integer")
	}
	if configuration.Copilot.MaxAICredits < copilot.MinimumAICredits {
		return catalogConfiguration{}, fmt.Errorf("invalid catalog Copilot max AI credits: use an integer of at least %d", copilot.MinimumAICredits)
	}
	if err := validateCatalogSynopsisConfiguration(configuration.Synopsis); err != nil {
		return catalogConfiguration{}, err
	}
	if err := validateCatalogOllamaConfiguration(configuration.Ollama); err != nil {
		return catalogConfiguration{}, err
	}
	if err := claude.ValidateConfiguration(configuration.Claude); err != nil {
		return catalogConfiguration{}, fmt.Errorf("invalid catalog Claude configuration: %w", err)
	}
	if err := validateCatalogEmbeddingConfiguration(configuration.Embedding); err != nil {
		return catalogConfiguration{}, err
	}
	return configuration, nil
}

func readCatalogConfigurationFile(path string) (catalogConfigurationFileContents, error) {
	contents, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return catalogConfigurationFileContents{}, nil
	}
	if err != nil {
		return catalogConfigurationFileContents{}, fmt.Errorf("read catalog configuration: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	var configuration catalogConfigurationFileContents
	if err := decoder.Decode(&configuration); err != nil {
		return catalogConfigurationFileContents{}, fmt.Errorf("parse catalog configuration: %w", err)
	}
	return configuration, nil
}

func applyCatalogConfiguration(configuration *catalogConfiguration, fileConfiguration catalogConfigurationFileContents) error {
	if fileConfiguration.Synopsis != nil {
		if fileConfiguration.Synopsis.Enabled != nil {
			configuration.Synopsis.Enabled = fileConfiguration.Synopsis.Enabled
		}
		if fileConfiguration.Synopsis.Provider != nil {
			configuration.Synopsis.Provider = index.CatalogSynopsisProvider(*fileConfiguration.Synopsis.Provider)
		}
		if fileConfiguration.Synopsis.SourceLimit != nil {
			configuration.Synopsis.SourceLimit = *fileConfiguration.Synopsis.SourceLimit
		}
		if fileConfiguration.Synopsis.Copilot != nil {
			if fileConfiguration.Synopsis.Copilot.Model != nil {
				configuration.Copilot.Model = *fileConfiguration.Synopsis.Copilot.Model
			}
			if fileConfiguration.Synopsis.Copilot.MaxAICredits != nil {
				configuration.Copilot.MaxAICredits = *fileConfiguration.Synopsis.Copilot.MaxAICredits
			}
			if fileConfiguration.Synopsis.Copilot.ProcessLimit != nil {
				configuration.Copilot.ProcessLimit = *fileConfiguration.Synopsis.Copilot.ProcessLimit
			}
			if fileConfiguration.Synopsis.Copilot.Path != nil {
				configuration.Copilot.Path = *fileConfiguration.Synopsis.Copilot.Path
			}
		}
		if fileConfiguration.Synopsis.Ollama != nil {
			if fileConfiguration.Synopsis.Ollama.Model != nil {
				configuration.Ollama.Model = *fileConfiguration.Synopsis.Ollama.Model
			}
			if fileConfiguration.Synopsis.Ollama.Endpoint != nil {
				configuration.Ollama.Endpoint = *fileConfiguration.Synopsis.Ollama.Endpoint
			}
			if len(fileConfiguration.Synopsis.Ollama.Timeout) != 0 {
				timeout, err := parseCatalogTimeout(fileConfiguration.Synopsis.Ollama.Timeout)
				if err != nil {
					return fmt.Errorf("invalid synopsis.ollama.timeout: %w", err)
				}
				configuration.Ollama.Timeout = timeout
			}
			if fileConfiguration.Synopsis.Ollama.ProcessLimit != nil {
				configuration.Synopsis.OllamaProcessLimit = *fileConfiguration.Synopsis.Ollama.ProcessLimit
			}
		}
		if fileConfiguration.Synopsis.Claude != nil {
			if fileConfiguration.Synopsis.Claude.Path != nil {
				configuration.Claude.Path = *fileConfiguration.Synopsis.Claude.Path
			}
			if fileConfiguration.Synopsis.Claude.Model != nil {
				configuration.Claude.Model = *fileConfiguration.Synopsis.Claude.Model
			}
			if fileConfiguration.Synopsis.Claude.FallbackModel != nil {
				configuration.Claude.FallbackModel = *fileConfiguration.Synopsis.Claude.FallbackModel
			}
			if fileConfiguration.Synopsis.Claude.MaxBudgetUSD != nil {
				configuration.Claude.MaxBudgetUSD = *fileConfiguration.Synopsis.Claude.MaxBudgetUSD
			}
			if fileConfiguration.Synopsis.Claude.Effort != nil {
				configuration.Claude.Effort = *fileConfiguration.Synopsis.Claude.Effort
			}
			if len(fileConfiguration.Synopsis.Claude.Timeout) != 0 {
				timeout, err := parseCatalogTimeout(fileConfiguration.Synopsis.Claude.Timeout)
				if err != nil {
					return fmt.Errorf("invalid synopsis.claude.timeout: %w", err)
				}
				configuration.Claude.Timeout = timeout
			}
		}
	}
	if fileConfiguration.Embedding != nil {
		if fileConfiguration.Embedding.Enabled != nil {
			configuration.Embedding.Enabled = fileConfiguration.Embedding.Enabled
		}
		if fileConfiguration.Embedding.Provider != nil {
			configuration.Embedding.Provider = *fileConfiguration.Embedding.Provider
		}
		if fileConfiguration.Embedding.Ollama != nil {
			if fileConfiguration.Embedding.Ollama.Model != nil {
				configuration.Embedding.Ollama.Model = *fileConfiguration.Embedding.Ollama.Model
			}
			if fileConfiguration.Embedding.Ollama.Endpoint != nil {
				configuration.Embedding.Ollama.Endpoint = *fileConfiguration.Embedding.Ollama.Endpoint
			}
			if len(fileConfiguration.Embedding.Ollama.Timeout) != 0 {
				timeout, err := parseCatalogTimeout(fileConfiguration.Embedding.Ollama.Timeout)
				if err != nil {
					return fmt.Errorf("invalid embedding.ollama.timeout: %w", err)
				}
				configuration.Embedding.Ollama.Timeout = timeout
			}
		}
		if fileConfiguration.Embedding.ProcessLimit != nil {
			configuration.Embedding.ProcessLimit = *fileConfiguration.Embedding.ProcessLimit
		}
	}
	return nil
}

func catalogFeatureEnabled(enabled *bool) bool {
	return enabled == nil || *enabled
}

func catalogFeatureEnabledValue(enabled bool) *bool {
	return &enabled
}

func parseCatalogTimeout(value json.RawMessage) (time.Duration, error) {
	var duration string
	if err := json.Unmarshal(value, &duration); err == nil {
		return time.ParseDuration(duration)
	}
	var seconds int
	if err := json.Unmarshal(value, &seconds); err != nil {
		return 0, fmt.Errorf("use a duration string or integer seconds")
	}
	return time.Duration(seconds) * time.Second, nil
}

func ConfigureFlags(command *cobra.Command) {
	command.Flags().String("catalog-synopsis-provider", "", "catalog synopsis provider: copilot, ollama, or claude")
	command.Flags().Int("catalog-synopsis-source-limit", 0, "maximum declaration source bytes per catalog synopsis")
	command.Flags().Bool("catalog-copilot", false, "enable Copilot catalog synopses")
	command.Flags().String("catalog-copilot-model", "", "Copilot model for catalog synopses")
	command.Flags().Int("catalog-copilot-max-ai-credits", 0, "maximum Copilot AI credits per catalog synopsis")
	command.Flags().Int("catalog-copilot-process-limit", 0, "maximum concurrent Copilot catalog processes")
	command.Flags().String("catalog-copilot-path", "", "Copilot command path for catalog synopses")
	command.Flags().String("catalog-ollama-model", "", "Ollama model for catalog synopses")
	command.Flags().String("catalog-ollama-endpoint", "", "Ollama endpoint for catalog synopses")
	command.Flags().Int("catalog-ollama-process-limit", 0, "maximum concurrent Ollama catalog synopsis requests")
	command.Flags().Bool("catalog-embeddings", false, "enable local Ollama catalog embeddings")
	command.Flags().String("catalog-embedding-model", "", "Ollama model for catalog embeddings")
	command.Flags().String("catalog-embedding-endpoint", "", "Ollama endpoint for catalog embeddings")
	command.Flags().Duration("catalog-embedding-timeout", 0, "Ollama request timeout for catalog embeddings")
	command.Flags().Int("catalog-embedding-process-limit", 0, "maximum concurrent Ollama catalog embedding requests")
}

func resolveCatalogConfiguration(command *cobra.Command, workspaceRoot string) (catalogConfiguration, error) {
	configuration, err := readCatalogConfiguration(workspaceRoot)
	if err != nil {
		return catalogConfiguration{}, err
	}
	flags := command.Flags()
	if flags.Changed("catalog-synopsis-provider") {
		provider, providerErr := flags.GetString("catalog-synopsis-provider")
		if providerErr != nil {
			return catalogConfiguration{}, providerErr
		}
		configuration.Synopsis.Provider = index.CatalogSynopsisProvider(provider)
	}
	if flags.Changed("catalog-synopsis-source-limit") {
		configuration.Synopsis.SourceLimit, err = flags.GetInt("catalog-synopsis-source-limit")
	}
	if err == nil && flags.Changed("catalog-copilot") {
		var enabled bool
		enabled, err = flags.GetBool("catalog-copilot")
		if enabled {
			configuration.Synopsis.Provider = index.CatalogSynopsisProviderCopilot
		}
	}
	if err == nil && flags.Changed("catalog-copilot-model") {
		configuration.Copilot.Model, err = flags.GetString("catalog-copilot-model")
	}
	if err == nil && flags.Changed("catalog-copilot-max-ai-credits") {
		configuration.Copilot.MaxAICredits, err = flags.GetInt("catalog-copilot-max-ai-credits")
	}
	if err == nil && flags.Changed("catalog-copilot-process-limit") {
		configuration.Copilot.ProcessLimit, err = flags.GetInt("catalog-copilot-process-limit")
	}
	if err == nil && flags.Changed("catalog-copilot-path") {
		configuration.Copilot.Path, err = flags.GetString("catalog-copilot-path")
	}
	if err == nil && flags.Changed("catalog-ollama-model") {
		configuration.Ollama.Model, err = flags.GetString("catalog-ollama-model")
	}
	if err == nil && flags.Changed("catalog-ollama-endpoint") {
		configuration.Ollama.Endpoint, err = flags.GetString("catalog-ollama-endpoint")
	}
	if err == nil && flags.Changed("catalog-ollama-process-limit") {
		configuration.Synopsis.OllamaProcessLimit, err = flags.GetInt("catalog-ollama-process-limit")
	}
	if err == nil && flags.Changed("catalog-embeddings") {
		var enabled bool
		enabled, err = flags.GetBool("catalog-embeddings")
		if enabled {
			configuration.Embedding.Provider = "ollama"
		} else {
			configuration.Embedding.Provider = ""
		}
	}
	if err == nil && flags.Changed("catalog-embedding-model") {
		configuration.Embedding.Ollama.Model, err = flags.GetString("catalog-embedding-model")
	}
	if err == nil && flags.Changed("catalog-embedding-endpoint") {
		configuration.Embedding.Ollama.Endpoint, err = flags.GetString("catalog-embedding-endpoint")
	}
	if err == nil && flags.Changed("catalog-embedding-timeout") {
		configuration.Embedding.Ollama.Timeout, err = flags.GetDuration("catalog-embedding-timeout")
	}
	if err == nil && flags.Changed("catalog-embedding-process-limit") {
		configuration.Embedding.ProcessLimit, err = flags.GetInt("catalog-embedding-process-limit")
	}
	if err != nil {
		return catalogConfiguration{}, err
	}
	if configuration.Copilot.ProcessLimit <= 0 {
		return catalogConfiguration{}, fmt.Errorf("invalid catalog Copilot process limit %s: use a positive integer", strconv.Itoa(configuration.Copilot.ProcessLimit))
	}
	if configuration.Copilot.MaxAICredits < copilot.MinimumAICredits {
		return catalogConfiguration{}, fmt.Errorf("invalid catalog Copilot max AI credits %s: use an integer of at least %d", strconv.Itoa(configuration.Copilot.MaxAICredits), copilot.MinimumAICredits)
	}
	if err := validateCatalogSynopsisConfiguration(configuration.Synopsis); err != nil {
		return catalogConfiguration{}, err
	}
	if err := validateCatalogOllamaConfiguration(configuration.Ollama); err != nil {
		return catalogConfiguration{}, err
	}
	if err := validateCatalogEmbeddingConfiguration(configuration.Embedding); err != nil {
		return catalogConfiguration{}, err
	}
	return configuration, nil
}

func validateCatalogSynopsisConfiguration(configuration catalogSynopsisConfiguration) error {
	switch configuration.Provider {
	case "", index.CatalogSynopsisProviderCopilot, index.CatalogSynopsisProviderOllama, index.CatalogSynopsisProviderClaude:
	default:
		return fmt.Errorf("invalid catalog synopsis provider %q: use copilot, ollama, or claude", configuration.Provider)
	}
	if configuration.SourceLimit <= 0 {
		return fmt.Errorf("invalid catalog synopsis source limit: use a positive integer")
	}
	if configuration.OllamaProcessLimit <= 0 || configuration.OllamaProcessLimit > index.MaximumSynopsisProcessLimit {
		return fmt.Errorf("invalid catalog Ollama process limit: use an integer from 1 through %d", index.MaximumSynopsisProcessLimit)
	}
	return nil
}

func validateCatalogOllamaConfiguration(configuration catalogOllamaConfiguration) error {
	if !ollama.ValidModel(configuration.Model) {
		return fmt.Errorf("invalid catalog Ollama model %q", configuration.Model)
	}
	endpoint, err := url.ParseRequestURI(configuration.Endpoint)
	if err != nil || endpoint.Scheme == "" || endpoint.Host == "" {
		return fmt.Errorf("invalid catalog Ollama endpoint: use an absolute URL")
	}
	if configuration.Timeout <= 0 || configuration.Timeout > 30*time.Second {
		return fmt.Errorf("invalid catalog Ollama timeout: use a duration from 1ns through 30s")
	}
	return nil
}

func validateCatalogEmbeddingConfiguration(configuration catalogEmbeddingConfiguration) error {
	switch configuration.Provider {
	case "", "ollama":
	default:
		return fmt.Errorf("invalid catalog embedding provider %q: use ollama", configuration.Provider)
	}
	if err := validateCatalogOllamaConfiguration(configuration.Ollama); err != nil {
		return fmt.Errorf("invalid catalog embedding Ollama configuration: %w", err)
	}
	if configuration.ProcessLimit <= 0 || configuration.ProcessLimit > index.MaximumEmbeddingProcessLimit {
		return fmt.Errorf("invalid catalog embedding process limit: use an integer from 1 through %d", index.MaximumEmbeddingProcessLimit)
	}
	return nil
}
