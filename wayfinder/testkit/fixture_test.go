package testkit

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceAndCompareJSON(t *testing.T) {
	workspace := NewWorkspace(t, map[string]string{
		"packages/app/src/main.ts": "export const main = 1;\n",
	})

	contents, err := os.ReadFile(filepath.Join(workspace.Root, "packages", "app", "src", "main.ts"))
	if err != nil {
		t.Fatalf("read fixture source file: %v", err)
	}
	if got, want := string(contents), "export const main = 1;\n"; got != want {
		t.Errorf("fixture source contents = %q, want %q", got, want)
	}

	reference := []byte(`{
		"nodes": [
			{"id": "function:main", "source_file": "/reference/src/main.ts", "source_location": "L1"},
			{"id": "function:helper", "source_file": "/reference/src/helper.ts", "source_location": "L1"}
		],
		"generated_at": "2026-08-14T10:00:00Z",
		"run_id": "reference-run",
		"graphify_metadata": {"engine": "python"}
	}`)
	agent := []byte(`{
		"run_id": "agent-run",
		"nodes": [
			{"source_location": "L1", "source_file": "C:\\agent\\src\\helper.ts", "id": "function:helper"},
			{"source_file": "C:\\agent\\src\\main.ts", "id": "function:main", "source_location": "L1"}
		],
		"generated_at": "2026-08-14T10:05:00Z",
		"graphify_metadata": {"engine": "go"}
	}`)

	if err := CompareJSON(reference, agent); err != nil {
		t.Fatalf("compare equivalent normalized results: %v", err)
	}

	different := []byte(`{"nodes": [{"id": "function:other"}]}`)
	if err := CompareJSON(reference, different); err == nil {
		t.Fatal("compare different results succeeded")
	}
}

func TestWorkspaceWritesAndRemovesContainedFiles(t *testing.T) {
	workspace := NewWorkspace(t, map[string]string{
		"packages/app/src/main.ts":    "export const version = 1;\n",
		"packages/app/src/removed.ts": "export const removed = true;\n",
	})

	workspace.WriteFile(t, "packages/app/src/main.ts", "export const version = 2;\n")
	contents, err := os.ReadFile(filepath.Join(workspace.Root, "packages", "app", "src", "main.ts"))
	if err != nil {
		t.Fatalf("read replaced fixture source file: %v", err)
	}
	if got, want := string(contents), "export const version = 2;\n"; got != want {
		t.Errorf("replaced fixture source contents = %q, want %q", got, want)
	}

	workspace.RemoveFile(t, "packages/app/src/removed.ts")
	if _, err := os.Stat(filepath.Join(workspace.Root, "packages", "app", "src", "removed.ts")); !os.IsNotExist(err) {
		t.Errorf("removed fixture source stat error = %v, want not exist", err)
	}
}

func TestFixturePathRejectsSymbolicLinks(t *testing.T) {
	root := t.TempDir()
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "linked")); err != nil {
		t.Fatalf("create fixture symbolic link: %v", err)
	}

	if _, err := fixturePath(root, "linked/outside.ts"); err == nil {
		t.Fatal("fixture path through symbolic link succeeded")
	}
}
