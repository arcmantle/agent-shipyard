//go:build windows

package catalog

import (
	"os/exec"
	"testing"
)

func TestConfigureBackgroundProcessDetachesChild(t *testing.T) {
	command := exec.Command("cmd.exe")
	configureBackgroundProcess(command)
	want := uint32(detachedProcess | createNewProcessGroup)
	if command.SysProcAttr == nil || command.SysProcAttr.CreationFlags != want {
		t.Fatalf("background catalog process flags = %#x, want %#x", command.SysProcAttr.CreationFlags, want)
	}
}
