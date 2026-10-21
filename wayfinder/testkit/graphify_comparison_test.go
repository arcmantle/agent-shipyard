package testkit

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"testing"
)

func graphifyCommandOutput(command *exec.Cmd) ([]byte, error) {
	output, err := command.Output()
	if err == nil {
		return output, nil
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) && len(exitError.Stderr) > 0 {
		return output, fmt.Errorf("%w\n%s", err, exitError.Stderr)
	}
	return output, err
}

func TestRunGraphifyComparisonCorpusComparesCLIAndExportedFacts(t *testing.T) {
	workspace := NewWorkspace(t, map[string]string{
		"package.json":  `{"name":"comparison-fixture"}`,
		"src/helper.ts": "export function helper() { return 1; }\n",
		"src/main.ts":   "import { helper } from './helper'; export function main() { return helper(); }\n",
	})
	database := filepath.Join(t.TempDir(), "graph.db")

	command := exec.Command("go", "run", "../cmd/agent-wayfinder", "index", "--catalog-background=false", "--database", database, "--format", "json", workspace.Root)
	if output, err := graphifyCommandOutput(command); err != nil {
		t.Fatalf("index comparison corpus workspace: %v\n%s", err, output)
	}

	command = exec.Command("go", "run", "../cmd/agent-wayfinder", "export", "--database", database, "--format", "json", workspace.Root)
	candidate, err := graphifyCommandOutput(command)
	if err != nil {
		t.Fatalf("export comparison corpus workspace: %v\n%s", err, candidate)
	}

	if err := RunGraphifyComparisonCorpus("typescript-import", candidate); err != nil {
		t.Fatal(err)
	}
}

func TestRunGraphifyComparisonCorpusComparesIndexDiagnostics(t *testing.T) {
	workspace := NewWorkspace(t, map[string]string{
		"package.json": `{"name":"comparison-fixture"}`,
		"src/main.ts":  "const support = import(moduleName);\n",
	})
	database := filepath.Join(t.TempDir(), "graph.db")

	command := exec.Command("go", "run", "../cmd/agent-wayfinder", "index", "--catalog-background=false", "--database", database, "--format", "json", workspace.Root)
	candidate, err := graphifyCommandOutput(command)
	if err != nil {
		t.Fatalf("index diagnostic comparison corpus workspace: %v\n%s", err, candidate)
	}
	if err := RunGraphifyIndexComparisonCorpus("typescript-diagnostic", candidate); err != nil {
		t.Fatal(err)
	}
}
