package index

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"agent-wayfinder/extractor"
	goextractor "agent-wayfinder/extractors/go"
	"agent-wayfinder/extractors/javascript"
	"agent-wayfinder/extractors/registry"
	"agent-wayfinder/extractors/typescript"
	"agent-wayfinder/graph"
	"agent-wayfinder/storage"
	"agent-wayfinder/workspace"
)

type Request struct {
	RetainCatalogUnits     bool
	Root                   string
	ConfiguredRoots        []string
	Progress               func(Progress)
	Measurement            func(Measurement)
	PipelineStatistics     func(PipelineStatistics)
	SQLiteWriteMeasurement func(storage.PublishMeasurement)
}

type Measurement struct {
	Name     string
	Duration time.Duration
}

const (
	DiscoveryMeasurement               = "discovery"
	PipelineWallMeasurement            = "pipeline_wall"
	ExtractionMeasurement              = "extraction"
	ExtractorBusyMeasurement           = "extractor_busy"
	WriterBusyMeasurement              = "writer_busy"
	ProducerBlockedMeasurement         = "producer_blocked"
	ExtractionWriteOverlapMeasurement  = "extraction_write_overlap"
	ResolutionMeasurement              = "resolution"
	AffectedSourceSelectionMeasurement = "affected_source_selection"
	ContributionRestorationMeasurement = "contribution_restoration"
	WorkspaceResolutionMeasurement     = "workspace_resolution"
)

type PipelineStatistics struct {
	ExtractionWorkers          int
	SourceQueueCapacity        int
	ContributionQueueHighWater int
	ContributionQueueCapacity  int
	ResolverPageSize           int
}

const initialContributionQueueCapacity = 32

type ProgressPhase string

const (
	ExtractPhase ProgressPhase = "extract"
	ResolvePhase ProgressPhase = "resolve"
	PublishPhase ProgressPhase = "publish"
)

type Progress struct {
	Phase            ProgressPhase
	CompletedSources int
	TotalSources     int
	WrittenNodes     int
	TotalNodes       int
	WrittenEdges     int
	TotalEdges       int
}

type BatchRequest struct {
	RetainCatalogUnits bool
	Root               string
	ConfiguredRoots    []string
	ChangedPaths       []string
	Measurement        func(Measurement)
}

type Result struct {
	Snapshot    storage.Snapshot
	Diagnostics []extractor.Diagnostic
}

type batchStore interface {
	storage.Publisher
	storage.StagedPublisher
	storage.SnapshotOpener
	storage.AffectedSourceFinder
	storage.SourceContributionReader
	resolverStore
}

type resolverStore interface {
	storage.ResolverProjectionPageReader
	storage.ResolverTargetReader
	storage.ResolverPackagePageReader
}

func Publish(ctx context.Context, publisher storage.Publisher, request Request) (storage.Snapshot, error) {
	result, err := Index(ctx, publisher, request)
	if err != nil {
		return storage.Snapshot{}, err
	}
	return result.Snapshot, nil
}

func PublishBatch(ctx context.Context, store batchStore, request BatchRequest) (storage.Snapshot, error) {
	if request.Root == "" {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: root is required")
	}
	if store == nil {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: publisher is required")
	}

	root, err := filepath.Abs(request.Root)
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: resolve root: %w", err)
	}
	discovery, err := workspace.Discover(root, workspace.DiscoverOptions{ConfiguredRoots: request.ConfiguredRoots})
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: discover sources: %w", err)
	}
	registered, err := registry.Default()
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: create extractor registry: %w", err)
	}
	snapshot, err := store.OpenSnapshot(ctx, storage.OpenSnapshotRequest{Workspace: root})
	if errors.Is(err, storage.ErrWorkspaceNotFound) {
		return Publish(ctx, store, Request{Root: root, ConfiguredRoots: request.ConfiguredRoots, RetainCatalogUnits: request.RetainCatalogUnits})
	}
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: open current snapshot: %w", err)
	}

	sourcesByPath := make(map[string]workspace.Source, len(discovery.Sources))
	for _, source := range discovery.Sources {
		sourcesByPath[source.Path] = source
	}
	changedPaths := make([]string, 0, len(request.ChangedPaths))
	changedSet := make(map[string]struct{}, len(request.ChangedPaths))
	for _, changedPath := range request.ChangedPaths {
		normalizedPath, err := normalizeChangedPath(root, changedPath)
		if err != nil {
			return storage.Snapshot{}, fmt.Errorf("publish source batch: %w", err)
		}
		if _, exists := changedSet[normalizedPath]; exists {
			continue
		}
		changedSet[normalizedPath] = struct{}{}
		changedPaths = append(changedPaths, normalizedPath)
	}
	sort.Strings(changedPaths)

	changed, deletedPaths, err := extractChangedSources(root, changedPaths, sourcesByPath, registered, request.RetainCatalogUnits)
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: %w", err)
	}
	if len(changed) == 0 {
		return snapshot, nil
	}
	changedContributions := contributionsFromSources(changed)
	changedUpdate, err := extractor.NewGraphUpdate(changedContributions)
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: create changed graph update: %w", err)
	}
	affectedSourceSelectionStarted := time.Now()
	affectedPaths, err := store.AffectedSources(ctx, snapshot, storage.AffectedSourcesRequest{Update: changedUpdate})
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: find affected sources: %w", err)
	}
	reportMeasurement(request.Measurement, AffectedSourceSelectionMeasurement, time.Since(affectedSourceSelectionStarted))
	affectedSources := make([]workspace.Source, 0, len(affectedPaths))
	for _, sourcePath := range affectedPaths {
		if _, changed := changedSet[sourcePath]; changed {
			continue
		}
		if source, found := sourcesByPath[sourcePath]; found {
			affectedSources = append(affectedSources, source)
		}
	}
	affected, err := extractDiscoveredSources(root, affectedSources, registered, request.RetainCatalogUnits)
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: %w", err)
	}
	updateSources := append(changed, affected...)
	contributions := contributionsFromSources(updateSources)
	if len(updateSources) > resolverProjectionPageSize {
		return publishStagedBatch(ctx, root, store, snapshot, discovery.Sources, updateSources, deletedPaths, request.Measurement)
	}

	contributionRestorationStarted := time.Now()
	reportMeasurement(request.Measurement, ContributionRestorationMeasurement, time.Since(contributionRestorationStarted))
	workspaceResolutionStarted := time.Now()
	workspaceFacts, _, err := resolveIncrementalWorkspaceFacts(ctx, root, store, snapshot, discovery.Sources, updateSources, deletedPaths)
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: resolve facts: %w", err)
	}
	reportMeasurement(request.Measurement, WorkspaceResolutionMeasurement, time.Since(workspaceResolutionStarted))
	contributions, err = withResolvedDependencies(contributions, workspaceFacts)
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: record resolved dependencies: %w", err)
	}
	update, err := extractor.NewGraphUpdate(contributions)
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: create graph update: %w", err)
	}
	snapshot, err = store.Publish(ctx, storage.PublishRequest{
		Workspace:                   root,
		Update:                      update,
		WorkspaceFacts:              workspaceFacts,
		ReplacedWorkspaceFactOwners: sourcePaths(updateSources),
		Measurement: func(measurement storage.PublishMeasurement) {
			reportMeasurement(request.Measurement, measurement.Name, measurement.Duration)
		},
	})
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: publish graph update: %w", err)
	}
	return snapshot, nil
}

func publishStagedBatch(ctx context.Context, root string, store storage.StagedPublisher, snapshot storage.Snapshot, discovered []workspace.Source, sources []extractedSource, deleted map[string]struct{}, measurement func(Measurement)) (storage.Snapshot, error) {
	update, err := extractor.NewGraphUpdate(contributionsFromSources(sources))
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("publish source batch: create staged graph update: %w", err)
	}
	contributionRestorationStarted := time.Now()
	reportMeasurement(measurement, ContributionRestorationMeasurement, time.Since(contributionRestorationStarted))
	return store.PublishStaged(ctx, storage.PublishRequest{Workspace: root, Update: update}, func(ctx context.Context, stager storage.ResolverStager) (storage.PublishRequest, error) {
		if err := stager.StageResolverSources(ctx, resolverStageSources(sources)); err != nil {
			return storage.PublishRequest{}, err
		}
		workspaceResolutionStarted := time.Now()
		workspaceFacts, _, err := resolveIncrementalWorkspaceFacts(ctx, root, stager, snapshot, discovered, sources, deleted)
		if err != nil {
			return storage.PublishRequest{}, fmt.Errorf("resolve facts: %w", err)
		}
		reportMeasurement(measurement, WorkspaceResolutionMeasurement, time.Since(workspaceResolutionStarted))
		contributions, err := withResolvedDependencies(contributionsFromSources(sources), workspaceFacts)
		if err != nil {
			return storage.PublishRequest{}, fmt.Errorf("record resolved dependencies: %w", err)
		}
		update, err := extractor.NewGraphUpdate(contributions)
		if err != nil {
			return storage.PublishRequest{}, fmt.Errorf("create staged graph update: %w", err)
		}
		return storage.PublishRequest{
			Workspace:                   root,
			Update:                      update,
			WorkspaceFacts:              workspaceFacts,
			ReplacedWorkspaceFactOwners: sourcePaths(sources),
			Measurement: func(publishMeasurement storage.PublishMeasurement) {
				reportMeasurement(measurement, publishMeasurement.Name, publishMeasurement.Duration)
			},
		}, nil
	})
}

func resolverStageSources(sources []extractedSource) []storage.ResolverStageSource {
	staged := make([]storage.ResolverStageSource, 0, len(sources))
	for _, source := range sources {
		staged = append(staged, storage.ResolverStageSource{
			ProjectID:  source.projectID,
			Language:   source.language,
			SourcePath: source.contribution.SourcePath(),
		})
	}
	return staged
}

func sourcePaths(sources []extractedSource) []string {
	paths := make([]string, 0, len(sources))
	for _, source := range sources {
		paths = append(paths, source.contribution.SourcePath())
	}
	sort.Strings(paths)
	return paths
}

func extractChangedSources(root string, paths []string, sourcesByPath map[string]workspace.Source, registered registry.Registry, retainCatalogUnits bool) ([]extractedSource, map[string]struct{}, error) {
	sources := make([]workspace.Source, 0, len(paths))
	deleted := make(map[string]struct{})
	deletions := make([]extractor.Contribution, 0)
	for _, sourcePath := range paths {
		if source, found := sourcesByPath[sourcePath]; found {
			sources = append(sources, source)
			continue
		}
		language, supported := registered.ForPath(sourcePath)
		if !supported {
			continue
		}
		vocabulary, err := vocabularyForLanguage(language.Metadata().Name)
		if err != nil {
			return nil, nil, fmt.Errorf("get vocabulary for deleted source %q: %w", sourcePath, err)
		}
		contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{SourcePath: sourcePath, Metadata: language.Metadata()})
		if err != nil {
			return nil, nil, fmt.Errorf("create deletion contribution for %q: %w", sourcePath, err)
		}
		deletions = append(deletions, contribution)
		deleted[sourcePath] = struct{}{}
	}
	extracted, err := extractDiscoveredSources(root, sources, registered, retainCatalogUnits)
	if err != nil {
		return nil, nil, err
	}
	for _, contribution := range deletions {
		extracted = append(extracted, extractedSource{language: contribution.Metadata().Name, contribution: contribution})
	}
	return extracted, deleted, nil
}

func mergeSources(stored []storage.SourceContribution, updated []extractedSource, deleted map[string]struct{}, sourcesByPath map[string]workspace.Source, registered registry.Registry) ([]extractedSource, error) {
	merged := make(map[string]extractedSource, len(stored)+len(updated))
	for _, source := range stored {
		if _, removed := deleted[source.SourcePath]; removed {
			continue
		}
		workspaceSource, found := sourcesByPath[source.SourcePath]
		if !found {
			continue
		}
		language, found := registered.ForPath(source.SourcePath)
		if !found {
			return nil, fmt.Errorf("restore source %q: no registered extractor", source.SourcePath)
		}
		vocabulary, err := vocabularyForLanguage(language.Metadata().Name)
		if err != nil {
			return nil, fmt.Errorf("restore source %q: get vocabulary: %w", source.SourcePath, err)
		}
		contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
			SourcePath:           source.SourcePath,
			Metadata:             source.Metadata,
			Facts:                source.Facts,
			CatalogUnits:         source.CatalogUnits,
			CatalogUnitsOmitted:  !source.CatalogUnitsCovered,
			UnresolvedReferences: source.UnresolvedReferences,
			SymbolReferences:     source.SymbolReferences,
			ExportedSurfaces:     source.ExportedSurfaces,
			Dependencies:         source.Dependencies,
			Diagnostics:          source.Diagnostics,
		})
		if err != nil {
			return nil, fmt.Errorf("restore source %q: %w", source.SourcePath, err)
		}
		merged[source.SourcePath] = extractedSource{projectID: workspaceSource.ProjectID, language: source.Metadata.Name, contribution: contribution}
	}
	for _, source := range updated {
		if _, removed := deleted[source.contribution.SourcePath()]; removed {
			delete(merged, source.contribution.SourcePath())
			continue
		}
		merged[source.contribution.SourcePath()] = source
	}
	paths := make([]string, 0, len(merged))
	for sourcePath := range merged {
		paths = append(paths, sourcePath)
	}
	sort.Strings(paths)
	result := make([]extractedSource, 0, len(paths))
	for _, sourcePath := range paths {
		result = append(result, merged[sourcePath])
	}
	return result, nil
}

func Index(ctx context.Context, publisher storage.Publisher, request Request) (Result, error) {
	if request.Root == "" {
		return Result{}, fmt.Errorf("index workspace: root is required")
	}
	if publisher == nil {
		return Result{}, fmt.Errorf("index workspace: publisher is required")
	}

	root, err := filepath.Abs(request.Root)
	if err != nil {
		return Result{}, fmt.Errorf("index workspace: resolve root: %w", err)
	}
	registered, err := registry.Default()
	if err != nil {
		return Result{}, fmt.Errorf("index workspace: create extractor registry: %w", err)
	}
	if sessionStore, supported := publisher.(storage.ContributionSessionStore); supported {
		allowEmpty := false
		if snapshotOpener, supported := publisher.(storage.SnapshotOpener); supported {
			_, openErr := snapshotOpener.OpenSnapshot(ctx, storage.OpenSnapshotRequest{Workspace: root})
			if openErr == nil {
				allowEmpty = true
			} else if !errors.Is(openErr, storage.ErrWorkspaceNotFound) {
				return Result{}, fmt.Errorf("index workspace: open current snapshot: %w", openErr)
			}
		}
		return newInitialIndexPipeline(sessionStore, request, root, registered, allowEmpty).Run(ctx)
	}
	discoveryStarted := time.Now()
	discovery, err := workspace.Discover(root, workspace.DiscoverOptions{ConfiguredRoots: request.ConfiguredRoots})
	if err != nil {
		return Result{}, fmt.Errorf("index workspace: discover sources: %w", err)
	}
	discoveryDuration := time.Since(discoveryStarted)

	reportMeasurement(request.Measurement, DiscoveryMeasurement, discoveryDuration)
	reportProgress(request.Progress, Progress{Phase: ExtractPhase, TotalSources: len(discovery.Sources)})
	extractionStarted := time.Now()
	extracted, err := extractDiscoveredSourcesWithProgress(root, discovery.Sources, registered, func(completed int) {
		reportProgress(request.Progress, Progress{Phase: ExtractPhase, CompletedSources: completed, TotalSources: len(discovery.Sources)})
	}, request.RetainCatalogUnits)
	if err != nil {
		return Result{}, fmt.Errorf("index workspace: %w", err)
	}
	reportMeasurement(request.Measurement, ExtractionMeasurement, time.Since(extractionStarted))
	contributions := contributionsFromSources(extracted)
	if len(contributions) == 0 {
		return Result{}, fmt.Errorf("index workspace: no supported source files discovered")
	}
	reportProgress(request.Progress, Progress{Phase: ResolvePhase, CompletedSources: len(extracted), TotalSources: len(discovery.Sources)})
	resolutionStarted := time.Now()
	workspaceFacts, diagnostics, err := resolveWorkspaceFacts(root, extracted)
	if err != nil {
		return Result{}, fmt.Errorf("index workspace: resolve facts: %w", err)
	}
	contributions, err = withResolvedDependencies(contributions, workspaceFacts)
	if err != nil {
		return Result{}, fmt.Errorf("index workspace: record resolved dependencies: %w", err)
	}
	reportMeasurement(request.Measurement, ResolutionMeasurement, time.Since(resolutionStarted))
	update, err := extractor.NewGraphUpdate(contributions)
	if err != nil {
		return Result{}, fmt.Errorf("index workspace: create graph update: %w", err)
	}
	reportProgress(request.Progress, Progress{Phase: PublishPhase, CompletedSources: len(extracted), TotalSources: len(discovery.Sources)})
	publishRequest := storage.PublishRequest{
		Workspace:              root,
		Update:                 update,
		WorkspaceFacts:         workspaceFacts,
		SQLiteWriteMeasurement: request.SQLiteWriteMeasurement,
		Measurement: func(measurement storage.PublishMeasurement) {
			reportMeasurement(request.Measurement, measurement.Name, measurement.Duration)
		},
	}
	var snapshot storage.Snapshot
	if progressPublisher, supported := publisher.(storage.ProgressPublisher); supported {
		snapshot, err = progressPublisher.PublishWithProgress(ctx, publishRequest, func(update storage.PublishProgress) {
			reportProgress(request.Progress, Progress{
				Phase:            PublishPhase,
				CompletedSources: update.CompletedContributions,
				TotalSources:     update.TotalContributions,
				WrittenNodes:     update.WrittenNodes,
				TotalNodes:       update.TotalNodes,
				WrittenEdges:     update.WrittenEdges,
				TotalEdges:       update.TotalEdges,
			})
		})
	} else {
		snapshot, err = publisher.Publish(ctx, publishRequest)
	}
	if err != nil {
		return Result{}, fmt.Errorf("index workspace: publish graph update: %w", err)
	}
	return Result{Snapshot: snapshot, Diagnostics: diagnostics}, nil
}

func extractDiscoveredSources(root string, sources []workspace.Source, registered registry.Registry, retainCatalogUnits bool) ([]extractedSource, error) {
	return extractDiscoveredSourcesWithProgress(root, sources, registered, nil, retainCatalogUnits)
}

func extractDiscoveredSourcesWithProgress(root string, sources []workspace.Source, registered registry.Registry, progress func(completed int), retainCatalogUnits bool) ([]extractedSource, error) {
	if len(sources) == 0 {
		return nil, nil
	}
	type extractionResult struct {
		source extractedSource
		err    error
	}
	results := make([]extractionResult, len(sources))
	jobs := make(chan int)
	completed := make(chan struct{}, len(sources))
	workerCount := min(len(sources), max(1, runtime.GOMAXPROCS(0)))
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			extractionWorkers, err := newExtractionWorkers()
			if err != nil {
				for sourceIndex := range jobs {
					results[sourceIndex].err = fmt.Errorf("create extraction workers: %w", err)
					completed <- struct{}{}
				}
				return
			}
			defer extractionWorkers.Close()
			extractionWorkers.retainCatalogUnits = retainCatalogUnits
			for sourceIndex := range jobs {
				results[sourceIndex].source, results[sourceIndex].err = extractDiscoveredSource(root, sources[sourceIndex], registered, extractionWorkers)
				completed <- struct{}{}
			}
		}()
	}
	go func() {
		for sourceIndex := range sources {
			jobs <- sourceIndex
		}
		close(jobs)
	}()

	for completedCount := 1; completedCount <= len(sources); completedCount++ {
		<-completed
		if progress != nil {
			progress(completedCount)
		}
	}
	workers.Wait()
	extracted := make([]extractedSource, 0, len(sources))
	for sourceIndex := range sources {
		result := results[sourceIndex]
		if result.err != nil {
			return nil, result.err
		}
		extracted = append(extracted, result.source)
	}
	return extracted, nil
}

func extractDiscoveredSource(root string, source workspace.Source, registered registry.Registry, workers *extractionWorkers) (extractedSource, error) {
	contents, err := os.ReadFile(filepath.Join(root, source.Path))
	if err != nil {
		return extractedSource{}, fmt.Errorf("read source %q: %w", source.Path, err)
	}
	language, found := registered.ForPath(source.Path)
	if !found {
		return extractedSource{}, fmt.Errorf("extract source %q: no registered extractor", source.Path)
	}
	contribution, err := extract(language, extractor.Source{
		ProjectID:        source.ProjectID,
		SourcePath:       source.Path,
		Contents:         contents,
		OmitCatalogUnits: workers != nil && !workers.retainCatalogUnits,
	}, workers)
	if err != nil {
		return extractedSource{}, fmt.Errorf("extract source %q: %w", source.Path, err)
	}
	return extractedSource{
		projectID:    source.ProjectID,
		language:     language.Metadata().Name,
		contribution: contribution,
	}, nil
}

func reportProgress(callback func(Progress), progress Progress) {
	if callback != nil {
		callback(progress)
	}
}

func reportMeasurement(callback func(Measurement), name string, duration time.Duration) {
	if callback != nil {
		callback(Measurement{Name: name, Duration: duration})
	}
}

func contributionsFromSources(sources []extractedSource) []extractor.Contribution {
	contributions := make([]extractor.Contribution, 0, len(sources))
	for _, source := range sources {
		contributions = append(contributions, source.contribution)
	}
	return contributions
}

func withResolvedDependencies(contributions []extractor.Contribution, facts graph.Facts) ([]extractor.Contribution, error) {
	pathsByFileID := make(map[string]string, len(contributions))
	for _, contribution := range contributions {
		for _, node := range contribution.Facts().Nodes {
			if node.Kind == "file" {
				pathsByFileID[node.ID] = contribution.SourcePath()
			}
		}
	}
	for _, node := range facts.Nodes {
		if node.Kind == "file" && node.Evidence.Span.Path != "" {
			pathsByFileID[node.ID] = node.Evidence.Span.Path
		}
	}

	targetsBySourcePath := make(map[string]map[string]struct{}, len(contributions))
	for _, edge := range facts.Edges {
		sourcePath, sourceIsFile := pathsByFileID[edge.SourceID]
		targetPath, targetIsFile := pathsByFileID[edge.TargetID]
		if !sourceIsFile || !targetIsFile || sourcePath == targetPath {
			continue
		}
		if targetsBySourcePath[sourcePath] == nil {
			targetsBySourcePath[sourcePath] = make(map[string]struct{})
		}
		targetsBySourcePath[sourcePath][targetPath] = struct{}{}
	}

	updated := make([]extractor.Contribution, 0, len(contributions))
	for _, contribution := range contributions {
		targets := targetsBySourcePath[contribution.SourcePath()]
		dependencies := make([]extractor.Dependency, 0, len(targets))
		for targetPath := range targets {
			dependencies = append(dependencies, extractor.Dependency{
				SourcePath: contribution.SourcePath(),
				TargetPath: targetPath,
			})
		}
		sort.Slice(dependencies, func(left, right int) bool {
			return dependencies[left].TargetPath < dependencies[right].TargetPath
		})
		withDependencies, err := contribution.WithDependencies(dependencies)
		if err != nil {
			return nil, err
		}
		updated = append(updated, withDependencies)
	}
	return updated, nil
}

func normalizeChangedPath(root, changedPath string) (string, error) {
	if changedPath == "" {
		return "", fmt.Errorf("changed path is required")
	}
	path := changedPath
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, path)
	}
	relative, err := filepath.Rel(root, filepath.Clean(path))
	if err != nil {
		return "", fmt.Errorf("resolve changed path: %w", err)
	}
	if relative == "." || relative == ".." || filepath.IsAbs(relative) || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("changed path %q is outside workspace", changedPath)
	}
	return filepath.ToSlash(relative), nil
}

type extractedSource struct {
	projectID    string
	language     string
	contribution extractor.Contribution
}

type resolutionGroup struct {
	projectID     string
	language      string
	contributions []extractor.Contribution
}

func resolveWorkspaceFacts(root string, sources []extractedSource) (graph.Facts, []extractor.Diagnostic, error) {
	groups := make(map[string]resolutionGroup)
	diagnostics := make([]extractor.Diagnostic, 0)
	for _, source := range sources {
		key := source.projectID + "\x00" + source.language
		group := groups[key]
		group.projectID = source.projectID
		group.language = source.language
		group.contributions = append(group.contributions, source.contribution)
		groups[key] = group
		diagnostics = append(diagnostics, source.contribution.Diagnostics()...)
	}

	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var facts graph.Facts
	for _, key := range keys {
		group := groups[key]
		definition, found := indexLanguages[group.language]
		if !found || definition.resolveWorkspace == nil {
			return graph.Facts{}, nil, fmt.Errorf("unsupported resolver %q", group.language)
		}
		groupFacts, groupDiagnostics, err := definition.resolveWorkspace(root, group.projectID, group.contributions)
		if err != nil {
			return graph.Facts{}, nil, err
		}
		facts.Edges = append(facts.Edges, groupFacts.Edges...)
		diagnostics = append(diagnostics, groupDiagnostics...)
	}
	return facts, diagnostics, nil
}

const resolverProjectionPageSize = 128

func resolveIncrementalWorkspaceFacts(ctx context.Context, root string, store resolverStore, snapshot storage.Snapshot, discovered []workspace.Source, sources []extractedSource, deleted map[string]struct{}) (graph.Facts, []extractor.Diagnostic, error) {
	registered, err := registry.Default()
	if err != nil {
		return graph.Facts{}, nil, fmt.Errorf("create extractor registry: %w", err)
	}
	groups := make(map[string][]workspace.Source)
	for _, source := range discovered {
		language, found := registered.ForPath(source.Path)
		if !found {
			continue
		}
		key := source.ProjectID + "\x00" + language.Metadata().Name
		groups[key] = append(groups[key], source)
	}
	overrides := make(map[string]extractedSource, len(sources))
	for _, source := range sources {
		overrides[source.contribution.SourcePath()] = source
	}
	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var facts graph.Facts
	diagnostics := make([]extractor.Diagnostic, 0)
	for _, key := range keys {
		projectID, language, _ := strings.Cut(key, "\x00")
		definition, found := indexLanguages[language]
		if !found || definition.resolveIncrementalProjections == nil {
			return graph.Facts{}, nil, fmt.Errorf("unsupported resolver %q", language)
		}
		groupFacts, groupDiagnostics, err := definition.resolveIncrementalProjections(ctx, root, store, snapshot, projectID, overrides, deleted)
		if err != nil {
			return graph.Facts{}, nil, err
		}
		facts.Edges = append(facts.Edges, groupFacts.Edges...)
		diagnostics = append(diagnostics, groupDiagnostics...)
	}
	return facts, diagnostics, nil
}

func resolveTypeScriptProjectionPages(ctx context.Context, store resolverStore, snapshot storage.Snapshot, projectID string, overrides map[string]extractedSource, deleted map[string]struct{}) (graph.Facts, []extractor.Diagnostic, error) {
	index := snapshotResolverIndex{store: store, snapshot: snapshot, overrides: overrides}
	contributions := incrementalResolverContributions(projectID, "typescript", overrides, deleted)
	var facts graph.Facts
	diagnostics := make([]extractor.Diagnostic, 0)
	for len(contributions) > 0 {
		pageSize := min(len(contributions), resolverProjectionPageSize)
		resolution, err := typescript.ResolvePage(ctx, contributions[:pageSize], projectID, index)
		if err != nil {
			return graph.Facts{}, nil, err
		}
		facts.Edges = append(facts.Edges, resolution.Facts().Edges...)
		diagnostics = append(diagnostics, resolution.Diagnostics()...)
		contributions = contributions[pageSize:]
	}
	return facts, diagnostics, nil
}

func resolveJavaScriptProjectionPages(ctx context.Context, store resolverStore, snapshot storage.Snapshot, projectID string, overrides map[string]extractedSource, deleted map[string]struct{}) (graph.Facts, []extractor.Diagnostic, error) {
	index := snapshotResolverIndex{store: store, snapshot: snapshot, overrides: overrides}
	contributions := incrementalResolverContributions(projectID, "javascript", overrides, deleted)
	var facts graph.Facts
	diagnostics := make([]extractor.Diagnostic, 0)
	for len(contributions) > 0 {
		pageSize := min(len(contributions), resolverProjectionPageSize)
		resolution, err := javascript.ResolvePage(ctx, contributions[:pageSize], projectID, index)
		if err != nil {
			return graph.Facts{}, nil, err
		}
		facts.Edges = append(facts.Edges, resolution.Facts().Edges...)
		diagnostics = append(diagnostics, resolution.Diagnostics()...)
		contributions = contributions[pageSize:]
	}
	return facts, diagnostics, nil
}

func resolveGoProjectionPages(ctx context.Context, store resolverStore, snapshot storage.Snapshot, projectID string, overrides map[string]extractedSource, deleted map[string]struct{}, view extractor.ResolverFileView) (graph.Facts, []extractor.Diagnostic, error) {
	index := snapshotResolverIndex{store: store, snapshot: snapshot, overrides: overrides}
	contributions := incrementalResolverContributions(projectID, "go", overrides, deleted)
	var facts graph.Facts
	diagnostics := make([]extractor.Diagnostic, 0)
	for len(contributions) > 0 {
		pageSize := min(len(contributions), resolverProjectionPageSize)
		resolution, err := goextractor.ResolvePage(ctx, contributions[:pageSize], projectID, index, view)
		if err != nil {
			return graph.Facts{}, nil, err
		}
		facts.Edges = append(facts.Edges, resolution.Facts().Edges...)
		diagnostics = append(diagnostics, resolution.Diagnostics()...)
		contributions = contributions[pageSize:]
	}
	return facts, diagnostics, nil
}

func incrementalResolverContributions(projectID, language string, overrides map[string]extractedSource, deleted map[string]struct{}) []extractor.Contribution {
	paths := make([]string, 0, len(overrides))
	for sourcePath, override := range overrides {
		if override.projectID != projectID || override.language != language {
			continue
		}
		if _, removed := deleted[sourcePath]; removed {
			continue
		}
		paths = append(paths, sourcePath)
	}
	sort.Strings(paths)
	contributions := make([]extractor.Contribution, 0, len(paths))
	for _, sourcePath := range paths {
		contributions = append(contributions, overrides[sourcePath].contribution)
	}
	return contributions
}

type snapshotResolverIndex struct {
	store     resolverStore
	snapshot  storage.Snapshot
	overrides map[string]extractedSource
}

func (index snapshotResolverIndex) ResolverTarget(ctx context.Context, request extractor.ResolverTargetRequest) (extractor.ResolverTarget, bool, error) {
	if override, found := index.overrides[request.SourcePath]; found && override.projectID == request.ProjectID && override.language == request.Language {
		return resolverTargetFromContribution(override), true, nil
	}
	return index.store.ResolverTarget(ctx, index.snapshot, request)
}

func (index snapshotResolverIndex) ResolverPackagePage(ctx context.Context, request extractor.ResolverPackagePageRequest) ([]extractor.ResolverTarget, error) {
	targets, err := index.store.ResolverPackagePage(ctx, index.snapshot, request)
	if err != nil {
		return nil, err
	}
	overridePaths := make([]string, 0, len(index.overrides))
	for sourcePath, override := range index.overrides {
		if override.projectID == request.ProjectID && override.language == request.Language && path.Dir(sourcePath) == request.PackagePath && sourcePath > request.AfterSourcePath {
			overridePaths = append(overridePaths, sourcePath)
		}
	}
	sort.Strings(overridePaths)
	overridePaths = overridePaths[:min(len(overridePaths), request.Limit)]
	seen := make(map[string]struct{}, len(targets))
	for targetIndex := range targets {
		seen[targets[targetIndex].SourcePath] = struct{}{}
		if override, found := index.overrides[targets[targetIndex].SourcePath]; found && override.projectID == request.ProjectID && override.language == request.Language {
			targets[targetIndex] = resolverTargetFromContribution(override)
		}
	}
	for _, sourcePath := range overridePaths {
		if _, found := seen[sourcePath]; !found {
			targets = append(targets, resolverTargetFromContribution(index.overrides[sourcePath]))
		}
	}
	sort.Slice(targets, func(first, second int) bool { return targets[first].SourcePath < targets[second].SourcePath })
	targets = targets[:min(len(targets), request.Limit)]
	return targets, nil
}

func resolverTargetFromContribution(source extractedSource) extractor.ResolverTarget {
	contribution := source.contribution
	return extractor.ResolverTarget{
		ProjectID:            source.projectID,
		SourcePath:           contribution.SourcePath(),
		Metadata:             contribution.Metadata(),
		Nodes:                contribution.Facts().Nodes,
		UnresolvedReferences: contribution.UnresolvedReferences(),
		SymbolReferences:     contribution.SymbolReferences(),
		ExportedSurfaces:     contribution.ExportedSurfaces(),
		Diagnostics:          contribution.Diagnostics(),
	}
}

func projectionContribution(projection extractor.ResolverProjection) (extractor.Contribution, error) {
	vocabulary, err := vocabularyForLanguage(projection.Metadata.Name)
	if err != nil {
		return extractor.Contribution{}, fmt.Errorf("create resolver projection %q: %w", projection.SourcePath, err)
	}
	return extractor.NewContribution(vocabulary, extractor.ContributionInput{
		ProjectID:            projection.ProjectID,
		SourcePath:           projection.SourcePath,
		Metadata:             projection.Metadata,
		Facts:                graph.Facts{Nodes: projection.Nodes, Edges: projection.Edges},
		UnresolvedReferences: projection.UnresolvedReferences,
		SymbolReferences:     projection.SymbolReferences,
		ExportedSurfaces:     projection.ExportedSurfaces,
		Dependencies:         projection.Dependencies,
		Diagnostics:          projection.Diagnostics,
	})
}

func goResolverFileView(root, projectID string) (extractor.ResolverFileView, error) {
	projectRoot := strings.TrimPrefix(projectID, "project:")
	contents, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(projectRoot), "go.mod"))
	if err != nil {
		if os.IsNotExist(err) {
			return extractor.NewResolverFileView(projectRoot, nil)
		}
		return extractor.ResolverFileView{}, fmt.Errorf("read Go module for %q: %w", projectID, err)
	}
	return extractor.NewResolverFileView(projectRoot, map[string][]byte{"go.mod": contents})
}
