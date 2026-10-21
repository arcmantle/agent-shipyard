package query

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"agent-wayfinder/cli"
	"agent-wayfinder/cmd/agent-wayfinder/catalog"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"

	"github.com/spf13/cobra"
)

func runDirect(command *cobra.Command, arguments []string, standardOutput, standardError io.Writer) int {
	if len(arguments) != 0 {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("query accepts source through --query, --file, or standard input; use --path for the workspace"))
	}
	format, err := cmd.Format(command)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	source, err := directSource(command)
	if err != nil {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError(err.Error()))
	}
	parsed, err := query.ParseGraphQuery(source)
	if err != nil {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError(err.Error()))
	}
	workspace, _ := command.Flags().GetString("path")
	workspaceRoot, err := filepath.Abs(workspace)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	database, err := cmd.DatabasePathForCommand(command, workspaceRoot)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	ctx := command.Context()
	store, err := sqlite.Open(ctx, database)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	defer store.Close()
	snapshot, err := store.OpenSnapshot(ctx, storage.OpenSnapshotRequest{Workspace: workspaceRoot})
	if errors.Is(err, storage.ErrWorkspaceNotFound) {
		return cmd.WriteError(standardError, cli.NewIndexUnavailableError(workspaceRoot))
	}
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	maxDepth, _ := command.Flags().GetInt("max-depth")
	maxNodes, _ := command.Flags().GetInt("max-nodes")
	diagnostics, _ := command.Flags().GetBool("diagnostics")
	options := query.GraphQueryOptions{Diagnostics: diagnostics}
	if parsed.Search != nil && parsed.Search.Kind == query.SearchVector {
		options.EmbeddingGenerator, err = catalog.NewEmbeddingGenerator(workspaceRoot, nil)
		if err != nil {
			return cmd.WriteError(standardError, err)
		}
	}
	result, err := query.ExecuteGraphQuerySnapshot(ctx, store, snapshot, parsed, query.GraphQueryLimits{MaxDepth: maxDepth, MaxNodes: maxNodes}, options)
	if err != nil {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError(err.Error()))
	}
	if err := cli.Render(standardOutput, cli.Result{Snapshot: snapshot, Text: GraphQueryText(result), Data: result}, format); err != nil {
		return cmd.WriteError(standardError, err)
	}
	return 0
}

func directSource(command *cobra.Command) (string, error) {
	if command.Flags().Changed("query") && command.Flags().Changed("file") {
		return "", fmt.Errorf("--query and --file cannot be used together")
	}
	var source string
	if command.Flags().Changed("query") {
		source, _ = command.Flags().GetString("query")
	} else {
		var content []byte
		var err error
		if command.Flags().Changed("file") {
			path, _ := command.Flags().GetString("file")
			content, err = os.ReadFile(path)
		} else {
			content, err = io.ReadAll(command.InOrStdin())
		}
		if err != nil {
			return "", fmt.Errorf("read graph-query source: %w", err)
		}
		source = string(content)
	}
	if strings.TrimSpace(source) == "" {
		return "", fmt.Errorf("query source is required through --query, --file, or standard input")
	}
	return source, nil
}
