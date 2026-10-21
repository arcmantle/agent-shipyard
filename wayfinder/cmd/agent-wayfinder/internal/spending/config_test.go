package spending

import (
	"strings"
	"testing"

	"agent-wayfinder/testkit"
)

func TestReadConfigurationMergesUserAndWorkspaceLimits(t *testing.T) {
	user := testkit.NewWorkspace(t, map[string]string{})
	user.WriteFile(t, ".agent-wayfinder/config.json", `{"spending":{"copilot":{"dailyAiCredits":100,"weeklyAiCredits":500},"claude":{"dailyUsd":10}}}`)
	t.Setenv("HOME", user.Root)
	t.Setenv("USERPROFILE", user.Root)
	workspace := testkit.NewWorkspace(t, map[string]string{
		".agent-wayfinder/config.json": `{"spending":{"copilot":{"dailyAiCredits":200,"monthlyAiCredits":1000},"claude":{"monthlyUsd":100}}}`,
	})

	configuration, err := ReadConfiguration(workspace.Root)
	if err != nil {
		t.Fatalf("read spending configuration: %v", err)
	}
	if configuration.Copilot.Daily != 200 || configuration.Copilot.Weekly != 500 || configuration.Copilot.Monthly != 1000 || configuration.Claude.Daily != 10 || configuration.Claude.Monthly != 100 {
		t.Errorf("spending configuration = %+v, want user limits with workspace overrides", configuration)
	}
}

func TestReadConfigurationRejectsInvalidLimits(t *testing.T) {
	for _, contents := range []string{
		`{"spending":{"copilot":{"dailyAiCredits":-1}}}`,
		`{"spending":{"claude":{"dailyUsd":-1}}}`,
		`{"spending":{"copilot":{"unknown":1}}}`,
	} {
		workspace := testkit.NewWorkspace(t, map[string]string{".agent-wayfinder/config.json": contents})
		_, err := ReadConfiguration(workspace.Root)
		if err == nil || !strings.Contains(err.Error(), "spending") {
			t.Errorf("read spending configuration error = %v, want invalid spending configuration", err)
		}
	}
}
