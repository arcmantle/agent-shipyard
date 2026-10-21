package index

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"agent-wayfinder/extractor"
	"agent-wayfinder/extractors/registry"
	"agent-wayfinder/graph"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
	"agent-wayfinder/testkit"
	"agent-wayfinder/workspace"
)

func TestIndexReturnsDeterministicConcurrentExtractionError(t *testing.T) {
	previousProcs := runtime.GOMAXPROCS(2)
	t.Cleanup(func() { runtime.GOMAXPROCS(previousProcs) })

	registered, err := registry.Default()
	if err != nil {
		t.Fatalf("create extractor registry: %v", err)
	}
	firstFailure := errors.New("first source failed")
	secondFailure := errors.New("second source failed")
	secondFinished := make(chan struct{})
	firstFinished := make(chan struct{})
	_, _, _, err = runPipelineExtraction(
		context.Background(),
		acceptingContributionSession{},
		".",
		[]workspace.Source{{Path: "src/first.ts"}, {Path: "src/second.ts"}},
		registered,
		func(_ string, source workspace.Source, _ registry.Registry, _ *extractionWorkers) (extractedSource, error) {
			switch source.Path {
			case "src/first.ts":
				<-secondFinished
				close(firstFinished)
				return extractedSource{}, fmt.Errorf("extract source %q: %w", source.Path, firstFailure)
			case "src/second.ts":
				close(secondFinished)
				return extractedSource{}, fmt.Errorf("extract source %q: %w", source.Path, secondFailure)
			default:
				return extractedSource{}, fmt.Errorf("unexpected source %q", source.Path)
			}
		},
		nil,
		nil,
	)
	if !errors.Is(err, firstFailure) || !strings.Contains(err.Error(), `src/first.ts`) {
		t.Errorf("index error = %v, want earliest source failure", err)
	}
	select {
	case <-firstFinished:
	default:
		t.Error("index returned before the earlier source worker finished")
	}
}

func TestIndexCallerCancellationTakesPrecedenceOverExtractionFailure(t *testing.T) {
	previousProcs := runtime.GOMAXPROCS(2)
	t.Cleanup(func() { runtime.GOMAXPROCS(previousProcs) })

	registered, err := registry.Default()
	if err != nil {
		t.Fatalf("create extractor registry: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	var startOnce sync.Once
	_, _, _, err = runPipelineExtraction(
		ctx,
		acceptingContributionSession{},
		".",
		[]workspace.Source{{Path: "src/first.ts"}, {Path: "src/second.ts"}},
		registered,
		func(_ string, source workspace.Source, _ registry.Registry, _ *extractionWorkers) (extractedSource, error) {
			startOnce.Do(func() {
				close(started)
				cancel()
			})
			<-started
			return extractedSource{}, fmt.Errorf("extract source %q: failed after cancellation", source.Path)
		},
		nil,
		nil,
	)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("index error = %v, want caller cancellation", err)
	}
}

func TestIndexExtractionFailureTakesPrecedenceOverContributionWriteFailure(t *testing.T) {
	previousProcs := runtime.GOMAXPROCS(2)
	t.Cleanup(func() { runtime.GOMAXPROCS(previousProcs) })

	registered, err := registry.Default()
	if err != nil {
		t.Fatalf("create extractor registry: %v", err)
	}

	extractionFailure := errors.New("source extraction failed")
	writeReady := make(chan struct{})
	_, _, _, err = runPipelineExtraction(
		context.Background(),
		failingContributionWriteSession{err: errors.New("contribution write failed")},
		".",
		[]workspace.Source{{Path: "src/first.ts"}, {Path: "src/second.ts"}},
		registered,
		func(_ string, source workspace.Source, registered registry.Registry, _ *extractionWorkers) (extractedSource, error) {
			if source.Path == "src/first.ts" {
				<-writeReady
				return extractedSource{}, fmt.Errorf("extract source %q: %w", source.Path, extractionFailure)
			}
			contribution, err := emptyContribution(source.Path, registered)
			close(writeReady)
			return extractedSource{contribution: contribution}, err
		},
		nil,
		nil,
	)
	if !errors.Is(err, extractionFailure) {
		t.Errorf("index error = %v, want extraction failure", err)
	}
}

func TestIndexExtractionFailureKeepsPriorSnapshotCurrent(t *testing.T) {
	fixture := testkit.NewWorkspace(t, map[string]string{
		"package.json": `{"name":"fixture"}`,
		"src/main.ts":  "export const value = 1;",
	})
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open graph store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	prior, err := Index(context.Background(), store, Request{Root: fixture.Root})
	if err != nil {
		t.Fatalf("index prior snapshot: %v", err)
	}
	mutatingStore := &stageMutationStore{
		Store: store,
		mutate: func() error {
			return os.Remove(filepath.Join(fixture.Root, "src/main.ts"))
		},
	}
	_, err = Index(context.Background(), mutatingStore, Request{Root: fixture.Root})
	if err == nil || !strings.Contains(err.Error(), `read source "src/main.ts"`) {
		t.Errorf("index error = %v, want source read failure", err)
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: fixture.Root})
	if err != nil {
		t.Fatalf("open current snapshot: %v", err)
	}
	if current != prior.Snapshot {
		t.Errorf("current snapshot after extraction failure = %+v, want %+v", current, prior.Snapshot)
	}
}

func TestIndexParseFailureKeepsPriorSnapshotCurrent(t *testing.T) {
	fixture := testkit.NewWorkspace(t, map[string]string{
		"package.json": `{"name":"fixture"}`,
		"src/main.ts":  "export const value = 1;",
	})
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open graph store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	prior, err := Index(context.Background(), store, Request{Root: fixture.Root})
	if err != nil {
		t.Fatalf("index prior snapshot: %v", err)
	}
	if err := os.WriteFile(filepath.Join(fixture.Root, "src/main.ts"), []byte("export const value = ;"), 0o644); err != nil {
		t.Fatalf("write malformed TypeScript source: %v", err)
	}

	_, err = Index(context.Background(), store, Request{Root: fixture.Root})
	if err == nil || !strings.Contains(err.Error(), `parse TypeScript source "src/main.ts" at 1:`) {
		t.Errorf("index error = %v, want actionable parse failure", err)
	}

	current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: fixture.Root})
	if err != nil {
		t.Fatalf("open current snapshot: %v", err)
	}
	if current != prior.Snapshot {
		t.Errorf("current snapshot after parse failure = %+v, want %+v", current, prior.Snapshot)
	}
}

type stageMutationStore struct {
	*sqlite.Store
	mutate func() error
}

func (store *stageMutationStore) BeginContributionSession(ctx context.Context, workspace string) (storage.ContributionSession, error) {
	session, err := store.Store.BeginContributionSession(ctx, workspace)
	if err != nil {
		return nil, err
	}
	return &stageMutationSession{ContributionSession: session, mutate: store.mutate}, nil
}

type stageMutationSession struct {
	storage.ContributionSession
	mutate func() error
	once   sync.Once
	err    error
}

func (session *stageMutationSession) StageSource(ctx context.Context, sourcePath string) error {
	if err := session.ContributionSession.StageSource(ctx, sourcePath); err != nil {
		return err
	}
	session.once.Do(func() { session.err = session.mutate() })
	return session.err
}

func TestIndexWorkerInitializationFailureTakesPrecedenceOverExtractionFailure(t *testing.T) {
	previousProcs := runtime.GOMAXPROCS(2)
	t.Cleanup(func() { runtime.GOMAXPROCS(previousProcs) })

	registered, err := registry.Default()
	if err != nil {
		t.Fatalf("create extractor registry: %v", err)
	}
	workerInitializationFailure := errors.New("worker initialization failed")
	extractionFailure := errors.New("source extraction failed")
	extractionStarted := make(chan struct{})
	workerInitializationFailed := make(chan struct{})
	var factoryCalls int
	var factoryMutex sync.Mutex
	_, _, _, err = runPipelineExtraction(
		context.Background(),
		acceptingContributionSession{},
		".",
		[]workspace.Source{{Path: "src/first.ts"}, {Path: "src/second.ts"}},
		registered,
		func(_ string, source workspace.Source, _ registry.Registry, _ *extractionWorkers) (extractedSource, error) {
			close(extractionStarted)
			<-workerInitializationFailed
			return extractedSource{}, fmt.Errorf("extract source %q: %w", source.Path, extractionFailure)
		},
		func() (*extractionWorkers, error) {
			factoryMutex.Lock()
			factoryCalls++
			call := factoryCalls
			factoryMutex.Unlock()
			if call == 1 {
				return newExtractionWorkers()
			}
			<-extractionStarted
			close(workerInitializationFailed)
			return nil, workerInitializationFailure
		},
		nil,
	)
	if !errors.Is(err, workerInitializationFailure) {
		t.Errorf("index error = %v, want worker initialization failure", err)
	}
}

type failingContributionWriteSession struct {
	err error
}

func (failingContributionWriteSession) StageSource(context.Context, string) error { return nil }

func (session failingContributionWriteSession) WriteContribution(context.Context, extractor.Contribution) error {
	return session.err
}

func (failingContributionWriteSession) SealContributions(context.Context) error { return nil }
func (failingContributionWriteSession) ReplaceContributionDependencies(context.Context, []extractor.Contribution) error {
	return nil
}
func (failingContributionWriteSession) WriteWorkspaceFacts(context.Context, graph.Facts) error {
	return nil
}
func (failingContributionWriteSession) SealWorkspaceFacts(context.Context) (storage.FactCounts, error) {
	return storage.FactCounts{}, nil
}
func (failingContributionWriteSession) ResolverProjectionPage(context.Context, storage.Snapshot, storage.ResolverProjectionPageRequest) ([]storage.ResolverProjection, error) {
	return nil, nil
}
func (failingContributionWriteSession) ResolverTarget(context.Context, storage.Snapshot, extractor.ResolverTargetRequest) (extractor.ResolverTarget, bool, error) {
	return extractor.ResolverTarget{}, false, nil
}
func (failingContributionWriteSession) ResolverPackagePage(context.Context, storage.Snapshot, extractor.ResolverPackagePageRequest) ([]extractor.ResolverTarget, error) {
	return nil, nil
}
func (failingContributionWriteSession) Commit(context.Context, storage.CommitRequest) (storage.Snapshot, error) {
	return storage.Snapshot{}, nil
}
func (failingContributionWriteSession) Rollback(context.Context) error { return nil }

type acceptingContributionSession struct {
	failingContributionWriteSession
}

func (acceptingContributionSession) WriteContribution(context.Context, extractor.Contribution) error {
	return nil
}

func emptyContribution(sourcePath string, registered registry.Registry) (extractor.Contribution, error) {
	language, _ := registered.ForPath(sourcePath)
	vocabulary, err := language.Vocabulary()
	if err != nil {
		return extractor.Contribution{}, err
	}
	return extractor.NewContribution(vocabulary, extractor.ContributionInput{
		SourcePath: sourcePath,
		Metadata:   language.Metadata(),
		Facts:      graph.Facts{},
	})
}

func runPipelineExtraction(ctx context.Context, session storage.ContributionSession, root string, sources []workspace.Source, registered registry.Registry, extractSource contributionExtractor, newWorker contributionWorkerFactory, progress func(int)) (contributionExtractionSummary, time.Duration, time.Duration, error) {
	pipeline := &InitialIndexPipeline{root: root, sources: sources, registered: registered}
	return pipeline.extractAndWriteContributions(ctx, session, extractSource, newWorker, progress)
}
