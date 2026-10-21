package query

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	indexcommand "agent-wayfinder/cmd/agent-wayfinder/index"
	"agent-wayfinder/query"
	"agent-wayfinder/testkit"
)

func TestMain(tests *testing.M) {
	home, err := os.MkdirTemp("", "agent-wayfinder-test-home-")
	if err != nil {
		panic(err)
	}
	if err := os.Setenv("HOME", home); err != nil {
		panic(err)
	}
	if err := os.Setenv("USERPROFILE", home); err != nil {
		panic(err)
	}
	exitCode := tests.Run()
	_ = os.RemoveAll(home)
	os.Exit(exitCode)
}

func directQueryFixture(t *testing.T) (string, string) {
	t.Helper()
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json":                 `{"name":"fixture"}`,
		"src/main.ts":                  "export function main() { return 1; }",
		".agent-wayfinder/config.json": `{"planning":{"provider":"copilot","copilot":{"cliPath":"/missing/copilot"}}}`,
	})
	database := filepath.Join(t.TempDir(), "graph.db")
	var output, errors bytes.Buffer
	exitCode := 0
	command := indexcommand.New(&output, &errors, &exitCode)
	command.SetArgs([]string{"--catalog-background=false", "--database", database, workspace.Root})
	if err := command.Execute(); err != nil || exitCode != 0 {
		t.Fatalf("index workspace: %v, exit %d\n%s", err, exitCode, &errors)
	}
	return workspace.Root, database
}

func TestDirectQueryInputsAndWorkspace(t *testing.T) {
	workspace, database := directQueryFixture(t)
	source := "MATCH (node {name: 'main'}) RETURN node LIMIT 10"
	sourceFile := filepath.Join(t.TempDir(), "query.cypher")
	if err := os.WriteFile(sourceFile, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name             string
		arguments        []string
		input            string
		currentDirectory bool
		text             bool
	}{
		{name: "flag", arguments: []string{"--query", source}},
		{name: "file", arguments: []string{"--file", sourceFile}},
		{name: "stdin", input: source},
		{name: "current directory", arguments: []string{"--query", source}, currentDirectory: true},
		{name: "text rows and warnings", arguments: []string{"--query", "MATCH (node) RETURN node.name LIMIT 1"}, text: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.currentDirectory {
				t.Chdir(workspace)
			}
			var output, errors bytes.Buffer
			exitCode := 0
			command := New(&output, &errors, &exitCode)
			command.SetIn(strings.NewReader(test.input))
			arguments := []string{"--database", database, "--format", "json"}
			if test.text {
				arguments = []string{"--database", database}
			}
			if !test.currentDirectory {
				arguments = append(arguments, "--path", workspace)
			}
			command.SetArgs(append(arguments, test.arguments...))
			if err := command.Execute(); err != nil || exitCode != 0 {
				t.Fatalf("direct query: %v, exit %d\n%s", err, exitCode, &errors)
			}
			if test.text {
				for _, expected := range []string{"Row: [", "Warning: graph query reached a result or node limit"} {
					if !strings.Contains(output.String(), expected) {
						t.Errorf("text result missing %q: %s", expected, &output)
					}
				}
				return
			}
			var envelope struct {
				Result query.GraphQueryResult `json:"result"`
			}
			if err := json.Unmarshal(output.Bytes(), &envelope); err != nil {
				t.Fatalf("decode direct query: %v\n%s", err, &output)
			}
			if len(envelope.Result.Graph.Nodes) != 1 || envelope.Result.Graph.Nodes[0].Label != "main" || len(envelope.Result.Evidence) == 0 || envelope.Result.Snapshot.Workspace != workspace {
				t.Fatalf("direct query result = %+v", envelope.Result)
			}
		})
	}
}

func TestDirectQueryReportsInputAndValidationErrors(t *testing.T) {
	workspace, database := directQueryFixture(t)
	validSource := "MATCH (node) RETURN node LIMIT 10"
	for _, test := range []struct {
		name      string
		arguments []string
		message   string
	}{
		{name: "empty input", message: "source is required"},
		{name: "empty flag", arguments: []string{"--query", " "}, message: "source is required"},
		{name: "conflicting sources", arguments: []string{"--query", validSource, "--file", "unused"}, message: "cannot be used together"},
		{name: "unreadable file", arguments: []string{"--file", filepath.Join(t.TempDir(), "missing")}, message: "read graph-query source"},
		{name: "positional input", arguments: []string{workspace, "main"}, message: "query accepts source"},
		{name: "invalid syntax", arguments: []string{"--query", "SELECT * FROM nodes"}, message: "parse graph query"},
		{name: "unknown schema", arguments: []string{"--query", "MATCH (node:unknown) RETURN node LIMIT 10"}, message: "validate graph query"},
		{name: "invalid limits", arguments: []string{"--query", validSource, "--max-nodes", "0"}, message: "validate graph query"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output, errors bytes.Buffer
			exitCode := 0
			command := New(&output, &errors, &exitCode)
			command.SetIn(strings.NewReader(""))
			command.SetArgs(append([]string{"--path", workspace, "--database", database}, test.arguments...))
			if err := command.Execute(); err != nil {
				t.Fatal(err)
			}
			if exitCode != 2 || !strings.Contains(errors.String(), test.message) || output.Len() != 0 {
				t.Fatalf("exit %d, output %q, error %q; want invalid argument with %q", exitCode, output.String(), errors.String(), test.message)
			}
		})
	}
}
