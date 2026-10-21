package main

import (
	"strings"
	"testing"
)

func TestCommandRuns(t *testing.T) {
	standardOutput := &strings.Builder{}
	standardError := &strings.Builder{}
	if exitCode := run(nil, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run command: exit code %d, error %s", exitCode, standardError.String())
	}
}

func TestCommandHelpListsPublicCommands(t *testing.T) {
	standardOutput := &strings.Builder{}
	standardError := &strings.Builder{}

	if exitCode := run([]string{"--help"}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run help command: exit code %d, error %s", exitCode, standardError.String())
	}

	output := standardOutput.String()
	for _, command := range []string{"install", "index", "ask", "query", "path", "inspect", "export", "indexer", "benchmark", "mcp"} {
		if !strings.Contains(output, command) {
			t.Errorf("help output = %q, want public command %q", output, command)
		}
	}
	if strings.Contains(output, "\n  explain") {
		t.Errorf("help output = %q, must not list obsolete explain command", output)
	}
}

func TestCommandRejectsUnsupportedOutputFormat(t *testing.T) {
	standardOutput := &strings.Builder{}
	standardError := &strings.Builder{}

	if exitCode := run([]string{"--format", "yaml"}, standardOutput, standardError); exitCode != 2 {
		t.Errorf("exit code = %d, want 2", exitCode)
	}
}
