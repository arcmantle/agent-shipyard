package planning

import (
	"strings"
	"testing"

	"agent-wayfinder/testkit"
)

func TestReadProviderUsesWorkspaceSelection(t *testing.T) {
	user := testkit.NewWorkspace(t, map[string]string{})
	user.WriteFile(t, ".agent-wayfinder/config.json", `{"planning":{"provider":"ollama"}}`)
	t.Setenv("HOME", user.Root)
	t.Setenv("USERPROFILE", user.Root)
	workspace := testkit.NewWorkspace(t, map[string]string{
		".agent-wayfinder/config.json": `{"planning":{"provider":"copilot"}}`,
	})

	provider, err := ReadProvider(workspace.Root)
	if err != nil {
		t.Fatalf("read planning provider: %v", err)
	}
	if provider != ProviderCopilot {
		t.Errorf("planning provider = %q, want copilot", provider)
	}
	source, err := ReadProviderSource(workspace.Root)
	if err != nil {
		t.Fatalf("read planning provider source: %v", err)
	}
	if source != "workspace" {
		t.Errorf("planning provider source = %q, want workspace", source)
	}
}

func TestReadProviderRejectsInvalidSelection(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		".agent-wayfinder/config.json": `{"planning":{"provider":"unknown"}}`,
	})
	_, err := ReadProvider(workspace.Root)
	if err == nil || !strings.Contains(err.Error(), "invalid planning provider") {
		t.Errorf("planning provider error = %v, want invalid provider", err)
	}
}
