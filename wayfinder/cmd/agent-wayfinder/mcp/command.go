package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"agent-wayfinder/cli"
	"agent-wayfinder/cmd/agent-wayfinder/ask"
	"agent-wayfinder/cmd/agent-wayfinder/explain"
	"agent-wayfinder/cmd/agent-wayfinder/export"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"
	"agent-wayfinder/cmd/agent-wayfinder/path"
	"agent-wayfinder/cmd/agent-wayfinder/query"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/spf13/cobra"
)

const mcpServerVersion = "0.1.0"

type mcpCommandRunner func(context.Context, []string, io.Writer, io.Writer) int

func New(standardOutput, standardError io.Writer, exitCode *int) *cobra.Command {
	return cmd.NewLeaf("mcp", "Run the Model Context Protocol server", func(*cobra.Command) {}, runServer, standardOutput, standardError, exitCode)
}

func runServer(_ *cobra.Command, arguments []string, _ io.Writer, standardError io.Writer) int {
	if len(arguments) != 0 {
		return cmd.WriteError(standardError, fmt.Errorf("mcp does not accept arguments"))
	}
	if err := server.ServeStdio(newMCPServer(runCommand)); err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("serve MCP over stdio: %w", err))
	}
	return 0
}

func runCommand(ctx context.Context, arguments []string, standardOutput, standardError io.Writer) int {
	if len(arguments) == 0 {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("expected MCP tool command"))
	}
	exitCode := 0
	var command *cobra.Command
	switch arguments[0] {
	case "ask":
		command = ask.New(standardOutput, standardError, &exitCode)
	case "query":
		command = query.New(standardOutput, standardError, &exitCode)
	case "path":
		command = path.New(standardOutput, standardError, &exitCode)
	case "inspect":
		command = explain.New(standardOutput, standardError, &exitCode)
	case "export":
		command = export.New(standardOutput, standardError, &exitCode)
	default:
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("expected MCP tool command"))
	}
	command.SetOut(standardOutput)
	command.SetErr(standardError)
	command.SetArgs(arguments[1:])
	if err := command.ExecuteContext(ctx); err != nil {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError(err.Error()))
	}
	return exitCode
}

func newMCPServer(runCommand mcpCommandRunner) *server.MCPServer {
	mcpServer := server.NewMCPServer("agent-wayfinder", mcpServerVersion, server.WithToolCapabilities(false))
	mcpServer.AddTool(askMCPTool(), commandToolHandler(runCommand, askMCPArguments))
	mcpServer.AddTool(queryMCPTool(), commandToolHandler(runCommand, queryMCPArguments))
	mcpServer.AddTool(pathMCPTool(), commandToolHandler(runCommand, pathMCPArguments))
	mcpServer.AddTool(inspectMCPTool(), commandToolHandler(runCommand, inspectMCPArguments))
	mcpServer.AddTool(exportMCPTool(), commandToolHandler(runCommand, exportMCPArguments))
	return mcpServer
}

func askMCPTool() mcp.Tool {
	return mcp.NewTool("ask",
		mcp.WithDescription("Ask a natural-language graph question with the selected AI provider and return validated source-backed evidence."),
		mcp.WithString("workspace", mcp.MinLength(1), mcp.Description("Workspace path; defaults to the current directory.")),
		mcp.WithString("question", mcp.Required(), mcp.MinLength(1), mcp.Description("Natural-language graph question.")),
		mcp.WithBoolean("diagnostics", mcp.Description("Include generated SQL and parameters.")),
		mcp.WithNumber("maxDepth", mcp.Description("Maximum relationship traversal depth.")),
		mcp.WithNumber("maxNodes", mcp.Description("Maximum number of traversed nodes.")),
		databaseMCPOption(),
	)
}

func queryMCPTool() mcp.Tool {
	return mcp.NewTool("query",
		mcp.WithDescription("Execute a direct constrained graph query against a published snapshot without AI planning."),
		mcp.WithString("workspace", mcp.MinLength(1), mcp.Description("Workspace path; defaults to the current directory.")),
		mcp.WithString("query", mcp.Required(), mcp.MinLength(1), mcp.Description("Constrained graph-query source.")),
		mcp.WithBoolean("diagnostics", mcp.Description("Include generated SQL and parameters.")),
		mcp.WithNumber("maxDepth", mcp.Description("Maximum relationship traversal depth.")),
		mcp.WithNumber("maxNodes", mcp.Description("Maximum number of traversed nodes.")),
		databaseMCPOption(),
	)
}

func pathMCPTool() mcp.Tool {
	return mcp.NewTool("path",
		mcp.WithDescription("Find a directed relationship path between two code graph nodes."),
		workspaceMCPOption(),
		mcp.WithString("source", mcp.Required(), mcp.MinLength(1)),
		mcp.WithString("target", mcp.Required(), mcp.MinLength(1)),
		mcp.WithBoolean("undirected", mcp.Description("Allow an undirected fallback when no directed path exists.")),
		mcp.WithNumber("maxDepth", mcp.Description("Maximum path depth.")),
		mcp.WithNumber("maxNodes", mcp.Description("Maximum number of traversed nodes.")),
		mcp.WithArray("projects", mcp.WithStringItems(mcp.MinLength(1))),
		mcp.WithArray("relations", mcp.WithStringItems(mcp.MinLength(1))),
		databaseMCPOption(),
	)
}

func inspectMCPTool() mcp.Tool {
	return mcp.NewTool("inspect",
		mcp.WithDescription("Inspect one exact or unambiguous code graph node."),
		workspaceMCPOption(),
		mcp.WithString("node", mcp.Required(), mcp.MinLength(1)),
		databaseMCPOption(),
	)
}

func exportMCPTool() mcp.Tool {
	return mcp.NewTool("export",
		mcp.WithDescription("Export all nodes and edges from a published code graph."),
		workspaceMCPOption(),
		databaseMCPOption(),
	)
}

func workspaceMCPOption() mcp.ToolOption {
	return mcp.WithString("workspace", mcp.Required(), mcp.MinLength(1), mcp.Description("Absolute or relative workspace path."))
}

func databaseMCPOption() mcp.ToolOption {
	return mcp.WithString("database", mcp.MinLength(1), mcp.Description("Optional SQLite database path."))
}

func commandToolHandler(runCommand mcpCommandRunner, arguments func(mcp.CallToolRequest) ([]string, error)) server.ToolHandlerFunc {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if err := ctx.Err(); err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		commandArguments, err := arguments(request)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		standardOutput := &strings.Builder{}
		standardError := &strings.Builder{}
		if exitCode := runCommand(ctx, commandArguments, standardOutput, standardError); exitCode != 0 {
			message := strings.TrimSpace(standardError.String())
			if message == "" {
				message = fmt.Sprintf("agent-wayfinder command failed with exit code %d", exitCode)
			}
			return mcp.NewToolResultError(message), nil
		}
		var structuredContent any
		if err := json.Unmarshal([]byte(standardOutput.String()), &structuredContent); err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("decode agent-wayfinder JSON output: %s", err)), nil
		}
		return mcp.NewToolResultStructured(structuredContent, strings.TrimSpace(standardOutput.String())), nil
	}
}

func queryMCPArguments(request mcp.CallToolRequest) ([]string, error) {
	source, err := request.RequireString("query")
	if err != nil {
		return nil, err
	}
	arguments := []string{"query", "--format", "json", "--query", source, "--path", request.GetString("workspace", "."), "--max-depth", strconv.Itoa(request.GetInt("maxDepth", 2)), "--max-nodes", strconv.Itoa(request.GetInt("maxNodes", 100))}
	arguments = appendMCPDatabase(arguments, request)
	if request.GetBool("diagnostics", false) {
		arguments = append(arguments, "--diagnostics")
	}
	return arguments, nil
}

func askMCPArguments(request mcp.CallToolRequest) ([]string, error) {
	question, err := request.RequireString("question")
	if err != nil {
		return nil, err
	}
	arguments := []string{"ask", "--format", "json", "--path", request.GetString("workspace", "."), "--max-depth", strconv.Itoa(request.GetInt("maxDepth", 2)), "--max-nodes", strconv.Itoa(request.GetInt("maxNodes", 100))}
	arguments = appendMCPDatabase(arguments, request)
	if request.GetBool("diagnostics", false) {
		arguments = append(arguments, "--diagnostics")
	}
	return append(arguments, "--", question), nil
}

func pathMCPArguments(request mcp.CallToolRequest) ([]string, error) {
	workspace, err := request.RequireString("workspace")
	if err != nil {
		return nil, err
	}
	source, err := request.RequireString("source")
	if err != nil {
		return nil, err
	}
	target, err := request.RequireString("target")
	if err != nil {
		return nil, err
	}
	arguments := []string{"path", "--format", "json", "--max-depth", strconv.Itoa(request.GetInt("maxDepth", 8)), "--max-nodes", strconv.Itoa(request.GetInt("maxNodes", 100))}
	if request.GetBool("undirected", false) {
		arguments = append(arguments, "--undirected")
	}
	arguments = appendMCPFilters(arguments, request)
	arguments = append(arguments, workspace, source, target)
	return arguments, nil
}

func inspectMCPArguments(request mcp.CallToolRequest) ([]string, error) {
	workspace, err := request.RequireString("workspace")
	if err != nil {
		return nil, err
	}
	node, err := request.RequireString("node")
	if err != nil {
		return nil, err
	}
	arguments := appendMCPDatabase([]string{"inspect", "--format", "json"}, request)
	return append(arguments, workspace, node), nil
}

func exportMCPArguments(request mcp.CallToolRequest) ([]string, error) {
	workspace, err := request.RequireString("workspace")
	if err != nil {
		return nil, err
	}
	arguments := appendMCPDatabase([]string{"export", "--format", "json"}, request)
	return append(arguments, workspace), nil
}

func appendMCPFilters(arguments []string, request mcp.CallToolRequest) []string {
	arguments = appendMCPDatabase(arguments, request)
	for _, project := range request.GetStringSlice("projects", nil) {
		arguments = append(arguments, "--project", project)
	}
	for _, relation := range request.GetStringSlice("relations", nil) {
		arguments = append(arguments, "--relation", relation)
	}
	return arguments
}

func appendMCPDatabase(arguments []string, request mcp.CallToolRequest) []string {
	if database := request.GetString("database", ""); database != "" {
		arguments = append(arguments, "--database", database)
	}
	return arguments
}
