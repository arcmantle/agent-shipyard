package indexer

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const (
	stateDirectory = ".agent-wayfinder"
	lockFileName   = "indexer.lock"
	endpointName   = "indexer.sock"
)

type Owner struct {
	lock     *os.File
	endpoint string
}

type ExistingOwnerError struct {
	Endpoint string
}

func (err *ExistingOwnerError) Error() string {
	return fmt.Sprintf("workspace indexer is already running at %q", err.Endpoint)
}

func Acquire(root string) (*Owner, error) {
	workspace, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace root: %w", err)
	}
	statePath := filepath.Join(workspace, stateDirectory)
	if err := os.MkdirAll(statePath, 0o755); err != nil {
		return nil, fmt.Errorf("create indexer state directory: %w", err)
	}

	endpoint := filepath.Join(statePath, endpointName)
	lock, err := os.OpenFile(filepath.Join(statePath, lockFileName), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open workspace indexer lock: %w", err)
	}
	if err := lockFile(lock); err != nil {
		if isLockBlocked(err) {
			metadata := ownerMetadata{Endpoint: endpoint}
			if decodeErr := json.NewDecoder(lock).Decode(&metadata); decodeErr != nil && !errors.Is(decodeErr, io.EOF) {
				_ = lock.Close()
				return nil, fmt.Errorf("read active workspace indexer identity: %w", decodeErr)
			}
			_ = lock.Close()
			return nil, &ExistingOwnerError{Endpoint: metadata.Endpoint}
		}
		_ = lock.Close()
		return nil, fmt.Errorf("lock workspace indexer: %w", err)
	}

	metadata, err := json.Marshal(ownerMetadata{Endpoint: endpoint})
	if err != nil {
		_ = unlockFile(lock)
		_ = lock.Close()
		return nil, fmt.Errorf("encode workspace indexer identity: %w", err)
	}
	if err := lock.Truncate(0); err != nil {
		_ = unlockFile(lock)
		_ = lock.Close()
		return nil, fmt.Errorf("clear workspace indexer identity: %w", err)
	}
	if _, err := lock.Seek(0, 0); err != nil {
		_ = unlockFile(lock)
		_ = lock.Close()
		return nil, fmt.Errorf("seek workspace indexer identity: %w", err)
	}
	if _, err := lock.Write(metadata); err != nil {
		_ = unlockFile(lock)
		_ = lock.Close()
		return nil, fmt.Errorf("write workspace indexer identity: %w", err)
	}
	return &Owner{lock: lock, endpoint: endpoint}, nil
}

func (owner *Owner) Endpoint() string {
	return owner.endpoint
}

func (owner *Owner) Close() error {
	if owner == nil || owner.lock == nil {
		return nil
	}
	if err := unlockFile(owner.lock); err != nil {
		return fmt.Errorf("unlock workspace indexer: %w", err)
	}
	err := owner.lock.Close()
	owner.lock = nil
	if err != nil {
		return fmt.Errorf("close workspace indexer lock: %w", err)
	}
	return nil
}

type ownerMetadata struct {
	Endpoint string `json:"endpoint"`
}
