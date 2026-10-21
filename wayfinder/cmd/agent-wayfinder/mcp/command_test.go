package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"agent-wayfinder/cli"
	"agent-wayfinder/cmd/agent-wayfinder/index"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"

	"github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/spf13/cobra"

	"agent-wayfinder/testkit"
)

func runTestCommand(ctx context.Context, arguments []string, standardOutput, standardError io.Writer) int {
	if len(arguments) == 0 {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("expected test command"))
	}
	exitCode := 0
	var command *cobra.Command
	switch arguments[0] {
	case "index":
		command = index.New(standardOutput, standardError, &exitCode)
	default:
		return runCommand(ctx, arguments, standardOutput, standardError)
	}
	command.SetOut(standardOutput)
	command.SetErr(standardError)
	command.SetArgs(arguments[1:])
	if err := command.ExecuteContext(ctx); err != nil {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError(err.Error()))
	}
	return exitCode
}

func TestMCPServerListsToolsAndRunsOtherCommands(t *testing.T) {
	var receivedCalls [][]string
	runCommand := func(_ context.Context, arguments []string, standardOutput, _ io.Writer) int {
		receivedCalls = append(receivedCalls, append([]string(nil), arguments...))
		fmt.Fprintln(standardOutput, `{"graphVersion":7,"publishedAt":"2026-08-31T12:00:00Z","result":{"nodes":[],"catalog":{"matches":[]}}}`)
		return 0
	}
	mcpClient, err := client.NewInProcessClient(newMCPServer(runCommand))
	if err != nil {
		t.Fatalf("create MCP client: %v", err)
	}
	t.Cleanup(func() { _ = mcpClient.Close() })
	ctx := context.Background()
	if err := mcpClient.Start(ctx); err != nil {
		t.Fatalf("start MCP client: %v", err)
	}
	if _, err := mcpClient.Initialize(ctx, mcp.InitializeRequest{Params: mcp.InitializeParams{
		ProtocolVersion: mcp.LATEST_PROTOCOL_VERSION,
		ClientInfo:      mcp.Implementation{Name: "agent-wayfinder-test", Version: "1.0.0"},
	}}); err != nil {
		t.Fatalf("initialize MCP client: %v", err)
	}

	tools, err := mcpClient.ListTools(ctx, mcp.ListToolsRequest{})
	if err != nil {
		t.Fatalf("list MCP tools: %v", err)
	}
	toolNames := make([]string, 0, len(tools.Tools))
	for _, tool := range tools.Tools {
		toolNames = append(toolNames, tool.Name)
	}
	sort.Strings(toolNames)
	if want := []string{"ask", "export", "inspect", "path", "query"}; !reflect.DeepEqual(toolNames, want) {
		t.Errorf("MCP tools = %v, want %v", toolNames, want)
	}

	toolCalls := []struct {
		name      string
		arguments map[string]any
		want      []string
	}{
		{
			name:      "ask",
			arguments: map[string]any{"workspace": "/workspace", "question": "what calls API?", "maxDepth": 3, "maxNodes": 20, "database": "/tmp/graph.db", "diagnostics": true},
			want:      []string{"ask", "--format", "json", "--path", "/workspace", "--max-depth", "3", "--max-nodes", "20", "--database", "/tmp/graph.db", "--diagnostics", "--", "what calls API?"},
		},
		{
			name:      "path",
			arguments: map[string]any{"workspace": "/workspace", "source": "API", "target": "Store", "undirected": true, "maxNodes": 20, "database": "/tmp/graph.db"},
			want:      []string{"path", "--format", "json", "--max-depth", "8", "--max-nodes", "20", "--undirected", "--database", "/tmp/graph.db", "/workspace", "API", "Store"},
		},
		{
			name:      "inspect",
			arguments: map[string]any{"workspace": "/workspace", "node": "API"},
			want:      []string{"inspect", "--format", "json", "/workspace", "API"},
		},
		{
			name:      "export",
			arguments: map[string]any{"workspace": "/workspace"},
			want:      []string{"export", "--format", "json", "/workspace"},
		},
	}
	for callIndex, toolCall := range toolCalls {
		result, err := mcpClient.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{Name: toolCall.name, Arguments: toolCall.arguments}})
		if err != nil {
			t.Fatalf("call %s tool: %v", toolCall.name, err)
		}
		if result.IsError {
			t.Errorf("%s tool returned an error: %+v", toolCall.name, result.Content)
		}
		if got := receivedCalls[callIndex]; !reflect.DeepEqual(got, toolCall.want) {
			t.Errorf("%s command arguments = %v, want %v", toolCall.name, got, toolCall.want)
		}
	}
}

func TestMCPToolReturnsCommandFailureAsToolError(t *testing.T) {
	handler := commandToolHandler(func(_ context.Context, _ []string, _, standardError io.Writer) int {
		fmt.Fprintln(standardError, "error: no published graph")
		return 1
	}, exportMCPArguments)

	result, err := handler(context.Background(), mcp.CallToolRequest{Params: mcp.CallToolParams{
		Arguments: map[string]any{"workspace": "/workspace"},
	}})
	if err != nil {
		t.Fatalf("run MCP tool handler: %v", err)
	}
	if !result.IsError {
		t.Fatalf("tool result = %+v, want command failure", result)
	}
}

func TestMCPGraphModesRejectCancelledRequests(t *testing.T) {
	for _, arguments := range []func(mcp.CallToolRequest) ([]string, error){askMCPArguments, queryMCPArguments} {
		for _, preCancelled := range []bool{true, false} {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if preCancelled {
				cancel()
			}
			calls := 0
			handler := commandToolHandler(func(commandContext context.Context, _ []string, _, standardError io.Writer) int {
				calls++
				cancel()
				if commandContext.Err() != context.Canceled {
					t.Fatal("runner did not receive request cancellation")
				}
				fmt.Fprintln(standardError, commandContext.Err())
				return 1
			}, arguments)
			result, err := handler(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{"question": "Find main", "query": "MATCH (node) RETURN node LIMIT 1"}}})
			wantCalls := 1
			if preCancelled {
				wantCalls = 0
			}
			if err != nil || !result.IsError || calls != wantCalls {
				t.Fatalf("result = %+v, error = %v, executions = %d; want cancelled tool error with %d executions", result, err, calls, wantCalls)
			}
		}
	}
}

func TestMCPGraphModesExecuteSharedSourceContract(t *testing.T) {
	providerCalls := 0
	provider := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		providerCalls++
		_ = json.NewEncoder(response).Encode(map[string]any{"message": map[string]string{"content": `{"candidates":["MATCH (node {name: 'validateAccessToken'}) RETURN node LIMIT 10"]}`}})
	}))
	t.Cleanup(provider.Close)
	configuration, err := json.Marshal(map[string]any{"planning": map[string]any{"provider": "ollama", "ollama": map[string]any{"endpoint": provider.URL}}, "embedding": map[string]any{"enabled": false}})
	if err != nil {
		t.Fatal(err)
	}
	workspace := testkit.NewWorkspace(t, map[string]string{
		"package.json":                 `{"name":"fixture"}`,
		"src/token.ts":                 "export function validateAccessToken(token: string) { return token.length > 0; }",
		".agent-wayfinder/config.json": string(configuration),
	})
	database := filepath.Join(t.TempDir(), "state", "graph.db")
	standardOutput := &bytes.Buffer{}
	standardError := &bytes.Buffer{}
	if exitCode := runTestCommand(context.Background(), []string{"index", "--catalog-background=false", "--database", database, workspace.Root}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run index command: exit code %d, error %s", exitCode, standardError.String())
	}
	mcpClient, err := client.NewInProcessClient(newMCPServer(runTestCommand))
	if err != nil {
		t.Fatalf("create MCP client: %v", err)
	}
	t.Cleanup(func() { _ = mcpClient.Close() })
	ctx := context.Background()
	if err := mcpClient.Start(ctx); err != nil {
		t.Fatalf("start MCP client: %v", err)
	}
	if _, err := mcpClient.Initialize(ctx, mcp.InitializeRequest{Params: mcp.InitializeParams{
		ProtocolVersion: mcp.LATEST_PROTOCOL_VERSION,
		ClientInfo:      mcp.Implementation{Name: "agent-wayfinder-test", Version: "1.0.0"},
	}}); err != nil {
		t.Fatalf("initialize MCP client: %v", err)
	}

	result, err := mcpClient.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{
		Name: "query",
		Arguments: map[string]any{
			"workspace": workspace.Root,
			"database":  database,
			"query":     "MATCH (node {name: 'validateAccessToken'}) RETURN node LIMIT 10",
		},
	}})
	if err != nil {
		t.Fatalf("call query tool: %v", err)
	}
	if result.IsError {
		t.Fatalf("query tool result = %+v, want graph evidence", result.Content)
	}
	structuredContent, ok := result.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("structured content = %#v, want JSON object", result.StructuredContent)
	}
	resultContent, ok := structuredContent["result"].(map[string]any)
	if !ok {
		t.Fatalf("structured result = %#v, want JSON object", structuredContent)
	}
	graph, ok := resultContent["graph"].(map[string]any)
	if !ok {
		t.Fatalf("graph result = %#v, want JSON object", resultContent["graph"])
	}
	nodes, ok := graph["nodes"].([]any)
	if !ok || len(nodes) != 1 {
		t.Fatalf("graph nodes = %#v, want one node", graph["nodes"])
	}
	node, ok := nodes[0].(map[string]any)
	if !ok {
		t.Fatalf("graph node = %#v, want JSON object", nodes[0])
	}
	evidence, ok := resultContent["evidence"].([]any)
	if !ok || len(evidence) != 1 {
		t.Fatalf("graph evidence = %#v, want source evidence", resultContent["evidence"])
	}
	if node["label"] != "validateAccessToken" || resultContent["snapshot"] == nil || resultContent["limits"] == nil || resultContent["warnings"] == nil {
		t.Errorf("query result = %#v, want shared graph result", resultContent)
	}

	t.Chdir(workspace.Root)
	defaultResult, err := mcpClient.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{
		Name: "query",
		Arguments: map[string]any{
			"database": database,
			"query":    "MATCH (node {name: 'validateAccessToken'}) RETURN node LIMIT 10",
		},
	}})
	if err != nil || defaultResult.IsError {
		t.Fatalf("query with default workspace: %v, result %+v", err, defaultResult)
	}
	if !reflect.DeepEqual(defaultResult.StructuredContent, result.StructuredContent) {
		t.Fatalf("default workspace result = %#v, want %#v", defaultResult.StructuredContent, result.StructuredContent)
	}
	if providerCalls != 0 {
		t.Fatalf("direct query called AI %d times", providerCalls)
	}
	askResult, err := mcpClient.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{
		Name: "ask", Arguments: map[string]any{"database": database, "question": "Which function validates access tokens?", "diagnostics": true},
	}})
	if err != nil || askResult.IsError {
		t.Fatalf("ask: %v, result %+v", err, askResult)
	}
	askEnvelope := askResult.StructuredContent.(map[string]any)
	askContent := askEnvelope["result"].(map[string]any)
	if providerCalls != 1 || !reflect.DeepEqual(askContent["graph"], resultContent["graph"]) || !reflect.DeepEqual(askContent["evidence"], resultContent["evidence"]) || askContent["selectedSource"] == nil || askContent["confidence"].(float64) <= 0 || askContent["confidenceBasis"] == nil || askContent["diagnostics"] == nil {
		t.Fatalf("MCP ask result = %#v, provider calls = %d", askContent, providerCalls)
	}
	missing, err := mcpClient.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{Name: "ask", Arguments: map[string]any{"database": database}}})
	if err != nil || !missing.IsError || providerCalls != 1 {
		t.Fatalf("missing ask question: %v, result %+v, calls %d", err, missing, providerCalls)
	}
	diagnosticQuery, err := mcpClient.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{Name: "query", Arguments: map[string]any{"database": database, "query": "MATCH (node {name: 'validateAccessToken'}) RETURN node LIMIT 10", "diagnostics": true}}})
	if err != nil || diagnosticQuery.IsError {
		t.Fatalf("query diagnostics: %v, result %+v", err, diagnosticQuery)
	}
	if diagnosticQuery.StructuredContent.(map[string]any)["result"].(map[string]any)["diagnostics"] == nil {
		t.Fatal("query diagnostic output missing")
	}
	for _, arguments := range []map[string]any{
		{"database": database},
		{"database": database, "query": "SELECT * FROM nodes"},
		{"database": database, "query": "MATCH (node:unknown) RETURN node LIMIT 10"},
	} {
		invalid, err := mcpClient.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{Name: "query", Arguments: arguments}})
		if err != nil || !invalid.IsError {
			t.Fatalf("invalid query arguments %v: %v, result %+v", arguments, err, invalid)
		}
	}
}
