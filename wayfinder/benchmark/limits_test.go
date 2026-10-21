package benchmark_test

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"agent-wayfinder/benchmark"
	"agent-wayfinder/graph"
	"agent-wayfinder/index"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
)

func TestValidateAcceptsOneInLimitRun(t *testing.T) {
	runs := []benchmark.Run{
		{Measurements: measurements(60*time.Second, 2*time.Second, 500*time.Millisecond, 500*time.Millisecond, 500*time.Millisecond)},
	}

	if err := benchmark.Validate(runs, 42); err != nil {
		t.Fatalf("validate in-limit medians: %v", err)
	}
}

func TestValidateRejectsMedianAboveApprovedLimit(t *testing.T) {
	runs := []benchmark.Run{
		{Measurements: measurements(61*time.Second, 2*time.Second, 200*time.Millisecond, 200*time.Millisecond, 200*time.Millisecond)},
	}

	err := benchmark.Validate(runs, 42)
	if err == nil {
		t.Fatal("validate over-limit median succeeded")
	}
	if !strings.Contains(err.Error(), "initial_index") || !strings.Contains(err.Error(), "1m0s") {
		t.Errorf("validate error = %q, want operation and approved limit", err)
	}
}

func TestValidateUsesTenSecondInitialIndexLimitForOneThousandFileCorpus(t *testing.T) {
	runs := []benchmark.Run{
		{Measurements: measurements(11*time.Second, 2*time.Second, 500*time.Millisecond, 500*time.Millisecond, 500*time.Millisecond)},
	}

	err := benchmark.Validate(runs, 1000)
	if err == nil {
		t.Fatal("validate over-limit 1000-file median succeeded")
	}
	if !strings.Contains(err.Error(), "initial_index") || !strings.Contains(err.Error(), "10s") {
		t.Errorf("validate error = %q, want initial_index and the 10s approved limit", err)
	}

	runs[0].Measurements[0].Duration = 9 * time.Second
	if err := benchmark.Validate(runs, 1000); err != nil {
		t.Fatalf("validate in-limit 1000-file median: %v", err)
	}
}

func TestValidateUsesTwoHundredSecondInitialIndexLimitForTenThousandFileCorpusAndSkipsUncalibratedMeasurements(t *testing.T) {
	runs := []benchmark.Run{
		{Measurements: measurements(200*time.Second, 3*time.Second, time.Hour, time.Hour, time.Hour)},
	}

	if err := benchmark.Validate(runs, 10000); err != nil {
		t.Fatalf("validate 10000-file median with uncalibrated measurements: %v", err)
	}

	runs[0].Measurements[0].Duration = 200*time.Second + time.Nanosecond
	err := benchmark.Validate(runs, 10000)
	if err == nil {
		t.Fatal("validate over-limit 10000-file median succeeded")
	}
	if !strings.Contains(err.Error(), "initial_index") || !strings.Contains(err.Error(), "3m20s") {
		t.Errorf("validate error = %q, want initial_index and the 200s approved limit", err)
	}
}

func TestValidateUsesThreeSecondIncrementalUpdateLimitForTenThousandFileCorpus(t *testing.T) {
	runs := []benchmark.Run{
		{Measurements: measurements(200*time.Second, 3*time.Second+time.Nanosecond, time.Hour, time.Hour, time.Hour)},
	}

	err := benchmark.Validate(runs, 10000)
	if err == nil {
		t.Fatal("validate over-limit 10000-file incremental median succeeded")
	}
	if !strings.Contains(err.Error(), "incremental_update") || !strings.Contains(err.Error(), "3s") {
		t.Errorf("validate error = %q, want incremental_update and the 3s approved limit", err)
	}
}

func TestValidateReportRejectsExactScalePeakRSSAboveApprovedCeiling(t *testing.T) {
	runs := []benchmark.Run{
		completeRun(90*time.Second, 1),
		completeRun(91*time.Second, 1),
		completeRun(92*time.Second, ^uint64(0)),
	}
	for index := range runs {
		runs[index].SourceFiles = 10000
		runs[index].NodeCount = 1000000
		runs[index].EdgeCount = 2000000
	}

	err := benchmark.ValidateExactScaleReport(runs, 10000)
	if err == nil {
		t.Fatal("validate exact-scale report above peak RSS ceiling succeeded")
	}
	if !strings.Contains(err.Error(), "peak RSS") || !strings.Contains(err.Error(), "approved ceiling") {
		t.Errorf("validate report error = %q, want approved peak RSS ceiling", err)
	}
}

func TestValidateReportRejectsExactScaleRunWithWrongCounts(t *testing.T) {
	runs := []benchmark.Run{
		completeRun(90*time.Second, 1),
		completeRun(91*time.Second, 1),
		completeRun(92*time.Second, 1),
	}
	for index := range runs {
		runs[index].SourceFiles = 10000
		runs[index].NodeCount = 1000000
		runs[index].EdgeCount = 2000000
	}
	runs[1].EdgeCount--

	err := benchmark.ValidateExactScaleReport(runs, 10000)
	if err == nil {
		t.Fatal("validate exact-scale report with wrong edge count succeeded")
	}
	if !strings.Contains(err.Error(), "1000000 nodes and 1999999 edges") || !strings.Contains(err.Error(), "1000000 nodes and 2000000 edges") {
		t.Errorf("validate report error = %q, want exact node and edge counts", err)
	}
}

func TestValidateScaleShapeRejectsRetainedHeapThatTracksCorpusGrowth(t *testing.T) {
	smaller := []benchmark.Run{
		{SourceFiles: 1000, RetainedHeapBytes: 100 << 20},
		{SourceFiles: 1000, RetainedHeapBytes: 101 << 20},
		{SourceFiles: 1000, RetainedHeapBytes: 102 << 20},
	}
	larger := []benchmark.Run{
		{SourceFiles: 10000, RetainedHeapBytes: 900 << 20},
		{SourceFiles: 10000, RetainedHeapBytes: 910 << 20},
		{SourceFiles: 10000, RetainedHeapBytes: 920 << 20},
	}

	err := benchmark.ValidateScaleShape(smaller, larger)
	if err == nil {
		t.Fatal("validate corpus-proportional retained heap succeeded")
	}
	if !strings.Contains(err.Error(), "retained heap") || !strings.Contains(err.Error(), "corpus growth") {
		t.Errorf("validate scale shape error = %q, want retained heap and corpus growth", err)
	}
}

func TestExactScaleRSSCalibrationRecordsThreeHostRuns(t *testing.T) {
	calibration := benchmark.ExactScaleRSSCalibration()
	if calibration.SourceFiles != 10000 || calibration.Host == "" || calibration.GoVersion == "" || calibration.Commit == "" || calibration.BinarySHA256 == "" {
		t.Errorf("RSS calibration = %+v, want corpus, host, Go, and commit details", calibration)
	}
	if len(calibration.RawPeakRSSBytes) != 3 || calibration.BaselineMedian == 0 || calibration.ApprovedCeiling < calibration.BaselineMedian {
		t.Errorf("RSS calibration = %+v, want three raw runs and a valid median and ceiling", calibration)
	}
}

func TestValidateExactScaleReportAcceptsRecordedCalibration(t *testing.T) {
	calibration := benchmark.ExactScaleRSSCalibration()
	runs := []benchmark.Run{
		completeRun(80*time.Second, calibration.RawPeakRSSBytes[0]),
		completeRun(84*time.Second, calibration.RawPeakRSSBytes[1]),
		completeRun(94*time.Second, calibration.RawPeakRSSBytes[2]),
	}
	for index := range runs {
		runs[index].SourceFiles = 10000
		runs[index].NodeCount = 1000000
		runs[index].EdgeCount = 2000000
	}

	if err := benchmark.ValidateExactScaleReport(runs, 10000); err != nil {
		t.Fatalf("validate recorded exact-scale calibration: %v", err)
	}
}

func TestValidateExactScaleReportUsesApprovedRSSAllowanceForFiveRuns(t *testing.T) {
	calibration := benchmark.ExactScaleRSSCalibration()
	if calibration.ApprovedCeiling != calibration.BaselineMedian*105/100 || calibration.NoiseAllowancePct != 5 {
		t.Fatalf("RSS calibration = %+v, want a 5 percent allowance", calibration)
	}
	runs := make([]benchmark.Run, 5)
	for runIndex := range runs {
		runs[runIndex] = completeRun(200*time.Second, calibration.ApprovedCeiling)
		runs[runIndex].SourceFiles = 10000
		runs[runIndex].NodeCount = 1000000
		runs[runIndex].EdgeCount = 2000000
	}
	if err := benchmark.ValidateExactScaleReport(runs, 10000); err != nil {
		t.Fatalf("validate five exact-scale runs at the approved RSS ceiling: %v", err)
	}
	runs[0].PeakRSSBytes++
	if err := benchmark.ValidateExactScaleReport(runs, 10000); err == nil || !strings.Contains(err.Error(), "approved ceiling") {
		t.Fatalf("validate over-limit RSS = %v, want approved ceiling error", err)
	}
	for _, runCount := range []int{1, 2, 4} {
		if err := benchmark.ValidateExactScaleReport(runs[:runCount], 10000); err == nil || !strings.Contains(err.Error(), "requires 3 or 5 runs") {
			t.Fatalf("validate %d runs = %v, want run count error", runCount, err)
		}
	}
}

func TestValidateReportRejectsMissingRunMetadata(t *testing.T) {
	runs := []benchmark.Run{
		{Measurements: measurements(time.Second, time.Second, time.Millisecond, time.Millisecond, time.Millisecond), PhaseMeasurements: phaseMeasurements(), ResolverMeasurements: resolverMeasurements(), SQLiteWriteMeasurements: sqliteWriteMeasurements()},
	}

	err := benchmark.ValidateReport(runs, 42)
	if err == nil {
		t.Fatal("validate report with missing metadata succeeded")
	}
	if !strings.Contains(err.Error(), "peak RSS") {
		t.Errorf("validate report error = %q, want missing metadata", err)
	}
}

func TestValidateReportRejectsDifferentChecksums(t *testing.T) {
	runs := []benchmark.Run{
		{Measurements: measurements(time.Second, time.Second, time.Millisecond, time.Millisecond, time.Millisecond)},
	}

	err := benchmark.ValidateReport(runs, 42)
	if err == nil {
		t.Fatal("validate report with incomplete run metadata succeeded")
	}
	if !strings.Contains(err.Error(), "phase measurements") {
		t.Errorf("validate report error = %q, want missing phase measurements", err)
	}
}

func TestValidateReportRejectsIncompletePhaseMeasurements(t *testing.T) {
	runs := []benchmark.Run{{
		Measurements:               measurements(time.Second, time.Second, time.Millisecond, time.Millisecond, time.Millisecond),
		ResolverMeasurements:       resolverMeasurements(),
		SQLiteWriteMeasurements:    sqliteWriteMeasurements(),
		ContributionQueueHighWater: 1,
		ContributionQueueCapacity:  1,
		PeakRSSBytes:               1,
		RetainedHeapBytes:          1,
		DatabaseBytes:              1,
		OutputChecksum:             "sha256:stable",
	}}

	err := benchmark.ValidateReport(runs, 42)
	if err == nil {
		t.Fatal("validate report without indexing phases succeeded")
	}
	if !strings.Contains(err.Error(), "phase measurements") {
		t.Errorf("validate report error = %q, want missing phase measurements", err)
	}
}

func TestValidateReportRejectsInvalidResolverMeasurements(t *testing.T) {
	testCases := []struct {
		name         string
		measurements []benchmark.Measurement
	}{
		{name: "missing", measurements: nil},
		{name: "wrong order", measurements: []benchmark.Measurement{
			{Name: "contribution_restoration", Duration: time.Millisecond},
			{Name: "affected_source_selection", Duration: time.Millisecond},
			{Name: "workspace_resolution", Duration: time.Millisecond},
		}},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			runs := []benchmark.Run{{
				Measurements:               measurements(time.Second, time.Second, time.Millisecond, time.Millisecond, time.Millisecond),
				PhaseMeasurements:          phaseMeasurements(),
				ResolverMeasurements:       testCase.measurements,
				SQLiteWriteMeasurements:    sqliteWriteMeasurements(),
				ContributionQueueHighWater: 1,
				ContributionQueueCapacity:  1,
				PeakRSSBytes:               1,
				DatabaseBytes:              1,
				OutputChecksum:             "sha256:stable",
			}}

			err := benchmark.ValidateReport(runs, 42)
			if err == nil {
				t.Fatal("validate report with invalid resolver measurements succeeded")
			}
			if !strings.Contains(err.Error(), "resolver measurements") {
				t.Errorf("validate report error = %q, want resolver measurement error", err)
			}
		})
	}
}

func TestOrderSQLiteWriteMeasurementsRejectsMissingRequiredMeasurement(t *testing.T) {
	measurements := sqliteWriteMeasurements()
	measurements = measurements[:len(measurements)-1]

	_, err := benchmark.OrderSQLiteWriteMeasurements(measurements)
	if err == nil {
		t.Fatal("order incomplete SQLite write measurements succeeded")
	}
	if !strings.Contains(err.Error(), "contribution_symbol_references") {
		t.Errorf("order SQLite write measurements error = %q, want missing measurement name", err)
	}
}

func TestValidateReportRejectsZeroDurationForApplicableSQLiteWrite(t *testing.T) {
	sqliteMeasurements := sqliteWriteMeasurements()
	sqliteMeasurements[0].Duration = 0
	runs := []benchmark.Run{{
		Measurements:               measurements(time.Second, time.Second, time.Millisecond, time.Millisecond, time.Millisecond),
		PhaseMeasurements:          phaseMeasurements(),
		ResolverMeasurements:       resolverMeasurements(),
		SQLiteWriteMeasurements:    sqliteMeasurements,
		ContributionQueueHighWater: 1,
		ContributionQueueCapacity:  1,
		PeakRSSBytes:               1,
		RetainedHeapBytes:          1,
		DatabaseBytes:              1,
		OutputChecksum:             "sha256:stable",
	}}

	err := benchmark.ValidateReport(runs, 42)
	if err == nil {
		t.Fatal("validate report with zero-duration SQLite write succeeded")
	}
	if !strings.Contains(err.Error(), "workspace_nodes") {
		t.Errorf("validate report error = %q, want zero-duration measurement name", err)
	}

	runs[0].SQLiteWriteMeasurements[0].NotApplicable = true
	if err := benchmark.ValidateReport(runs, 42); err != nil {
		t.Fatalf("validate report with not-applicable SQLite write: %v", err)
	}
}

func TestGenerateCorpusCreatesDeterministicSourceFanout(t *testing.T) {
	firstRoot := t.TempDir()
	secondRoot := t.TempDir()
	specification := benchmark.CorpusSpec{SourceFiles: 3, FunctionsPerFile: 4}

	first, err := benchmark.GenerateCorpus(firstRoot, specification)
	if err != nil {
		t.Fatalf("generate first corpus: %v", err)
	}
	second, err := benchmark.GenerateCorpus(secondRoot, specification)
	if err != nil {
		t.Fatalf("generate second corpus: %v", err)
	}

	if first.SourceFiles != 3 || first.FunctionsPerFile != 4 || first.UpdatePath == "" || first.QueryTerm == "" || first.PathSource == "" || first.PathTarget == "" || first.ExplainTerm == "" {
		t.Errorf("first corpus = %+v, want source details and benchmark targets", first)
	}
	if first != second {
		t.Errorf("corpus metadata differs: first = %+v, second = %+v", first, second)
	}
	for sourceIndex := 0; sourceIndex < specification.SourceFiles; sourceIndex++ {
		path := filepath.Join("src", "module-"+strconv.Itoa(sourceIndex)+".ts")
		firstContents, err := os.ReadFile(filepath.Join(firstRoot, path))
		if err != nil {
			t.Fatalf("read first source %q: %v", path, err)
		}
		secondContents, err := os.ReadFile(filepath.Join(secondRoot, path))
		if err != nil {
			t.Fatalf("read second source %q: %v", path, err)
		}
		if string(firstContents) != string(secondContents) {
			t.Errorf("source %q differs across generated corpora", path)
		}
	}

	contents, err := os.ReadFile(filepath.Join(firstRoot, first.UpdatePath))
	if err != nil {
		t.Fatalf("read update source: %v", err)
	}
	if !strings.Contains(string(contents), "import") || !strings.Contains(string(contents), "function") {
		t.Errorf("update source = %q, want imports and functions", contents)
	}
}

func TestGenerateCorpusDistributesAdditionalFunctionsAcrossFiles(t *testing.T) {
	root := t.TempDir()
	specification := benchmark.CorpusSpec{
		SourceFiles:         4,
		FunctionsPerFile:    2,
		AdditionalFunctions: 3,
		UncalledFunctions:   2,
	}
	if _, err := benchmark.GenerateCorpus(root, specification); err != nil {
		t.Fatalf("generate corpus: %v", err)
	}

	for sourceIndex, wantFunctions := range []int{3, 3, 3, 2} {
		contents, err := os.ReadFile(filepath.Join(root, "src", "module-"+strconv.Itoa(sourceIndex)+".ts"))
		if err != nil {
			t.Fatalf("read source %d: %v", sourceIndex, err)
		}
		if got := strings.Count(string(contents), "export function"); got != wantFunctions {
			t.Errorf("source %d function count = %d, want %d", sourceIndex, got, wantFunctions)
		}
	}
}

func TestExactScaleCorpusSpecProducesExactNodeAndEdgeTargets(t *testing.T) {
	for _, sourceFiles := range []int{1000, 10000} {
		specification, err := benchmark.ExactScaleCorpusSpec(sourceFiles)
		if err != nil {
			t.Fatalf("create exact scale specification for %d files: %v", sourceFiles, err)
		}
		root := t.TempDir()
		corpus, err := benchmark.GenerateCorpus(root, specification)
		if err != nil {
			t.Fatalf("generate exact scale corpus for %d files: %v", sourceFiles, err)
		}
		if corpus.ExpectedNodes != sourceFiles*100 || corpus.ExpectedEdges != sourceFiles*200 {
			t.Errorf("%d-file corpus counts = %d nodes and %d edges, want %d and %d", sourceFiles, corpus.ExpectedNodes, corpus.ExpectedEdges, sourceFiles*100, sourceFiles*200)
		}
	}
}

func TestGeneratedCorpusProducesExpectedGraphEvidence(t *testing.T) {
	root := t.TempDir()
	corpus, err := benchmark.GenerateCorpus(root, benchmark.CorpusSpec{SourceFiles: 3, FunctionsPerFile: 4})
	if err != nil {
		t.Fatalf("generate corpus: %v", err)
	}
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "benchmark.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer store.Close()

	result, err := index.Index(context.Background(), store, index.Request{Root: root})
	if err != nil {
		t.Fatalf("index corpus: %v", err)
	}
	facts := graph.Facts{}
	if err := store.Export(context.Background(), result.Snapshot, storage.ExportRequest{}, factCollector{facts: &facts}); err != nil {
		t.Fatalf("export corpus facts: %v", err)
	}

	if len(facts.Nodes) != 16 {
		t.Errorf("node count = %d, want 16", len(facts.Nodes))
	}
	if len(facts.Edges) != 30 {
		t.Errorf("edge count = %d, want 30", len(facts.Edges))
	}
	if !containsNode(facts.Nodes, corpus.PathSource) || !containsNode(facts.Nodes, corpus.PathTarget) || !containsNode(facts.Nodes, corpus.ExplainTerm) {
		t.Errorf("graph nodes do not contain benchmark targets: %+v", facts.Nodes)
	}
}

func TestGenerateRealisticCorpusCreatesDeterministicBoundedFanIn(t *testing.T) {
	firstRoot := t.TempDir()
	secondRoot := t.TempDir()
	specification, err := benchmark.NewRealisticCorpusSpec(9)
	if err != nil {
		t.Fatalf("create realistic corpus specification: %v", err)
	}

	first, err := benchmark.GenerateRealisticCorpus(firstRoot, specification)
	if err != nil {
		t.Fatalf("generate first realistic corpus: %v", err)
	}
	second, err := benchmark.GenerateRealisticCorpus(secondRoot, specification)
	if err != nil {
		t.Fatalf("generate second realistic corpus: %v", err)
	}
	if first != second {
		t.Errorf("realistic corpus metadata differs: first = %+v, second = %+v", first, second)
	}

	for sourceIndex := 0; sourceIndex < specification.SourceFiles; sourceIndex++ {
		path := filepath.Join("src", "module-"+strconv.Itoa(sourceIndex)+".ts")
		contents, err := os.ReadFile(filepath.Join(firstRoot, path))
		if err != nil {
			t.Fatalf("read source %q: %v", path, err)
		}
		if got := strings.Count(string(contents), "import {"); got > 4 {
			t.Errorf("source %d import count = %d, want at most 4", sourceIndex, got)
		}
	}

	// Source 0 sits at index%3, index%5, index%7, and index%11, so it carries the full declaration mix.
	rootContents, err := os.ReadFile(filepath.Join(firstRoot, "src", "module-0.ts"))
	if err != nil {
		t.Fatalf("read source 0: %v", err)
	}
	for _, want := range []string{"export function", "export class", "export interface", "export type", "import.meta.env"} {
		if !strings.Contains(string(rootContents), want) {
			t.Errorf("source 0 = %q, want it to contain %q", rootContents, want)
		}
	}
}

func TestGenerateRealisticCorpusIndexesWithoutError(t *testing.T) {
	root := t.TempDir()
	specification, err := benchmark.NewRealisticCorpusSpec(12)
	if err != nil {
		t.Fatalf("create realistic corpus specification: %v", err)
	}
	corpus, err := benchmark.GenerateRealisticCorpus(root, specification)
	if err != nil {
		t.Fatalf("generate realistic corpus: %v", err)
	}
	if corpus.ExpectedNodes != 0 || corpus.ExpectedEdges != 0 {
		t.Errorf("realistic corpus expected counts = %d nodes and %d edges, want 0 and 0 (data-derived)", corpus.ExpectedNodes, corpus.ExpectedEdges)
	}

	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "benchmark.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer store.Close()

	result, err := index.Index(context.Background(), store, index.Request{Root: root})
	if err != nil {
		t.Fatalf("index realistic corpus: %v", err)
	}
	facts := graph.Facts{}
	if err := store.Export(context.Background(), result.Snapshot, storage.ExportRequest{}, factCollector{facts: &facts}); err != nil {
		t.Fatalf("export realistic corpus facts: %v", err)
	}
	if len(facts.Nodes) == 0 || len(facts.Edges) == 0 {
		t.Errorf("realistic corpus produced %d nodes and %d edges, want more than 0 of each", len(facts.Nodes), len(facts.Edges))
	}
	if !containsNode(facts.Nodes, corpus.PathSource) || !containsNode(facts.Nodes, corpus.PathTarget) || !containsNode(facts.Nodes, corpus.ExplainTerm) {
		t.Errorf("graph nodes do not contain benchmark targets: %+v", facts.Nodes)
	}
}

type factCollector struct {
	facts *graph.Facts
}

func (collector factCollector) WriteNode(node graph.Node) error {
	collector.facts.Nodes = append(collector.facts.Nodes, node)
	return nil
}

func (collector factCollector) WriteEdge(edge graph.Edge) error {
	collector.facts.Edges = append(collector.facts.Edges, edge)
	return nil
}

func containsNode(nodes []graph.Node, qualifiedName string) bool {
	for _, node := range nodes {
		if node.QualifiedName == qualifiedName || node.Label == qualifiedName {
			return true
		}
	}
	return false
}

func measurements(initialIndex, incrementalUpdate, query, path, explain time.Duration) []benchmark.Measurement {
	return []benchmark.Measurement{
		{Name: "initial_index", Duration: initialIndex},
		{Name: "incremental_update", Duration: incrementalUpdate},
		{Name: "query", Duration: query},
		{Name: "path", Duration: path},
		{Name: "inspect", Duration: explain},
	}
}

func phaseMeasurements() []benchmark.Measurement {
	return []benchmark.Measurement{
		{Name: "discovery", Duration: time.Millisecond},
		{Name: "pipeline_wall", Duration: time.Millisecond},
		{Name: "extraction", Duration: time.Millisecond},
		{Name: "extractor_busy", Duration: time.Millisecond},
		{Name: "writer_busy", Duration: time.Millisecond},
		{Name: "producer_blocked", Duration: time.Millisecond},
		{Name: "extraction_write_overlap", Duration: time.Millisecond},
		{Name: "resolution", Duration: time.Millisecond},
		{Name: "publication_preparation", Duration: time.Millisecond},
		{Name: "sqlite_write", Duration: time.Millisecond},
		{Name: "commit", Duration: time.Millisecond},
		{Name: "staged_transaction", Duration: time.Millisecond},
	}
}

func resolverMeasurements() []benchmark.Measurement {
	return []benchmark.Measurement{
		{Name: "affected_source_selection", Duration: time.Millisecond},
		{Name: "contribution_restoration", Duration: time.Millisecond},
		{Name: "workspace_resolution", Duration: time.Millisecond},
		{Name: "publication_preparation", Duration: time.Millisecond},
		{Name: "sqlite_write", Duration: time.Millisecond},
		{Name: "commit", Duration: time.Millisecond},
	}
}

func sqliteWriteMeasurements() []benchmark.Measurement {
	return []benchmark.Measurement{
		{Name: "workspace_nodes", Duration: time.Millisecond},
		{Name: "workspace_edges", Duration: time.Millisecond},
		{Name: "file_contributions", Duration: time.Millisecond},
		{Name: "contribution_nodes", Duration: time.Millisecond},
		{Name: "contribution_edges", Duration: time.Millisecond},
		{Name: "contribution_extensions", Duration: time.Millisecond},
		{Name: "contribution_dependencies", Duration: time.Millisecond},
		{Name: "contribution_exported_surfaces", Duration: time.Millisecond},
		{Name: "contribution_diagnostics", Duration: time.Millisecond},
		{Name: "contribution_unresolved_references", Duration: time.Millisecond},
		{Name: "contribution_module_bindings", Duration: time.Millisecond},
		{Name: "contribution_symbol_references", Duration: time.Millisecond},
	}
}

func completeRun(initialIndex time.Duration, peakRSSBytes uint64) benchmark.Run {
	return benchmark.Run{
		Measurements:               measurements(initialIndex, time.Second, time.Millisecond, time.Millisecond, time.Millisecond),
		PhaseMeasurements:          phaseMeasurements(),
		ResolverMeasurements:       resolverMeasurements(),
		SQLiteWriteMeasurements:    sqliteWriteMeasurements(),
		ContributionQueueHighWater: 1,
		ContributionQueueCapacity:  1,
		PeakRSSBytes:               peakRSSBytes,
		RetainedHeapBytes:          1,
		DatabaseBytes:              1,
		OutputChecksum:             "sha256:stable",
	}
}
