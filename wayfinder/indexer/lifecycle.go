package indexer

import (
	"fmt"
	"path/filepath"
	"sync"
	"time"
)

const (
	idleTimeout     = 5 * time.Minute
	publishThrottle = 250 * time.Millisecond
	retryBackoff    = time.Second
	maxRetryBackoff = time.Minute
	reconcilePeriod = 5 * time.Minute
)

type Progress struct {
	Completed int `json:"completed"`
	Total     int `json:"total"`
}

type Status struct {
	Workspace    string    `json:"workspace"`
	Endpoint     string    `json:"endpoint"`
	Running      bool      `json:"running"`
	Activity     time.Time `json:"activity"`
	Progress     Progress  `json:"progress"`
	QueuedPaths  []string  `json:"queuedPaths"`
	Version      int       `json:"version"`
	Error        string    `json:"error"`
	IdleDeadline time.Time `json:"idleDeadline"`
}

type Manager struct {
	mu         sync.Mutex
	workers    map[string]*worker
	publisher  Publisher
	throttle   time.Duration
	idle       time.Duration
	retryBase  time.Duration
	retryMax   time.Duration
	reconciler Reconciler
	reconcile  time.Duration
}

type worker struct {
	owner          *Owner
	status         Status
	pending        []string
	pendingSet     map[string]struct{}
	timer          *time.Timer
	publishing     bool
	stopping       bool
	publishDone    chan struct{}
	retryDelay     time.Duration
	reconcileTimer *time.Timer
}

func NewManager(options ...ManagerOption) *Manager {
	manager := &Manager{
		workers:   make(map[string]*worker),
		publisher: func(Batch) error { return nil },
		throttle:  publishThrottle,
		idle:      idleTimeout,
		retryBase: retryBackoff,
		retryMax:  maxRetryBackoff,
		reconcile: reconcilePeriod,
	}
	for _, option := range options {
		option(manager)
	}
	if manager.publisher == nil {
		manager.publisher = func(Batch) error { return nil }
	}
	return manager
}

func (manager *Manager) Start(root string) (Status, error) {
	workspace, err := filepath.Abs(root)
	if err != nil {
		return Status{}, fmt.Errorf("start workspace indexer: resolve workspace root: %w", err)
	}

	manager.mu.Lock()
	defer manager.mu.Unlock()

	if existing, found := manager.workers[workspace]; found {
		existing.status.Activity = time.Now().UTC()
		existing.status.IdleDeadline = existing.status.Activity.Add(manager.idle)
		return copyStatus(existing.status), nil
	}

	owner, err := Acquire(workspace)
	if err != nil {
		return Status{}, fmt.Errorf("start workspace indexer: %w", err)
	}
	now := time.Now().UTC()
	status := Status{
		Workspace:    workspace,
		Endpoint:     owner.Endpoint(),
		Running:      true,
		Activity:     now,
		QueuedPaths:  []string{},
		IdleDeadline: now.Add(manager.idle),
	}
	worker := &worker{
		owner:      owner,
		status:     status,
		pendingSet: make(map[string]struct{}),
	}
	manager.workers[workspace] = worker
	if manager.reconciler != nil {
		manager.scheduleReconciliationLocked(workspace, worker)
	}
	return copyStatus(status), nil
}

func (manager *Manager) Status(root string) (Status, bool, error) {
	workspace, err := filepath.Abs(root)
	if err != nil {
		return Status{}, false, fmt.Errorf("get workspace indexer status: resolve workspace root: %w", err)
	}

	manager.mu.Lock()
	defer manager.mu.Unlock()
	worker, found := manager.workers[workspace]
	if !found {
		return Status{Workspace: workspace, QueuedPaths: []string{}}, false, nil
	}
	return copyStatus(worker.status), true, nil
}

func (manager *Manager) Touch(root string) (Status, bool, error) {
	workspace, err := filepath.Abs(root)
	if err != nil {
		return Status{}, false, fmt.Errorf("update workspace indexer activity: resolve workspace root: %w", err)
	}

	manager.mu.Lock()
	defer manager.mu.Unlock()
	worker, found := manager.workers[workspace]
	if !found {
		return Status{Workspace: workspace, QueuedPaths: []string{}}, false, nil
	}
	worker.status.Activity = time.Now().UTC()
	worker.status.IdleDeadline = worker.status.Activity.Add(manager.idle)
	return copyStatus(worker.status), true, nil
}

func (manager *Manager) Stop(root string) error {
	workspace, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("stop workspace indexer: resolve workspace root: %w", err)
	}

	for {
		manager.mu.Lock()
		worker, found := manager.workers[workspace]
		if !found {
			manager.mu.Unlock()
			return nil
		}
		worker.stopping = true
		if worker.timer != nil {
			worker.timer.Stop()
			worker.timer = nil
		}
		if worker.reconcileTimer != nil {
			worker.reconcileTimer.Stop()
			worker.reconcileTimer = nil
		}
		if worker.publishing {
			done := worker.publishDone
			manager.mu.Unlock()
			<-done
			continue
		}
		if err := worker.owner.Close(); err != nil {
			worker.stopping = false
			manager.mu.Unlock()
			return fmt.Errorf("stop workspace indexer: %w", err)
		}
		delete(manager.workers, workspace)
		manager.mu.Unlock()
		return nil
	}
}

func copyStatus(status Status) Status {
	status.QueuedPaths = append([]string{}, status.QueuedPaths...)
	return status
}
