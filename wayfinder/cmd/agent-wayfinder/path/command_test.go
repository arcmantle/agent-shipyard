package path

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"agent-wayfinder/testkit"
)

func TestMain(m *testing.M) {
	if err := os.Chdir(".."); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

func TestPathCommandReportsDirectedPathAndDeterministicNoResult(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json":  `{"name":"fixture"}`,
		"src/helper.ts": "export function helper() { return 1; }",
		"src/main.ts":   "import { helper } from './helper'; export function main() { return helper(); }",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	if output, err := exec.Command("go", "run", ".", "index", "--database", database, workspace.Root).CombinedOutput(); err != nil {
		t.Fatalf("run index command: %v\n%s", err, output)
	}

	pathCommand := exec.Command("go", "run", ".", "path", "--database", database, workspace.Root, "src/main.ts::main", "src/helper.ts::helper")
	pathOutput, err := pathCommand.CombinedOutput()
	if err != nil {
		t.Fatalf("run path command: %v\n%s", err, pathOutput)
	}
	if got := string(pathOutput); !strings.Contains(got, "src/main.ts::main") || !strings.Contains(got, "src/helper.ts::helper") || !strings.Contains(got, "typescript:calls") {
		t.Errorf("path output = %q, want directed call path", got)
	}

	noResultCommand := exec.Command("go", "run", ".", "path", "--database", database, workspace.Root, "src/helper.ts::helper", "src/main.ts::main")
	noResultOutput, err := noResultCommand.CombinedOutput()
	if err != nil {
		t.Fatalf("run no-result path command: %v\n%s", err, noResultOutput)
	}
	if got := string(noResultOutput); !strings.Contains(got, "No directed path found.") {
		t.Errorf("no-result path output = %q, want deterministic directed no-result", got)
	}

	fallbackCommand := exec.Command("go", "run", ".", "path", "--database", database, "--undirected", workspace.Root, "src/helper.ts::helper", "src/main.ts::main")
	fallbackOutput, err := fallbackCommand.CombinedOutput()
	if err != nil {
		t.Fatalf("run undirected fallback path command: %v\n%s", err, fallbackOutput)
	}
	if got := string(fallbackOutput); !strings.Contains(got, "Used undirected fallback.") {
		t.Errorf("fallback output = %q, want undirected fallback report", got)
	}

	missingFallbackCommand := exec.Command("go", "run", ".", "path", "--database", database, "--undirected", "--relation", "references", "--format", "json", workspace.Root, "src/main.ts::main", "src/helper.ts::helper")
	missingFallbackOutput, err := missingFallbackCommand.CombinedOutput()
	if err != nil {
		t.Fatalf("run missing undirected path command: %v\n%s", err, missingFallbackOutput)
	}
	var missingFallbackResult struct {
		Result struct {
			UndirectedFallbackAttempted bool `json:"undirectedFallbackAttempted"`
		} `json:"result"`
	}
	if err := json.Unmarshal(missingFallbackOutput, &missingFallbackResult); err != nil {
		t.Fatalf("decode missing fallback path result: %v\n%s", err, missingFallbackOutput)
	}
	if !missingFallbackResult.Result.UndirectedFallbackAttempted {
		t.Errorf("missing fallback path result = %s, want fallback attempt", missingFallbackOutput)
	}
}
