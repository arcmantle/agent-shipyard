package configuration

import (
	"os"
	"path/filepath"
)

const filePath = ".agent-wayfinder/config.json"

func Paths(workspaceRoot string) []string {
	paths := make([]string, 0, 2)
	home, err := os.UserHomeDir()
	if err == nil && home != "" {
		paths = append(paths, filepath.Join(home, filePath))
	}
	return append(paths, filepath.Join(workspaceRoot, filePath))
}
