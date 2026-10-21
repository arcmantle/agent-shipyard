package skill

import (
	"embed"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"agent-wayfinder/cli"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"

	"github.com/spf13/cobra"
)

//go:embed skill_assets/SKILL.md skill_assets/references/commands.md
var bundledSkill embed.FS

func New(standardOutput, standardError io.Writer, exitCode *int) *cobra.Command {
	return cmd.NewLeaf("install", "Install the Agent Wayfinder skill", configure, run, standardOutput, standardError, exitCode)
}

func configure(command *cobra.Command) {
	command.Flags().Bool("project", false, "install in the current project")
}

func run(command *cobra.Command, arguments []string, standardOutput, standardError io.Writer) int {
	if len(arguments) != 0 {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("install accepts no arguments"))
	}
	project, err := command.Flags().GetBool("project")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	root, err := skillInstallRoot(project)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	destination := filepath.Join(root, ".agents", "skills", "agent-wayfinder")
	if err := installBundledSkill(destination); err != nil {
		return cmd.WriteError(standardError, err)
	}
	if _, err := fmt.Fprintf(standardOutput, "Skill installed: %s\n", destination); err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("render skill installation: %w", err))
	}
	return 0
}

func skillInstallRoot(project bool) (string, error) {
	if project {
		root, err := os.Getwd()
		if err != nil {
			return "", fmt.Errorf("resolve project skill installation path: %w", err)
		}
		return root, nil
	}
	root, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve user skill installation path: %w", err)
	}
	return root, nil
}

func installBundledSkill(destination string) error {
	files := []struct {
		source      string
		destination string
	}{
		{source: "skill_assets/references/commands.md", destination: filepath.Join(destination, "references", "commands.md")},
		{source: "skill_assets/SKILL.md", destination: filepath.Join(destination, "SKILL.md")},
	}
	for _, file := range files {
		contents, err := bundledSkill.ReadFile(file.source)
		if err != nil {
			return fmt.Errorf("read bundled skill file %q: %w", file.source, err)
		}
		if err := writeSkillFile(file.destination, contents); err != nil {
			return err
		}
	}
	return nil
}

func writeSkillFile(destination string, contents []byte) error {
	directory := filepath.Dir(destination)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return fmt.Errorf("create skill directory %q: %w", directory, err)
	}
	temporary, err := os.CreateTemp(directory, ".agent-wayfinder-skill-*")
	if err != nil {
		return fmt.Errorf("create temporary skill file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o644); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("set temporary skill file permissions: %w", err)
	}
	if _, err := temporary.Write(contents); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write temporary skill file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary skill file: %w", err)
	}
	if err := os.Rename(temporaryPath, destination); err == nil {
		return nil
	}
	if err := os.Remove(destination); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("replace skill file %q: %w", destination, err)
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return fmt.Errorf("install skill file %q: %w", destination, err)
	}
	return nil
}
