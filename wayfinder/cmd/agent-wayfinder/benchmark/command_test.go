package benchmark

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"agent-wayfinder/benchmark"
	"agent-wayfinder/cli"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"
	"agent-wayfinder/storage"
	"agent-wayfinder/testkit"
)

type benchmarkValidationStore struct {
	counts      storage.FactCounts
	countError  error
	missingTerm string
	failingTerm string
	lookupError error
	calls       []string
	snapshots   []storage.Snapshot
}

func (store *benchmarkValidationStore) FactCounts(_ context.Context, snapshot storage.Snapshot) (storage.FactCounts, error) {
	store.calls = append(store.calls, "counts")
	store.snapshots = append(store.snapshots, snapshot)
	return store.counts, store.countError
}

func (store *benchmarkValidationStore) LookupNodes(_ context.Context, snapshot storage.Snapshot, request storage.NodeLookupRequest) ([]storage.NodeMatch, error) {
	store.calls = append(store.calls, "search:"+request.Text)
	store.snapshots = append(store.snapshots, snapshot)
	if request.Limit != 1 {
		return nil, errors.New("expected a single validation match")
	}
	return store.matches(request.Text)
}

func (store *benchmarkValidationStore) LookupExactNodes(_ context.Context, snapshot storage.Snapshot, identifier string) ([]storage.NodeMatch, error) {
	store.calls = append(store.calls, "exact:"+identifier)
	store.snapshots = append(store.snapshots, snapshot)
	return store.matches(identifier)
}

func (store *benchmarkValidationStore) matches(term string) ([]storage.NodeMatch, error) {
	if term == store.failingTerm {
		return nil, store.lookupError
	}
	if term == store.missingTerm {
		return nil, nil
	}
	return []storage.NodeMatch{{}}, nil
}

func TestBenchmarkSnapshotValidation(test *testing.T) {
	failure := errors.New("storage failure")
	for _, scenario := range []struct {
		name        string
		counts      storage.FactCounts
		countError  error
		missingTerm string
		failingTerm string
		explainTerm string
		wantError   bool
	}{
		{name: "duplicate query and explain", counts: storage.FactCounts{Nodes: 16, Edges: 30}, explainTerm: "entry"},
		{name: "distinct explain", counts: storage.FactCounts{Nodes: 16, Edges: 30}, explainTerm: "other"},
		{name: "wrong nodes", counts: storage.FactCounts{Nodes: 15, Edges: 30}, wantError: true},
		{name: "wrong edges", counts: storage.FactCounts{Nodes: 16, Edges: 29}, wantError: true},
		{name: "count failure", countError: failure, wantError: true},
		{name: "missing exact source", counts: storage.FactCounts{Nodes: 16, Edges: 30}, missingTerm: "source::entry", wantError: true},
		{name: "missing exact target", counts: storage.FactCounts{Nodes: 16, Edges: 30}, missingTerm: "target::next", wantError: true},
		{name: "missing query", counts: storage.FactCounts{Nodes: 16, Edges: 30}, missingTerm: "entry", wantError: true},
		{name: "missing explain", counts: storage.FactCounts{Nodes: 16, Edges: 30}, missingTerm: "other", explainTerm: "other", wantError: true},
		{name: "exact lookup failure", counts: storage.FactCounts{Nodes: 16, Edges: 30}, failingTerm: "source::entry", wantError: true},
		{name: "search failure", counts: storage.FactCounts{Nodes: 16, Edges: 30}, failingTerm: "entry", wantError: true},
	} {
		test.Run(scenario.name, func(test *testing.T) {
			store := &benchmarkValidationStore{counts: scenario.counts, countError: scenario.countError,
				missingTerm: scenario.missingTerm, failingTerm: scenario.failingTerm, lookupError: failure}
			snapshot := storage.Snapshot{Workspace: "workspace", Version: 2}
			corpus := benchmark.Corpus{ExpectedNodes: 16, ExpectedEdges: 30, QueryTerm: "entry",
				PathSource: "source::entry", PathTarget: "target::next", ExplainTerm: scenario.explainTerm}
			counts, err := validateBenchmarkSnapshot(store, snapshot, corpus)
			if (err != nil) != scenario.wantError {
				test.Fatalf("validation error = %v, want error %t", err, scenario.wantError)
			}
			if scenario.countError != nil || scenario.failingTerm != "" {
				if !errors.Is(err, failure) {
					test.Fatalf("validation error = %v, want wrapped storage failure", err)
				}
			}
			if !scenario.wantError {
				wantCalls := []string{"counts", "exact:source::entry", "exact:target::next", "search:entry"}
				if scenario.explainTerm != "entry" {
					wantCalls = append(wantCalls, "search:"+scenario.explainTerm)
				}
				if !reflect.DeepEqual(store.calls, wantCalls) || counts != scenario.counts {
					test.Fatalf("validation = %+v, calls %v, want %+v and %v", counts, store.calls, scenario.counts, wantCalls)
				}
			}
			for _, seen := range store.snapshots {
				if seen != snapshot {
					test.Fatalf("validation snapshot = %+v, want %+v", seen, snapshot)
				}
			}
		})
	}
}

func run(arguments []string, standardOutput, standardError *strings.Builder) int {
	if len(arguments) == 0 || arguments[0] != "benchmark" {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("expected benchmark command"))
	}
	exitCode := 0
	command := New(standardOutput, standardError, &exitCode)
	command.SetArgs(arguments[1:])
	if err := command.Execute(); err != nil {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError(err.Error()))
	}
	return exitCode
}

func TestBenchmarkFTSSettingPreservesGraphContract(t *testing.T) {
	var baseline benchmarkRunResult
	for _, enabled := range []bool{true, false} {
		output, standardError := &strings.Builder{}, &strings.Builder{}
		arguments := []string{"benchmark", "--format", "json", "--source-files", "3", "--functions-per-file", "4"}
		if !enabled {
			arguments = append(arguments, "--fts=false")
		}
		if exitCode := run(arguments, output, standardError); exitCode != 0 {
			t.Fatalf("run benchmark: exit %d, error %s", exitCode, standardError.String())
		}
		var envelope struct {
			Result benchmarkResult `json:"result"`
		}
		if err := json.Unmarshal([]byte(output.String()), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Result.Configuration.NodeFTSEnabled != enabled || len(envelope.Result.Runs) != 1 {
			t.Fatalf("unexpected FTS configuration or run count: %+v", envelope.Result)
		}
		current := envelope.Result.Runs[0]
		arguments[2] = "text"
		output.Reset()
		standardError.Reset()
		if exitCode := run(arguments, output, standardError); exitCode != 0 {
			t.Fatalf("run text benchmark: exit %d, error %s", exitCode, standardError.String())
		}
		if !strings.Contains(output.String(), fmt.Sprintf("node FTS enabled: %t", enabled)) {
			t.Fatal("text report omits FTS setting")
		}
		if current.DatabaseBytes <= 4096 {
			t.Fatalf("database measurement omits published data: %d bytes", current.DatabaseBytes)
		}
		if enabled {
			baseline = current
		} else if current.NodeCount != baseline.NodeCount || current.EdgeCount != baseline.EdgeCount || current.OutputChecksum != baseline.OutputChecksum {
			t.Fatalf("FTS setting changed graph counts or checksum: on=%+v off=%+v", baseline, current)
		}
	}
}

func TestBenchmarkFailurePreservesCompletedMeasurements(t *testing.T) {
	for _, mode := range []string{"local", "isolated"} {
		t.Run(mode, func(t *testing.T) {
			output, standardError := &strings.Builder{}, &strings.Builder{}
			profileDirectory := t.TempDir()
			arguments := []string{"benchmark", "--format", "json", "--incremental-cpu-profile", profileDirectory}
			wantNodes, wantEdges := 16, 30
			if mode == "isolated" {
				arguments = append(arguments, "--exact-scale", "--source-files", "4")
				wantNodes, wantEdges = 400, 800
			} else {
				arguments = append(arguments, "--source-files", "3", "--functions-per-file", "4")
			}
			exitCode := run(arguments, output, standardError)
			if exitCode == 0 || !strings.Contains(standardError.String(), "create initial-index CPU profile") {
				t.Fatalf("benchmark failure = %d, %s", exitCode, standardError.String())
			}
			var envelope struct {
				GraphVersion int `json:"graphVersion"`
				Result       struct {
					Failure struct {
						Operation string `json:"operation"`
						Error     string `json:"error"`
					} `json:"failure"`
					Measurements []struct {
						Name       string `json:"name"`
						DurationNS int64  `json:"durationNs"`
					} `json:"measurements"`
					UnavailableMeasurements []string          `json:"unavailableMeasurements"`
					UnavailableResources    []string          `json:"unavailableResources"`
					PhaseMeasurements       []json.RawMessage `json:"phaseMeasurements"`
					DatabasePath            string            `json:"databasePath"`
					DatabaseBytes           int64             `json:"databaseBytes"`
					PeakRSSBytes            uint64            `json:"peakRssBytes"`
					RetainedHeapBytes       uint64            `json:"retainedHeapBytes"`
					Runs                    []struct {
						NodeCount      int     `json:"nodeCount"`
						EdgeCount      int     `json:"edgeCount"`
						OutputChecksum *string `json:"outputChecksum"`
					} `json:"runs"`
				} `json:"result"`
			}
			if err := json.Unmarshal([]byte(output.String()), &envelope); err != nil {
				t.Fatalf("decode partial report: %v\n%s", err, output.String())
			}
			report := envelope.Result
			if report.Failure.Operation != "incremental_update" || !strings.Contains(report.Failure.Error, "create initial-index CPU profile") || envelope.GraphVersion != 1 {
				t.Fatalf("partial failure metadata = %+v, snapshot %d", report.Failure, envelope.GraphVersion)
			}
			if len(report.Measurements) != 1 || report.Measurements[0].Name != "initial_index" || report.Measurements[0].DurationNS <= 0 || len(report.PhaseMeasurements) == 0 {
				t.Fatalf("completed measurements = %+v, phases %d", report.Measurements, len(report.PhaseMeasurements))
			}
			if strings.Join(report.UnavailableMeasurements, ",") != "incremental_update,query,path,inspect" || strings.Join(report.UnavailableResources, ",") != "outputChecksum" {
				t.Fatalf("unavailable values = %v, %v", report.UnavailableMeasurements, report.UnavailableResources)
			}
			if len(report.Runs) != 1 || report.Runs[0].NodeCount != wantNodes || report.Runs[0].EdgeCount != wantEdges || report.Runs[0].OutputChecksum != nil {
				t.Fatalf("partial graph results = %+v", report.Runs)
			}
			if report.DatabasePath == "" {
				t.Fatal("partial report omits retained database path")
			}
			t.Cleanup(func() { _ = os.RemoveAll(filepath.Dir(report.DatabasePath)) })
			info, err := os.Stat(report.DatabasePath)
			if err != nil || report.DatabaseBytes <= 4096 || info.Size() != report.DatabaseBytes || report.PeakRSSBytes == 0 || report.RetainedHeapBytes == 0 {
				t.Fatalf("partial resource results = %+v, database info %v, error %v", report, info, err)
			}
		})
	}
}

func TestBenchmarkInitialFailureReportsUnavailableResources(t *testing.T) {
	for _, mode := range []string{"local", "isolated"} {
		t.Run(mode, func(t *testing.T) {
			output, standardError := &strings.Builder{}, &strings.Builder{}
			arguments := []string{"benchmark", "--format", "json", "--source-files", "4", "--cpu-profile", t.TempDir()}
			if mode == "isolated" {
				arguments = append(arguments, "--exact-scale")
			} else {
				arguments = append(arguments, "--functions-per-file", "4")
			}
			if exitCode := run(arguments, output, standardError); exitCode != 1 {
				t.Fatalf("failed initial benchmark exit code = %d: %s", exitCode, standardError.String())
			}
			var envelope struct {
				GraphVersion *int                       `json:"graphVersion"`
				Result       map[string]json.RawMessage `json:"result"`
			}
			if err := json.Unmarshal([]byte(output.String()), &envelope); err != nil {
				t.Fatalf("decode failed initial report: %v", err)
			}
			var unavailable []string
			if err := json.Unmarshal(envelope.Result["unavailableResources"], &unavailable); err != nil {
				t.Fatal(err)
			}
			if envelope.GraphVersion != nil || strings.Join(unavailable, ",") != "nodeCount,edgeCount,peakRssBytes,retainedHeapBytes,outputChecksum" {
				t.Fatalf("initial unavailable results = %v, snapshot %v", unavailable, envelope.GraphVersion)
			}
			for _, field := range unavailable {
				if _, present := envelope.Result[field]; present {
					t.Errorf("unavailable resource %s has a value", field)
				}
			}
			var runs []map[string]json.RawMessage
			if err := json.Unmarshal(envelope.Result["runs"], &runs); err != nil || len(runs) != 1 {
				t.Fatalf("partial runs = %v, error %v", runs, err)
			}
			for _, field := range unavailable {
				if _, present := runs[0][field]; present {
					t.Errorf("unavailable run resource %s has a value", field)
				}
			}
			var database string
			if err := json.Unmarshal(envelope.Result["databasePath"], &database); err != nil || database == "" {
				t.Fatalf("retained database = %q, error %v", database, err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(filepath.Dir(database)) })
			if _, err := os.Stat(database); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestBenchmarkFailureTextMarksMissingResults(t *testing.T) {
	output, standardError := &strings.Builder{}, &strings.Builder{}
	if exitCode := run([]string{"benchmark", "--source-files", "3", "--functions-per-file", "4", "--incremental-cpu-profile", t.TempDir()}, output, standardError); exitCode != 1 {
		t.Fatalf("failed text benchmark exit code = %d: %s", exitCode, standardError.String())
	}
	for _, expected := range []string{"failed operation: incremental_update", "initial_index:", "query: unavailable", "path: unavailable", "inspect: unavailable", "outputChecksum: unavailable"} {
		if !strings.Contains(output.String(), expected) {
			t.Errorf("partial text report omits %q: %s", expected, output.String())
		}
	}
	for _, line := range strings.Split(output.String(), "\n") {
		if database, found := strings.CutPrefix(line, "database path: "); found {
			t.Cleanup(func() { _ = os.RemoveAll(filepath.Dir(database)) })
			if _, err := os.Stat(database); err != nil {
				t.Fatal(err)
			}
			return
		}
	}
	t.Fatal("partial text report omits retained database path")
}

func TestBenchmarkCommandMeasuresCriticalUserPath(t *testing.T) {
	output := &strings.Builder{}
	standardError := &strings.Builder{}
	if exitCode := run([]string{"benchmark", "--format", "json", "--source-files", "3", "--functions-per-file", "4"}, output, standardError); exitCode != 0 {
		t.Fatalf("run benchmark command: exit code %d, error %s", exitCode, standardError.String())
	}

	var result struct {
		GraphVersion int    `json:"graphVersion"`
		PublishedAt  string `json:"publishedAt"`
		Result       struct {
			ContributionQueueHighWater int `json:"contributionQueueHighWater"`
			ContributionQueueCapacity  int `json:"contributionQueueCapacity"`
			Measurements               []struct {
				Name       string `json:"name"`
				DurationNS int64  `json:"durationNs"`
			} `json:"measurements"`
			PhaseMeasurements []struct {
				Name       string `json:"name"`
				DurationNS int64  `json:"durationNs"`
			} `json:"phaseMeasurements"`
			ResolverMeasurements []struct {
				Name       string `json:"name"`
				DurationNS int64  `json:"durationNs"`
			} `json:"resolverMeasurements"`
			SQLiteWriteMeasurements []struct {
				Name       string `json:"name"`
				DurationNS int64  `json:"durationNs"`
			} `json:"sqliteWriteMeasurements"`
			Runs []struct {
				ContributionQueueHighWater int `json:"contributionQueueHighWater"`
				ContributionQueueCapacity  int `json:"contributionQueueCapacity"`
				Measurements               []struct {
					Name       string `json:"name"`
					DurationNS int64  `json:"durationNs"`
				} `json:"measurements"`
				PhaseMeasurements []struct {
					Name       string `json:"name"`
					DurationNS int64  `json:"durationNs"`
				} `json:"phaseMeasurements"`
				ResolverMeasurements []struct {
					Name       string `json:"name"`
					DurationNS int64  `json:"durationNs"`
				} `json:"resolverMeasurements"`
				SQLiteWriteMeasurements []struct {
					Name       string `json:"name"`
					DurationNS int64  `json:"durationNs"`
				} `json:"sqliteWriteMeasurements"`
				PeakRSSBytes   uint64 `json:"peakRssBytes"`
				DatabaseBytes  int64  `json:"databaseBytes"`
				OutputChecksum string `json:"outputChecksum"`
			} `json:"runs"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(output.String()), &result); err != nil {
		t.Fatalf("decode benchmark result: %v\n%s", err, output.String())
	}
	if result.GraphVersion != 2 || result.PublishedAt == "" {
		t.Errorf("benchmark metadata = {%d, %q}, want published graph metadata", result.GraphVersion, result.PublishedAt)
	}
	if len(result.Result.Measurements) != 5 {
		t.Fatalf("measurements = %+v, want five critical-path measurements", result.Result.Measurements)
	}
	for index, want := range []string{"initial_index", "incremental_update", "query", "path", "inspect"} {
		measurement := result.Result.Measurements[index]
		if measurement.Name != want {
			t.Errorf("measurement %d name = %q, want %q", index, measurement.Name, want)
		}
		if measurement.DurationNS < 0 {
			t.Errorf("measurement %q duration = %d, want non-negative", measurement.Name, measurement.DurationNS)
		}
	}
	for runIndex, run := range result.Result.Runs {
		if len(run.PhaseMeasurements) != 12 {
			t.Fatalf("run %d phase measurements = %+v, want twelve indexing phases", runIndex, run.PhaseMeasurements)
		}
		for phaseIndex, want := range []string{"discovery", "pipeline_wall", "extraction", "extractor_busy", "writer_busy", "producer_blocked", "extraction_write_overlap", "resolution", "publication_preparation", "sqlite_write", "commit", "staged_transaction"} {
			measurement := run.PhaseMeasurements[phaseIndex]
			if measurement.Name != want {
				t.Errorf("run %d phase measurement %d name = %q, want %q", runIndex, phaseIndex, measurement.Name, want)
			}
			if measurement.DurationNS < 0 {
				t.Errorf("run %d phase %q duration = %d, want non-negative", runIndex, measurement.Name, measurement.DurationNS)
			}
		}
		if run.ContributionQueueHighWater <= 0 || run.ContributionQueueHighWater > run.ContributionQueueCapacity {
			t.Errorf("run %d queue statistics = %d/%d, want positive high-water at most capacity", runIndex, run.ContributionQueueHighWater, run.ContributionQueueCapacity)
		}
		if len(run.ResolverMeasurements) != 6 {
			t.Fatalf("run %d resolver measurements = %+v, want six incremental phase measurements", runIndex, run.ResolverMeasurements)
		}
		for measurementIndex, want := range []string{"affected_source_selection", "contribution_restoration", "workspace_resolution", "publication_preparation", "sqlite_write", "commit"} {
			measurement := run.ResolverMeasurements[measurementIndex]
			if measurement.Name != want {
				t.Errorf("run %d resolver measurement %d name = %q, want %q", runIndex, measurementIndex, measurement.Name, want)
			}
			if measurement.DurationNS < 0 {
				t.Errorf("run %d resolver measurement %q duration = %d, want non-negative", runIndex, measurement.Name, measurement.DurationNS)
			}
		}
	}
	if len(result.Result.ResolverMeasurements) != 6 {
		t.Fatalf("incremental phase medians = %+v, want six measurements", result.Result.ResolverMeasurements)
	}
	if result.Result.ContributionQueueHighWater <= 0 || result.Result.ContributionQueueHighWater > result.Result.ContributionQueueCapacity {
		t.Errorf("queue statistics = %d/%d, want positive high-water at most capacity", result.Result.ContributionQueueHighWater, result.Result.ContributionQueueCapacity)
	}
	writeTables := []string{
		"workspace_nodes",
		"workspace_edges",
		"file_contributions",
		"contribution_nodes",
		"contribution_edges",
		"contribution_extensions",
		"contribution_dependencies",
		"contribution_exported_surfaces",
		"contribution_diagnostics",
		"contribution_unresolved_references",
		"contribution_module_bindings",
		"contribution_symbol_references",
	}
	if len(result.Result.SQLiteWriteMeasurements) != len(writeTables) {
		t.Fatalf("SQLite write medians = %+v, want %d table measurements", result.Result.SQLiteWriteMeasurements, len(writeTables))
	}
	for measurementIndex, want := range writeTables {
		measurement := result.Result.SQLiteWriteMeasurements[measurementIndex]
		if measurement.Name != want {
			t.Errorf("SQLite write median %d name = %q, want %q", measurementIndex, measurement.Name, want)
		}
		if measurement.DurationNS < 0 {
			t.Errorf("SQLite write median %q duration = %d, want non-negative", measurement.Name, measurement.DurationNS)
		}
	}
	if len(result.Result.Runs) != 1 {
		t.Fatalf("warm runs = %+v, want one", result.Result.Runs)
	}
	for runIndex, run := range result.Result.Runs {
		if len(run.Measurements) != 5 || run.PeakRSSBytes == 0 || run.DatabaseBytes <= 0 || run.OutputChecksum == "" {
			t.Errorf("warm run %d = %+v, want measurements and resource metadata", runIndex, run)
		}
		if len(run.SQLiteWriteMeasurements) != len(writeTables) {
			t.Errorf("warm run %d SQLite write measurements = %+v, want %d table measurements", runIndex, run.SQLiteWriteMeasurements, len(writeTables))
		}
	}
	if progress := standardError.String(); !strings.Contains(progress, "Benchmark setup: generated 3/3 source files") || !strings.Contains(progress, "Benchmark setup: validation extract 3/3 sources") || !strings.Contains(progress, "Benchmark setup: validation resolve 3/3 sources") || !strings.Contains(progress, "Benchmark setup: validation publish 3/3 sources") || !strings.Contains(progress, "Benchmark setup: validated 16/16 nodes and 30/30 edges") || !strings.Contains(progress, "Benchmark run 1/1: complete") {
		t.Errorf("benchmark progress = %q, want setup counts and run completion messages", progress)
	}
	progress := standardError.String()
	previous := -1
	for _, message := range []string{"initial_index complete (", ": retained_heap", ": validation\n", "validated 16/16 nodes and 30/30 edges"} {
		position := strings.Index(progress, message)
		if position <= previous {
			t.Fatalf("benchmark progress = %q, want %q after the previous stage", progress, message)
		}
		previous = position
	}
}

func TestBenchmarkCommandRunsExplicitExactScaleAcceptance(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		t.Run(fmt.Sprintf("fts_%t", enabled), func(t *testing.T) {
			output := &strings.Builder{}
			standardError := &strings.Builder{}
			arguments := []string{"benchmark", "--format", "json", "--exact-scale", "--source-files", "4", "--runs", "3", fmt.Sprintf("--fts=%t", enabled)}
			if exitCode := run(arguments, output, standardError); exitCode != 0 {
				t.Fatalf("run exact-scale benchmark command: exit code %d, error %s", exitCode, standardError.String())
			}

			var result struct {
				Result struct {
					Configuration struct {
						NodeFTSEnabled            bool `json:"nodeFtsEnabled"`
						ExtractionWorkers         int  `json:"extractionWorkers"`
						SourceQueueCapacity       int  `json:"sourceQueueCapacity"`
						ContributionQueueCapacity int  `json:"contributionQueueCapacity"`
						ContributionBatchRows     int  `json:"contributionBatchRows"`
						ContributionBatchBytes    int  `json:"contributionBatchBytes"`
						ContributionBatchSources  int  `json:"contributionBatchSources"`
						ResolverPageSize          int  `json:"resolverPageSize"`
						WorkspaceFactBatchRows    int  `json:"workspaceFactBatchRows"`
						WorkspaceFactBatchBytes   int  `json:"workspaceFactBatchBytes"`
					} `json:"configuration"`
					Runs []struct {
						SourceFiles    int    `json:"sourceFiles"`
						NodeCount      int    `json:"nodeCount"`
						EdgeCount      int    `json:"edgeCount"`
						OutputChecksum string `json:"outputChecksum"`
					} `json:"runs"`
				} `json:"result"`
			}
			if err := json.Unmarshal([]byte(output.String()), &result); err != nil {
				t.Fatalf("decode exact-scale benchmark result: %v\n%s", err, output.String())
			}
			if len(result.Result.Runs) != 3 {
				t.Fatalf("exact-scale runs = %d, want 3", len(result.Result.Runs))
			}
			configuration := result.Result.Configuration
			if configuration.NodeFTSEnabled != enabled {
				t.Fatalf("isolated samples lost FTS setting: got %t, want %t", configuration.NodeFTSEnabled, enabled)
			}
			if configuration.ExtractionWorkers <= 0 || configuration.SourceQueueCapacity <= 0 || configuration.ContributionQueueCapacity <= 0 || configuration.ContributionBatchRows <= 0 || configuration.ContributionBatchBytes <= 0 || configuration.ContributionBatchSources <= 0 || configuration.ResolverPageSize <= 0 || configuration.WorkspaceFactBatchRows <= 0 || configuration.WorkspaceFactBatchBytes <= 0 {
				t.Errorf("exact-scale configuration = %+v, want all positive memory bounds", configuration)
			}
			checksum := result.Result.Runs[0].OutputChecksum
			for runIndex, benchmarkRun := range result.Result.Runs {
				if benchmarkRun.SourceFiles != 4 || benchmarkRun.NodeCount != 400 || benchmarkRun.EdgeCount != 800 {
					t.Errorf("run %d counts = %d sources, %d nodes and %d edges, want 4, 400 and 800", runIndex, benchmarkRun.SourceFiles, benchmarkRun.NodeCount, benchmarkRun.EdgeCount)
				}
				if checksum == "" || benchmarkRun.OutputChecksum != checksum {
					t.Errorf("run %d checksum = %q, want stable nonempty %q", runIndex, benchmarkRun.OutputChecksum, checksum)
				}
			}
		})
	}
}

func TestBenchmarkCommandWritesInitialIndexCPUProfile(t *testing.T) {
	profilePath := filepath.Join(t.TempDir(), "initial-index.pprof")
	output := &strings.Builder{}
	standardError := &strings.Builder{}

	if exitCode := run([]string{"benchmark", "--source-files", "3", "--functions-per-file", "4", "--cpu-profile", profilePath}, output, standardError); exitCode != 0 {
		t.Fatalf("run benchmark with CPU profile: exit code %d, error %s", exitCode, standardError.String())
	}

	profile, err := os.Stat(profilePath)
	if err != nil {
		t.Fatalf("stat CPU profile: %v", err)
	}
	if profile.Size() == 0 {
		t.Error("CPU profile is empty")
	}
}

func TestBenchmarkCommandWritesIncrementalUpdateCPUProfile(t *testing.T) {
	profilePath := filepath.Join(t.TempDir(), "incremental-update.pprof")
	output := &strings.Builder{}
	standardError := &strings.Builder{}

	if exitCode := run([]string{"benchmark", "--source-files", "3", "--functions-per-file", "4", "--incremental-cpu-profile", profilePath}, output, standardError); exitCode != 0 {
		t.Fatalf("run benchmark with incremental CPU profile: exit code %d, error %s", exitCode, standardError.String())
	}

	profile, err := os.Stat(profilePath)
	if err != nil {
		t.Fatalf("stat incremental CPU profile: %v", err)
	}
	if profile.Size() == 0 {
		t.Error("incremental CPU profile is empty")
	}
}

func TestBenchmarkCommandMeasuresGoWorkspace(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		".agent-wayfinder/config.json": `{"sources":{"exclude":["reference/**"]}}`,
		"go.mod":                       "module example.com/fixture\n\ngo 1.24\n",
		"cmd/main.go":                  "package main\n\nimport \"example.com/fixture/service\"\n\nfunc main() { service.Run() }\n",
		"service/run.go":               "package service\n\nfunc Run() {}\n",
		"reference/api.ts":             "export function incompatible(name: string): string { return \"\"; }\n",
	})
	updatePath := filepath.Join(workspace.Root, "cmd", "main.go")
	baseline, err := os.ReadFile(updatePath)
	if err != nil {
		t.Fatalf("read workspace source baseline: %v", err)
	}
	output := &strings.Builder{}
	standardError := &strings.Builder{}

	if exitCode := run([]string{"benchmark", "--format", "json", workspace.Root}, output, standardError); exitCode != 0 {
		t.Fatalf("run Go workspace benchmark: exit code %d, error %s", exitCode, standardError.String())
	}

	var result struct {
		Result struct {
			Runs []struct {
				OutputChecksum string `json:"outputChecksum"`
			} `json:"runs"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(output.String()), &result); err != nil {
		t.Fatalf("decode Go workspace benchmark result: %v\n%s", err, output.String())
	}
	if len(result.Result.Runs) != 1 {
		t.Errorf("benchmark runs = %+v, want one workspace measurement", result.Result.Runs)
	}
	for runIndex, run := range result.Result.Runs {
		if run.OutputChecksum == "" {
			t.Errorf("benchmark run %d has no output checksum", runIndex)
		}
	}
	contents, err := os.ReadFile(updatePath)
	if err != nil {
		t.Fatalf("read benchmarked workspace source: %v", err)
	}
	if string(contents) != string(baseline) {
		t.Errorf("benchmarked workspace source changed\ngot:  %q\nwant: %q", contents, baseline)
	}
	if progress := standardError.String(); !strings.Contains(progress, "Benchmark setup: measure 2 workspace source files") {
		t.Errorf("benchmark progress = %q, want ignored source exclusion", progress)
	}
}

func TestBenchmarkCommandRejectsWorkspaceWithoutSources(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		"README.md": "No source files.\n",
	})
	output := &strings.Builder{}
	standardError := &strings.Builder{}

	if exitCode := run([]string{"benchmark", workspace.Root}, output, standardError); exitCode != 2 {
		t.Errorf("exit code = %d, want 2", exitCode)
	}
	if errorOutput := standardError.String(); !strings.Contains(errorOutput, "no supported source files") {
		t.Errorf("error = %q, want missing source files message", errorOutput)
	}
}

func TestBenchmarkCommandRejectsNonpositiveCorpusSize(t *testing.T) {
	output := &strings.Builder{}
	standardError := &strings.Builder{}

	if exitCode := run([]string{"benchmark", "--source-files", "0"}, output, standardError); exitCode != 2 {
		t.Errorf("benchmark invalid source file count exit code = %d, want 2", exitCode)
	}
	if !strings.Contains(standardError.String(), "must be positive") {
		t.Errorf("benchmark invalid source file count error = %q, want validation error", standardError.String())
	}
}
