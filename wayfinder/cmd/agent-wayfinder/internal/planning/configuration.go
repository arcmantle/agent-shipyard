package planning

import (
	"encoding/json"
	"fmt"
	"os"

	configpath "agent-wayfinder/cmd/agent-wayfinder/internal/configuration"
)

type Provider string

const (
	ProviderOllama  Provider = "ollama"
	ProviderClaude  Provider = "claude"
	ProviderCopilot Provider = "copilot"
)

func ReadProvider(workspaceRoot string) (Provider, error) {
	provider, _, err := readProvider(workspaceRoot)
	return provider, err
}

func ReadProviderSource(workspaceRoot string) (string, error) {
	_, source, err := readProvider(workspaceRoot)
	return source, err
}

func readProvider(workspaceRoot string) (Provider, string, error) {
	var provider Provider
	source := "default"
	paths := configpath.Paths(workspaceRoot)
	for index, path := range paths {
		contents, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return "", "", fmt.Errorf("read planning configuration: %w", err)
		}
		var root map[string]json.RawMessage
		if err := json.Unmarshal(contents, &root); err != nil {
			return "", "", fmt.Errorf("parse planning configuration: %w", err)
		}
		planningContents, exists := root["planning"]
		if !exists {
			continue
		}
		var planning map[string]json.RawMessage
		if err := json.Unmarshal(planningContents, &planning); err != nil {
			return "", "", fmt.Errorf("parse planning configuration: %w", err)
		}
		providerContents, exists := planning["provider"]
		if !exists {
			continue
		}
		if err := json.Unmarshal(providerContents, &provider); err != nil {
			return "", "", fmt.Errorf("parse planning provider: %w", err)
		}
		source = "user"
		if index == len(paths)-1 {
			source = "workspace"
		}
	}
	switch provider {
	case "", ProviderOllama, ProviderClaude, ProviderCopilot:
		return provider, source, nil
	default:
		return "", "", fmt.Errorf("invalid planning provider %q: use ollama, claude, or copilot", provider)
	}
}
