package indexer

import (
	"fmt"
	"path/filepath"
	"time"
)

type Event struct {
	Path string
}

type Batch struct {
	Workspace string
	Paths     []string
}

type Publisher func(Batch) error

type Reconciler func(workspace string) ([]Event, error)

type ManagerOption func(*Manager)

func WithPublisher(publisher Publisher) ManagerOption {
	return func(manager *Manager) {
		manager.publisher = publisher
	}
}

func WithPublishThrottle(throttle time.Duration) ManagerOption {
	return func(manager *Manager) {
		if throttle > 0 {
			manager.throttle = throttle
		}
	}
}

func WithIdleTimeout(timeout time.Duration) ManagerOption {
	return func(manager *Manager) {
		if timeout > 0 {
			manager.idle = timeout
		}
	}
}

func WithRetryBackoff(base, maximum time.Duration) ManagerOption {
	return func(manager *Manager) {
		if base > 0 {
			manager.retryBase = base
		}
		if maximum >= manager.retryBase {
			manager.retryMax = maximum
		}
	}
}

func WithReconciler(reconciler Reconciler) ManagerOption {
	return func(manager *Manager) {
		manager.reconciler = reconciler
	}
}

func WithReconciliationInterval(interval time.Duration) ManagerOption {
	return func(manager *Manager) {
		if interval > 0 {
			manager.reconcile = interval
		}
	}
}

func (manager *Manager) Enqueue(root string, events ...Event) error {
	workspace, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("enqueue workspace events: resolve workspace root: %w", err)
	}

	manager.mu.Lock()
	defer manager.mu.Unlock()
	worker, found := manager.workers[workspace]
	if !found || worker.stopping {
		return fmt.Errorf("enqueue workspace events: workspace indexer is not running")
	}
	for _, event := range events {
		path, err := normalizeEventPath(workspace, event.Path)
		if err != nil {
			return fmt.Errorf("enqueue workspace events: %w", err)
		}
		if _, found := worker.pendingSet[path]; found {
			continue
		}
		worker.pendingSet[path] = struct{}{}
		worker.pending = append(worker.pending, path)
	}
	worker.status.QueuedPaths = append([]string{}, worker.pending...)
	if len(worker.pending) > 0 && !worker.publishing && worker.timer == nil {
		manager.schedulePublishLocked(workspace, worker)
	}
	return nil
}

func (manager *Manager) schedulePublishLocked(workspace string, worker *worker) {
	manager.scheduleAfterLocked(workspace, worker, manager.throttle)
}

func (manager *Manager) scheduleAfterLocked(workspace string, worker *worker, delay time.Duration) {
	worker.timer = time.AfterFunc(delay, func() {
		manager.publish(workspace)
	})
}

func (manager *Manager) scheduleReconciliationLocked(workspace string, worker *worker) {
	worker.reconcileTimer = time.AfterFunc(manager.reconcile, func() {
		manager.reconcileWorkspace(workspace)
	})
}

func (manager *Manager) reconcileWorkspace(workspace string) {
	manager.mu.Lock()
	worker, found := manager.workers[workspace]
	if !found || worker.stopping || manager.reconciler == nil {
		manager.mu.Unlock()
		return
	}
	worker.reconcileTimer = nil
	reconciler := manager.reconciler
	manager.mu.Unlock()

	events, err := reconciler(workspace)
	if err == nil && len(events) > 0 {
		err = manager.Enqueue(workspace, events...)
	}

	manager.mu.Lock()
	worker, found = manager.workers[workspace]
	if found && !worker.stopping {
		if err != nil {
			worker.status.Error = fmt.Sprintf("reconcile workspace: %v", err)
		}
		manager.scheduleReconciliationLocked(workspace, worker)
	}
	manager.mu.Unlock()
}

func (manager *Manager) publish(workspace string) {
	manager.mu.Lock()
	worker, found := manager.workers[workspace]
	if !found || worker.stopping || worker.publishing || len(worker.pending) == 0 {
		manager.mu.Unlock()
		return
	}
	paths := append([]string{}, worker.pending...)
	worker.pending = nil
	worker.pendingSet = make(map[string]struct{})
	worker.status.QueuedPaths = []string{}
	worker.timer = nil
	worker.publishing = true
	worker.publishDone = make(chan struct{})
	manager.mu.Unlock()

	err := callPublisher(manager.publisher, Batch{Workspace: workspace, Paths: paths})

	manager.mu.Lock()
	worker.publishing = false
	if err != nil {
		worker.status.Error = err.Error()
		worker.pending = uniquePaths(append(paths, worker.pending...))
		worker.pendingSet = make(map[string]struct{}, len(worker.pending))
		for _, path := range worker.pending {
			worker.pendingSet[path] = struct{}{}
		}
		worker.status.QueuedPaths = append([]string{}, worker.pending...)
		if worker.retryDelay == 0 {
			worker.retryDelay = manager.retryBase
		} else {
			worker.retryDelay *= 2
			if worker.retryDelay > manager.retryMax {
				worker.retryDelay = manager.retryMax
			}
		}
	} else {
		worker.status.Error = ""
		worker.retryDelay = 0
	}
	close(worker.publishDone)
	if len(worker.pending) > 0 && !worker.stopping && worker.timer == nil {
		delay := manager.throttle
		if err != nil {
			delay = worker.retryDelay
		}
		manager.scheduleAfterLocked(workspace, worker, delay)
	}
	manager.mu.Unlock()
}

func callPublisher(publisher Publisher, batch Batch) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("publish batch: %v", recovered)
		}
	}()
	return publisher(batch)
}

func normalizeEventPath(workspace, path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("event path is required")
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(workspace, path)
	}
	path = filepath.Clean(path)
	relative, err := filepath.Rel(workspace, path)
	if err != nil {
		return "", fmt.Errorf("resolve event path: %w", err)
	}
	if relative == "." || relative == ".." || filepath.IsAbs(relative) || isParentPath(relative) {
		return "", fmt.Errorf("event path %q is outside workspace", path)
	}
	return filepath.ToSlash(relative), nil
}

func isParentPath(path string) bool {
	prefix := ".." + string(filepath.Separator)
	return len(path) > len(prefix) && path[:len(prefix)] == prefix
}

func uniquePaths(paths []string) []string {
	seen := make(map[string]struct{}, len(paths))
	unique := make([]string, 0, len(paths))
	for _, path := range paths {
		if _, found := seen[path]; found {
			continue
		}
		seen[path] = struct{}{}
		unique = append(unique, path)
	}
	return unique
}
