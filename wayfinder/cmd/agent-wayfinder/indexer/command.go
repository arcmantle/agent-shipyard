package indexer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"agent-wayfinder/cli"
	"agent-wayfinder/cmd/agent-wayfinder/catalog"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"
	"agent-wayfinder/index"
	"agent-wayfinder/indexer"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"

	"github.com/spf13/cobra"
)

func New(standardOutput, standardError io.Writer, exitCode *int) *cobra.Command {
	indexerCommand := &cobra.Command{
		Use:           "indexer",
		Short:         "Control the workspace indexer",
		SilenceErrors: true,
		SilenceUsage:  true,
	}
	indexerCommand.PersistentFlags().String("format", "", "output format: text or json")

	addAction := func(use, short string, action func(string, cli.Format, io.Writer, io.Writer) int) {
		indexerCommand.AddCommand(&cobra.Command{
			Use:   use + " WORKSPACE",
			Short: short,
			Args:  cobra.ExactArgs(1),
			Run: func(command *cobra.Command, arguments []string) {
				format, err := cmd.Format(command)
				if err != nil {
					*exitCode = cmd.WriteError(standardError, err)
					return
				}
				*exitCode = action(arguments[0], format, standardOutput, standardError)
			},
		})
	}
	addAction("serve", "Run the workspace indexer", func(workspace string, _ cli.Format, _ io.Writer, standardError io.Writer) int {
		return runIndexerServer(workspace, standardError)
	})
	addAction("start", "Start the workspace indexer", runIndexerStart)
	addAction("status", "Show workspace indexer status", func(workspace string, format cli.Format, standardOutput, standardError io.Writer) int {
		return runIndexerRequest(workspace, indexer.StatusCommand, format, standardOutput, standardError)
	})
	addAction("stop", "Stop the workspace indexer", func(workspace string, format cli.Format, standardOutput, standardError io.Writer) int {
		return runIndexerRequest(workspace, indexer.StopCommand, format, standardOutput, standardError)
	})

	return indexerCommand
}

func runIndexerServer(workspace string, standardError io.Writer) int {
	workspaceRoot, err := filepath.Abs(workspace)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve indexer workspace path: %w", err))
	}
	database, err := cmd.DatabasePath(workspaceRoot, "")
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve indexer database path: %w", err))
	}
	if err := indexer.NewServer(indexer.NewManager(indexer.WithPublisher(newIndexerPublisher(database)))).Serve(workspaceRoot); err != nil {
		return cmd.WriteError(standardError, err)
	}
	return 0
}

var startCatalogRefresh = catalog.StartRefresh

func newIndexerPublisher(database string) indexer.Publisher {
	return func(batch indexer.Batch) error {
		store, err := sqlite.Open(context.Background(), database)
		if err != nil {
			return fmt.Errorf("open indexer database: %w", err)
		}
		defer store.Close()
		previous, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: batch.Workspace})
		if err != nil && !errors.Is(err, storage.ErrWorkspaceNotFound) {
			return fmt.Errorf("open prior indexer snapshot: %w", err)
		}
		snapshot, err := index.PublishBatch(context.Background(), store, index.BatchRequest{
			Root:         batch.Workspace,
			ChangedPaths: batch.Paths,
		})
		if err != nil {
			return fmt.Errorf("publish indexer batch: %w", err)
		}
		if err := store.WriteCatalogTask(context.Background(), storage.CatalogTask{
			Workspace:    batch.Workspace,
			GraphVersion: snapshot.Version,
			State:        storage.CatalogTaskQueued,
			StartedAt:    time.Now().UTC(),
			ChangedPaths: append([]string(nil), batch.Paths...),
		}); err != nil {
			fmt.Fprintf(os.Stderr, "Catalog refresh: status unavailable (%v)\n", err)
		}
		startCatalogRefresh(catalog.RefreshRequest{
			Database:         database,
			Workspace:        batch.Workspace,
			Snapshot:         snapshot,
			PreviousSnapshot: previous,
			ChangedPaths:     append([]string(nil), batch.Paths...),
		})
		return nil
	}
}

func runIndexerStart(workspace string, format cli.Format, standardOutput, standardError io.Writer) int {
	workspaceRoot, err := filepath.Abs(workspace)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve indexer workspace path: %w", err))
	}
	status, err := indexer.Request(context.Background(), workspaceRoot, indexer.StatusCommand)
	if err == nil {
		return renderIndexerStatus(standardOutput, format, status)
	}

	executable, err := os.Executable()
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("start workspace indexer: find executable: %w", err))
	}
	command := exec.Command(executable, "indexer", "serve", workspaceRoot)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("start workspace indexer: launch background process: %w", err))
	}

	deadline := time.Now().Add(time.Second)
	for {
		status, err = indexer.Request(context.Background(), workspaceRoot, indexer.StatusCommand)
		if err == nil {
			return renderIndexerStatus(standardOutput, format, status)
		}
		if time.Now().After(deadline) {
			return cmd.WriteError(standardError, fmt.Errorf("start workspace indexer: wait for control endpoint: %w", err))
		}
		time.Sleep(time.Millisecond)
	}
}

func runIndexerRequest(workspace string, command indexer.Command, format cli.Format, standardOutput, standardError io.Writer) int {
	status, err := indexer.Request(context.Background(), workspace, command)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	return renderIndexerStatus(standardOutput, format, status)
}

func renderIndexerStatus(writer io.Writer, format cli.Format, status indexer.Status) int {
	switch format {
	case cli.FormatText:
		_, err := fmt.Fprintf(
			writer,
			"Workspace: %s\nRunning: %t\nActivity: %s\nProgress: %d/%d\nQueued paths: %d\nVersion: %d\nError: %s\nIdle deadline: %s\n",
			status.Workspace,
			status.Running,
			status.Activity.UTC().Format(time.RFC3339),
			status.Progress.Completed,
			status.Progress.Total,
			len(status.QueuedPaths),
			status.Version,
			status.Error,
			status.IdleDeadline.UTC().Format(time.RFC3339),
		)
		if err != nil {
			return cmd.WriteError(writer, fmt.Errorf("render indexer status: %w", err))
		}
		return 0
	case cli.FormatJSON:
		if err := json.NewEncoder(writer).Encode(status); err != nil {
			return cmd.WriteError(writer, fmt.Errorf("render indexer status: %w", err))
		}
		return 0
	default:
		return cmd.WriteError(writer, fmt.Errorf("render indexer status: unsupported format %q", format))
	}
}
