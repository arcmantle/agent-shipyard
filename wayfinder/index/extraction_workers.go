package index

import (
	"context"
	"fmt"

	"agent-wayfinder/extractor"
	go_extractor "agent-wayfinder/extractors/go"
	js_extractor "agent-wayfinder/extractors/javascript"
	ts_extractor "agent-wayfinder/extractors/typescript"
	"agent-wayfinder/graph"
	"agent-wayfinder/storage"
)

type extractionWorker interface {
	Extract(extractor.Source) (extractor.Contribution, error)
	Close() error
}

type extractionWorkerFactory func() (extractionWorker, error)
type directExtractor func(extractor.Source) (extractor.Contribution, error)
type vocabularyFactory func() (graph.Vocabulary, error)
type workspaceResolver func(string, string, []extractor.Contribution) (graph.Facts, []extractor.Diagnostic, error)
type projectionPageResolver func(context.Context, string, string, []extractor.Contribution, extractor.ResolverIndex) (graph.Facts, []extractor.Diagnostic, error)
type incrementalProjectionResolver func(context.Context, string, resolverStore, storage.Snapshot, string, map[string]extractedSource, map[string]struct{}) (graph.Facts, []extractor.Diagnostic, error)

type indexLanguage struct {
	newWorker                     extractionWorkerFactory
	extract                       directExtractor
	vocabulary                    vocabularyFactory
	resolveWorkspace              workspaceResolver
	resolveProjectionPage         projectionPageResolver
	resolveIncrementalProjections incrementalProjectionResolver
}

// indexLanguages is the single registration point for index language behavior.
var indexLanguages = map[string]indexLanguage{
	"go": {
		newWorker: func() (extractionWorker, error) {
			return go_extractor.NewWorker()
		},
		extract:    go_extractor.Extract,
		vocabulary: func() (graph.Vocabulary, error) { return go_extractor.New().Vocabulary() },
		resolveWorkspace: func(root, projectID string, contributions []extractor.Contribution) (graph.Facts, []extractor.Diagnostic, error) {
			view, err := goResolverFileView(root, projectID)
			if err != nil {
				return graph.Facts{}, nil, err
			}
			resolution, err := go_extractor.ResolveWithFileView(contributions, view)
			return resolution.Facts(), resolution.Diagnostics(), err
		},
		resolveProjectionPage: func(ctx context.Context, root, projectID string, contributions []extractor.Contribution, index extractor.ResolverIndex) (graph.Facts, []extractor.Diagnostic, error) {
			view, err := goResolverFileView(root, projectID)
			if err != nil {
				return graph.Facts{}, nil, err
			}
			resolution, err := go_extractor.ResolvePage(ctx, contributions, projectID, index, view)
			return resolution.Facts(), resolution.Diagnostics(), err
		},
		resolveIncrementalProjections: func(ctx context.Context, root string, store resolverStore, snapshot storage.Snapshot, projectID string, overrides map[string]extractedSource, deleted map[string]struct{}) (graph.Facts, []extractor.Diagnostic, error) {
			view, err := goResolverFileView(root, projectID)
			if err != nil {
				return graph.Facts{}, nil, err
			}
			return resolveGoProjectionPages(ctx, store, snapshot, projectID, overrides, deleted, view)
		},
	},
	"javascript": {
		newWorker: func() (extractionWorker, error) {
			return js_extractor.NewWorker()
		},
		extract:    js_extractor.Extract,
		vocabulary: func() (graph.Vocabulary, error) { return js_extractor.New().Vocabulary() },
		resolveWorkspace: func(_ string, _ string, contributions []extractor.Contribution) (graph.Facts, []extractor.Diagnostic, error) {
			resolution, err := js_extractor.Resolve(contributions)
			return resolution.Facts(), resolution.Diagnostics(), err
		},
		resolveProjectionPage: func(ctx context.Context, _ string, projectID string, contributions []extractor.Contribution, index extractor.ResolverIndex) (graph.Facts, []extractor.Diagnostic, error) {
			resolution, err := js_extractor.ResolvePage(ctx, contributions, projectID, index)
			return resolution.Facts(), resolution.Diagnostics(), err
		},
		resolveIncrementalProjections: func(ctx context.Context, _ string, store resolverStore, snapshot storage.Snapshot, projectID string, overrides map[string]extractedSource, deleted map[string]struct{}) (graph.Facts, []extractor.Diagnostic, error) {
			return resolveJavaScriptProjectionPages(ctx, store, snapshot, projectID, overrides, deleted)
		},
	},
	"typescript": {
		newWorker: func() (extractionWorker, error) {
			return ts_extractor.NewWorker()
		},
		extract:    ts_extractor.Extract,
		vocabulary: func() (graph.Vocabulary, error) { return ts_extractor.New().Vocabulary() },
		resolveWorkspace: func(_ string, _ string, contributions []extractor.Contribution) (graph.Facts, []extractor.Diagnostic, error) {
			resolution, err := ts_extractor.Resolve(contributions)
			return resolution.Facts(), resolution.Diagnostics(), err
		},
		resolveProjectionPage: func(ctx context.Context, _ string, projectID string, contributions []extractor.Contribution, index extractor.ResolverIndex) (graph.Facts, []extractor.Diagnostic, error) {
			resolution, err := ts_extractor.ResolvePage(ctx, contributions, projectID, index)
			return resolution.Facts(), resolution.Diagnostics(), err
		},
		resolveIncrementalProjections: func(ctx context.Context, _ string, store resolverStore, snapshot storage.Snapshot, projectID string, overrides map[string]extractedSource, deleted map[string]struct{}) (graph.Facts, []extractor.Diagnostic, error) {
			return resolveTypeScriptProjectionPages(ctx, store, snapshot, projectID, overrides, deleted)
		},
	},
}

type extractionWorkers struct {
	workers            map[string]extractionWorker
	retainCatalogUnits bool
}

func newExtractionWorkers() (*extractionWorkers, error) {
	return &extractionWorkers{workers: make(map[string]extractionWorker)}, nil
}

func (workers *extractionWorkers) ForLanguage(language string) (extractionWorker, bool, error) {
	if workers == nil || workers.workers == nil {
		return nil, false, nil
	}
	if worker, found := workers.workers[language]; found {
		return worker, true, nil
	}
	definition, found := indexLanguages[language]
	if !found || definition.newWorker == nil {
		return nil, false, nil
	}
	worker, err := definition.newWorker()
	if err != nil {
		return nil, false, fmt.Errorf("create %s extraction worker: %w", language, err)
	}
	workers.workers[language] = worker
	return worker, true, nil
}

func (workers *extractionWorkers) Close() error {
	if workers == nil {
		return nil
	}
	var closeErr error
	for language, worker := range workers.workers {
		if err := worker.Close(); err != nil && closeErr == nil {
			closeErr = err
		}
		delete(workers.workers, language)
	}
	return closeErr
}

func vocabularyForLanguage(language string) (graph.Vocabulary, error) {
	definition, found := indexLanguages[language]
	if !found || definition.vocabulary == nil {
		return graph.Vocabulary{}, fmt.Errorf("unsupported extractor %q", language)
	}
	return definition.vocabulary()
}

func extract(registered extractor.Extractor, source extractor.Source, workers *extractionWorkers) (extractor.Contribution, error) {
	language := registered.Metadata().Name
	if worker, found, err := workers.ForLanguage(language); err != nil {
		return extractor.Contribution{}, err
	} else if found {
		return worker.Extract(source)
	}
	definition, found := indexLanguages[language]
	if !found || definition.extract == nil {
		return extractor.Contribution{}, fmt.Errorf("unsupported extractor %q", language)
	}
	return definition.extract(source)
}
