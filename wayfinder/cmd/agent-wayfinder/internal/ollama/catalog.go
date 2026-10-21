package ollama

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"agent-wayfinder/index"
)

const (
	catalogSynopsisMaxResponseBytes = 4096
	catalogSynopsisKeepAlive        = "5m"
	catalogSynopsisContextTokens    = 2048
	catalogSynopsisPredictionTokens = 128
	catalogSynopsisThreadLimit      = 1
	catalogSynopsisMaxPromptBytes   = 1536
)

type CatalogSynopsisConfiguration struct {
	Model   string
	Timeout time.Duration
}

type CatalogSynopsisGenerator struct {
	configuration CatalogSynopsisConfiguration
	endpoint      string
	client        *http.Client
}

func NewCatalogSynopsisGenerator(configuration CatalogSynopsisConfiguration, endpoint string, client *http.Client) CatalogSynopsisGenerator {
	if client == nil {
		client = http.DefaultClient
	}
	return CatalogSynopsisGenerator{configuration: configuration, endpoint: endpoint, client: client}
}

func (generator CatalogSynopsisGenerator) GenerateCatalogSynopsis(parent context.Context, unit index.CatalogSynopsisInput) (string, error) {
	ctx, cancel := context.WithTimeout(parent, generator.configuration.Timeout)
	defer cancel()

	contents, err := json.Marshal(struct {
		Model   string `json:"model"`
		Prompt  string `json:"prompt"`
		Stream  bool   `json:"stream"`
		Think   bool   `json:"think"`
		Options struct {
			NumCtx     int `json:"num_ctx"`
			NumPredict int `json:"num_predict"`
			NumThread  int `json:"num_thread"`
		} `json:"options"`
		KeepAlive string `json:"keep_alive"`
	}{
		Model:  generator.configuration.Model,
		Prompt: catalogSynopsisPrompt(unit),
		Stream: false,
		Think:  false,
		Options: struct {
			NumCtx     int `json:"num_ctx"`
			NumPredict int `json:"num_predict"`
			NumThread  int `json:"num_thread"`
		}{NumCtx: catalogSynopsisContextTokens, NumPredict: catalogSynopsisPredictionTokens, NumThread: catalogSynopsisThreadLimit},
		KeepAlive: catalogSynopsisKeepAlive,
	})
	if err != nil {
		return "", fmt.Errorf("encode Ollama catalog synopsis request: %w", err)
	}
	endpoint := strings.TrimRight(strings.TrimSpace(generator.endpoint), "/")
	if endpoint == "" {
		endpoint = defaultEndpoint
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/api/generate", bytes.NewReader(contents))
	if err != nil {
		return "", fmt.Errorf("create Ollama catalog synopsis request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := generator.client.Do(request)
	if err != nil {
		return "", fmt.Errorf("run Ollama catalog synopsis: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return "", fmt.Errorf("run Ollama catalog synopsis: unexpected HTTP status %s", response.Status)
	}
	responseContents, err := io.ReadAll(io.LimitReader(response.Body, catalogSynopsisMaxResponseBytes+1))
	if err != nil {
		return "", fmt.Errorf("read Ollama catalog synopsis: %w", err)
	}
	if len(responseContents) > catalogSynopsisMaxResponseBytes {
		return "", fmt.Errorf("read Ollama catalog synopsis: exceeds %d bytes", catalogSynopsisMaxResponseBytes)
	}
	var payload struct {
		Response string `json:"response"`
	}
	if err := json.Unmarshal(responseContents, &payload); err != nil {
		return "", fmt.Errorf("parse Ollama catalog synopsis: %w", err)
	}
	if strings.TrimSpace(payload.Response) == "" {
		return "", fmt.Errorf("parse Ollama catalog synopsis: missing response")
	}
	return strings.TrimSpace(payload.Response), nil
}

func (generator CatalogSynopsisGenerator) ReleaseCatalogSynopsisModel(ctx context.Context) error {
	requestContext, cancel := context.WithTimeout(ctx, generator.configuration.Timeout)
	defer cancel()
	contents, err := json.Marshal(struct {
		Model     string `json:"model"`
		KeepAlive string `json:"keep_alive"`
	}{Model: generator.configuration.Model, KeepAlive: "0"})
	if err != nil {
		return fmt.Errorf("encode Ollama catalog synopsis release: %w", err)
	}
	endpoint := strings.TrimRight(strings.TrimSpace(generator.endpoint), "/")
	if endpoint == "" {
		endpoint = defaultEndpoint
	}
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, endpoint+"/api/generate", bytes.NewReader(contents))
	if err != nil {
		return fmt.Errorf("create Ollama catalog synopsis release: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := generator.client.Do(request)
	if err != nil {
		return fmt.Errorf("release Ollama catalog synopsis: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("release Ollama catalog synopsis: unexpected HTTP status %s", response.Status)
	}
	return nil
}

func catalogSynopsisPrompt(unit index.CatalogSynopsisInput) string {
	prompt := "Write one concise factual capability synopsis from only this catalog unit. Return synopsis text only.\n" +
		"Name: " + unit.Name + "\n" +
		"Kind: " + string(unit.Kind) + "\n" +
		"Owner: " + unit.Owner + "\n" +
		"Signature: " + unit.Signature + "\n" +
		"Declaration source: " + unit.DeclarationSource + "\n" +
		"Comments: " + strings.Join(unit.Comments, " ") + "\n" +
		"Identifiers: " + strings.Join(unit.IdentifierTokens, " ")
	for len(prompt) > catalogSynopsisMaxPromptBytes {
		_, size := utf8.DecodeLastRuneInString(prompt)
		prompt = prompt[:len(prompt)-size]
	}
	return prompt
}
