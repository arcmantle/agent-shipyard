package indexer_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"agent-wayfinder/indexer"
)

func TestAcquireReusesLiveWorkspaceOwner(t *testing.T) {
	root := t.TempDir()

	owner, err := indexer.Acquire(root)
	if err != nil {
		t.Fatalf("acquire first owner: %v", err)
	}
	t.Cleanup(func() {
		if err := owner.Close(); err != nil {
			t.Errorf("close owner: %v", err)
		}
	})

	_, err = indexer.Acquire(root)
	var existing *indexer.ExistingOwnerError
	if !errors.As(err, &existing) {
		t.Fatalf("acquire concurrent owner error = %v, want ExistingOwnerError", err)
	}
	if existing.Endpoint != owner.Endpoint() {
		t.Errorf("existing owner endpoint = %q, want %q", existing.Endpoint, owner.Endpoint())
	}
	if owner.Endpoint() != filepath.Join(root, ".agent-wayfinder", "indexer.sock") {
		t.Errorf("owner endpoint = %q, want workspace-local endpoint", owner.Endpoint())
	}
}

func TestAcquireRecoversStaleOwnerMetadata(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, ".agent-wayfinder")
	if err := os.MkdirAll(state, 0o755); err != nil {
		t.Fatalf("create indexer state directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(state, "indexer.lock"), []byte(`{"endpoint":"stale"}`), 0o600); err != nil {
		t.Fatalf("write stale owner metadata: %v", err)
	}

	owner, err := indexer.Acquire(root)
	if err != nil {
		t.Fatalf("recover stale owner: %v", err)
	}
	t.Cleanup(func() {
		if err := owner.Close(); err != nil {
			t.Errorf("close recovered owner: %v", err)
		}
	})
	if owner.Endpoint() != filepath.Join(root, ".agent-wayfinder", "indexer.sock") {
		t.Errorf("recovered owner endpoint = %q, want workspace-local endpoint", owner.Endpoint())
	}
}

func TestAcquireRecoversCorruptStaleOwnerMetadata(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, ".agent-wayfinder")
	if err := os.MkdirAll(state, 0o755); err != nil {
		t.Fatalf("create indexer state directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(state, "indexer.lock"), []byte(`{"endpoint":`), 0o600); err != nil {
		t.Fatalf("write corrupt stale owner metadata: %v", err)
	}

	owner, err := indexer.Acquire(root)
	if err != nil {
		t.Fatalf("recover corrupt stale owner metadata: %v", err)
	}
	t.Cleanup(func() {
		if err := owner.Close(); err != nil {
			t.Errorf("close recovered owner: %v", err)
		}
	})
}

func TestAcquireSucceedsAfterOwnerClose(t *testing.T) {
	root := t.TempDir()
	firstOwner, err := indexer.Acquire(root)
	if err != nil {
		t.Fatalf("acquire first owner: %v", err)
	}
	if err := firstOwner.Close(); err != nil {
		t.Fatalf("close first owner: %v", err)
	}

	secondOwner, err := indexer.Acquire(root)
	if err != nil {
		t.Fatalf("acquire owner after close: %v", err)
	}
	t.Cleanup(func() {
		if err := secondOwner.Close(); err != nil {
			t.Errorf("close second owner: %v", err)
		}
	})
	if secondOwner.Endpoint() != firstOwner.Endpoint() {
		t.Errorf("owner endpoint after close = %q, want %q", secondOwner.Endpoint(), firstOwner.Endpoint())
	}
}

func TestManagerStartsWorkspaceIndexerAndReportsStatus(t *testing.T) {
	root := t.TempDir()
	manager := indexer.NewManager()
	t.Cleanup(func() {
		if err := manager.Stop(root); err != nil {
			t.Errorf("stop manager: %v", err)
		}
	})

	status, err := manager.Start(root)
	if err != nil {
		t.Fatalf("start workspace indexer: %v", err)
	}
	if !status.Running {
		t.Error("status running = false, want true")
	}
	if status.Workspace != root {
		t.Errorf("status workspace = %q, want %q", status.Workspace, root)
	}
	if status.Endpoint != filepath.Join(root, ".agent-wayfinder", "indexer.sock") {
		t.Errorf("status endpoint = %q, want workspace-local endpoint", status.Endpoint)
	}
	if status.Activity.IsZero() {
		t.Error("status activity is zero")
	}
	if status.IdleDeadline.IsZero() {
		t.Error("status idle deadline is zero")
	}
	if status.QueuedPaths == nil {
		t.Error("status queued paths = nil, want empty list")
	}
}

func TestManagerReusesWorkspaceIndexerAndRefreshesActivity(t *testing.T) {
	root := t.TempDir()
	manager := indexer.NewManager()
	t.Cleanup(func() {
		if err := manager.Stop(root); err != nil {
			t.Errorf("stop manager: %v", err)
		}
	})

	first, err := manager.Start(root)
	if err != nil {
		t.Fatalf("start first workspace indexer: %v", err)
	}
	second, err := manager.Start(root)
	if err != nil {
		t.Fatalf("reuse workspace indexer: %v", err)
	}
	if second.Endpoint != first.Endpoint {
		t.Errorf("reused endpoint = %q, want %q", second.Endpoint, first.Endpoint)
	}
	if second.Activity.Before(first.Activity) {
		t.Errorf("reused activity = %s, want at or after %s", second.Activity, first.Activity)
	}

	status, found, err := manager.Status(root)
	if err != nil {
		t.Fatalf("get workspace indexer status: %v", err)
	}
	if !found || !status.Running {
		t.Errorf("status = %+v, found = %t, want running workspace indexer", status, found)
	}
}

func TestManagerStopsWorkspaceIndexerAndReleasesOwner(t *testing.T) {
	root := t.TempDir()
	manager := indexer.NewManager()
	if _, err := manager.Start(root); err != nil {
		t.Fatalf("start workspace indexer: %v", err)
	}
	if err := manager.Stop(root); err != nil {
		t.Fatalf("stop workspace indexer: %v", err)
	}

	status, found, err := manager.Status(root)
	if err != nil {
		t.Fatalf("get stopped workspace indexer status: %v", err)
	}
	if found || status.Running {
		t.Errorf("status = %+v, found = %t, want stopped workspace indexer", status, found)
	}
	owner, err := indexer.Acquire(root)
	if err != nil {
		t.Fatalf("acquire owner after graceful stop: %v", err)
	}
	t.Cleanup(func() {
		if err := owner.Close(); err != nil {
			t.Errorf("close owner: %v", err)
		}
	})
}

func TestManagerPublishesNormalizedCoalescedEventBatch(t *testing.T) {
	root := t.TempDir()
	batches := make(chan indexer.Batch, 1)
	manager := indexer.NewManager(
		indexer.WithPublisher(func(batch indexer.Batch) error {
			batches <- batch
			return nil
		}),
		indexer.WithPublishThrottle(time.Millisecond),
	)
	t.Cleanup(func() {
		if err := manager.Stop(root); err != nil {
			t.Errorf("stop manager: %v", err)
		}
	})
	if _, err := manager.Start(root); err != nil {
		t.Fatalf("start workspace indexer: %v", err)
	}

	if err := manager.Enqueue(root,
		indexer.Event{Path: "src/main.ts"},
		indexer.Event{Path: filepath.Join(root, "src", "main.ts")},
		indexer.Event{Path: "src/util.ts"},
	); err != nil {
		t.Fatalf("enqueue file events: %v", err)
	}

	select {
	case batch := <-batches:
		if batch.Workspace != root {
			t.Errorf("batch workspace = %q, want %q", batch.Workspace, root)
		}
		if got, want := batch.Paths, []string{"src/main.ts", "src/util.ts"}; !equalStrings(got, want) {
			t.Errorf("batch paths = %q, want %q", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for coalesced event batch")
	}
}

func TestManagerPublishesTrailingBatchWithoutConcurrentPublish(t *testing.T) {
	root := t.TempDir()
	started := make(chan indexer.Batch, 2)
	completeFirst := make(chan struct{})
	completed := make(chan indexer.Batch, 2)
	var publisherMu sync.Mutex
	activePublishes := 0
	manager := indexer.NewManager(
		indexer.WithPublisher(func(batch indexer.Batch) error {
			publisherMu.Lock()
			activePublishes++
			if activePublishes != 1 {
				publisherMu.Unlock()
				t.Errorf("active publishes = %d, want 1", activePublishes)
				return nil
			}
			publisherMu.Unlock()

			started <- batch
			if batch.Paths[0] == "first.ts" {
				<-completeFirst
			}
			completed <- batch

			publisherMu.Lock()
			activePublishes--
			publisherMu.Unlock()
			return nil
		}),
		indexer.WithPublishThrottle(time.Millisecond),
	)
	t.Cleanup(func() {
		if err := manager.Stop(root); err != nil {
			t.Errorf("stop manager: %v", err)
		}
	})
	if _, err := manager.Start(root); err != nil {
		t.Fatalf("start workspace indexer: %v", err)
	}
	if err := manager.Enqueue(root, indexer.Event{Path: "first.ts"}); err != nil {
		t.Fatalf("enqueue first event: %v", err)
	}

	select {
	case batch := <-started:
		if got, want := batch.Paths, []string{"first.ts"}; !equalStrings(got, want) {
			t.Errorf("first batch paths = %q, want %q", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first publish")
	}
	if err := manager.Enqueue(root,
		indexer.Event{Path: "second.ts"},
		indexer.Event{Path: "third.ts"},
	); err != nil {
		t.Fatalf("enqueue trailing events: %v", err)
	}
	close(completeFirst)

	for _, want := range [][]string{{"first.ts"}, {"second.ts", "third.ts"}} {
		select {
		case batch := <-completed:
			if !equalStrings(batch.Paths, want) {
				t.Errorf("published batch paths = %q, want %q", batch.Paths, want)
			}
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for batch %q", want)
		}
	}
}

func TestManagerRecoversFromPublisherPanic(t *testing.T) {
	root := t.TempDir()
	published := make(chan indexer.Batch, 1)
	publishStarted := make(chan struct{})
	allowPanic := make(chan struct{})
	first := true
	manager := indexer.NewManager(
		indexer.WithPublisher(func(batch indexer.Batch) error {
			if first {
				first = false
				close(publishStarted)
				<-allowPanic
				panic("publisher failure")
			}
			published <- batch
			return nil
		}),
		indexer.WithPublishThrottle(time.Millisecond),
		indexer.WithRetryBackoff(time.Millisecond, time.Millisecond),
	)
	t.Cleanup(func() {
		select {
		case <-allowPanic:
		default:
			close(allowPanic)
		}
		if err := manager.Stop(root); err != nil {
			t.Errorf("stop manager: %v", err)
		}
	})
	if _, err := manager.Start(root); err != nil {
		t.Fatalf("start workspace indexer: %v", err)
	}
	if err := manager.Enqueue(root, indexer.Event{Path: "first.ts"}); err != nil {
		t.Fatalf("enqueue first event: %v", err)
	}

	select {
	case <-publishStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first publish")
	}
	if err := manager.Enqueue(root, indexer.Event{Path: "second.ts"}); err != nil {
		t.Fatalf("enqueue event during first publish: %v", err)
	}
	close(allowPanic)
	select {
	case batch := <-published:
		if got, want := batch.Paths, []string{"first.ts", "second.ts"}; !equalStrings(got, want) {
			t.Errorf("recovery batch paths = %q, want %q", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for batch after publisher panic")
	}
}

func TestManagerRetriesFailedBatchAndRetainsItsPaths(t *testing.T) {
	root := t.TempDir()
	published := make(chan indexer.Batch, 1)
	attempts := 0
	manager := indexer.NewManager(
		indexer.WithPublisher(func(batch indexer.Batch) error {
			attempts++
			if attempts == 1 {
				return errors.New("temporary publisher failure")
			}
			published <- batch
			return nil
		}),
		indexer.WithPublishThrottle(time.Millisecond),
		indexer.WithRetryBackoff(time.Millisecond, time.Millisecond),
	)
	t.Cleanup(func() {
		if err := manager.Stop(root); err != nil {
			t.Errorf("stop manager: %v", err)
		}
	})
	if _, err := manager.Start(root); err != nil {
		t.Fatalf("start workspace indexer: %v", err)
	}
	if err := manager.Enqueue(root, indexer.Event{Path: "retry.ts"}); err != nil {
		t.Fatalf("enqueue retry event: %v", err)
	}

	select {
	case batch := <-published:
		if got, want := batch.Paths, []string{"retry.ts"}; !equalStrings(got, want) {
			t.Errorf("retried batch paths = %q, want %q", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for retry")
	}

	status, found, err := manager.Status(root)
	if err != nil {
		t.Fatalf("get status after retry: %v", err)
	}
	if !found {
		t.Fatal("workspace indexer is not running after retry")
	}
	if status.Error != "" {
		t.Errorf("status error = %q, want cleared after successful retry", status.Error)
	}
}

func TestManagerDeduplicatesPathsQueuedDuringFailedPublish(t *testing.T) {
	root := t.TempDir()
	publishStarted := make(chan struct{})
	allowFailure := make(chan struct{})
	published := make(chan indexer.Batch, 1)
	attempts := 0
	manager := indexer.NewManager(
		indexer.WithPublisher(func(batch indexer.Batch) error {
			attempts++
			if attempts == 1 {
				close(publishStarted)
				<-allowFailure
				return errors.New("temporary publisher failure")
			}
			published <- batch
			return nil
		}),
		indexer.WithPublishThrottle(time.Millisecond),
		indexer.WithRetryBackoff(time.Millisecond, time.Millisecond),
	)
	t.Cleanup(func() {
		if err := manager.Stop(root); err != nil {
			t.Errorf("stop manager: %v", err)
		}
	})
	if _, err := manager.Start(root); err != nil {
		t.Fatalf("start workspace indexer: %v", err)
	}
	if err := manager.Enqueue(root, indexer.Event{Path: "retry.ts"}); err != nil {
		t.Fatalf("enqueue retry event: %v", err)
	}
	select {
	case <-publishStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for failed publish")
	}
	if err := manager.Enqueue(root, indexer.Event{Path: "retry.ts"}); err != nil {
		t.Fatalf("enqueue duplicate retry event: %v", err)
	}
	close(allowFailure)

	select {
	case batch := <-published:
		if got, want := batch.Paths, []string{"retry.ts"}; !equalStrings(got, want) {
			t.Errorf("retried batch paths = %q, want %q", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for deduplicated retry")
	}
}

func TestManagerReconcilesPathsThroughPublishQueue(t *testing.T) {
	root := t.TempDir()
	published := make(chan indexer.Batch, 1)
	manager := indexer.NewManager(
		indexer.WithPublisher(func(batch indexer.Batch) error {
			published <- batch
			return nil
		}),
		indexer.WithPublishThrottle(time.Millisecond),
		indexer.WithReconciler(func(string) ([]indexer.Event, error) {
			return []indexer.Event{{Path: "recovered.ts"}}, nil
		}),
		indexer.WithReconciliationInterval(time.Millisecond),
	)
	t.Cleanup(func() {
		if err := manager.Stop(root); err != nil {
			t.Errorf("stop manager: %v", err)
		}
	})
	if _, err := manager.Start(root); err != nil {
		t.Fatalf("start workspace indexer: %v", err)
	}

	select {
	case batch := <-published:
		if got, want := batch.Paths, []string{"recovered.ts"}; !equalStrings(got, want) {
			t.Errorf("reconciled batch paths = %q, want %q", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for reconciled batch")
	}
}

func TestManagerReportsReconciliationFailure(t *testing.T) {
	root := t.TempDir()
	manager := indexer.NewManager(
		indexer.WithReconciler(func(string) ([]indexer.Event, error) {
			return nil, errors.New("scan failed")
		}),
		indexer.WithReconciliationInterval(time.Millisecond),
	)
	t.Cleanup(func() {
		if err := manager.Stop(root); err != nil {
			t.Errorf("stop manager: %v", err)
		}
	})
	if _, err := manager.Start(root); err != nil {
		t.Fatalf("start workspace indexer: %v", err)
	}

	deadline := time.After(time.Second)
	for {
		status, found, err := manager.Status(root)
		if err != nil {
			t.Fatalf("get status after reconciliation failure: %v", err)
		}
		if found && status.Error == "reconcile workspace: scan failed" {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("status error = %q, want reconciliation failure", status.Error)
		case <-time.After(time.Millisecond):
		}
	}
}

func TestServerStopsIndexerAfterIdleTimeout(t *testing.T) {
	root, err := os.MkdirTemp("", "ag-")
	if err != nil {
		t.Fatalf("create short workspace path: %v", err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Errorf("remove workspace: %v", err)
		}
	})
	server := indexer.NewServer(indexer.NewManager(indexer.WithIdleTimeout(time.Millisecond)))
	finished := make(chan error, 1)
	go func() {
		finished <- server.Serve(root)
	}()

	select {
	case err := <-finished:
		if err != nil {
			t.Fatalf("serve workspace indexer: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("workspace indexer did not stop after idle timeout")
	}

	owner, err := indexer.Acquire(root)
	if err != nil {
		t.Fatalf("acquire owner after idle shutdown: %v", err)
	}
	t.Cleanup(func() {
		if err := owner.Close(); err != nil {
			t.Errorf("close owner: %v", err)
		}
	})
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

func TestServerReportsStatusAndStopsWorkspaceIndexer(t *testing.T) {
	root, err := os.MkdirTemp("", "ag-")
	if err != nil {
		t.Fatalf("create short workspace path: %v", err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Errorf("remove workspace: %v", err)
		}
	})
	server := indexer.NewServer(indexer.NewManager())
	finished := make(chan error, 1)
	go func() {
		finished <- server.Serve(root)
	}()

	context, cancel := context.WithTimeout(context.Background(), time.Second)
	t.Cleanup(cancel)
	var status indexer.Status
	for {
		var err error
		status, err = indexer.Request(context, root, indexer.StatusCommand)
		if err == nil {
			break
		}
		if context.Err() != nil {
			t.Fatalf("request workspace indexer status: %v", err)
		}
		time.Sleep(time.Millisecond)
	}
	if !status.Running || status.Workspace != root {
		t.Errorf("status = %+v, want running workspace indexer", status)
	}

	if _, err := indexer.Request(context, root, indexer.StopCommand); err != nil {
		t.Fatalf("stop workspace indexer: %v", err)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatalf("serve workspace indexer: %v", err)
		}
	case <-context.Done():
		t.Fatal("workspace indexer did not stop")
	}

	owner, err := indexer.Acquire(root)
	if err != nil {
		t.Fatalf("acquire owner after server stop: %v", err)
	}
	t.Cleanup(func() {
		if err := owner.Close(); err != nil {
			t.Errorf("close owner: %v", err)
		}
	})
}
