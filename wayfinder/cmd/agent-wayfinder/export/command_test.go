package export

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

func TestExportCommandWritesPublishedGraphAsJSON(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json":  `{"name":"fixture"}`,
		"src/helper.ts": "export function helper() { return 1; }",
		"src/main.ts":   "import { helper } from './helper'; export function main() { return helper(); }",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")

	indexCommand := exec.Command("go", "run", ".", "index", "--database", database, workspace.Root)
	if output, err := indexCommand.CombinedOutput(); err != nil {
		t.Fatalf("run index command: %v\n%s", err, output)
	}
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatalf("read working directory: %v", err)
	}
	relativeWorkspace, err := filepath.Rel(workingDirectory, workspace.Root)
	if err != nil {
		t.Fatalf("resolve relative workspace: %v", err)
	}

	exportCommand := exec.Command("go", "run", ".", "export", "--database", database, "--format", "json", relativeWorkspace)
	output, err := exportCommand.CombinedOutput()
	if err != nil {
		t.Fatalf("run export command: %v\n%s", err, output)
	}

	var result struct {
		GraphVersion int    `json:"graphVersion"`
		PublishedAt  string `json:"publishedAt"`
		Result       struct {
			Nodes []struct {
				ID       string `json:"id"`
				Evidence any    `json:"evidence"`
			} `json:"nodes"`
			Edges []struct {
				Relation string `json:"relation"`
				Evidence any    `json:"evidence"`
			} `json:"edges"`
		} `json:"result"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatalf("decode export result: %v\n%s", err, output)
	}
	var schema map[string]any
	if err := json.Unmarshal(output, &schema); err != nil {
		t.Fatalf("decode export schema: %v\n%s", err, output)
	}
	resultData := schema["result"].(map[string]any)
	nodes := resultData["nodes"].([]any)
	firstNode := nodes[0].(map[string]any)
	if _, exists := firstNode["id"]; !exists {
		t.Errorf("exported node fields = %v, want lower-camel-case id", firstNode)
	}
	if _, exists := firstNode["ID"]; exists {
		t.Errorf("exported node fields = %v, do not want upper-case ID", firstNode)
	}
	if result.GraphVersion != 1 {
		t.Errorf("graph version = %d, want 1", result.GraphVersion)
	}
	if result.PublishedAt == "" {
		t.Error("published time is empty")
	}
	if len(result.Result.Nodes) == 0 || result.Result.Nodes[0].Evidence == nil {
		t.Errorf("exported nodes = %+v, want nodes with evidence", result.Result.Nodes)
	}
	for _, edge := range result.Result.Edges {
		if edge.Relation == "typescript:imports_from" && edge.Evidence != nil {
			return
		}
	}
	t.Errorf("exported edges = %+v, want resolved import edge with evidence", result.Result.Edges)
}

func TestExportCommandRejectsWorkspaceWithoutPublishedGraph(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json": `{"name":"fixture"}`,
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	if err := os.MkdirAll(filepath.Dir(database), 0o755); err != nil {
		t.Fatalf("create database directory: %v", err)
	}

	command := exec.Command("go", "run", ".", "export", "--database", database, workspace.Root)
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatalf("run export command succeeded: %s", output)
	}
	if got := string(output); !strings.Contains(got, "no published graph is available for workspace") {
		t.Errorf("export error = %q, want index unavailable message", got)
	}
}
