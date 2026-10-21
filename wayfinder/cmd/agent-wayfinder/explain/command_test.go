package explain

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
	"agent-wayfinder/testkit"
)

func TestMain(m *testing.M) {
	if err := os.Chdir(".."); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

func TestInspectCommandReportsNodeEvidenceAndGroupedDirectEdges(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json":  `{"name":"fixture"}`,
		"src/helper.ts": "export function helper() { return 1; }",
		"src/main.ts":   "import { helper } from './helper'; export function main() { return helper(); }",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")

	indexCommand := exec.Command("go", "run", ".", "index", "--catalog-background=false", "--database", database, workspace.Root)
	if output, err := indexCommand.CombinedOutput(); err != nil {
		t.Fatalf("run index command: %v\n%s", err, output)
	}
	if output, err := exec.Command("go", "run", ".", "catalog", "--foreground", "--database", database, workspace.Root).CombinedOutput(); err != nil {
		t.Fatalf("run catalog command: %v\n%s", err, output)
	}

	textCommand := exec.Command("go", "run", ".", "inspect", "--database", database, workspace.Root, "src/helper.ts::helper")
	textOutput, err := textCommand.CombinedOutput()
	if err != nil {
		t.Fatalf("run inspect command: %v\n%s", err, textOutput)
	}
	for _, want := range []string{
		"Node:",
		"Source: src/helper.ts:",
		"Extractor: typescript",
		"Direct edges:",
		"typescript:imports_from (1):",
		"Catalog evidence:",
		"- deterministic:",
	} {
		if !strings.Contains(string(textOutput), want) {
			t.Errorf("explain text = %q, want %q", textOutput, want)
		}
	}

	jsonCommand := exec.Command("go", "run", ".", "inspect", "--database", database, "--format", "json", workspace.Root, "src/helper.ts::helper")
	jsonOutput, err := jsonCommand.CombinedOutput()
	if err != nil {
		t.Fatalf("run explain JSON command: %v\n%s", err, jsonOutput)
	}
	var output struct {
		Result struct {
			Explanation struct {
				Node struct {
					Evidence struct {
						Extractor  string `json:"extractor"`
						Confidence string `json:"confidence"`
					} `json:"evidence"`
				} `json:"node"`
				SupportingFacts struct {
					Edges []struct {
						Relation string `json:"relation"`
						Evidence any    `json:"evidence"`
					} `json:"edges"`
				} `json:"supportingFacts"`
			} `json:"explanation"`
		} `json:"result"`
	}
	if err := json.Unmarshal(jsonOutput, &output); err != nil {
		t.Fatalf("decode inspect JSON result: %v\n%s", err, jsonOutput)
	}
	if !strings.HasPrefix(output.Result.Explanation.Node.Evidence.Extractor, "typescript") || output.Result.Explanation.Node.Evidence.Confidence == "" {
		t.Errorf("node evidence = %+v, want TypeScript evidence with confidence", output.Result.Explanation.Node.Evidence)
	}
	for _, edge := range output.Result.Explanation.SupportingFacts.Edges {
		if edge.Relation == "typescript:imports_from" && edge.Evidence != nil {
			return
		}
	}
	t.Errorf("supporting edges = %+v, want an evidenced import edge", output.Result.Explanation.SupportingFacts.Edges)
}

func TestInspectCommandShowsGeneratorLabeledCatalogSynopses(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json":     `{"name":"fixture"}`,
		"src/validator.ts": "export function validateAccessToken(token: string) { return token.length > 0; }",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	if output, err := exec.Command("go", "run", ".", "index", "--catalog-background=false", "--database", database, workspace.Root).CombinedOutput(); err != nil {
		t.Fatalf("run index command: %v\n%s", err, output)
	}

	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		t.Fatalf("open catalog database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	snapshot, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspace.Root})
	if err != nil {
		t.Fatalf("open catalog snapshot: %v", err)
	}
	matches, err := store.LookupExactNodes(context.Background(), snapshot, "src/validator.ts::validateAccessToken")
	if err != nil || len(matches) != 1 {
		t.Fatalf("find validator node: matches=%+v error=%v", matches, err)
	}
	if err := store.WriteCatalog(context.Background(), snapshot, storage.CatalogWriteRequest{Entries: []storage.CatalogEntry{{
		NodeID:                matches[0].Node.ID,
		Name:                  matches[0].Node.QualifiedName,
		DeterministicSynopsis: "Validate an access token.",
		CopilotSynopsis:       "Check that an access token is valid.",
		OllamaSynopsis:        "Validate token input.",
		ClaudeSynopsis:        "Confirm access-token validity.",
	}}}); err != nil {
		t.Fatalf("write catalog entry: %v", err)
	}

	output, err := exec.Command("go", "run", ".", "inspect", "--database", database, "--format", "json", workspace.Root, "src/validator.ts::validateAccessToken").CombinedOutput()
	if err != nil {
		t.Fatalf("run inspect command: %v\n%s", err, output)
	}
	var result struct {
		Result struct {
			CatalogEvidence []struct {
				Generator string `json:"generator"`
				Synopsis  string `json:"synopsis"`
			} `json:"catalogEvidence"`
		} `json:"result"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatalf("decode inspect result: %v\n%s", err, output)
	}
	if want := []struct {
		Generator string `json:"generator"`
		Synopsis  string `json:"synopsis"`
	}{
		{Generator: "deterministic", Synopsis: "Validate an access token."},
		{Generator: "copilot", Synopsis: "Check that an access token is valid."},
		{Generator: "ollama", Synopsis: "Validate token input."},
		{Generator: "claude", Synopsis: "Confirm access-token validity."},
	}; !reflect.DeepEqual(result.Result.CatalogEvidence, want) {
		t.Errorf("catalog evidence = %+v, want %+v", result.Result.CatalogEvidence, want)
	}
}

func TestInspectCommandReportsAmbiguousCandidatesAndRemainderCount(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json": `{"name":"fixture"}`,
		"src/a.ts":     "export function helper() { return 1; }",
		"src/b.ts":     "export function helper() { return 2; }",
		"src/c.ts":     "export function helper() { return 3; }",
		"src/d.ts":     "export function helper() { return 4; }",
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	if output, err := exec.Command("go", "run", ".", "index", "--database", database, workspace.Root).CombinedOutput(); err != nil {
		t.Fatalf("run index command: %v\n%s", err, output)
	}

	command := exec.Command("go", "run", ".", "inspect", "--database", database, "--format", "json", workspace.Root, "helper")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("run ambiguous inspect command: %v\n%s", err, output)
	}
	var result struct {
		Result struct {
			Candidates []struct {
				QualifiedName string `json:"qualifiedName"`
			} `json:"candidates"`
			RemainderCount int `json:"remainderCount"`
			Explanation    any `json:"explanation"`
		} `json:"result"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatalf("decode ambiguous explain JSON result: %v\n%s", err, output)
	}
	if len(result.Result.Candidates) != 3 {
		t.Errorf("candidates = %+v, want three displayed candidates", result.Result.Candidates)
	}
	var candidates []string
	for _, candidate := range result.Result.Candidates {
		candidates = append(candidates, candidate.QualifiedName)
	}
	if want := []string{"src/a.ts::helper", "src/b.ts::helper", "src/c.ts::helper"}; !reflect.DeepEqual(candidates, want) {
		t.Errorf("candidate qualified names = %v, want %v", candidates, want)
	}
	if result.Result.RemainderCount != 1 {
		t.Errorf("remainder count = %d, want 1", result.Result.RemainderCount)
	}
	if result.Result.Explanation != nil {
		t.Errorf("explanation = %+v, want none for ambiguous candidates", result.Result.Explanation)
	}
}
