package sqlite_test

import (
	"context"
	"path/filepath"
	"testing"

	"agent-wayfinder/storage"
	"agent-wayfinder/storage/conformance"
	"agent-wayfinder/storage/sqlite"
)

func TestStoreConformance(t *testing.T) {
	conformance.RunStoreSuite(t, func(t *testing.T) storage.Store {
		t.Helper()
		store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
		if err != nil {
			t.Fatalf("open SQLite store: %v", err)
		}
		t.Cleanup(func() {
			if err := store.Close(); err != nil {
				t.Errorf("close SQLite store: %v", err)
			}
		})
		return store
	})
}
