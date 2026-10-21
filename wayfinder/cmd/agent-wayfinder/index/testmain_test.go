package index

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

var cliBinary string

func TestMain(m *testing.M) {
	home, err := os.MkdirTemp("", "agent-wayfinder-test-home-")
	if err != nil {
		panic(err)
	}
	if err := os.Setenv("HOME", home); err != nil {
		panic(err)
	}
	if err := os.Setenv("USERPROFILE", home); err != nil {
		panic(err)
	}
	if err := os.Chdir(".."); err != nil {
		panic(err)
	}
	binaryDirectory, err := os.MkdirTemp("", "agent-wayfinder-test-cli-")
	if err != nil {
		panic(err)
	}
	cliBinary = filepath.Join(binaryDirectory, "agent-wayfinder")
	if output, err := exec.Command("go", "build", "-o", cliBinary, ".").CombinedOutput(); err != nil {
		panic(string(output))
	}
	code := m.Run()
	_ = os.RemoveAll(home)
	_ = os.RemoveAll(binaryDirectory)
	os.Exit(code)
}

func cliCommand(arguments ...string) *exec.Cmd {
	return exec.Command(cliBinary, arguments...)
}
