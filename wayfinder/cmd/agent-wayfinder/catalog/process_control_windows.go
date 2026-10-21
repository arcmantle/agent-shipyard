//go:build windows

package catalog

import (
	"fmt"
	"os"
)

func terminateCatalogProcess(processID int, _ string) (bool, error) {
	if processID <= 0 {
		return false, nil
	}
	process, err := os.FindProcess(processID)
	if err != nil {
		return false, fmt.Errorf("find catalog process: %w", err)
	}
	if err := process.Kill(); err != nil {
		return false, fmt.Errorf("stop catalog process: %w", err)
	}
	return true, nil
}
