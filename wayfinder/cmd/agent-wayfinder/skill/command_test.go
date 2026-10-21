package skill

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"agent-wayfinder/cli"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"
)

func runSkillCommand(arguments []string, standardOutput, standardError *strings.Builder) int {
	if len(arguments) == 0 || arguments[0] != "install" {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("expected install command"))
	}
	exitCode := 0
	command := New(standardOutput, standardError, &exitCode)
	command.SetOut(standardOutput)
	command.SetErr(standardError)
	command.SetArgs(arguments[1:])
	if err := command.Execute(); err != nil {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError(err.Error()))
	}
	return exitCode
}

func TestInstallCommandWritesUserSkill(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	standardOutput := &strings.Builder{}
	standardError := &strings.Builder{}

	if exitCode := runSkillCommand([]string{"install"}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run install command: exit code %d, error %s", exitCode, standardError.String())
	}

	skillDirectory := filepath.Join(home, ".agents", "skills", "agent-wayfinder")
	assertFileContains(t, filepath.Join(skillDirectory, "SKILL.md"), "name: agent-wayfinder")
	assertFileContains(t, filepath.Join(skillDirectory, "references", "commands.md"), "# Agent Wayfinder Command Reference")
	if output := standardOutput.String(); !strings.Contains(output, skillDirectory) {
		t.Errorf("install output = %q, want destination %q", output, skillDirectory)
	}

	skillPath := filepath.Join(skillDirectory, "SKILL.md")
	if err := os.WriteFile(skillPath, []byte("stale"), 0o644); err != nil {
		t.Fatalf("write stale skill: %v", err)
	}
	if exitCode := runSkillCommand([]string{"install"}, &strings.Builder{}, standardError); exitCode != 0 {
		t.Fatalf("update installed skill: exit code %d, error %s", exitCode, standardError.String())
	}
	assertFileContains(t, skillPath, "name: agent-wayfinder")
}

func TestInstallCommandWritesProjectSkill(t *testing.T) {
	project := t.TempDir()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Chdir(project)
	standardOutput := &strings.Builder{}
	standardError := &strings.Builder{}

	if exitCode := runSkillCommand([]string{"install", "--project"}, standardOutput, standardError); exitCode != 0 {
		t.Fatalf("run project install command: exit code %d, error %s", exitCode, standardError.String())
	}

	skillDirectory := filepath.Join(project, ".agents", "skills", "agent-wayfinder")
	assertFileContains(t, filepath.Join(skillDirectory, "SKILL.md"), "name: agent-wayfinder")
	assertFileContains(t, filepath.Join(skillDirectory, "references", "commands.md"), "# Agent Wayfinder Command Reference")
	if _, err := os.Stat(filepath.Join(home, ".agents", "skills", "agent-wayfinder", "SKILL.md")); !os.IsNotExist(err) {
		t.Errorf("global skill exists after project install: %v", err)
	}
}

func TestInstalledSkillAssetsMatchBundledAssets(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	if exitCode := runSkillCommand([]string{"install"}, &strings.Builder{}, &strings.Builder{}); exitCode != 0 {
		t.Fatalf("run install command: exit code %d", exitCode)
	}

	for _, asset := range []struct {
		bundled   string
		installed string
	}{
		{bundled: "skill_assets/SKILL.md", installed: filepath.Join("SKILL.md")},
		{bundled: "skill_assets/references/commands.md", installed: filepath.Join("references", "commands.md")},
	} {
		want, err := bundledSkill.ReadFile(asset.bundled)
		if err != nil {
			t.Fatalf("read bundled asset %s: %v", asset.bundled, err)
		}
		path := filepath.Join(home, ".agents", "skills", "agent-wayfinder", asset.installed)
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read installed asset %s: %v", path, err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("installed asset %s does not match bundled asset %s", path, asset.bundled)
		}
	}
}

func TestBundledSkillIncludesCommandReference(t *testing.T) {
	skill, err := bundledSkill.ReadFile("skill_assets/SKILL.md")
	if err != nil {
		t.Fatalf("read bundled skill: %v", err)
	}
	if !strings.Contains(string(skill), "./references/commands.md") {
		t.Errorf("bundled skill does not link to its command reference")
	}
	if !strings.Contains(string(skill), "MCP tools") {
		t.Errorf("bundled skill does not describe MCP tool use")
	}
	if _, err := bundledSkill.ReadFile("skill_assets/references/commands.md"); err != nil {
		t.Fatalf("read bundled command reference: %v", err)
	}
}

func assertFileContains(t *testing.T, path, expected string) {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if !strings.Contains(string(contents), expected) {
		t.Errorf("%s = %q, want text %q", path, contents, expected)
	}
}
