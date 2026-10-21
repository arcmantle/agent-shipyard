//go:build !windows

package catalog

import (
	"os/exec"
	"testing"
)

func TestConfigureBackgroundProcessStartsNewSession(t *testing.T) {
	command := exec.Command("true")
	configureBackgroundProcess(command)
	if command.SysProcAttr == nil || !command.SysProcAttr.Setsid {
		t.Fatal("background catalog process is not configured to start a new session")
	}
}
