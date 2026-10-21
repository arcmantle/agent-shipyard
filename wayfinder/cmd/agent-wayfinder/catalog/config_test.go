package catalog

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"agent-wayfinder/extractor"
	"agent-wayfinder/index"
	"agent-wayfinder/testkit"

	"github.com/spf13/cobra"
)

func TestReadCatalogConfigurationReadsWorkspaceAndUsesConservativeDefaults(t *testing.T) {
	configured := testkit.NewWorkspace(t, map[string]string{
		".agent-wayfinder/config.json": `{"$schema":"https://example.test/config.schema.json","synopsis":{"provider":"copilot","sourceLimit":512,"copilot":{"model":"gpt-5.6-luna","maxAiCredits":42,"processLimit":3,"path":"/opt/bin/copilot"},"ollama":{"model":"catalog-generation:8b","endpoint":"http://localhost:11435","timeout":"12s","processLimit":1},"claude":{"path":"/opt/bin/claude","model":"sonnet","fallbackModel":"haiku","maxBudgetUsd":0.25,"effort":"high","timeout":"12s"}},"embedding":{"provider":"ollama","ollama":{"model":"qwen3-embedding:8b","endpoint":"http://localhost:11435","timeout":"12s"},"processLimit":1}}`,
	})
	configuration, err := readCatalogConfiguration(configured.Root)
	if err != nil {
		t.Fatalf("read configured catalog configuration: %v", err)
	}
	if configuration.Synopsis.Provider != index.CatalogSynopsisProviderCopilot || configuration.Synopsis.SourceLimit != 512 || configuration.Synopsis.OllamaProcessLimit != 1 || configuration.Copilot.Model != "gpt-5.6-luna" || configuration.Copilot.MaxAICredits != 42 || configuration.Copilot.ProcessLimit != 3 || configuration.Copilot.Path != "/opt/bin/copilot" || configuration.Ollama.Model != "catalog-generation:8b" || configuration.Ollama.Endpoint != "http://localhost:11435" || configuration.Ollama.Timeout != 12*time.Second || configuration.Claude.Path != "/opt/bin/claude" || configuration.Claude.Model != "sonnet" || configuration.Claude.FallbackModel != "haiku" || configuration.Claude.MaxBudgetUSD != 0.25 || configuration.Claude.Effort != "high" || configuration.Claude.Timeout != 12*time.Second || configuration.Embedding.Provider != "ollama" || configuration.Embedding.Ollama.Model != "qwen3-embedding:8b" || configuration.Embedding.Ollama.Endpoint != "http://localhost:11435" || configuration.Embedding.Ollama.Timeout != 12*time.Second || configuration.Embedding.ProcessLimit != 1 {
		t.Errorf("configured catalog configuration = %+v, want workspace values", configuration)
	}

	defaults := testkit.NewWorkspace(t, map[string]string{
		"package.json": `{"name":"fixture"}`,
	})
	configuration, err = readCatalogConfiguration(defaults.Root)
	if err != nil {
		t.Fatalf("read default catalog configuration: %v", err)
	}
	if configuration.Synopsis.Provider != "" || configuration.Synopsis.SourceLimit != extractor.DefaultCatalogDeclarationSourceLimit || configuration.Synopsis.OllamaProcessLimit != 1 || configuration.Copilot.Model != "" || configuration.Copilot.MaxAICredits != 30 || configuration.Copilot.ProcessLimit != 1 || configuration.Copilot.Path != "" || configuration.Ollama.Model != "qwen3:8b" || configuration.Ollama.Endpoint != index.DefaultOllamaHost || configuration.Ollama.Timeout != 30*time.Second || configuration.Embedding.Provider != "" || configuration.Embedding.Ollama.Model != "qwen3-embedding:4b" || configuration.Embedding.Ollama.Endpoint != index.DefaultOllamaHost || configuration.Embedding.Ollama.Timeout != index.DefaultOllamaCatalogEmbeddingTimeout || configuration.Embedding.ProcessLimit != 1 {
		t.Errorf("default catalog configuration = %+v, want disabled Copilot and default embedding model", configuration)
	}
}

func TestCatalogFeatureEnablementDisablesConfiguredGenerators(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		".agent-wayfinder/config.json": `{"synopsis":{"enabled":false,"provider":"ollama"},"embedding":{"enabled":false,"provider":"ollama"}}`,
	})
	configuration, err := readCatalogConfiguration(workspace.Root)
	if err != nil {
		t.Fatalf("read disabled catalog configuration: %v", err)
	}
	if catalogFeatureEnabled(configuration.Synopsis.Enabled) || configuration.Synopsis.Provider != index.CatalogSynopsisProviderOllama || catalogFeatureEnabled(configuration.Embedding.Enabled) || configuration.Embedding.Provider != "ollama" {
		t.Errorf("disabled catalog configuration = %+v, want disabled configured features", configuration)
	}
	options, err := catalogWriteOptions(configuration, workspace.Root, nil)
	if err != nil {
		t.Fatalf("create disabled catalog write options: %v", err)
	}
	if options.SynopsisGenerator != nil || options.EmbeddingGenerator != nil {
		t.Errorf("catalog generators = %+v, want disabled generators", options)
	}
}

func TestReadCatalogConfigurationMergesUserAndWorkspaceValues(t *testing.T) {
	user := testkit.NewWorkspace(t, map[string]string{})
	user.WriteFile(t, ".agent-wayfinder/config.json", `{"synopsis":{"provider":"copilot","sourceLimit":512,"copilot":{"maxAiCredits":42,"processLimit":3,"path":"user-copilot"},"ollama":{"model":"user-model","endpoint":"http://localhost:11435"}},"embedding":{"provider":"ollama","ollama":{"model":"user-embedding","endpoint":"http://localhost:11436","timeout":"12s"},"processLimit":1}}`)
	t.Setenv("HOME", user.Root)
	t.Setenv("USERPROFILE", user.Root)
	workspace := testkit.NewWorkspace(t, map[string]string{
		".agent-wayfinder/config.json": `{"synopsis":{"sourceLimit":1024,"copilot":{"path":"workspace-copilot"},"ollama":{"model":"workspace-model"}},"embedding":{"ollama":{"model":"workspace-embedding"}}}`,
	})

	configuration, err := readCatalogConfiguration(workspace.Root)
	if err != nil {
		t.Fatalf("read layered catalog configuration: %v", err)
	}
	if configuration.Synopsis.Provider != index.CatalogSynopsisProviderCopilot || configuration.Synopsis.SourceLimit != 1024 || configuration.Copilot.MaxAICredits != 42 || configuration.Copilot.ProcessLimit != 3 || configuration.Copilot.Path != "workspace-copilot" || configuration.Ollama.Model != "workspace-model" || configuration.Ollama.Endpoint != "http://localhost:11435" || configuration.Embedding.Provider != "ollama" || configuration.Embedding.Ollama.Model != "workspace-embedding" || configuration.Embedding.Ollama.Endpoint != "http://localhost:11436" || configuration.Embedding.Ollama.Timeout != 12*time.Second || configuration.Embedding.ProcessLimit != 1 {
		t.Errorf("catalog configuration = %+v, want workspace values to override user values", configuration)
	}
}

func TestCatalogFlagsOverrideWorkspaceConfiguration(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		".agent-wayfinder/config.json": `{"synopsis":{"provider":"copilot","sourceLimit":512,"copilot":{"model":"workspace-model","maxAiCredits":42,"processLimit":2,"path":"workspace-copilot"}}}`,
	})
	command := &cobra.Command{}
	ConfigureFlags(command)
	for name, value := range map[string]string{
		"catalog-synopsis-provider":       "claude",
		"catalog-synopsis-source-limit":   "1024",
		"catalog-copilot":                 "false",
		"catalog-copilot-model":           "flag-model",
		"catalog-copilot-max-ai-credits":  "60",
		"catalog-copilot-process-limit":   "4",
		"catalog-copilot-path":            "flag-copilot",
		"catalog-ollama-model":            "flag-generation:8b",
		"catalog-ollama-endpoint":         "http://localhost:11435",
		"catalog-embeddings":              "true",
		"catalog-embedding-model":         "qwen3-embedding:8b",
		"catalog-embedding-endpoint":      "http://localhost:11436",
		"catalog-embedding-timeout":       "12s",
		"catalog-embedding-process-limit": "1",
	} {
		if err := command.Flags().Set(name, value); err != nil {
			t.Fatalf("set --%s: %v", name, err)
		}
	}

	configuration, err := resolveCatalogConfiguration(command, workspace.Root)
	if err != nil {
		t.Fatalf("resolve catalog configuration: %v", err)
	}
	if configuration.Synopsis.Provider != index.CatalogSynopsisProviderClaude || configuration.Synopsis.SourceLimit != 1024 || configuration.Copilot.Model != "flag-model" || configuration.Copilot.MaxAICredits != 60 || configuration.Copilot.ProcessLimit != 4 || configuration.Copilot.Path != "flag-copilot" || configuration.Ollama.Model != "flag-generation:8b" || configuration.Ollama.Endpoint != "http://localhost:11435" || configuration.Embedding.Provider != "ollama" || configuration.Embedding.Ollama.Model != "qwen3-embedding:8b" || configuration.Embedding.Ollama.Endpoint != "http://localhost:11436" || configuration.Embedding.Ollama.Timeout != 12*time.Second || configuration.Embedding.ProcessLimit != 1 {
		t.Errorf("catalog configuration = %+v, want flag overrides", configuration)
	}
}

func TestReadCatalogConfigurationRejectsInvalidSynopsisValues(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		contents string
		want     string
	}{
		{
			name:     "provider",
			contents: `{"synopsis":{"provider":"unknown","sourceLimit":512}}`,
			want:     "invalid catalog synopsis provider",
		},
		{
			name:     "source limit",
			contents: `{"synopsis":{"provider":"copilot","sourceLimit":0}}`,
			want:     "invalid catalog synopsis source limit",
		},
		{
			name:     "Copilot max AI credits",
			contents: `{"synopsis":{"copilot":{"maxAiCredits":29}}}`,
			want:     "invalid catalog Copilot max AI credits",
		},
		{
			name:     "Ollama model",
			contents: `{"synopsis":{"ollama":{"model":" "}}}`,
			want:     "invalid catalog Ollama model",
		},
		{
			name:     "Ollama model pattern",
			contents: `{"synopsis":{"ollama":{"model":"invalid model"}}}`,
			want:     "invalid catalog Ollama model",
		},
		{
			name:     "Ollama endpoint",
			contents: `{"synopsis":{"ollama":{"endpoint":"localhost:11434"}}}`,
			want:     "invalid catalog Ollama endpoint",
		},
		{
			name:     "embedding provider",
			contents: `{"embedding":{"provider":"unknown"}}`,
			want:     "invalid catalog embedding provider",
		},
		{
			name:     "embedding Ollama model",
			contents: `{"embedding":{"ollama":{"model":"invalid model"}}}`,
			want:     "invalid catalog embedding Ollama configuration",
		},
		{
			name:     "embedding Ollama endpoint",
			contents: `{"embedding":{"ollama":{"endpoint":"localhost:11434"}}}`,
			want:     "invalid catalog embedding Ollama configuration",
		},
		{
			name:     "embedding Ollama timeout",
			contents: `{"embedding":{"ollama":{"timeout":"31s"}}}`,
			want:     "invalid catalog embedding Ollama configuration",
		},
		{
			name:     "embedding process limit too low",
			contents: `{"embedding":{"processLimit":0}}`,
			want:     "invalid catalog embedding process limit",
		},
		{
			name:     "embedding process limit too high",
			contents: `{"embedding":{"processLimit":3}}`,
			want:     "invalid catalog embedding process limit",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			workspace := testkit.NewWorkspace(t, map[string]string{
				".agent-wayfinder/config.json": testCase.contents,
			})
			_, err := readCatalogConfiguration(workspace.Root)
			if err == nil || !strings.Contains(err.Error(), testCase.want) {
				t.Errorf("read catalog configuration error = %v, want %q", err, testCase.want)
			}
		})
	}
}

func TestCatalogFlagsRejectInvalidSynopsisValues(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		flag  string
		value string
		want  string
	}{
		{name: "provider", flag: "catalog-synopsis-provider", value: "unknown", want: "invalid catalog synopsis provider"},
		{name: "source limit", flag: "catalog-synopsis-source-limit", value: "0", want: "invalid catalog synopsis source limit"},
		{name: "Copilot max AI credits", flag: "catalog-copilot-max-ai-credits", value: "29", want: "invalid catalog Copilot max AI credits"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			command := &cobra.Command{}
			ConfigureFlags(command)
			if err := command.Flags().Set(testCase.flag, testCase.value); err != nil {
				t.Fatalf("set --%s: %v", testCase.flag, err)
			}
			_, err := resolveCatalogConfiguration(command, t.TempDir())
			if err == nil || !strings.Contains(err.Error(), testCase.want) {
				t.Errorf("resolve catalog configuration error = %v, want %q", err, testCase.want)
			}
		})
	}
}

func TestCatalogFlagsAcceptMaximumOllamaSynopsisProcessLimit(t *testing.T) {
	command := &cobra.Command{}
	ConfigureFlags(command)
	if err := command.Flags().Set("catalog-ollama-process-limit", "4"); err != nil {
		t.Fatalf("set catalog Ollama process limit: %v", err)
	}

	configuration, err := resolveCatalogConfiguration(command, t.TempDir())
	if err != nil {
		t.Fatalf("resolve catalog configuration: %v", err)
	}
	if configuration.Synopsis.OllamaProcessLimit != 4 {
		t.Errorf("catalog Ollama process limit = %d, want 4", configuration.Synopsis.OllamaProcessLimit)
	}
}

func TestNewCatalogEmbeddingGeneratorUsesConfiguredOllamaSettings(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/embed" {
			t.Errorf("Ollama request path = %q, want /api/embed", request.URL.Path)
		}
		contents, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read Ollama request: %v", err)
		}
		if string(contents) != `{"model":"qwen3-embedding:8b","input":["validates an access token"],"options":{"num_thread":1},"keep_alive":"0"}` {
			t.Errorf("Ollama request = %s, want configured bounded model and input", contents)
		}
		_, _ = response.Write([]byte(`{"embeddings":[[0.1,0.2]]}`))
	}))
	t.Cleanup(server.Close)
	generator, err := newCatalogEmbeddingGenerator(catalogConfiguration{Embedding: catalogEmbeddingConfiguration{Provider: "ollama", Ollama: catalogOllamaConfiguration{Model: "qwen3-embedding:8b", Endpoint: server.URL, Timeout: time.Second}}}, server.Client())
	if err != nil {
		t.Fatalf("create catalog embedding generator: %v", err)
	}
	if _, err := generator.GenerateCatalogEmbedding(context.Background(), "validates an access token"); err != nil {
		t.Fatalf("generate catalog embedding: %v", err)
	}
}

func TestNewCatalogEmbeddingGeneratorUsesDefaultsWhenConfigurationIsUnset(t *testing.T) {
	t.Setenv("OLLAMA_HOST", "")
	generator, err := newCatalogEmbeddingGenerator(catalogConfiguration{}, nil)
	if err != nil {
		t.Fatalf("create default catalog embedding generator: %v", err)
	}
	if generator != nil {
		t.Errorf("default catalog embedding generator = %T, want disabled", generator)
	}
}
