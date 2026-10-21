package ollama

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	configpath "agent-wayfinder/cmd/agent-wayfinder/internal/configuration"
	"agent-wayfinder/cmd/agent-wayfinder/internal/planning"
	"agent-wayfinder/query"
)

const defaultEndpoint = "http://127.0.0.1:11434"

const (
	PlannerContextTokens    = 8192
	PlannerPredictionTokens = 2048
	PlannerThreadLimit      = 1
	PlannerMaxResponseBytes = 8 * 1024
)

type Configuration struct {
	Enabled  bool
	Model    string
	Endpoint string
	Timeout  time.Duration
}

type configurationFile struct {
	Model    *string         `json:"model"`
	Endpoint *string         `json:"endpoint"`
	Timeout  json.RawMessage `json:"timeout"`
}

var modelPattern = regexp.MustCompile(`^[A-Za-z0-9._:/-]+$`)

func ReadConfiguration(workspaceRoot string) (Configuration, error) {
	configuration := Configuration{Model: "qwen3:8b", Endpoint: DefaultEndpoint(), Timeout: 30 * time.Second}
	paths := configpath.Paths(workspaceRoot)
	for _, path := range paths {
		fileConfiguration, err := readConfigurationFile(path)
		if err != nil {
			return Configuration{}, err
		}
		if fileConfiguration.Model != nil {
			configuration.Model = *fileConfiguration.Model
		}
		if fileConfiguration.Endpoint != nil {
			configuration.Endpoint = *fileConfiguration.Endpoint
		}
		if len(fileConfiguration.Timeout) > 0 {
			configuration.Timeout, err = parseJSONTimeout(fileConfiguration.Timeout)
			if err != nil {
				return Configuration{}, fmt.Errorf("invalid planning.ollama.timeout: %w", err)
			}
		}
	}
	provider, err := planning.ReadProvider(workspaceRoot)
	if err != nil {
		return Configuration{}, err
	}
	configuration.Enabled = provider == planning.ProviderOllama
	if err := validateConfiguration(configuration); err != nil {
		return Configuration{}, err
	}
	return configuration, nil
}

func readConfigurationFile(path string) (configurationFile, error) {
	contents, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return configurationFile{}, nil
	}
	if err != nil {
		return configurationFile{}, fmt.Errorf("read Ollama planner configuration: %w", err)
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(contents, &root); err != nil {
		return configurationFile{}, fmt.Errorf("parse Ollama planner configuration: %w", err)
	}
	planningContents, exists := root["planning"]
	if !exists {
		return configurationFile{}, nil
	}
	var planning map[string]json.RawMessage
	if err := json.Unmarshal(planningContents, &planning); err != nil {
		return configurationFile{}, fmt.Errorf("parse Ollama planner configuration: %w", err)
	}
	plannerContents, exists := planning["ollama"]
	if !exists {
		return configurationFile{}, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(plannerContents))
	decoder.DisallowUnknownFields()
	var configuration configurationFile
	if err := decoder.Decode(&configuration); err != nil {
		return configurationFile{}, fmt.Errorf("parse Ollama planner configuration: %w", err)
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

func validateConfiguration(configuration Configuration) error {
	if !ValidModel(configuration.Model) {
		return fmt.Errorf("invalid Ollama planner model %q", configuration.Model)
	}
	endpoint, err := url.ParseRequestURI(configuration.Endpoint)
	if err != nil || endpoint.Scheme == "" || endpoint.Host == "" {
		return fmt.Errorf("invalid Ollama planner endpoint: use an absolute URL")
	}
	if configuration.Timeout <= 0 || configuration.Timeout > 30*time.Second {
		return fmt.Errorf("invalid Ollama planner timeout: use a duration from 1ns through 30s")
	}
	return nil
}

func ValidModel(model string) bool {
	return strings.TrimSpace(model) != "" && modelPattern.MatchString(model)
}

type plannerRequest struct {
	Model     string           `json:"model"`
	Messages  []plannerMessage `json:"messages"`
	Format    any              `json:"format"`
	Options   plannerOptions   `json:"options"`
	Think     bool             `json:"think"`
	KeepAlive string           `json:"keep_alive"`
	Stream    bool             `json:"stream"`
}

type plannerOptions struct {
	NumCtx     int `json:"num_ctx"`
	NumPredict int `json:"num_predict"`
	NumThread  int `json:"num_thread"`
}

type plannerMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type plannerResponse struct {
	Message struct {
		Content string `json:"content"`
	} `json:"message"`
}

func RunGraphPlanner(parent context.Context, configuration Configuration, request query.GraphPlanningRequest, endpoint string, client *http.Client) ([]byte, error) {
	prompt, err := query.GraphPlanningPrompt(request)
	if err != nil {
		return nil, err
	}
	return runPlannerRequest(parent, configuration, plannerRequest{
		Model: configuration.Model,
		Messages: []plannerMessage{
			{Role: "system", Content: "Return only JSON query candidates. Do not use tools or report confidence."},
			{Role: "user", Content: prompt},
		},
		Format:    json.RawMessage(query.GraphPlanningResponseSchema),
		Options:   plannerOptions{NumCtx: PlannerContextTokens, NumPredict: PlannerPredictionTokens, NumThread: PlannerThreadLimit},
		KeepAlive: "0",
	}, endpoint, client)
}

func runPlannerRequest(parent context.Context, configuration Configuration, body plannerRequest, endpoint string, client *http.Client) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, configuration.Timeout)
	defer cancel()
	requestBody, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode Ollama planner request: %w", err)
	}
	if client == nil {
		client = http.DefaultClient
	}
	url := strings.TrimRight(strings.TrimSpace(endpoint), "/")
	if url == "" {
		url = defaultEndpoint
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url+"/api/chat", bytes.NewReader(requestBody))
	if err != nil {
		return nil, fmt.Errorf("create Ollama planner request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("run Ollama planner: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("run Ollama planner: unexpected HTTP status %s", response.Status)
	}
	contents, err := io.ReadAll(io.LimitReader(response.Body, PlannerMaxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read Ollama planner response: %w", err)
	}
	if len(contents) > PlannerMaxResponseBytes {
		return nil, fmt.Errorf("read Ollama planner response: exceeds %d bytes", PlannerMaxResponseBytes)
	}
	var responseData plannerResponse
	if err := json.Unmarshal(contents, &responseData); err != nil {
		return nil, fmt.Errorf("parse Ollama planner response: %w", err)
	}
	if strings.TrimSpace(responseData.Message.Content) == "" {
		return nil, fmt.Errorf("parse Ollama planner response: missing message content")
	}
	return []byte(responseData.Message.Content), nil
}

func Endpoint() string {
	endpoint := strings.TrimSpace(os.Getenv("OLLAMA_HOST"))
	if endpoint != "" && !strings.Contains(endpoint, "://") {
		return "http://" + endpoint
	}
	return endpoint
}

func DefaultEndpoint() string {
	endpoint := Endpoint()
	if endpoint == "" {
		return defaultEndpoint
	}
	return endpoint
}
