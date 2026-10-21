package benchmark

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"agent-wayfinder/benchmark"
	"agent-wayfinder/index"
)

type benchmarkMeasurement struct {
	Name          string `json:"name"`
	DurationNS    int64  `json:"durationNs"`
	NotApplicable bool   `json:"notApplicable,omitempty"`
}

type benchmarkFailure struct {
	Operation string `json:"operation"`
	Error     string `json:"error"`
}

type benchmarkRunResult struct {
	Measurements               []benchmarkMeasurement `json:"measurements"`
	PhaseMeasurements          []benchmarkMeasurement `json:"phaseMeasurements"`
	ResolverMeasurements       []benchmarkMeasurement `json:"resolverMeasurements"`
	SQLiteWriteMeasurements    []benchmarkMeasurement `json:"sqliteWriteMeasurements"`
	SourceFiles                int                    `json:"sourceFiles"`
	NodeCount                  int                    `json:"nodeCount"`
	EdgeCount                  int                    `json:"edgeCount"`
	ContributionQueueHighWater int                    `json:"contributionQueueHighWater"`
	ContributionQueueCapacity  int                    `json:"contributionQueueCapacity"`
	PeakRSSBytes               uint64                 `json:"peakRssBytes"`
	RetainedHeapBytes          uint64                 `json:"retainedHeapBytes"`
	DatabaseBytes              int64                  `json:"databaseBytes"`
	OutputChecksum             string                 `json:"outputChecksum,omitempty"`
	Failure                    *benchmarkFailure      `json:"failure,omitempty"`
	UnavailableMeasurements    []string               `json:"unavailableMeasurements,omitempty"`
	UnavailableResources       []string               `json:"unavailableResources,omitempty"`
	DatabasePath               string                 `json:"databasePath,omitempty"`
}

type benchmarkResult struct {
	Configuration              benchmarkConfiguration    `json:"configuration"`
	RSSCalibration             *benchmark.RSSCalibration `json:"rssCalibration,omitempty"`
	ScaleShape                 *benchmark.ScaleShape     `json:"scaleShape,omitempty"`
	Measurements               []benchmarkMeasurement    `json:"measurements"`
	PhaseMeasurements          []benchmarkMeasurement    `json:"phaseMeasurements"`
	ResolverMeasurements       []benchmarkMeasurement    `json:"resolverMeasurements"`
	SQLiteWriteMeasurements    []benchmarkMeasurement    `json:"sqliteWriteMeasurements"`
	ContributionQueueHighWater int                       `json:"contributionQueueHighWater"`
	ContributionQueueCapacity  int                       `json:"contributionQueueCapacity"`
	Runs                       []benchmarkRunResult      `json:"runs"`
	PeakRSSBytes               uint64                    `json:"peakRssBytes"`
	RetainedHeapBytes          uint64                    `json:"retainedHeapBytes"`
	DatabaseBytes              int64                     `json:"databaseBytes"`
	OutputChecksum             string                    `json:"outputChecksum,omitempty"`
	Failure                    *benchmarkFailure         `json:"failure,omitempty"`
	UnavailableMeasurements    []string                  `json:"unavailableMeasurements,omitempty"`
	UnavailableResources       []string                  `json:"unavailableResources,omitempty"`
	DatabasePath               string                    `json:"databasePath,omitempty"`
}

type benchmarkConfiguration struct {
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
}

func (result benchmarkRunResult) MarshalJSON() ([]byte, error) {
	type plain benchmarkRunResult
	return marshalBenchmarkResult(plain(result), result.UnavailableResources)
}

func (result benchmarkResult) MarshalJSON() ([]byte, error) {
	type plain benchmarkResult
	return marshalBenchmarkResult(plain(result), result.UnavailableResources)
}

func marshalBenchmarkResult(result any, unavailable []string) ([]byte, error) {
	encoded, err := json.Marshal(result)
	if err != nil || len(unavailable) == 0 {
		return encoded, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return nil, err
	}
	for _, field := range unavailable {
		delete(fields, field)
	}
	return json.Marshal(fields)
}

const benchmarkProgressInterval = 5 * time.Second

type benchmarkProgressReporter struct {
	writer     io.Writer
	runNumber  int
	totalRuns  int
	startedAt  time.Time
	completed  int
	phase      string
	stopTicker chan struct{}
	done       chan struct{}
}

type benchmarkSetupReporter struct {
	writer           io.Writer
	startedAt        time.Time
	phase            string
	completedSources int
	totalSources     int
	lastReported     int
	lastWrittenFacts int
	mutex            sync.Mutex
	stopTicker       chan struct{}
	done             chan struct{}
}

func newBenchmarkSetupReporter(writer io.Writer) *benchmarkSetupReporter {
	return &benchmarkSetupReporter{writer: writer, startedAt: time.Now(), stopTicker: make(chan struct{}), done: make(chan struct{})}
}

func (reporter *benchmarkSetupReporter) start(phase string, totalSources int) {
	reporter.mutex.Lock()
	reporter.phase = phase
	reporter.totalSources = totalSources
	reporter.mutex.Unlock()
	fmt.Fprintf(reporter.writer, "Benchmark setup: %s 0/%d sources\n", phase, totalSources)
	go func() {
		ticker := time.NewTicker(benchmarkProgressInterval)
		defer ticker.Stop()
		defer close(reporter.done)
		for {
			select {
			case <-ticker.C:
				reporter.reportHeartbeat()
			case <-reporter.stopTicker:
				return
			}
		}
	}()
}

func (reporter *benchmarkSetupReporter) update(progress index.Progress) {
	reporter.mutex.Lock()
	reporter.phase = "validation " + string(progress.Phase)
	reporter.completedSources = progress.CompletedSources
	reporter.totalSources = progress.TotalSources
	writtenFacts := progress.WrittenNodes + progress.WrittenEdges
	shouldReport := progress.Phase != index.ExtractPhase || progress.CompletedSources == progress.TotalSources || progress.CompletedSources-reporter.lastReported >= 1000
	if shouldReport && progress.Phase == index.ExtractPhase {
		reporter.lastReported = progress.CompletedSources
	}
	if progress.Phase == index.PublishPhase {
		shouldReport = writtenFacts == progress.TotalNodes+progress.TotalEdges || writtenFacts-reporter.lastWrittenFacts >= 100000
		if shouldReport {
			reporter.lastWrittenFacts = writtenFacts
		}
	}
	phase := reporter.phase
	completed := reporter.completedSources
	total := reporter.totalSources
	writtenNodes := progress.WrittenNodes
	totalNodes := progress.TotalNodes
	writtenEdges := progress.WrittenEdges
	totalEdges := progress.TotalEdges
	reporter.mutex.Unlock()
	if shouldReport {
		if progress.Phase == index.PublishPhase {
			fmt.Fprintf(reporter.writer, "Benchmark setup: %s %d/%d sources, %d/%d node records, %d/%d edge records\n", phase, completed, total, writtenNodes, totalNodes, writtenEdges, totalEdges)
		} else {
			fmt.Fprintf(reporter.writer, "Benchmark setup: %s %d/%d sources\n", phase, completed, total)
		}
	}
}

func (reporter *benchmarkSetupReporter) reportHeartbeat() {
	reporter.mutex.Lock()
	phase := reporter.phase
	completed := reporter.completedSources
	total := reporter.totalSources
	reporter.mutex.Unlock()
	fmt.Fprintf(reporter.writer, "Benchmark setup: %s %d/%d sources (%s elapsed)\n", phase, completed, total, time.Since(reporter.startedAt).Round(time.Second))
}

func (reporter *benchmarkSetupReporter) finish() {
	close(reporter.stopTicker)
	<-reporter.done
}

func newBenchmarkProgressReporter(writer io.Writer, runNumber, totalRuns, completed int) *benchmarkProgressReporter {
	return &benchmarkProgressReporter{
		writer:    writer,
		runNumber: runNumber,
		totalRuns: totalRuns,
		startedAt: time.Now(),
		completed: completed,
	}
}

func (reporter *benchmarkProgressReporter) start(phase string) {
	reporter.phase = phase
	fmt.Fprintf(reporter.writer, "Benchmark run %d/%d: %s\n", reporter.runNumber, reporter.totalRuns, phase)
	reporter.stopTicker = make(chan struct{})
	reporter.done = make(chan struct{})
	go func() {
		ticker := time.NewTicker(benchmarkProgressInterval)
		defer ticker.Stop()
		defer close(reporter.done)
		for {
			select {
			case <-ticker.C:
				reporter.reportHeartbeat()
			case <-reporter.stopTicker:
				return
			}
		}
	}()
}

func (reporter *benchmarkProgressReporter) finishPhase() {
	if reporter.stopTicker == nil {
		return
	}
	close(reporter.stopTicker)
	<-reporter.done
	reporter.stopTicker = nil
}

func (reporter *benchmarkProgressReporter) complete() {
	reporter.finishPhase()
	fmt.Fprintf(reporter.writer, "Benchmark run %d/%d: complete (%s elapsed)\n", reporter.runNumber, reporter.totalRuns, time.Since(reporter.startedAt).Round(time.Second))
}

func (reporter *benchmarkProgressReporter) reportHeartbeat() {
	elapsed := time.Since(reporter.startedAt).Round(time.Second)
	message := fmt.Sprintf("Benchmark run %d/%d: %s (%s elapsed", reporter.runNumber, reporter.totalRuns, reporter.phase, elapsed)
	if reporter.completed > 0 {
		estimatedTotal := time.Duration(reporter.completed+1) * elapsed / time.Duration(reporter.completed)
		remaining := estimatedTotal - elapsed
		message += fmt.Sprintf(", about %s remaining", max(remaining, 0).Round(time.Second))
	}
	fmt.Fprintln(reporter.writer, message+")")
}

func renderBenchmarkText(result benchmarkResult) string {
	lines := make([]string, 0, len(result.Measurements)+len(result.PhaseMeasurements)+len(result.ResolverMeasurements))
	lines = append(lines, fmt.Sprintf("node FTS enabled: %t", result.Configuration.NodeFTSEnabled))
	if result.Failure != nil {
		lines = append(lines, "failed operation: "+result.Failure.Operation, "failure: "+result.Failure.Error, "database path: "+result.DatabasePath)
	}
	for _, measurement := range result.Measurements {
		lines = append(lines, fmt.Sprintf("%s: %d ns", measurement.Name, measurement.DurationNS))
	}
	for _, measurement := range result.PhaseMeasurements {
		lines = append(lines, fmt.Sprintf("%s: %d ns", measurement.Name, measurement.DurationNS))
	}
	for _, measurement := range result.ResolverMeasurements {
		lines = append(lines, fmt.Sprintf("%s: %d ns", measurement.Name, measurement.DurationNS))
	}
	for _, measurement := range result.SQLiteWriteMeasurements {
		if measurement.NotApplicable {
			lines = append(lines, measurement.Name+": not applicable")
		} else {
			lines = append(lines, fmt.Sprintf("%s: %d ns", measurement.Name, measurement.DurationNS))
		}
	}
	lines = append(lines, fmt.Sprintf("contribution queue high-water: %d/%d", result.ContributionQueueHighWater, result.ContributionQueueCapacity))
	unavailable := make(map[string]bool, len(result.UnavailableResources))
	for _, name := range result.UnavailableMeasurements {
		lines = append(lines, name+": unavailable")
	}
	for _, name := range result.UnavailableResources {
		unavailable[name] = true
		lines = append(lines, name+": unavailable")
	}
	if !unavailable["peakRssBytes"] {
		lines = append(lines, fmt.Sprintf("peak RSS: %d bytes", result.PeakRSSBytes))
	}
	if !unavailable["retainedHeapBytes"] {
		lines = append(lines, fmt.Sprintf("retained heap: %d bytes", result.RetainedHeapBytes))
	}
	if !unavailable["databaseBytes"] {
		lines = append(lines, fmt.Sprintf("database: %d bytes", result.DatabaseBytes))
	}
	if !unavailable["outputChecksum"] {
		lines = append(lines, "output checksum: "+result.OutputChecksum)
	}
	return strings.Join(lines, "\n")
}

func benchmarkRunFromResult(result benchmarkRunResult, configuration benchmarkConfiguration) benchmark.Run {
	return benchmark.Run{
		NodeFTSEnabled:             configuration.NodeFTSEnabled,
		Measurements:               measurementsFromResults(result.Measurements),
		PhaseMeasurements:          measurementsFromResults(result.PhaseMeasurements),
		ResolverMeasurements:       measurementsFromResults(result.ResolverMeasurements),
		SQLiteWriteMeasurements:    measurementsFromResults(result.SQLiteWriteMeasurements),
		SourceFiles:                result.SourceFiles,
		NodeCount:                  result.NodeCount,
		EdgeCount:                  result.EdgeCount,
		ExtractionWorkers:          configuration.ExtractionWorkers,
		SourceQueueCapacity:        configuration.SourceQueueCapacity,
		ContributionQueueHighWater: result.ContributionQueueHighWater,
		ContributionQueueCapacity:  result.ContributionQueueCapacity,
		ContributionBatchRows:      configuration.ContributionBatchRows,
		ContributionBatchBytes:     configuration.ContributionBatchBytes,
		ContributionBatchSources:   configuration.ContributionBatchSources,
		ResolverPageSize:           configuration.ResolverPageSize,
		WorkspaceFactBatchRows:     configuration.WorkspaceFactBatchRows,
		WorkspaceFactBatchBytes:    configuration.WorkspaceFactBatchBytes,
		PeakRSSBytes:               result.PeakRSSBytes,
		RetainedHeapBytes:          result.RetainedHeapBytes,
		DatabaseBytes:              result.DatabaseBytes,
		OutputChecksum:             result.OutputChecksum,
	}
}

func measurementsFromResults(results []benchmarkMeasurement) []benchmark.Measurement {
	measurements := make([]benchmark.Measurement, 0, len(results))
	for _, result := range results {
		measurements = append(measurements, benchmark.Measurement{Name: result.Name, Duration: time.Duration(result.DurationNS), NotApplicable: result.NotApplicable})
	}
	return measurements
}

func benchmarkConfigurationFromRuns(runs []benchmark.Run) benchmarkConfiguration {
	if len(runs) == 0 {
		return benchmarkConfiguration{}
	}
	run := runs[0]
	return benchmarkConfiguration{
		NodeFTSEnabled:            run.NodeFTSEnabled,
		ExtractionWorkers:         run.ExtractionWorkers,
		SourceQueueCapacity:       run.SourceQueueCapacity,
		ContributionQueueCapacity: run.ContributionQueueCapacity,
		ContributionBatchRows:     run.ContributionBatchRows,
		ContributionBatchBytes:    run.ContributionBatchBytes,
		ContributionBatchSources:  run.ContributionBatchSources,
		ResolverPageSize:          run.ResolverPageSize,
		WorkspaceFactBatchRows:    run.WorkspaceFactBatchRows,
		WorkspaceFactBatchBytes:   run.WorkspaceFactBatchBytes,
	}
}

func benchmarkRunResults(runs []benchmark.Run) []benchmarkRunResult {
	results := make([]benchmarkRunResult, 0, len(runs))
	for _, run := range runs {
		measurements := make([]benchmarkMeasurement, 0, len(run.Measurements))
		for _, measurement := range run.Measurements {
			measurements = append(measurements, benchmarkMeasurement{Name: measurement.Name, DurationNS: measurement.Duration.Nanoseconds()})
		}
		results = append(results, benchmarkRunResult{
			Measurements:               measurements,
			PhaseMeasurements:          benchmarkMeasurements(run.PhaseMeasurements),
			ResolverMeasurements:       benchmarkMeasurements(run.ResolverMeasurements),
			SQLiteWriteMeasurements:    benchmarkMeasurements(run.SQLiteWriteMeasurements),
			SourceFiles:                run.SourceFiles,
			NodeCount:                  run.NodeCount,
			EdgeCount:                  run.EdgeCount,
			ContributionQueueHighWater: run.ContributionQueueHighWater,
			ContributionQueueCapacity:  run.ContributionQueueCapacity,
			PeakRSSBytes:               run.PeakRSSBytes,
			RetainedHeapBytes:          run.RetainedHeapBytes,
			DatabaseBytes:              run.DatabaseBytes,
			OutputChecksum:             run.OutputChecksum,
		})
	}
	return results
}

func benchmarkMeasurements(measurements []benchmark.Measurement) []benchmarkMeasurement {
	result := make([]benchmarkMeasurement, 0, len(measurements))
	for _, measurement := range measurements {
		result = append(result, benchmarkMeasurement{Name: measurement.Name, DurationNS: measurement.Duration.Nanoseconds(), NotApplicable: measurement.NotApplicable})
	}
	return result
}

func maxPeakRSS(runs []benchmark.Run) uint64 {
	var maximum uint64
	for _, run := range runs {
		maximum = max(maximum, run.PeakRSSBytes)
	}
	return maximum
}

func maxRetainedHeap(runs []benchmark.Run) uint64 {
	var maximum uint64
	for _, run := range runs {
		maximum = max(maximum, run.RetainedHeapBytes)
	}
	return maximum
}

func maxDatabaseBytes(runs []benchmark.Run) int64 {
	var maximum int64
	for _, run := range runs {
		maximum = max(maximum, run.DatabaseBytes)
	}
	return maximum
}

func maxContributionQueueHighWater(runs []benchmark.Run) int {
	maximum := 0
	for _, run := range runs {
		maximum = max(maximum, run.ContributionQueueHighWater)
	}
	return maximum
}

func maxContributionQueueCapacity(runs []benchmark.Run) int {
	maximum := 0
	for _, run := range runs {
		maximum = max(maximum, run.ContributionQueueCapacity)
	}
	return maximum
}
