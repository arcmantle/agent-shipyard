package index

import (
	"context"
	"runtime"
	"testing"

	"agent-wayfinder/extractor"
	goextractor "agent-wayfinder/extractors/go"
	"agent-wayfinder/extractors/registry"
	"agent-wayfinder/workspace"
)

type blockingFirstContributionWriteSession struct {
	acceptingContributionSession
	writeStarted chan struct{}
	releaseWrite chan struct{}
	blocked      bool
}

func (session *blockingFirstContributionWriteSession) WriteContribution(ctx context.Context, contribution extractor.Contribution) error {
	if !session.blocked {
		session.blocked = true
		close(session.writeStarted)
		select {
		case <-session.releaseWrite:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func TestInitialIndexPipelineMeasuresBoundedQueuePressureAndDirectOverlap(t *testing.T) {
	previousProcs := runtime.GOMAXPROCS(64)
	t.Cleanup(func() { runtime.GOMAXPROCS(previousProcs) })

	registered, err := registry.Default()
	if err != nil {
		t.Fatalf("create extractor registry: %v", err)
	}
	sourceCount := 64
	sources := make([]workspace.Source, 0, sourceCount)
	for sourceIndex := 0; sourceIndex < sourceCount; sourceIndex++ {
		sources = append(sources, workspace.Source{Path: "source-" + string(rune('A'+sourceIndex)) + ".ts"})
	}
	pipeline := &InitialIndexPipeline{
		sources:    sources,
		registered: registered,
		metrics: initialPipelineMetrics{
			queueCapacity: initialContributionQueueCapacity,
		},
	}
	session := &blockingFirstContributionWriteSession{
		writeStarted: make(chan struct{}),
		releaseWrite: make(chan struct{}),
	}
	extracted := make(chan struct{}, sourceCount)
	completed := make(chan error, 1)
	go func() {
		_, _, _, err := pipeline.extractAndWriteContributions(
			context.Background(),
			session,
			func(_ string, source workspace.Source, registered registry.Registry, _ *extractionWorkers) (extractedSource, error) {
				contribution, err := emptyContribution(source.Path, registered)
				extracted <- struct{}{}
				return extractedSource{contribution: contribution}, err
			},
			newExtractionWorkers,
			nil,
		)
		completed <- err
	}()

	<-session.writeStarted
	for range sourceCount {
		<-extracted
	}
	close(session.releaseWrite)
	if err := <-completed; err != nil {
		t.Fatalf("extract and write contributions: %v", err)
	}

	if pipeline.metrics.queueHighWater != initialContributionQueueCapacity {
		t.Errorf("queue high-water = %d, want capacity %d", pipeline.metrics.queueHighWater, initialContributionQueueCapacity)
	}
	if pipeline.metrics.producerBlocked <= 0 {
		t.Errorf("producer blocked duration = %s, want positive", pipeline.metrics.producerBlocked)
	}
	if pipeline.metrics.overlap <= 0 {
		t.Errorf("extraction/write overlap = %s, want positive", pipeline.metrics.overlap)
	}
}

func TestExtractUsesProvidedGoWorker(t *testing.T) {
	registered, err := registry.Default()
	if err != nil {
		t.Fatalf("create extractor registry: %v", err)
	}
	language, found := registered.ForPath("src/service.go")
	if !found {
		t.Fatal("find Go extractor")
	}
	worker, err := goextractor.NewWorker()
	if err != nil {
		t.Fatalf("create Go worker: %v", err)
	}
	if err := worker.Close(); err != nil {
		t.Fatalf("close Go worker: %v", err)
	}

	_, err = extract(language, extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/service.go",
		Contents:   []byte("package fixture\n"),
	}, &extractionWorkers{workers: map[string]extractionWorker{"go": worker}})
	if err == nil || err.Error() != "Go worker is closed" {
		t.Errorf("extract error = %v, want closed Go worker error", err)
	}
}

func TestExtractFallsBackWithoutGoWorker(t *testing.T) {
	registered, err := registry.Default()
	if err != nil {
		t.Fatalf("create extractor registry: %v", err)
	}
	language, found := registered.ForPath("src/service.go")
	if !found {
		t.Fatal("find Go extractor")
	}

	contribution, err := extract(language, extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/service.go",
		Contents:   []byte("package fixture\n"),
	}, &extractionWorkers{})
	if err != nil {
		t.Fatalf("extract Go source without worker: %v", err)
	}
	if len(contribution.Facts().Nodes) == 0 {
		t.Error("extracted Go contribution has no nodes")
	}
}

func TestExtractInitializesOnlySourceLanguageWorker(t *testing.T) {
	registered, err := registry.Default()
	if err != nil {
		t.Fatalf("create extractor registry: %v", err)
	}
	for _, test := range []struct {
		name              string
		source            extractor.Source
		initializedWorker string
	}{
		{
			name:              "Go",
			source:            extractor.Source{ProjectID: "project:fixture", SourcePath: "src/service.go", Contents: []byte("package fixture\n")},
			initializedWorker: "go",
		},
		{
			name:              "JavaScript",
			source:            extractor.Source{ProjectID: "project:fixture", SourcePath: "src/service.js", Contents: []byte("export const value = 1;\n")},
			initializedWorker: "javascript",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			language, found := registered.ForPath(test.source.SourcePath)
			if !found {
				t.Fatalf("find extractor for %q", test.source.SourcePath)
			}
			workers, err := newExtractionWorkers()
			if err != nil {
				t.Fatalf("create extraction workers: %v", err)
			}
			t.Cleanup(func() { _ = workers.Close() })

			if _, err := extract(language, test.source, workers); err != nil {
				t.Fatalf("extract %s source: %v", test.name, err)
			}
			if _, found := workers.workers[test.initializedWorker]; !found {
				t.Errorf("%s worker was not initialized", test.name)
			}
			if _, found := workers.workers["typescript"]; found {
				t.Errorf("TypeScript worker was initialized for a %s source", test.name)
			}
		})
	}
}

func TestIndexLanguagesDefineAllIndexHandlers(t *testing.T) {
	for _, language := range []string{"go", "javascript", "typescript"} {
		definition, found := indexLanguages[language]
		if !found {
			t.Errorf("index language %q is not registered", language)
			continue
		}
		if definition.extract == nil {
			t.Errorf("index language %q has no direct extractor", language)
		}
		if definition.vocabulary == nil {
			t.Errorf("index language %q has no vocabulary factory", language)
		}
		if definition.resolveWorkspace == nil {
			t.Errorf("index language %q has no workspace resolver", language)
		}
		if definition.resolveProjectionPage == nil {
			t.Errorf("index language %q has no projection-page resolver", language)
		}
		if definition.resolveIncrementalProjections == nil {
			t.Errorf("index language %q has no incremental projection resolver", language)
		}
	}
}
