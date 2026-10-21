package mcp

import (
	"os"
	"testing"
)

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
	code := m.Run()
	_ = os.RemoveAll(home)
	os.Exit(code)
}
