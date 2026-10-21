package storage_test

import (
	"path/filepath"
	"testing"

	"agent-wayfinder/testkit"
)

func TestOnlySQLiteAdapterUsesSQLiteImplementationDetails(t *testing.T) {
	root := filepath.Clean("..")
	if err := testkit.CheckStorageAdapterBoundary(root); err != nil {
		t.Fatalf("check storage adapter boundary: %v", err)
	}
}
