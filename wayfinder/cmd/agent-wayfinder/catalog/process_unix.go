//go:build !windows

package catalog

import (
	"os/exec"
	"syscall"
)

func configureBackgroundProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
