package benchmark

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"strconv"
	"strings"
	"time"

	"agent-wayfinder/benchmark"
	"agent-wayfinder/cli"
	"agent-wayfinder/graph"
	"agent-wayfinder/index"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
	"agent-wayfinder/workspace"

	"github.com/spf13/cobra"
)

func measureIsolatedBenchmarkRun(sourceFiles int, standardError io.Writer, ftsEnabled bool, cpuProfilePath, incrementalCPUProfilePath string) (benchmark.Run, storage.Snapshot, error) {
	executable, err := os.Executable()
	if err != nil {
		return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("find benchmark executable: %w", err)
	}
	arguments := []string{"benchmark", "--format", "json", "--source-files", strconv.Itoa(sourceFiles), "--runs", "1", "--internal-sample", "--fts=" + strconv.FormatBool(ftsEnabled)}
	if cpuProfilePath != "" {
		arguments = append(arguments, "--cpu-profile", cpuProfilePath)
	}
	if incrementalCPUProfilePath != "" {
		arguments = append(arguments, "--incremental-cpu-profile", incrementalCPUProfilePath)
	}
	var command *exec.Cmd
	if strings.HasSuffix(executable, ".test") {
		command = exec.Command("go", append([]string{"run", "."}, arguments...)...)
		_, sourceFile, _, ok := runtime.Caller(0)
		if !ok {
			return benchmark.Run{}, storage.Snapshot{}, errors.New("find benchmark command source directory")
		}
		command.Dir = filepath.Dir(filepath.Dir(sourceFile))
	} else {
		command = exec.Command(executable, arguments...)
	}
	var output strings.Builder
	command.Stdout = &output
	command.Stderr = standardError
	commandErr := command.Run()
	var envelope struct {
		GraphVersion storage.GraphVersion `json:"graphVersion"`
		PublishedAt  string               `json:"publishedAt"`
		Result       benchmarkResult      `json:"result"`
	}
	if err := json.Unmarshal([]byte(output.String()), &envelope); err != nil {
		if commandErr != nil {
			return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("run isolated benchmark: %w", commandErr)
		}
		return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("decode isolated benchmark: %w", err)
	}
	if commandErr != nil && envelope.Result.Failure == nil {
		return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("run isolated benchmark: %w", commandErr)
	}
	if len(envelope.Result.Runs) != 1 {
		return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("isolated benchmark returned %d runs, want 1", len(envelope.Result.Runs))
	}
	var publishedAt time.Time
	if envelope.PublishedAt != "" {
		publishedAt, err = time.Parse("2006-01-02T15:04:05Z", envelope.PublishedAt)
		if err != nil {
			return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("decode isolated benchmark publication time: %w", err)
		}
	}
	run := benchmarkRunFromResult(envelope.Result.Runs[0], envelope.Result.Configuration)
	snapshot := storage.Snapshot{Version: envelope.GraphVersion, PublishedAt: publishedAt}
	if failure := envelope.Result.Failure; failure != nil {
		return run, snapshot, &benchmarkRunError{operation: failure.Operation, cause: errors.New(failure.Error), run: run, snapshot: snapshot, databasePath: envelope.Result.DatabasePath, unavailableResources: envelope.Result.UnavailableResources}
	}
	return run, snapshot, nil
}

func prepareWorkspaceBenchmark(root string) (string, benchmark.Corpus, error) {
	workspaceRoot, err := filepath.Abs(root)
	if err != nil {
		return "", benchmark.Corpus{}, fmt.Errorf("resolve benchmark workspace: %w", err)
	}
	discovery, err := workspace.Discover(workspaceRoot, workspace.DiscoverOptions{})
	if err != nil {
		return "", benchmark.Corpus{}, fmt.Errorf("discover benchmark workspace: %w", err)
	}
	if len(discovery.Sources) == 0 {
		return "", benchmark.Corpus{}, cli.NewInvalidArgumentError("benchmark workspace has no supported source files")
	}
	source := discovery.Sources[0]
	return workspaceRoot, benchmark.Corpus{
		SourceFiles: len(discovery.Sources),
		UpdatePath:  source.Path,
		QueryTerm:   source.Path,
		PathSource:  source.ProjectID,
		PathTarget:  source.Path,
		ExplainTerm: source.Path,
	}, nil
}

func prepareBenchmarkCorpus(specification benchmark.CorpusSpec, standardError io.Writer) (string, benchmark.Corpus, error) {
	workspace, err := os.MkdirTemp("", "agent-wayfinder-benchmark-")
	if err != nil {
		return "", benchmark.Corpus{}, fmt.Errorf("create benchmark workspace: %w", err)
	}
	lastReported := 0
	fmt.Fprintf(standardError, "Benchmark setup: generate %d source files\n", specification.SourceFiles)
	corpus, err := benchmark.GenerateCorpusWithProgress(workspace, specification, func(created, total int) {
		if created == total || created-lastReported >= 1000 {
			fmt.Fprintf(standardError, "Benchmark setup: generated %d/%d source files\n", created, total)
			lastReported = created
		}
	})
	if err != nil {
		os.RemoveAll(workspace)
		return "", benchmark.Corpus{}, err
	}
	if err := os.MkdirAll(filepath.Join(workspace, ".agent-wayfinder"), 0o755); err != nil {
		os.RemoveAll(workspace)
		return "", benchmark.Corpus{}, fmt.Errorf("create benchmark database directory: %w", err)
	}

	fmt.Fprintf(standardError, "Benchmark setup: corpus expects %d nodes and %d edges; run 1 will validate the indexed result\n", corpus.ExpectedNodes, corpus.ExpectedEdges)
	return workspace, corpus, nil
}

func prepareRealisticBenchmarkCorpus(sourceFiles int, standardError io.Writer) (string, benchmark.Corpus, error) {
	specification, err := benchmark.NewRealisticCorpusSpec(sourceFiles)
	if err != nil {
		return "", benchmark.Corpus{}, cli.NewInvalidArgumentError(err.Error())
	}
	workspace, err := os.MkdirTemp("", "agent-wayfinder-benchmark-")
	if err != nil {
		return "", benchmark.Corpus{}, fmt.Errorf("create benchmark workspace: %w", err)
	}
	lastReported := 0
	fmt.Fprintf(standardError, "Benchmark setup: generate %d realistic source files\n", specification.SourceFiles)
	corpus, err := benchmark.GenerateRealisticCorpusWithProgress(workspace, specification, func(created, total int) {
		if created == total || created-lastReported >= 1000 {
			fmt.Fprintf(standardError, "Benchmark setup: generated %d/%d source files\n", created, total)
			lastReported = created
		}
	})
	if err != nil {
		os.RemoveAll(workspace)
		return "", benchmark.Corpus{}, err
	}
	if err := os.MkdirAll(filepath.Join(workspace, ".agent-wayfinder"), 0o755); err != nil {
		os.RemoveAll(workspace)
		return "", benchmark.Corpus{}, fmt.Errorf("create benchmark database directory: %w", err)
	}

	fmt.Fprintln(standardError, "Benchmark setup: realistic corpus node and edge counts are data-derived; skipping exact-count validation")
	return workspace, corpus, nil
}

func benchmarkCorpusSpec(command *cobra.Command) (benchmark.CorpusSpec, error) {
	sourceFiles, err := command.Flags().GetInt("source-files")
	if err != nil {
		return benchmark.CorpusSpec{}, err
	}
	functionsPerFile, err := command.Flags().GetInt("functions-per-file")
	if err != nil {
		return benchmark.CorpusSpec{}, err
	}
	if sourceFiles <= 0 || functionsPerFile <= 0 {
		return benchmark.CorpusSpec{}, cli.NewInvalidArgumentError("benchmark source file count and function count must be positive")
	}
	if !command.Flags().Changed("functions-per-file") {
		specification, err := benchmark.ExactScaleCorpusSpec(sourceFiles)
		if err != nil {
			return benchmark.CorpusSpec{}, cli.NewInvalidArgumentError(err.Error())
		}
		return specification, nil
	}
	additionalFunctions := 0
	uncalledFunctions := 0
	extraSideEffectImport := false
	if sourceFiles == benchmark.DefaultCorpusSpec.SourceFiles && functionsPerFile == benchmark.DefaultCorpusSpec.FunctionsPerFile {
		additionalFunctions = benchmark.DefaultCorpusSpec.AdditionalFunctions
		uncalledFunctions = benchmark.DefaultCorpusSpec.UncalledFunctions
		extraSideEffectImport = benchmark.DefaultCorpusSpec.ExtraSideEffectImport
	}
	return benchmark.CorpusSpec{
		SourceFiles:           sourceFiles,
		FunctionsPerFile:      functionsPerFile,
		AdditionalFunctions:   additionalFunctions,
		UncalledFunctions:     uncalledFunctions,
		ExtraSideEffectImport: extraSideEffectImport,
	}, nil
}

type benchmarkRunError struct {
	operation            string
	cause                error
	run                  benchmark.Run
	snapshot             storage.Snapshot
	databasePath         string
	unavailableResources []string
}

func (failure *benchmarkRunError) Error() string { return failure.cause.Error() }
func (failure *benchmarkRunError) Unwrap() error { return failure.cause }

func measureBenchmarkRun(workspace, stateDirectory string, corpus benchmark.Corpus, reporter *benchmarkProgressReporter, cpuProfilePath, incrementalCPUProfilePath string, ftsEnabled bool) (resultRun benchmark.Run, resultSnapshot storage.Snapshot, resultErr error) {
	database := filepath.Join(stateDirectory, fmt.Sprintf("benchmark-%d.db", reporter.runNumber))
	if err := os.Remove(database); err != nil && !os.IsNotExist(err) {
		return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("reset benchmark database: %w", err)
	}
	store, err := sqlite.OpenWithOptions(context.Background(), database, sqlite.Options{DisableNodeFTS: !ftsEnabled})
	if err != nil {
		return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("open benchmark database: %w", err)
	}
	storeClosed := false
	defer func() {
		if !storeClosed {
			_ = store.Close()
		}
	}()

	measurements := make([]benchmark.Measurement, 0, 5)
	phaseMeasurements := make([]benchmark.Measurement, 0, 5)
	resolverMeasurements := make([]benchmark.Measurement, 0, 3)
	sqliteWriteMeasurements := make([]benchmark.Measurement, 0, 12)
	operationName := "initial_index"
	var snapshot storage.Snapshot
	var pipelineStatistics index.PipelineStatistics
	var initialIndexPeakRSS uint64
	var initialIndexRetainedHeap uint64
	var counts storage.FactCounts
	var checksum string
	var databaseBytes int64
	buildRun := func() benchmark.Run {
		memoryLimits := store.MemoryLimits()
		return benchmark.Run{NodeFTSEnabled: ftsEnabled, Measurements: measurements, PhaseMeasurements: phaseMeasurements, ResolverMeasurements: resolverMeasurements, SQLiteWriteMeasurements: sqliteWriteMeasurements, SourceFiles: corpus.SourceFiles, NodeCount: counts.Nodes, EdgeCount: counts.Edges, ExtractionWorkers: pipelineStatistics.ExtractionWorkers, SourceQueueCapacity: pipelineStatistics.SourceQueueCapacity, ContributionQueueHighWater: pipelineStatistics.ContributionQueueHighWater, ContributionQueueCapacity: pipelineStatistics.ContributionQueueCapacity, ContributionBatchRows: memoryLimits.ContributionBatchRows, ContributionBatchBytes: memoryLimits.ContributionBatchBytes, ContributionBatchSources: memoryLimits.ContributionBatchSources, ResolverPageSize: pipelineStatistics.ResolverPageSize, WorkspaceFactBatchRows: memoryLimits.WorkspaceFactBatchRows, WorkspaceFactBatchBytes: memoryLimits.WorkspaceFactBatchBytes, PeakRSSBytes: initialIndexPeakRSS, RetainedHeapBytes: initialIndexRetainedHeap, DatabaseBytes: databaseBytes, OutputChecksum: checksum}
	}
	defer func() {
		if resultErr == nil {
			return
		}
		reporter.finishPhase()
		countsAvailable := false
		if !storeClosed && snapshot.Version > 0 {
			if currentCounts, err := store.FactCounts(context.Background(), snapshot); err == nil {
				counts, countsAvailable = currentCounts, true
			}
		} else if snapshot.Version > 0 && operationName == "resources" {
			countsAvailable = true
		}
		if !storeClosed {
			closeErr := store.Close()
			storeClosed = true
			if closeErr != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("close failed benchmark database: %w", closeErr))
			} else if info, err := os.Stat(database); err == nil {
				databaseBytes = info.Size()
			}
		}
		resultRun, resultSnapshot = buildRun(), snapshot
		unavailableResources := make([]string, 0, 6)
		if !countsAvailable {
			unavailableResources = append(unavailableResources, "nodeCount", "edgeCount")
		}
		if initialIndexPeakRSS == 0 {
			unavailableResources = append(unavailableResources, "peakRssBytes")
		}
		if initialIndexRetainedHeap == 0 {
			unavailableResources = append(unavailableResources, "retainedHeapBytes")
		}
		if databaseBytes == 0 {
			unavailableResources = append(unavailableResources, "databaseBytes")
		}
		if checksum == "" {
			unavailableResources = append(unavailableResources, "outputChecksum")
		}
		resultErr = &benchmarkRunError{operation: operationName, cause: resultErr, run: resultRun, snapshot: snapshot, databasePath: database, unavailableResources: unavailableResources}
	}()
	measure := func(name string, operation func() error) error {
		operationName = name
		reporter.start(name)
		started := time.Now()
		err := operation()
		reporter.finishPhase()
		if err != nil {
			return fmt.Errorf("benchmark %s: %w", name, err)
		}
		measurements = append(measurements, benchmark.Measurement{Name: name, Duration: time.Since(started)})
		return nil
	}

	measureInitialIndex := func() error {
		request := index.Request{
			Root: workspace,
			Measurement: func(measurement index.Measurement) {
				phaseMeasurements = append(phaseMeasurements, benchmark.Measurement{Name: measurement.Name, Duration: measurement.Duration})
			},
			PipelineStatistics: func(statistics index.PipelineStatistics) {
				pipelineStatistics = statistics
			},
			SQLiteWriteMeasurement: func(measurement storage.PublishMeasurement) {
				sqliteWriteMeasurements = append(sqliteWriteMeasurements, benchmark.Measurement{Name: measurement.Name, Duration: measurement.Duration, NotApplicable: measurement.NotApplicable})
			},
		}
		var setupReporter *benchmarkSetupReporter
		if reporter.runNumber == 1 {
			setupReporter = newBenchmarkSetupReporter(reporter.writer)
			setupReporter.start("validation extract", corpus.SourceFiles)
			request.Progress = setupReporter.update
		}
		result, err := index.Index(context.Background(), store, request)
		if setupReporter != nil {
			setupReporter.finish()
		}
		if err == nil {
			snapshot = result.Snapshot
			initialIndexPeakRSS = benchmark.PeakRSSBytes()
		}
		return err
	}
	var initialIndexError error
	if reporter.runNumber == 1 {
		profile, err := startCPUProfile(cpuProfilePath)
		if err != nil {
			return benchmark.Run{}, storage.Snapshot{}, err
		}
		started := time.Now()
		initialIndexError = measureInitialIndex()
		if profile != nil {
			pprof.StopCPUProfile()
			if err := profile.Close(); err != nil {
				initialIndexError = errors.Join(initialIndexError, fmt.Errorf("close initial-index CPU profile: %w", err))
			}
		}
		if initialIndexError == nil {
			measurements = append(measurements, benchmark.Measurement{Name: "initial_index", Duration: time.Since(started)})
		}
	} else {
		initialIndexError = measure("initial_index", measureInitialIndex)
	}
	if initialIndexError != nil {
		return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("benchmark initial_index: %w", initialIndexError)
	}
	fmt.Fprintf(reporter.writer, "Benchmark run %d/%d: initial_index complete (%s)\n", reporter.runNumber, reporter.totalRuns, measurements[len(measurements)-1].Duration)
	operationName = "retained_heap"
	reporter.start(operationName)
	initialIndexRetainedHeap = retainedHeapBytes()
	reporter.finishPhase()
	if reporter.runNumber == 1 {
		operationName = "validation"
		reporter.start(operationName)
		counts, err = validateBenchmarkSnapshot(store, snapshot, corpus)
		reporter.finishPhase()
		if err != nil {
			return benchmark.Run{}, storage.Snapshot{}, err
		}
		if corpus.ExpectedNodes > 0 || corpus.ExpectedEdges > 0 {
			fmt.Fprintf(reporter.writer, "Benchmark setup: validated %d/%d nodes and %d/%d edges\n", counts.Nodes, corpus.ExpectedNodes, counts.Edges, corpus.ExpectedEdges)
		} else {
			fmt.Fprintln(reporter.writer, "Benchmark setup: validated published workspace graph")
		}
	}
	updatedSource := filepath.Join(workspace, corpus.UpdatePath)
	operationName = "incremental_update"
	contents, err := os.ReadFile(updatedSource)
	if err != nil {
		return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("read benchmark source update: %w", err)
	}
	if err := os.WriteFile(updatedSource, append(contents, '\n'), 0o644); err != nil {
		return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("update benchmark source: %w", err)
	}
	if err := measure("incremental_update", func() error {
		profile, err := startCPUProfile(incrementalCPUProfilePath)
		if err != nil {
			return err
		}
		if profile != nil {
			defer func() {
				pprof.StopCPUProfile()
				_ = profile.Close()
			}()
		}
		updatedSnapshot, err := index.PublishBatch(context.Background(), store, index.BatchRequest{
			Root:         workspace,
			ChangedPaths: []string{corpus.UpdatePath},
			Measurement: func(measurement index.Measurement) {
				resolverMeasurements = append(resolverMeasurements, benchmark.Measurement{Name: measurement.Name, Duration: measurement.Duration})
			},
		})
		if err == nil {
			snapshot = updatedSnapshot
		}
		return err
	}); err != nil {
		return benchmark.Run{}, storage.Snapshot{}, err
	}
	if err := measure("query", func() error {
		parsed, err := query.ParseGraphQuery(fmt.Sprintf("MATCH (node {name: %q}) RETURN node LIMIT 100", corpus.QueryTerm))
		if err != nil {
			return err
		}
		_, err = query.ExecuteGraphQuerySnapshot(context.Background(), store, snapshot, parsed, query.GraphQueryLimits{MaxDepth: 1, MaxNodes: 100}, query.GraphQueryOptions{})
		return err
	}); err != nil {
		return benchmark.Run{}, storage.Snapshot{}, err
	}
	if err := measure("path", func() error {
		_, err := query.FindPathSnapshot(context.Background(), store, store, snapshot, query.PathRequest{Source: corpus.PathSource, Target: corpus.PathTarget, MaxDepth: 1, MaxNodes: 10})
		return err
	}); err != nil {
		return benchmark.Run{}, storage.Snapshot{}, err
	}
	if err := measure("inspect", func() error {
		_, err := query.ExplainSnapshot(context.Background(), store, store, snapshot, corpus.ExplainTerm)
		return err
	}); err != nil {
		return benchmark.Run{}, storage.Snapshot{}, err
	}
	operationName = "checksum"
	reporter.start("checksum and resource summary")
	checksum, err = graphChecksum(context.Background(), store, snapshot)
	if err != nil {
		return benchmark.Run{}, storage.Snapshot{}, err
	}
	reporter.finishPhase()
	orderedSQLiteWriteMeasurements, err := benchmark.OrderSQLiteWriteMeasurements(sqliteWriteMeasurements)
	if err != nil {
		return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("measure benchmark run: %w", err)
	}
	sqliteWriteMeasurements = orderedSQLiteWriteMeasurements
	operationName = "resources"
	counts, err = store.FactCounts(context.Background(), snapshot)
	if err != nil {
		return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("measure benchmark run: count graph facts: %w", err)
	}
	closeErr := store.Close()
	storeClosed = true
	if closeErr != nil {
		return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("close benchmark database: %w", closeErr)
	}
	databaseInfo, err := os.Stat(database)
	if err != nil {
		return benchmark.Run{}, storage.Snapshot{}, fmt.Errorf("read benchmark database size: %w", err)
	}
	databaseBytes = databaseInfo.Size()
	return buildRun(), snapshot, nil
}

func startCPUProfile(path string) (*os.File, error) {
	if path == "" {
		return nil, nil
	}
	profile, err := os.Create(path)
	if err != nil {
		return nil, fmt.Errorf("create initial-index CPU profile: %w", err)
	}
	if err := pprof.StartCPUProfile(profile); err != nil {
		_ = profile.Close()
		return nil, fmt.Errorf("start initial-index CPU profile: %w", err)
	}
	return profile, nil
}

type benchmarkSnapshotValidator interface {
	storage.FactCounter
	storage.NodeLookup
	storage.ExactNodeLookup
}

func validateBenchmarkSnapshot(store benchmarkSnapshotValidator, snapshot storage.Snapshot, corpus benchmark.Corpus) (storage.FactCounts, error) {
	counts, err := store.FactCounts(context.Background(), snapshot)
	if err != nil {
		return storage.FactCounts{}, fmt.Errorf("validate benchmark corpus: count graph facts: %w", err)
	}
	if (corpus.ExpectedNodes > 0 && counts.Nodes != corpus.ExpectedNodes) || (corpus.ExpectedEdges > 0 && counts.Edges != corpus.ExpectedEdges) {
		return storage.FactCounts{}, fmt.Errorf("validate benchmark corpus: graph contains %d nodes and %d edges, want %d nodes and %d edges", counts.Nodes, counts.Edges, corpus.ExpectedNodes, corpus.ExpectedEdges)
	}
	checked := make(map[string]bool, 4)
	for _, lookup := range []struct {
		term  string
		exact bool
	}{{corpus.PathSource, true}, {corpus.PathTarget, true}, {corpus.QueryTerm, false}, {corpus.ExplainTerm, false}} {
		if checked[lookup.term] {
			continue
		}
		var matches []storage.NodeMatch
		var err error
		if lookup.exact {
			matches, err = store.LookupExactNodes(context.Background(), snapshot, lookup.term)
		} else {
			matches, err = store.LookupNodes(context.Background(), snapshot, storage.NodeLookupRequest{Text: lookup.term, Limit: 1})
		}
		if err != nil {
			return storage.FactCounts{}, fmt.Errorf("validate benchmark corpus: look up %q: %w", lookup.term, err)
		}
		if len(matches) == 0 {
			return storage.FactCounts{}, fmt.Errorf("validate benchmark corpus: expected graph node %q is unavailable", lookup.term)
		}
		checked[lookup.term] = true
	}
	return counts, nil
}

type benchmarkChecksumSink struct {
	hash hash.Hash
}

func (sink benchmarkChecksumSink) WriteNode(node graph.Node) error {
	_, _ = fmt.Fprintf(sink.hash, "node\x00%s\x00%s\x00%s\n", node.ID, node.Kind, node.QualifiedName)
	return nil
}

func (sink benchmarkChecksumSink) WriteEdge(edge graph.Edge) error {
	_, _ = fmt.Fprintf(sink.hash, "edge\x00%s\x00%s\x00%s\n", edge.SourceID, edge.TargetID, edge.Relation)
	return nil
}

func graphChecksum(ctx context.Context, store storage.Exporter, snapshot storage.Snapshot) (string, error) {
	sum := sha256.New()
	if err := store.Export(ctx, snapshot, storage.ExportRequest{}, benchmarkChecksumSink{hash: sum}); err != nil {
		return "", fmt.Errorf("checksum benchmark graph: %w", err)
	}
	return fmt.Sprintf("sha256:%x", sum.Sum(nil)), nil
}

func retainedHeapBytes() uint64 {
	runtime.GC()
	var statistics runtime.MemStats
	runtime.ReadMemStats(&statistics)
	return statistics.HeapAlloc
}
