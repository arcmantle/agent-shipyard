package benchmark

import (
	"fmt"
	"sort"
	"time"
)

type Measurement struct {
	Name          string
	Duration      time.Duration
	NotApplicable bool
}

type Run struct {
	NodeFTSEnabled             bool
	Measurements               []Measurement
	PhaseMeasurements          []Measurement
	ResolverMeasurements       []Measurement
	SQLiteWriteMeasurements    []Measurement
	SourceFiles                int
	NodeCount                  int
	EdgeCount                  int
	ExtractionWorkers          int
	SourceQueueCapacity        int
	ContributionQueueHighWater int
	ContributionQueueCapacity  int
	ContributionBatchRows      int
	ContributionBatchBytes     int
	ContributionBatchSources   int
	ResolverPageSize           int
	WorkspaceFactBatchRows     int
	WorkspaceFactBatchBytes    int
	PeakRSSBytes               uint64
	RetainedHeapBytes          uint64
	DatabaseBytes              int64
	OutputChecksum             string
}

type rssAcceptance struct {
	baselineMedian uint64
	ceiling        uint64
}

type RSSCalibration struct {
	SourceFiles       int
	Host              string
	GoVersion         string
	Commit            string
	BinarySHA256      string
	RawPeakRSSBytes   []uint64
	BaselineMedian    uint64
	ApprovedCeiling   uint64
	NoiseAllowancePct int
}

type ScaleShape struct {
	SmallerSourceFiles        int
	LargerSourceFiles         int
	SmallerMedianRetainedHeap uint64
	LargerMedianRetainedHeap  uint64
	CorpusGrowth              int
	MaximumRetainedHeapGrowth float64
}

var exactScaleRSSCalibration = RSSCalibration{
	SourceFiles:       10000,
	Host:              "Apple M2 Pro, 32 GiB, macOS 26.5.1 (25F80)",
	GoVersion:         "go1.25.5 darwin/arm64",
	Commit:            "a14ce063e5f9822310e20c6312125841b55fdd59",
	BinarySHA256:      "282c629b8eb99b02359c7280c271619558f845821dcb4fe6b9bac14be3c3cb87",
	RawPeakRSSBytes:   []uint64{453197824, 455016448, 457883648},
	BaselineMedian:    455016448,
	ApprovedCeiling:   477767270,
	NoiseAllowancePct: 5,
}

var approvedRSSBySourceFiles = map[int]rssAcceptance{
	10000: {
		baselineMedian: exactScaleRSSCalibration.BaselineMedian,
		ceiling:        exactScaleRSSCalibration.ApprovedCeiling,
	},
}

func ExactScaleRSSCalibration() RSSCalibration {
	calibration := exactScaleRSSCalibration
	calibration.RawPeakRSSBytes = append([]uint64(nil), calibration.RawPeakRSSBytes...)
	return calibration
}

var defaultApprovedLimits = map[string]time.Duration{
	"initial_index":      60 * time.Second,
	"incremental_update": 2 * time.Second,
	"query":              500 * time.Millisecond,
	"path":               500 * time.Millisecond,
	"inspect":            500 * time.Millisecond,
}

// approvedLimitsBySourceFiles holds acceptance limits calibrated for one exact-scale
// benchmark corpus. A corpus size without an entry falls back to defaultApprovedLimits.
// A profile may omit a measurement name that has no limit calibrated at that scale yet;
// Validate then skips that measurement instead of failing the run.
var approvedLimitsBySourceFiles = map[int]map[string]time.Duration{
	1000: {
		"initial_index":      10 * time.Second,
		"incremental_update": 2 * time.Second,
		"query":              500 * time.Millisecond,
		"path":               500 * time.Millisecond,
		"inspect":            500 * time.Millisecond,
	},
	// query, path, and inspect scale with corpus size and have no calibrated limit here yet.
	10000: {
		"initial_index":      200 * time.Second,
		"incremental_update": 3 * time.Second,
	},
}

func approvedLimitsFor(sourceFiles int) map[string]time.Duration {
	if limits, ok := approvedLimitsBySourceFiles[sourceFiles]; ok {
		return limits
	}
	return defaultApprovedLimits
}

var measurementOrder = []string{
	"initial_index",
	"incremental_update",
	"query",
	"path",
	"inspect",
}

var phaseMeasurementOrder = []string{
	"discovery",
	"pipeline_wall",
	"extraction",
	"extractor_busy",
	"writer_busy",
	"producer_blocked",
	"extraction_write_overlap",
	"resolution",
	"publication_preparation",
	"sqlite_write",
	"commit",
	"staged_transaction",
}

var resolverMeasurementOrder = []string{
	"affected_source_selection",
	"contribution_restoration",
	"workspace_resolution",
	"publication_preparation",
	"sqlite_write",
	"commit",
}

var sqliteWriteMeasurementOrder = []string{
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

func Validate(runs []Run, sourceFiles int) error {
	if len(runs) == 0 {
		return fmt.Errorf("benchmark requires at least one run")
	}
	limits := approvedLimitsFor(sourceFiles)

	durations := make(map[string][]time.Duration, len(limits))
	for _, run := range runs {
		seen := make(map[string]bool, len(limits))
		for _, measurement := range run.Measurements {
			// A measurement outside this corpus size's profile has no calibrated limit; skip it.
			if _, tracked := limits[measurement.Name]; !tracked {
				continue
			}
			if seen[measurement.Name] {
				return fmt.Errorf("benchmark run contains duplicate measurement %q", measurement.Name)
			}
			seen[measurement.Name] = true
			durations[measurement.Name] = append(durations[measurement.Name], measurement.Duration)
		}
		for name := range limits {
			if !seen[name] {
				return fmt.Errorf("benchmark run is missing measurement %q", name)
			}
		}
	}

	for name, limit := range limits {
		values := durations[name]
		sort.Slice(values, func(left, right int) bool { return values[left] < values[right] })
		median := values[len(values)/2]
		if median > limit {
			return fmt.Errorf("benchmark %q median %s exceeds approved limit %s", name, median, limit)
		}
	}
	return nil
}

func ValidateReport(runs []Run, sourceFiles int) error {
	if err := Validate(runs, sourceFiles); err != nil {
		return err
	}
	checksum := ""
	for _, run := range runs {
		if err := validateMeasurementOrder(run.PhaseMeasurements, phaseMeasurementOrder); err != nil {
			return fmt.Errorf("benchmark run phase measurements: %w", err)
		}
		if err := validateMeasurementOrder(run.ResolverMeasurements, resolverMeasurementOrder); err != nil {
			return fmt.Errorf("benchmark run resolver measurements: %w", err)
		}
		if err := validateMeasurementOrder(run.SQLiteWriteMeasurements, sqliteWriteMeasurementOrder); err != nil {
			return fmt.Errorf("benchmark run SQLite write measurements: %w", err)
		}
		for _, measurement := range run.SQLiteWriteMeasurements {
			if !measurement.NotApplicable && measurement.Duration <= 0 {
				return fmt.Errorf("benchmark run SQLite write measurement %q has no measured duration", measurement.Name)
			}
		}
		if run.PeakRSSBytes == 0 || run.RetainedHeapBytes == 0 || run.DatabaseBytes <= 0 || run.OutputChecksum == "" {
			return fmt.Errorf("benchmark run is missing peak RSS, retained heap, database size, or output checksum")
		}
		if run.ContributionQueueHighWater <= 0 || run.ContributionQueueCapacity <= 0 || run.ContributionQueueHighWater > run.ContributionQueueCapacity {
			return fmt.Errorf("benchmark run has invalid contribution queue high-water %d for capacity %d", run.ContributionQueueHighWater, run.ContributionQueueCapacity)
		}
		if checksum == "" {
			checksum = run.OutputChecksum
		} else if run.OutputChecksum != checksum {
			return fmt.Errorf("benchmark runs have different output checksums")
		}
	}
	return nil
}

func ValidateExactScaleReport(runs []Run, sourceFiles int) error {
	if len(runs) != 3 && len(runs) != 5 {
		return fmt.Errorf("exact-scale benchmark requires 3 or 5 runs, got %d", len(runs))
	}
	if err := ValidateReport(runs, sourceFiles); err != nil {
		return err
	}
	peakRSSValues := make([]uint64, 0, len(runs))
	for _, run := range runs {
		if run.SourceFiles != sourceFiles || run.NodeCount != sourceFiles*100 || run.EdgeCount != sourceFiles*200 {
			return fmt.Errorf("benchmark run contains %d source files, %d nodes and %d edges, want %d source files, %d nodes and %d edges", run.SourceFiles, run.NodeCount, run.EdgeCount, sourceFiles, sourceFiles*100, sourceFiles*200)
		}
		peakRSSValues = append(peakRSSValues, run.PeakRSSBytes)
	}
	if acceptance, ok := approvedRSSBySourceFiles[sourceFiles]; ok {
		if acceptance.baselineMedian == 0 || acceptance.ceiling == 0 || len(exactScaleRSSCalibration.RawPeakRSSBytes) != 3 {
			return fmt.Errorf("exact-scale benchmark has no approved RSS calibration")
		}
		for _, peakRSS := range peakRSSValues {
			if peakRSS > acceptance.ceiling {
				return fmt.Errorf("benchmark peak RSS %d exceeds approved ceiling %d", peakRSS, acceptance.ceiling)
			}
		}
	}
	return nil
}

func ValidateScaleShape(smaller, larger []Run) error {
	_, err := MeasureScaleShape(smaller, larger)
	return err
}

func MeasureScaleShape(smaller, larger []Run) (ScaleShape, error) {
	if len(smaller) == 0 || len(larger) == 0 {
		return ScaleShape{}, fmt.Errorf("benchmark scale shape requires smaller and larger runs")
	}
	smallerSources := smaller[0].SourceFiles
	largerSources := larger[0].SourceFiles
	if smallerSources <= 0 || largerSources <= smallerSources {
		return ScaleShape{}, fmt.Errorf("benchmark scale shape requires increasing positive source counts")
	}
	for _, run := range smaller {
		if run.SourceFiles != smallerSources || run.RetainedHeapBytes == 0 {
			return ScaleShape{}, fmt.Errorf("benchmark smaller scale has inconsistent source count or retained heap")
		}
	}
	for _, run := range larger {
		if run.SourceFiles != largerSources || run.RetainedHeapBytes == 0 {
			return ScaleShape{}, fmt.Errorf("benchmark larger scale has inconsistent source count or retained heap")
		}
	}
	smallerMedian := medianUint64(smaller, func(run Run) uint64 { return run.RetainedHeapBytes })
	largerMedian := medianUint64(larger, func(run Run) uint64 { return run.RetainedHeapBytes })
	sourceGrowth := uint64(largerSources / smallerSources)
	shape := ScaleShape{
		SmallerSourceFiles:        smallerSources,
		LargerSourceFiles:         largerSources,
		SmallerMedianRetainedHeap: smallerMedian,
		LargerMedianRetainedHeap:  largerMedian,
		CorpusGrowth:              int(sourceGrowth),
		MaximumRetainedHeapGrowth: float64(sourceGrowth) / 2,
	}
	if sourceGrowth < 2 || largerMedian >= smallerMedian*sourceGrowth/2 {
		return ScaleShape{}, fmt.Errorf("benchmark retained heap median grew from %d to %d while corpus growth was %dx", smallerMedian, largerMedian, sourceGrowth)
	}
	return shape, nil
}

func medianUint64(runs []Run, selectValue func(Run) uint64) uint64 {
	values := make([]uint64, 0, len(runs))
	for _, run := range runs {
		values = append(values, selectValue(run))
	}
	sort.Slice(values, func(left, right int) bool { return values[left] < values[right] })
	return values[len(values)/2]
}

func Medians(runs []Run) []Measurement {
	return medians(runs, measurementOrder, func(run Run) []Measurement { return run.Measurements })
}

func PhaseMedians(runs []Run) []Measurement {
	return medians(runs, phaseMeasurementOrder, func(run Run) []Measurement { return run.PhaseMeasurements })
}

func ResolverMedians(runs []Run) []Measurement {
	return medians(runs, resolverMeasurementOrder, func(run Run) []Measurement { return run.ResolverMeasurements })
}

func SQLiteWriteMedians(runs []Run) []Measurement {
	return medians(runs, sqliteWriteMeasurementOrder, func(run Run) []Measurement { return run.SQLiteWriteMeasurements })
}

func OrderSQLiteWriteMeasurements(measurements []Measurement) ([]Measurement, error) {
	type aggregate struct {
		duration   time.Duration
		seen       bool
		applicable bool
	}
	aggregates := make(map[string]aggregate, len(measurements))
	for _, measurement := range measurements {
		value := aggregates[measurement.Name]
		value.seen = true
		if !measurement.NotApplicable {
			value.applicable = true
			value.duration += measurement.Duration
		}
		aggregates[measurement.Name] = value
	}
	ordered := make([]Measurement, 0, len(sqliteWriteMeasurementOrder))
	for _, name := range sqliteWriteMeasurementOrder {
		value := aggregates[name]
		if !value.seen {
			return nil, fmt.Errorf("missing required SQLite write measurement %q", name)
		}
		ordered = append(ordered, Measurement{Name: name, Duration: value.duration, NotApplicable: !value.applicable})
	}
	return ordered, nil
}

func validateMeasurementOrder(measurements []Measurement, order []string) error {
	if len(measurements) != len(order) {
		return fmt.Errorf("got %d, want %d", len(measurements), len(order))
	}
	for index, name := range order {
		if measurements[index].Name != name {
			return fmt.Errorf("measurement %d is %q, want %q", index, measurements[index].Name, name)
		}
	}
	return nil
}

func medians(runs []Run, order []string, selectMeasurements func(Run) []Measurement) []Measurement {
	durations := make(map[string][]time.Duration, len(order))
	applicable := make(map[string]bool, len(order))
	for _, run := range runs {
		for _, measurement := range selectMeasurements(run) {
			if !measurement.NotApplicable {
				applicable[measurement.Name] = true
				durations[measurement.Name] = append(durations[measurement.Name], measurement.Duration)
			}
		}
	}

	measurements := make([]Measurement, 0, len(order))
	for _, name := range order {
		values := durations[name]
		if !applicable[name] {
			measurements = append(measurements, Measurement{Name: name, NotApplicable: true})
			continue
		}
		sort.Slice(values, func(left, right int) bool { return values[left] < values[right] })
		measurements = append(measurements, Measurement{Name: name, Duration: values[len(values)/2]})
	}
	return measurements
}
