package index

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"agent-wayfinder/cli"
	"agent-wayfinder/cmd/agent-wayfinder/catalog"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"
	"agent-wayfinder/extractor"
	"agent-wayfinder/index"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"

	"github.com/spf13/cobra"
)

func New(standardOutput, standardError io.Writer, exitCode *int) *cobra.Command {
	return cmd.NewLeaf("index WORKSPACE", "Index a workspace", configure, runIndex, standardOutput, standardError, exitCode)
}

var startCatalogProcess = catalog.StartProcess

func configure(command *cobra.Command) {
	cmd.DatabaseAndFormatFlags(command)
	catalog.ConfigureFlags(command)
	command.Flags().Bool("catalog-background", true, "start the post-publication background catalog pass")
	command.Flags().Bool("retain-catalog-units", false, "retain source units for later historical cataloging")
}

func runIndex(command *cobra.Command, arguments []string, standardOutput, standardError io.Writer) int {
	if len(arguments) != 1 {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("index requires one workspace path"))
	}
	format, err := cmd.Format(command)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	catalogBackground, err := command.Flags().GetBool("catalog-background")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	retainCatalogUnits, err := command.Flags().GetBool("retain-catalog-units")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}

	workspace := arguments[0]
	workspaceRoot, err := filepath.Abs(workspace)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve index workspace path: %w", err))
	}
	database, err := cmd.DatabasePathForCommand(command, workspaceRoot)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve index database path: %w", err))
	}
	if err := os.MkdirAll(filepath.Dir(database), 0o755); err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("create index database directory: %w", err))
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("open index database: %w", err))
	}
	defer store.Close()

	result, err := index.Index(context.Background(), store, index.Request{Root: workspace, RetainCatalogUnits: retainCatalogUnits})
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	if catalogBackground {
		if err := store.WriteCatalogTask(context.Background(), storage.CatalogTask{
			Workspace:    result.Snapshot.Workspace,
			GraphVersion: result.Snapshot.Version,
			State:        storage.CatalogTaskQueued,
			StartedAt:    time.Now().UTC(),
		}); err != nil {
			fmt.Fprintf(standardError, "Catalog refresh: status unavailable (%v)\n", err)
		}
		executable, err := os.Executable()
		if err != nil {
			fmt.Fprintf(standardError, "Catalog refresh: not started (%v)\n", err)
		} else if err := startCatalogProcess(catalog.ProcessRequest{Executable: executable, Database: database, Workspace: workspaceRoot}); err != nil {
			fmt.Fprintf(standardError, "Catalog refresh: not started (%v)\n", err)
		}
	}
	data := struct {
		Workspace   string                 `json:"workspace"`
		Diagnostics []extractor.Diagnostic `json:"diagnostics"`
	}{
		Workspace:   result.Snapshot.Workspace,
		Diagnostics: result.Diagnostics,
	}
	if err := cli.Render(standardOutput, cli.Result{
		Snapshot: result.Snapshot,
		Text:     fmt.Sprintf("Workspace: %s", result.Snapshot.Workspace),
		Data:     data,
	}, format); err != nil {
		return cmd.WriteError(standardError, err)
	}
	return 0
}
