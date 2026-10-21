package testkit

import (
	"strings"
	"testing"
)

func TestCheckStorageAdapterBoundary(t *testing.T) {
	allowed := NewWorkspace(t, map[string]string{
		".benchmark-output/copy/source/go.mod": "module copied-workspace\n",
		".benchmark-output/copy/source/storage/sqlite/store.go": `package sqlite

import "database/sql"

type Store struct {
	database *sql.DB
}
`,
		"storage/service.go": `package storage

type Service struct{}
`,
		"storage/sqlite/store.go": `package sqlite

import "database/sql"

type Store struct {
	database *sql.DB
}
`,
	})

	if err := CheckStorageAdapterBoundary(allowed.Root); err != nil {
		t.Fatalf("check allowed SQLite adapter use: %v", err)
	}

	violation := NewWorkspace(t, map[string]string{
		".benchmark-output/copy/source/go.mod": "module copied-workspace\n",
		".benchmark-output/copy/source/storage/service.go": `package storage

import "database/sql"

type Service struct {
	database *sql.DB
}
`,
		"storage/service.go": `package storage

import (
	"database/sql"
	_ "github.com/arcmantle/go-sqlite3"
)

type Service struct {
	database *sql.DB
}
`,
	})

	err := CheckStorageAdapterBoundary(violation.Root)
	if err == nil {
		t.Fatal("check accepted SQLite details outside the adapter")
	}
	for _, want := range []string{"storage/service.go", "database/sql", "github.com/arcmantle/go-sqlite3", ".benchmark-output/copy/source/storage/service.go"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("boundary error = %q, want %q", err, want)
		}
	}
}
