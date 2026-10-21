//go:build !windows

package catalog

import (
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func terminateCatalogProcess(processID int, workspace string) (bool, error) {
	if processID <= 0 {
		return false, nil
	}
	output, err := exec.Command("ps", "-p", strconv.Itoa(processID), "-o", "command=").Output()
	var exitError *exec.ExitError
	if errors.As(err, &exitError) || strings.TrimSpace(string(output)) == "" {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect catalog process: %w", err)
	}
	command := string(output)
	if !strings.Contains(command, "catalog") || !strings.Contains(command, workspace) {
		return false, fmt.Errorf("catalog stop: recorded process does not match the catalog workspace")
	}
	if err := syscall.Kill(processID, syscall.SIGTERM); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return false, nil
		}
		return false, fmt.Errorf("stop catalog process: %w", err)
	}
	return true, nil
}
