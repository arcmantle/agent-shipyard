package catalog

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"agent-wayfinder/cli"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"
	"agent-wayfinder/cmd/agent-wayfinder/internal/copilot"
	"agent-wayfinder/cmd/agent-wayfinder/internal/ollama"
	"agent-wayfinder/cmd/agent-wayfinder/internal/spending"
	"agent-wayfinder/index"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"

	"github.com/jedib0t/go-pretty/v6/table"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

func New(standardOutput, standardError io.Writer, exitCode *int) *cobra.Command {
	return cmd.NewLeaf("catalog [WORKSPACE]", "Build the capability catalog for a published graph", configureCommand, runCatalog, standardOutput, standardError, exitCode)
}

func NewStatus(standardOutput, standardError io.Writer, exitCode *int) *cobra.Command {
	return cmd.NewLeaf("catalog-status [WORKSPACE]", "Show latest catalog pass status", cmd.DatabaseAndFormatFlags, runCatalogStatus, standardOutput, standardError, exitCode)
}

func NewStop(standardOutput, standardError io.Writer, exitCode *int) *cobra.Command {
	return cmd.NewLeaf("catalog-stop [WORKSPACE]", "Stop a running catalog pass", cmd.DatabaseAndFormatFlags, runCatalogStop, standardOutput, standardError, exitCode)
}

func configureCommand(command *cobra.Command) {
	cmd.DatabaseAndFormatFlags(command)
	ConfigureFlags(command)
	command.Flags().Bool("foreground", false, "run cataloging in this terminal")
	command.Flags().Bool("catalog-worker", false, "run the detached catalog worker")
	_ = command.Flags().MarkHidden("catalog-worker")
}

type ProcessRequest struct {
	Executable string
	Database   string
	Workspace  string
	Arguments  []string
}

func StartProcess(request ProcessRequest) error {
	if strings.HasSuffix(filepath.Base(request.Executable), ".test") {
		return nil
	}
	errorLog, err := os.OpenFile(catalogErrorLogPath(request.Database), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("open catalog process error log: %w", err)
	}
	defer errorLog.Close()
	arguments := []string{"catalog", "--foreground", "--catalog-worker", "--database", request.Database}
	arguments = append(arguments, request.Arguments...)
	arguments = append(arguments, request.Workspace)
	command := exec.Command(request.Executable, arguments...)
	command.Stdout = io.Discard
	command.Stderr = errorLog
	configureBackgroundProcess(command)
	if err := command.Start(); err != nil {
		return fmt.Errorf("start catalog process: %w", err)
	}
	if err := command.Process.Release(); err != nil {
		return fmt.Errorf("release catalog process: %w", err)
	}
	return nil
}

func catalogErrorLogPath(database string) string {
	return database + ".catalog.err"
}

type RefreshRequest struct {
	Database         string
	Workspace        string
	Snapshot         storage.Snapshot
	PreviousSnapshot storage.Snapshot
	ChangedPaths     []string
}

const (
	catalogRefreshTimeout     = 30 * time.Second
	catalogStatusWriteTimeout = 5 * time.Second
)

var runCatalogRefresh = refreshCatalog

var startDetachedCatalogProcess = StartProcess

var terminateDetachedCatalogProcess = terminateCatalogProcess

var catalogRefreshes = refreshCoordinator{tails: make(map[string]*refreshEntry)}

type refreshCoordinator struct {
	mu    sync.Mutex
	tails map[string]*refreshEntry
}

type refreshEntry struct {
	done chan struct{}
	err  error
}

func StartRefresh(request RefreshRequest) {
	catalogRefreshes.mu.Lock()
	previous := catalogRefreshes.tails[request.Workspace]
	current := &refreshEntry{done: make(chan struct{})}
	catalogRefreshes.tails[request.Workspace] = current
	catalogRefreshes.mu.Unlock()

	go func() {
		if previous != nil {
			<-previous.done
			if previous.err != nil {
				request.PreviousSnapshot = storage.Snapshot{}
				request.ChangedPaths = nil
			}
		}
		defer func() {
			close(current.done)
			catalogRefreshes.mu.Lock()
			if catalogRefreshes.tails[request.Workspace] == current {
				delete(catalogRefreshes.tails, request.Workspace)
			}
			catalogRefreshes.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), catalogRefreshTimeout)
		defer cancel()
		current.err = runCatalogRefresh(ctx, request)
	}()
}

func refreshCatalog(ctx context.Context, request RefreshRequest) error {
	store, err := sqlite.Open(ctx, request.Database)
	if err != nil {
		return err
	}
	defer store.Close()
	snapshot, err := store.OpenSnapshot(ctx, storage.OpenSnapshotRequest{Workspace: request.Workspace})
	if err != nil {
		return err
	}
	if snapshot.Version != request.Snapshot.Version {
		request.PreviousSnapshot = storage.Snapshot{}
		request.ChangedPaths = nil
	}
	task := storage.CatalogTask{
		Workspace:    request.Workspace,
		GraphVersion: snapshot.Version,
		State:        storage.CatalogTaskRunning,
		ProcessID:    os.Getpid(),
		StartedAt:    time.Now().UTC(),
		ChangedPaths: append([]string(nil), request.ChangedPaths...),
	}
	if err := store.WriteCatalogTask(ctx, task); err != nil {
		return err
	}
	fail := func(catalogError error) error {
		task.State = storage.CatalogTaskFailed
		task.FinishedAt = time.Now().UTC()
		task.Failure = catalogError.Error()
		statusContext, cancelStatusWrite := context.WithTimeout(context.Background(), catalogStatusWriteTimeout)
		defer cancelStatusWrite()
		if statusError := store.WriteCatalogTask(statusContext, task); statusError != nil {
			return statusError
		}
		return catalogError
	}
	configuration, err := readCatalogConfiguration(request.Workspace)
	if err != nil {
		return fail(err)
	}
	options, err := catalogWriteOptions(configuration, request.Workspace, store)
	if err != nil {
		return fail(err)
	}
	result, err := index.Catalog(ctx, store, index.CatalogRequest{
		Root:                request.Workspace,
		Snapshot:            snapshot,
		PreviousSnapshot:    request.PreviousSnapshot,
		ChangedPaths:        request.ChangedPaths,
		CatalogWriteOptions: options,
		Progress: func(progress index.CatalogProgress) {
			task.CompletedUnits = progress.CompletedUnits
			task.TotalUnits = progress.TotalUnits
			task.Stage = progress.Stage
			_ = store.WriteCatalogTask(ctx, task)
		},
	})
	if err != nil {
		return fail(err)
	}
	task.State = storage.CatalogTaskComplete
	task.FinishedAt = time.Now().UTC()
	task.CompletedUnits = result.Units
	task.TotalUnits = result.Units
	if err := store.WriteCatalogTask(ctx, task); err != nil {
		return fail(err)
	}
	return nil
}

func runCatalog(command *cobra.Command, arguments []string, standardOutput, standardError io.Writer) int {
	workspace, err := catalogWorkspaceArgument("catalog", arguments)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	format, err := cmd.Format(command)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	workspaceRoot, err := filepath.Abs(workspace)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve catalog workspace path: %w", err))
	}
	database, err := cmd.DatabasePathForCommand(command, workspaceRoot)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve catalog database path: %w", err))
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("open catalog database: %w", err))
	}
	storeClosed := false
	defer func() {
		if !storeClosed {
			_ = store.Close()
		}
	}()
	snapshot, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspaceRoot})
	if errors.Is(err, storage.ErrWorkspaceNotFound) {
		return cmd.WriteError(standardError, cli.NewIndexUnavailableError(workspaceRoot))
	}
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	foreground, err := command.Flags().GetBool("foreground")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	worker, err := command.Flags().GetBool("catalog-worker")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	if !worker {
		existingTask, found, err := store.ReadCatalogTask(context.Background(), workspaceRoot)
		if err != nil {
			return cmd.WriteError(standardError, err)
		}
		if found && (existingTask.State == storage.CatalogTaskQueued || existingTask.State == storage.CatalogTaskRunning) {
			return cmd.WriteError(standardError, fmt.Errorf("catalog already %s for %s: use catalog-status or catalog-stop", existingTask.State, workspaceRoot))
		}
	}
	if !foreground {
		task := storage.CatalogTask{Workspace: workspaceRoot, GraphVersion: snapshot.Version, State: storage.CatalogTaskQueued, StartedAt: time.Now().UTC()}
		if err := store.WriteCatalogTask(context.Background(), task); err != nil {
			return cmd.WriteError(standardError, err)
		}
		if err := store.Close(); err != nil {
			return cmd.WriteError(standardError, fmt.Errorf("close catalog launcher database: %w", err))
		}
		storeClosed = true
		executable, err := os.Executable()
		if err != nil {
			return cmd.WriteError(standardError, fmt.Errorf("resolve catalog executable: %w", err))
		}
		if err := startDetachedCatalogProcess(ProcessRequest{Executable: executable, Database: database, Workspace: workspaceRoot, Arguments: detachedCatalogArguments(command)}); err != nil {
			task.State = storage.CatalogTaskFailed
			task.FinishedAt = time.Now().UTC()
			task.Failure = err.Error()
			failureStore, openError := sqlite.Open(context.Background(), database)
			if openError != nil {
				return cmd.WriteError(standardError, fmt.Errorf("%w; record catalog startup failure: %v", err, openError))
			}
			writeError := failureStore.WriteCatalogTask(context.Background(), task)
			closeError := failureStore.Close()
			if writeError != nil {
				return cmd.WriteError(standardError, fmt.Errorf("%w; record catalog startup failure: %v", err, writeError))
			}
			if closeError != nil {
				return cmd.WriteError(standardError, fmt.Errorf("%w; close catalog startup-failure database: %v", err, closeError))
			}
			return cmd.WriteError(standardError, err)
		}
		data := struct {
			Workspace string `json:"workspace"`
			State     string `json:"state"`
		}{Workspace: workspaceRoot, State: string(storage.CatalogTaskQueued)}
		if err := cli.Render(standardOutput, cli.Result{OmitSnapshot: true, Text: fmt.Sprintf("Catalog started in background: %s", workspaceRoot), Data: data}, format); err != nil {
			return cmd.WriteError(standardError, err)
		}
		return 0
	}
	task := storage.CatalogTask{Workspace: workspaceRoot, GraphVersion: snapshot.Version, State: storage.CatalogTaskRunning, ProcessID: os.Getpid(), StartedAt: time.Now().UTC()}
	if err := store.WriteCatalogTask(context.Background(), task); err != nil {
		return cmd.WriteError(standardError, err)
	}
	fail := func(catalogError error) int {
		task.State = storage.CatalogTaskFailed
		task.FinishedAt = time.Now().UTC()
		task.Failure = catalogError.Error()
		_ = store.WriteCatalogTask(context.Background(), task)
		return cmd.WriteError(standardError, catalogError)
	}
	configuration, err := resolveCatalogConfiguration(command, workspaceRoot)
	if err != nil {
		return fail(err)
	}
	options, err := catalogWriteOptions(configuration, workspaceRoot, store)
	if err != nil {
		return fail(err)
	}
	result, err := index.Catalog(context.Background(), store, index.CatalogRequest{
		Root:                workspaceRoot,
		Snapshot:            snapshot,
		CatalogWriteOptions: options,
		Progress: func(progress index.CatalogProgress) {
			task.CompletedUnits = progress.CompletedUnits
			task.TotalUnits = progress.TotalUnits
			task.Stage = progress.Stage
			_ = store.WriteCatalogTask(context.Background(), task)
			if !worker {
				_, _ = fmt.Fprintf(standardError, "Catalog progress: %d/%d\n", progress.CompletedUnits, progress.TotalUnits)
			}
		},
	})
	if err != nil {
		return fail(err)
	}
	task.State = storage.CatalogTaskComplete
	task.FinishedAt = time.Now().UTC()
	task.CompletedUnits = result.Units
	task.TotalUnits = result.Units
	if err := store.WriteCatalogTask(context.Background(), task); err != nil {
		return cmd.WriteError(standardError, err)
	}
	retrievalMethods := []string{"lexical"}
	if result.Units > 0 && result.Write.EmbeddingUnavailableReason == "" {
		retrievalMethods = append(retrievalMethods, "optional embeddings")
	}
	data := struct {
		Workspace                  string   `json:"workspace"`
		Units                      int      `json:"units"`
		RetrievalMethods           []string `json:"retrievalMethods"`
		CopilotUnavailableReason   string   `json:"copilotUnavailableReason,omitempty"`
		OllamaUnavailableReason    string   `json:"ollamaUnavailableReason,omitempty"`
		ClaudeUnavailableReason    string   `json:"claudeUnavailableReason,omitempty"`
		EmbeddingUnavailableReason string   `json:"embeddingUnavailableReason,omitempty"`
	}{
		Workspace:                  result.Snapshot.Workspace,
		Units:                      result.Units,
		RetrievalMethods:           retrievalMethods,
		CopilotUnavailableReason:   result.Write.CopilotUnavailableReason,
		OllamaUnavailableReason:    result.Write.OllamaUnavailableReason,
		ClaudeUnavailableReason:    result.Write.ClaudeUnavailableReason,
		EmbeddingUnavailableReason: result.Write.EmbeddingUnavailableReason,
	}
	text := fmt.Sprintf("Catalog units: %d\nRetrieval methods: %s", data.Units, strings.Join(data.RetrievalMethods, ", "))
	if data.EmbeddingUnavailableReason != "" {
		text += fmt.Sprintf("\nOptional embeddings: skipped (%s)", data.EmbeddingUnavailableReason)
	}
	if err := cli.Render(standardOutput, cli.Result{Snapshot: result.Snapshot, Text: text, Data: data}, format); err != nil {
		return cmd.WriteError(standardError, err)
	}
	return 0
}

func detachedCatalogArguments(command *cobra.Command) []string {
	arguments := make([]string, 0)
	command.Flags().Visit(func(flag *pflag.Flag) {
		if strings.HasPrefix(flag.Name, "catalog-") {
			arguments = append(arguments, "--"+flag.Name+"="+flag.Value.String())
		}
	})
	return arguments
}

func catalogWriteOptions(configuration catalogConfiguration, workspaceRoot string, store storage.SpendReservationStore) (index.CatalogWriteOptions, error) {
	embeddingGenerator, err := newCatalogEmbeddingGenerator(configuration, nil)
	if err != nil {
		return index.CatalogWriteOptions{}, err
	}
	options := index.CatalogWriteOptions{
		EmbeddingGenerator:    embeddingGenerator,
		EmbeddingProcessLimit: configuration.Embedding.ProcessLimit,
		SynopsisProvider:      configuration.Synopsis.Provider,
		SynopsisSourceLimit:   configuration.Synopsis.SourceLimit,
	}
	if !catalogFeatureEnabled(configuration.Synopsis.Enabled) {
		return options, nil
	}
	switch configuration.Synopsis.Provider {
	case "":
		return options, nil
	case index.CatalogSynopsisProviderCopilot:
		spendingConfiguration, err := spending.ReadConfiguration(workspaceRoot)
		if err != nil {
			return index.CatalogWriteOptions{}, err
		}
		options.SynopsisGenerator = spendingCatalogSynopsisGenerator{
			provider:      index.CatalogSynopsisProviderCopilot,
			configuration: spendingConfiguration,
			store:         store,
			copilotConfiguration: copilot.CatalogConfiguration{
				Path:         configuration.Copilot.Path,
				Model:        configuration.Copilot.Model,
				MaxAICredits: configuration.Copilot.MaxAICredits,
			},
		}
		options.SynopsisProcessLimit = configuration.Copilot.ProcessLimit
	case index.CatalogSynopsisProviderOllama:
		options.SynopsisGenerator = ollama.NewCatalogSynopsisGenerator(ollama.CatalogSynopsisConfiguration{Model: configuration.Ollama.Model, Timeout: configuration.Ollama.Timeout}, configuration.Ollama.Endpoint, nil)
		options.SynopsisProcessLimit = configuration.Synopsis.OllamaProcessLimit
	case index.CatalogSynopsisProviderClaude:
		spendingConfiguration, err := spending.ReadConfiguration(workspaceRoot)
		if err != nil {
			return index.CatalogWriteOptions{}, err
		}
		options.SynopsisGenerator = spendingCatalogSynopsisGenerator{
			provider:            index.CatalogSynopsisProviderClaude,
			configuration:       spendingConfiguration,
			store:               store,
			claudeConfiguration: configuration.Claude,
		}
		options.SynopsisProcessLimit = 1
	default:
		return index.CatalogWriteOptions{}, fmt.Errorf("invalid catalog synopsis provider %q", configuration.Synopsis.Provider)
	}
	return options, nil
}

type catalogStatusData struct {
	Workspace      string               `json:"workspace"`
	State          string               `json:"state"`
	GraphVersion   storage.GraphVersion `json:"graphVersion"`
	ProcessID      int                  `json:"processId,omitempty"`
	Processing     string               `json:"processing,omitempty"`
	Usage          *catalogProcessUsage `json:"usage,omitempty"`
	StartedAt      time.Time            `json:"startedAt"`
	Elapsed        time.Duration        `json:"elapsed"`
	CompletedUnits int                  `json:"completedUnits"`
	TotalUnits     int                  `json:"totalUnits"`
	ChangedPaths   []string             `json:"changedPaths,omitempty"`
	Failure        string               `json:"failure,omitempty"`
}

func runCatalogStatus(command *cobra.Command, arguments []string, standardOutput, standardError io.Writer) int {
	workspace, err := catalogWorkspaceArgument("catalog-status", arguments)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	format, err := cmd.Format(command)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	workspaceRoot, err := filepath.Abs(workspace)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve catalog status workspace path: %w", err))
	}
	database, err := cmd.DatabasePathForCommand(command, workspaceRoot)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("open catalog status database: %w", err))
	}
	defer store.Close()
	task, found, err := store.ReadCatalogTask(context.Background(), workspaceRoot)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	if !found {
		data := catalogStatusData{Workspace: workspaceRoot, State: "not_started"}
		if err := cli.Render(standardOutput, cli.Result{OmitSnapshot: true, Text: formatCatalogStatusText(data), Data: data}, format); err != nil {
			return cmd.WriteError(standardError, err)
		}
		return 0
	}
	if task.State == storage.CatalogTaskRunning && task.ProcessID == 0 {
		task.State = storage.CatalogTaskInterrupted
		task.ProcessID = 0
		task.FinishedAt = time.Now().UTC()
		task.Failure = "catalog process was interrupted before process monitoring was available"
		if err := store.WriteCatalogTask(context.Background(), task); err != nil {
			return cmd.WriteError(standardError, err)
		}
	}
	endedAt := time.Now().UTC()
	if !task.FinishedAt.IsZero() {
		endedAt = task.FinishedAt
	}
	failure := task.Failure
	state := string(task.State)
	if task.State == storage.CatalogTaskQueued && failure == "" {
		if processFailure, err := os.ReadFile(catalogErrorLogPath(database)); err == nil && strings.TrimSpace(string(processFailure)) != "" {
			state = string(storage.CatalogTaskFailed)
			failure = strings.TrimSpace(string(processFailure))
		}
	}
	data := catalogStatusData{Workspace: task.Workspace, State: state, GraphVersion: task.GraphVersion, ProcessID: task.ProcessID, StartedAt: task.StartedAt, Elapsed: endedAt.Sub(task.StartedAt), CompletedUnits: task.CompletedUnits, TotalUnits: task.TotalUnits, ChangedPaths: task.ChangedPaths, Failure: failure}
	if task.State == storage.CatalogTaskRunning {
		data.Processing = task.Stage
		if data.Processing == "" {
			data.Processing = formatCatalogProcessing(task.CompletedUnits, task.TotalUnits)
		}
		data.Usage = readCatalogProcessUsage(task.ProcessID)
	}
	if err := cli.Render(standardOutput, cli.Result{OmitSnapshot: true, Text: formatCatalogStatusText(data), Data: data}, format); err != nil {
		return cmd.WriteError(standardError, err)
	}
	return 0
}

func runCatalogStop(command *cobra.Command, arguments []string, standardOutput, standardError io.Writer) int {
	workspace, err := catalogWorkspaceArgument("catalog-stop", arguments)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	format, err := cmd.Format(command)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	workspaceRoot, err := filepath.Abs(workspace)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve catalog stop workspace path: %w", err))
	}
	database, err := cmd.DatabasePathForCommand(command, workspaceRoot)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("open catalog stop database: %w", err))
	}
	defer store.Close()
	task, found, err := store.ReadCatalogTask(context.Background(), workspaceRoot)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	if !found || task.State != storage.CatalogTaskRunning {
		return cmd.WriteError(standardError, fmt.Errorf("catalog stop: no running catalog pass for %s", workspaceRoot))
	}
	stopped, err := terminateDetachedCatalogProcess(task.ProcessID, workspaceRoot)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	task.State = storage.CatalogTaskInterrupted
	task.FinishedAt = time.Now().UTC()
	task.ProcessID = 0
	if stopped {
		task.Failure = "catalog process stopped"
	} else {
		task.Failure = "catalog process was not running"
	}
	if err := store.WriteCatalogTask(context.Background(), task); err != nil {
		return cmd.WriteError(standardError, err)
	}
	data := struct {
		Workspace string `json:"workspace"`
		State     string `json:"state"`
	}{Workspace: workspaceRoot, State: string(storage.CatalogTaskInterrupted)}
	if err := cli.Render(standardOutput, cli.Result{OmitSnapshot: true, Text: fmt.Sprintf("Catalog stopped: %s", workspaceRoot), Data: data}, format); err != nil {
		return cmd.WriteError(standardError, err)
	}
	return 0
}

func formatCatalogStatusText(data catalogStatusData) string {
	status := table.NewWriter()
	status.SetStyle(table.StyleLight)
	status.AppendHeader(table.Row{"FIELD", "VALUE"})
	status.AppendRow(table.Row{"State", displayCatalogTaskState(data.State)})
	status.AppendRow(table.Row{"Workspace", data.Workspace})
	if data.State == "not_started" {
		return fmt.Sprintf("Capability Catalog Status\n\n%s\n\nNo catalog pass has been recorded for this workspace.", status.Render())
	}
	status.AppendRow(table.Row{"Graph version", data.GraphVersion})
	status.AppendRow(table.Row{"Started", data.StartedAt.UTC().Format(time.RFC3339)})
	status.AppendRow(table.Row{"Elapsed", data.Elapsed.Round(time.Millisecond)})
	status.AppendRow(table.Row{"Progress", fmt.Sprintf("%d/%d catalog units", data.CompletedUnits, data.TotalUnits)})
	if data.ProcessID > 0 {
		status.AppendRow(table.Row{"Process", fmt.Sprintf("PID %d", data.ProcessID)})
	}
	if data.Processing != "" {
		status.AppendRow(table.Row{"Processing", data.Processing})
	}
	if data.Usage != nil {
		status.AppendRow(table.Row{"Catalog client CPU", fmt.Sprintf("%.1f%%", data.Usage.CPUPercent)})
		status.AppendRow(table.Row{"Catalog client memory", formatCatalogMemory(data.Usage.ResidentMemoryBytes)})
	} else if data.State == string(storage.CatalogTaskRunning) && data.ProcessID > 0 {
		status.AppendRow(table.Row{"Catalog client CPU", "unavailable"})
		status.AppendRow(table.Row{"Catalog client memory", "unavailable"})
	}
	if len(data.ChangedPaths) == 0 {
		status.AppendRow(table.Row{"Scope", "full workspace"})
	} else {
		status.AppendRow(table.Row{"Scope", fmt.Sprintf("%d changed files", len(data.ChangedPaths))})
	}
	if data.Failure != "" {
		status.AppendRow(table.Row{"Failure", data.Failure})
	}
	return fmt.Sprintf("Capability Catalog Status\n\n%s", status.Render())
}

func formatCatalogMemory(bytes uint64) string {
	return fmt.Sprintf("%.1f MiB", float64(bytes)/(1024*1024))
}

func catalogWorkspaceArgument(commandName string, arguments []string) (string, error) {
	switch len(arguments) {
	case 0:
		return ".", nil
	case 1:
		return arguments[0], nil
	default:
		return "", cli.NewInvalidArgumentError(fmt.Sprintf("%s accepts at most one workspace path", commandName))
	}
}

func formatCatalogProcessing(completedUnits, totalUnits int) string {
	if totalUnits == 0 {
		return "preparing catalog units"
	}
	if completedUnits >= totalUnits {
		return "catalog units complete"
	}
	return fmt.Sprintf("catalog unit %d of %d", completedUnits+1, totalUnits)
}

func displayCatalogTaskState(state string) string {
	switch state {
	case "not_started":
		return "Not started"
	case string(storage.CatalogTaskQueued):
		return "Queued"
	case string(storage.CatalogTaskRunning):
		return "Running"
	case string(storage.CatalogTaskInterrupted):
		return "Interrupted"
	case string(storage.CatalogTaskComplete):
		return "Complete"
	case string(storage.CatalogTaskFailed):
		return "Failed"
	default:
		return state
	}
}
