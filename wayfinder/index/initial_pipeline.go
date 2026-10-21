package index

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"agent-wayfinder/extractor"
	"agent-wayfinder/extractors/registry"
	"agent-wayfinder/graph"
	"agent-wayfinder/storage"
	"agent-wayfinder/workspace"
)

type contributionExtractor func(string, workspace.Source, registry.Registry, *extractionWorkers) (extractedSource, error)
type contributionWorkerFactory func() (*extractionWorkers, error)

type contributionExtractionResult struct {
	index                int
	source               extractedSource
	err                  error
	workerInitialization bool
}

type contributionExtractionJob struct {
	index  int
	source workspace.Source
}

type initialSourceStream func(context.Context, func(workspace.Source) error) (int, error)

type contributionExtractionRun struct {
	ctx                 context.Context
	cancel              context.CancelFunc
	jobs                chan contributionExtractionJob
	results             chan contributionExtractionResult
	workers             sync.WaitGroup
	metricsMu           sync.Mutex
	extractorBusy       time.Duration
	producerBlocked     time.Duration
	queueHighWater      int
	producersFinishedAt time.Time
	sourceCount         int
	producerError       error
}

type contributionExtractionSummary struct {
	completedSources int
	totalSources     int
	totalNodes       int
	totalEdges       int
	projectNodes     map[string]struct{}
}

type pipelineInterval struct {
	started time.Time
	ended   time.Time
}

type initialPipelineMetrics struct {
	discovery         time.Duration
	pipelineWall      time.Duration
	extraction        time.Duration
	extractorBusy     time.Duration
	writerBusy        time.Duration
	producerBlocked   time.Duration
	overlap           time.Duration
	resolution        time.Duration
	preparation       time.Duration
	sqliteWrite       time.Duration
	commit            time.Duration
	stagedTransaction time.Duration
	writeIntervals    []pipelineInterval
	queueHighWater    int
	queueCapacity     int
	workerCount       int
}

type InitialIndexPipeline struct {
	store      storage.ContributionSessionStore
	request    Request
	root       string
	sources    []workspace.Source
	stream     initialSourceStream
	groups     map[string]struct{}
	allowEmpty bool
	registered registry.Registry
	metrics    initialPipelineMetrics
}

func newInitialIndexPipeline(store storage.ContributionSessionStore, request Request, root string, registered registry.Registry, allowEmpty bool) *InitialIndexPipeline {
	return &InitialIndexPipeline{
		store:   store,
		request: request,
		root:    root,
		stream: func(ctx context.Context, emit func(workspace.Source) error) (int, error) {
			_, sourceCount, err := workspace.DiscoverStream(ctx, root, workspace.DiscoverOptions{ConfiguredRoots: request.ConfiguredRoots}, emit)
			return sourceCount, err
		},
		groups:     make(map[string]struct{}),
		allowEmpty: allowEmpty,
		registered: registered,
		metrics: initialPipelineMetrics{
			queueCapacity: initialContributionQueueCapacity,
		},
	}
}

func (pipeline *InitialIndexPipeline) extractAndWriteContributions(ctx context.Context, session storage.ContributionSession, extractSource contributionExtractor, newWorker contributionWorkerFactory, progress func(int)) (contributionExtractionSummary, time.Duration, time.Duration, error) {
	if extractSource == nil {
		extractSource = extractDiscoveredSource
	}
	if newWorker == nil {
		newWorker = newExtractionWorkers
	}
	started := time.Now()
	run := pipeline.startExtraction(ctx, session, extractSource, newWorker)
	defer run.cancel()
	summary, writeDuration, err := pipeline.consumeContributions(ctx, session, run, progress)
	if err != nil {
		return contributionExtractionSummary{}, 0, 0, err
	}
	pipeline.metrics.extraction = run.producersFinishedAt.Sub(started)
	summary.totalSources = run.sourceCount
	run.metricsMu.Lock()
	pipeline.metrics.extractorBusy = run.extractorBusy
	pipeline.metrics.producerBlocked = run.producerBlocked
	pipeline.metrics.queueHighWater = run.queueHighWater
	run.metricsMu.Unlock()
	for _, interval := range pipeline.metrics.writeIntervals {
		overlapStarted := maxTime(started, interval.started)
		overlapEnded := minTime(run.producersFinishedAt, interval.ended)
		if overlapEnded.After(overlapStarted) {
			pipeline.metrics.overlap += overlapEnded.Sub(overlapStarted)
		}
	}
	return summary, writeDuration, pipeline.metrics.overlap, nil
}

func (pipeline *InitialIndexPipeline) startExtraction(ctx context.Context, session storage.ContributionSession, extractSource contributionExtractor, newWorker contributionWorkerFactory) *contributionExtractionRun {
	pipelineContext, cancel := context.WithCancel(ctx)
	run := &contributionExtractionRun{
		ctx:     pipelineContext,
		cancel:  cancel,
		jobs:    make(chan contributionExtractionJob, initialContributionQueueCapacity),
		results: make(chan contributionExtractionResult, initialContributionQueueCapacity),
	}
	workerCount := max(1, runtime.GOMAXPROCS(0))
	pipeline.metrics.workerCount = workerCount
	run.workers.Add(workerCount)
	for range workerCount {
		go pipeline.runExtractionWorker(run, extractSource, newWorker)
	}
	go pipeline.produceSources(run, session)
	go pipeline.closeExtractionResults(run)
	return run
}

func (pipeline *InitialIndexPipeline) runExtractionWorker(run *contributionExtractionRun, extractSource contributionExtractor, newWorker contributionWorkerFactory) {
	defer run.workers.Done()
	workers, err := newWorker()
	if err != nil {
		run.cancel()
		run.results <- contributionExtractionResult{
			err:                  fmt.Errorf("create extraction workers: %w", err),
			workerInitialization: true,
		}
		return
	}
	defer workers.Close()
	workers.retainCatalogUnits = pipeline.request.RetainCatalogUnits
	for job := range run.jobs {
		extractionStarted := time.Now()
		extracted, err := extractSource(pipeline.root, job.source, pipeline.registered, workers)
		run.metricsMu.Lock()
		run.extractorBusy += time.Since(extractionStarted)
		run.metricsMu.Unlock()
		if err != nil {
			run.cancel()
		}
		run.metricsMu.Lock()
		queueDepth := min(cap(run.results), len(run.results)+1)
		if queueDepth > run.queueHighWater {
			run.queueHighWater = queueDepth
		}
		run.metricsMu.Unlock()
		blockedStarted := time.Now()
		run.results <- contributionExtractionResult{index: job.index, source: extracted, err: err}
		run.metricsMu.Lock()
		run.producerBlocked += time.Since(blockedStarted)
		run.metricsMu.Unlock()
		if err != nil {
			return
		}
	}
}

func (pipeline *InitialIndexPipeline) produceSources(run *contributionExtractionRun, session storage.ContributionSession) {
	defer close(run.jobs)
	discoveryStarted := time.Now()
	if pipeline.groups == nil {
		pipeline.groups = make(map[string]struct{})
	}
	stream := pipeline.stream
	if stream == nil {
		stream = func(ctx context.Context, emit func(workspace.Source) error) (int, error) {
			for _, source := range pipeline.sources {
				if err := emit(source); err != nil {
					return 0, err
				}
			}
			return len(pipeline.sources), nil
		}
	}
	sourceIndex := 0
	sourceCount, err := stream(run.ctx, func(source workspace.Source) error {
		if err := session.StageSource(run.ctx, source.Path); err != nil {
			return fmt.Errorf("stage source %q: %w", source.Path, err)
		}
		if language, found := pipeline.registered.ForPath(source.Path); found {
			pipeline.groups[source.ProjectID+"\x00"+language.Metadata().Name] = struct{}{}
		}
		job := contributionExtractionJob{index: sourceIndex, source: source}
		sourceIndex++
		select {
		case run.jobs <- job:
			return nil
		case <-run.ctx.Done():
			return run.ctx.Err()
		}
	})
	pipeline.metrics.discovery = time.Since(discoveryStarted)
	run.sourceCount = sourceCount
	if err != nil {
		run.producerError = err
		run.cancel()
	}
}

func (pipeline *InitialIndexPipeline) closeExtractionResults(run *contributionExtractionRun) {
	run.workers.Wait()
	run.producersFinishedAt = time.Now()
	close(run.results)
}

func (pipeline *InitialIndexPipeline) consumeContributions(ctx context.Context, session storage.ContributionSession, run *contributionExtractionRun, progress func(int)) (contributionExtractionSummary, time.Duration, error) {
	summary := contributionExtractionSummary{projectNodes: make(map[string]struct{})}
	var writeDuration time.Duration
	var workerInitializationError error
	var extractionError *contributionExtractionResult
	var writeError error
	failed := false
	for result := range run.results {
		if result.err != nil {
			if result.workerInitialization {
				if workerInitializationError == nil {
					workerInitializationError = result.err
				}
			} else if extractionError == nil || result.index < extractionError.index {
				failedResult := result
				extractionError = &failedResult
			}
			if !failed {
				failed = true
				run.cancel()
			}
			continue
		}
		if failed {
			continue
		}
		writeStarted := time.Now()
		if err := session.WriteContribution(ctx, result.source.contribution); err != nil {
			writeError = fmt.Errorf("write contribution: %w", err)
			failed = true
			run.cancel()
			continue
		}
		writeEnded := time.Now()
		writeDuration += writeEnded.Sub(writeStarted)
		pipeline.metrics.writeIntervals = append(pipeline.metrics.writeIntervals, pipelineInterval{started: writeStarted, ended: writeEnded})
		summary.completedSources++
		facts := result.source.contribution.Facts()
		for _, node := range facts.Nodes {
			if node.Kind != "project" {
				summary.totalNodes++
				continue
			}
			if _, exists := summary.projectNodes[node.ID]; !exists {
				summary.projectNodes[node.ID] = struct{}{}
				summary.totalNodes++
			}
		}
		summary.totalEdges += len(facts.Edges)
		if progress != nil {
			progress(summary.completedSources)
		}
	}
	if err := ctx.Err(); err != nil {
		return contributionExtractionSummary{}, 0, err
	}
	if run.producerError != nil && !errors.Is(run.producerError, context.Canceled) {
		return contributionExtractionSummary{}, 0, run.producerError
	}
	if workerInitializationError != nil {
		return contributionExtractionSummary{}, 0, workerInitializationError
	}
	if extractionError != nil {
		return contributionExtractionSummary{}, 0, extractionError.err
	}
	if writeError != nil {
		return contributionExtractionSummary{}, 0, writeError
	}
	return summary, writeDuration, nil
}

func (pipeline *InitialIndexPipeline) Run(ctx context.Context) (Result, error) {
	pipelineStarted := time.Now()
	preparationStarted := time.Now()
	session, err := pipeline.store.BeginContributionSession(ctx, pipeline.root)
	if err != nil {
		return Result{}, fmt.Errorf("index workspace: begin contribution session: %w", err)
	}
	defer session.Rollback(context.Background())
	pipeline.metrics.preparation = time.Since(preparationStarted)
	reportProgress(pipeline.request.Progress, Progress{Phase: ExtractPhase})
	summary, writeDuration, _, err := pipeline.extractAndWriteContributions(ctx, session, nil, nil, func(completed int) {
		reportProgress(pipeline.request.Progress, Progress{Phase: ExtractPhase, CompletedSources: completed})
	})
	if err != nil {
		return Result{}, fmt.Errorf("index workspace: %w", err)
	}
	if summary.totalSources == 0 && !pipeline.allowEmpty {
		return Result{}, fmt.Errorf("index workspace: no supported source files discovered")
	}
	reportProgress(pipeline.request.Progress, Progress{Phase: ExtractPhase, CompletedSources: summary.completedSources, TotalSources: summary.totalSources})
	sealStarted := time.Now()
	if err := session.SealContributions(ctx); err != nil {
		return Result{}, fmt.Errorf("index workspace: seal contributions: %w", err)
	}
	writeDuration += time.Since(sealStarted)

	workspaceFacts, diagnostics, dependencyWriteDuration, err := pipeline.resolve(ctx, session, summary.completedSources)
	if err != nil {
		return Result{}, err
	}
	writeDuration += dependencyWriteDuration
	pipeline.metrics.writerBusy = writeDuration
	workspaceFacts.Nodes += summary.totalNodes
	workspaceFacts.Edges += summary.totalEdges

	result, err := pipeline.commit(ctx, session, summary, workspaceFacts, diagnostics)
	if err != nil {
		return Result{}, err
	}
	pipeline.metrics.pipelineWall = time.Since(pipelineStarted)
	pipeline.reportMetrics()
	return result, nil
}

func (pipeline *InitialIndexPipeline) resolve(ctx context.Context, session storage.ContributionSession, completedSources int) (storage.FactCounts, []extractor.Diagnostic, time.Duration, error) {
	reportProgress(pipeline.request.Progress, Progress{Phase: ResolvePhase, CompletedSources: completedSources, TotalSources: completedSources})
	resolutionStarted := time.Now()
	diagnostics, dependencyWriteDuration, err := pipeline.resolveProjectionPages(ctx, session)
	if err != nil {
		return storage.FactCounts{}, nil, 0, fmt.Errorf("index workspace: resolve facts: %w", err)
	}
	counts, err := session.SealWorkspaceFacts(ctx)
	if err != nil {
		return storage.FactCounts{}, nil, 0, fmt.Errorf("index workspace: seal workspace facts: %w", err)
	}
	pipeline.metrics.resolution = time.Since(resolutionStarted)
	return counts, diagnostics, dependencyWriteDuration, nil
}

type contributionSessionResolverIndex struct {
	session  storage.ContributionSession
	snapshot storage.Snapshot
}

func (index contributionSessionResolverIndex) ResolverTarget(ctx context.Context, request extractor.ResolverTargetRequest) (extractor.ResolverTarget, bool, error) {
	return index.session.ResolverTarget(ctx, index.snapshot, request)
}

func (index contributionSessionResolverIndex) ResolverPackagePage(ctx context.Context, request extractor.ResolverPackagePageRequest) ([]extractor.ResolverTarget, error) {
	return index.session.ResolverPackagePage(ctx, index.snapshot, request)
}

func (pipeline *InitialIndexPipeline) resolveProjectionPages(ctx context.Context, session storage.ContributionSession) ([]extractor.Diagnostic, time.Duration, error) {
	keys := make([]string, 0, len(pipeline.groups))
	for key := range pipeline.groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	snapshot := storage.Snapshot{Workspace: pipeline.root}
	index := contributionSessionResolverIndex{session: session, snapshot: snapshot}
	diagnostics := make([]extractor.Diagnostic, 0)
	var dependencyWriteDuration time.Duration
	for _, key := range keys {
		projectID, language, _ := strings.Cut(key, "\x00")
		after := ""
		for {
			projections, err := session.ResolverProjectionPage(ctx, snapshot, storage.ResolverProjectionPageRequest{
				ProjectID:       projectID,
				Language:        language,
				AfterSourcePath: after,
				Limit:           resolverProjectionPageSize,
			})
			if err != nil {
				return nil, 0, fmt.Errorf("read %s resolver projection page: %w", language, err)
			}
			if len(projections) == 0 {
				break
			}
			after = projections[len(projections)-1].SourcePath
			contributions := make([]extractor.Contribution, 0, len(projections))
			for _, projection := range projections {
				contribution, err := projectionContribution(projection)
				if err != nil {
					return nil, 0, err
				}
				contributions = append(contributions, contribution)
				diagnostics = append(diagnostics, projection.Diagnostics...)
			}

			pageFacts, pageDiagnostics, err := resolveInitialProjectionPage(ctx, pipeline.root, projectID, language, contributions, index)
			if err != nil {
				return nil, 0, err
			}
			updated, err := withResolvedDependencies(contributions, pageFacts)
			if err != nil {
				return nil, 0, fmt.Errorf("record resolved dependencies: %w", err)
			}
			dependenciesStarted := time.Now()
			if err := session.ReplaceContributionDependencies(ctx, updated); err != nil {
				return nil, 0, fmt.Errorf("replace contribution dependencies: %w", err)
			}
			dependencyWriteDuration += time.Since(dependenciesStarted)
			pageFacts.Nodes = nil
			if err := session.WriteWorkspaceFacts(ctx, pageFacts); err != nil {
				return nil, 0, fmt.Errorf("write workspace fact page: %w", err)
			}
			diagnostics = append(diagnostics, pageDiagnostics...)
		}
	}
	return diagnostics, dependencyWriteDuration, nil
}

func resolveInitialProjectionPage(ctx context.Context, root, projectID, language string, contributions []extractor.Contribution, index extractor.ResolverIndex) (graph.Facts, []extractor.Diagnostic, error) {
	definition, found := indexLanguages[language]
	if !found || definition.resolveProjectionPage == nil {
		return graph.Facts{}, nil, fmt.Errorf("unsupported resolver %q", language)
	}
	return definition.resolveProjectionPage(ctx, root, projectID, contributions, index)
}

func (pipeline *InitialIndexPipeline) commit(ctx context.Context, session storage.ContributionSession, summary contributionExtractionSummary, workspaceFacts storage.FactCounts, diagnostics []extractor.Diagnostic) (Result, error) {
	totalNodes := workspaceFacts.Nodes
	totalEdges := workspaceFacts.Edges
	reportProgress(pipeline.request.Progress, Progress{
		Phase:            PublishPhase,
		CompletedSources: summary.completedSources,
		TotalSources:     summary.completedSources,
		TotalNodes:       totalNodes,
		TotalEdges:       totalEdges,
	})
	snapshot, err := session.Commit(ctx, storage.CommitRequest{
		Measurement: func(measurement storage.PublishMeasurement) {
			switch measurement.Name {
			case storage.CommitMeasurement:
				pipeline.metrics.commit += measurement.Duration
			case storage.StagedTransactionMeasurement:
				pipeline.metrics.stagedTransaction += measurement.Duration
			}
		},
		SQLiteWriteMeasurement: func(measurement storage.PublishMeasurement) {
			if !measurement.NotApplicable {
				pipeline.metrics.sqliteWrite += measurement.Duration
			}
			if pipeline.request.SQLiteWriteMeasurement != nil {
				pipeline.request.SQLiteWriteMeasurement(measurement)
			}
		},
	})
	if err != nil {
		return Result{}, fmt.Errorf("index workspace: commit contribution session: %w", err)
	}
	reportProgress(pipeline.request.Progress, Progress{
		Phase:            PublishPhase,
		CompletedSources: summary.completedSources,
		TotalSources:     summary.completedSources,
		WrittenNodes:     totalNodes,
		TotalNodes:       totalNodes,
		WrittenEdges:     totalEdges,
		TotalEdges:       totalEdges,
	})
	return Result{Snapshot: snapshot, Diagnostics: diagnostics}, nil
}

func (pipeline *InitialIndexPipeline) reportMetrics() {
	measurements := []Measurement{
		{Name: DiscoveryMeasurement, Duration: pipeline.metrics.discovery},
		{Name: PipelineWallMeasurement, Duration: pipeline.metrics.pipelineWall},
		{Name: ExtractionMeasurement, Duration: pipeline.metrics.extraction},
		{Name: ExtractorBusyMeasurement, Duration: pipeline.metrics.extractorBusy},
		{Name: WriterBusyMeasurement, Duration: pipeline.metrics.writerBusy},
		{Name: ProducerBlockedMeasurement, Duration: pipeline.metrics.producerBlocked},
		{Name: ExtractionWriteOverlapMeasurement, Duration: pipeline.metrics.overlap},
		{Name: ResolutionMeasurement, Duration: pipeline.metrics.resolution},
		{Name: storage.PublicationPreparationMeasurement, Duration: pipeline.metrics.preparation},
		{Name: storage.SQLiteWriteMeasurement, Duration: pipeline.metrics.sqliteWrite},
		{Name: storage.CommitMeasurement, Duration: pipeline.metrics.commit},
		{Name: storage.StagedTransactionMeasurement, Duration: pipeline.metrics.stagedTransaction},
	}
	for _, measurement := range measurements {
		reportMeasurement(pipeline.request.Measurement, measurement.Name, measurement.Duration)
	}
	if pipeline.request.PipelineStatistics != nil {
		pipeline.request.PipelineStatistics(PipelineStatistics{
			ExtractionWorkers:          pipeline.metrics.workerCount,
			SourceQueueCapacity:        pipeline.metrics.queueCapacity,
			ContributionQueueHighWater: pipeline.metrics.queueHighWater,
			ContributionQueueCapacity:  pipeline.metrics.queueCapacity,
			ResolverPageSize:           resolverProjectionPageSize,
		})
	}
}

func maxTime(left, right time.Time) time.Time {
	if left.After(right) {
		return left
	}
	return right
}

func minTime(left, right time.Time) time.Time {
	if left.Before(right) {
		return left
	}
	return right
}
