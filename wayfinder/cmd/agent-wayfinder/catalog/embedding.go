package catalog

import (
	"net/http"

	"agent-wayfinder/index"
)

func newCatalogEmbeddingGenerator(configuration catalogConfiguration, client *http.Client) (index.CatalogEmbeddingGenerator, error) {
	if !catalogFeatureEnabled(configuration.Embedding.Enabled) || configuration.Embedding.Provider == "" {
		return nil, nil
	}
	return index.NewOllamaCatalogEmbeddingGenerator(configuration.Embedding.Ollama.Model, configuration.Embedding.Ollama.Endpoint, configuration.Embedding.Ollama.Timeout, client)
}

func NewEmbeddingGenerator(workspaceRoot string, client *http.Client) (index.CatalogEmbeddingGenerator, error) {
	configuration, err := readCatalogConfiguration(workspaceRoot)
	if err != nil {
		return nil, err
	}
	return newCatalogEmbeddingGenerator(configuration, client)
}
