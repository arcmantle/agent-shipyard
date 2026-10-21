//go:build !windows

package catalog

import (
	"os/exec"
	"strconv"
	"strings"
)

func readCatalogProcessUsage(processID int) *catalogProcessUsage {
	if processID <= 0 {
		return nil
	}
	output, err := exec.Command("ps", "-p", strconv.Itoa(processID), "-o", "%cpu=", "-o", "rss=").Output()
	if err != nil {
		return nil
	}
	fields := strings.Fields(string(output))
	if len(fields) != 2 {
		return nil
	}
	cpuPercent, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || cpuPercent < 0 {
		return nil
	}
	residentMemoryKiB, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return nil
	}
	return &catalogProcessUsage{CPUPercent: cpuPercent, ResidentMemoryBytes: residentMemoryKiB * 1024}
}
