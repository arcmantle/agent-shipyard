package configuration

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestPathsIncludesWorkspaceWhenUserHomeIsUnavailable(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("USERPROFILE", "")
	workspace := t.TempDir()

	paths := Paths(workspace)
	want := []string{filepath.Join(workspace, filePath)}
	if !reflect.DeepEqual(paths, want) {
		t.Errorf("configuration paths = %q, want %q", paths, want)
	}
}
