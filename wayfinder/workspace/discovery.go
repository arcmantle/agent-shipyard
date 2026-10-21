package workspace

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"agent-wayfinder/configuration"

	"github.com/bmatcuk/doublestar/v4"
	gitignore "github.com/sabhiram/go-gitignore"
)

type DiscoverOptions struct {
	ConfiguredRoots []string
}

type Project struct {
	ID   string
	Root string
}

type Source struct {
	Path      string
	ProjectID string
}

type Discovery struct {
	Projects []Project
	Sources  []Source
}

type gitIgnoreRule struct {
	root     string
	patterns []gitIgnorePattern
}

type gitIgnorePattern struct {
	matcher *gitignore.GitIgnore
	negated bool
}

type sourceRules struct {
	include    []string
	exclude    []string
	gitIgnores []gitIgnoreRule
}

func Discover(root string, options DiscoverOptions) (Discovery, error) {
	sources := make([]Source, 0)
	projects, _, err := DiscoverStream(context.Background(), root, options, func(source Source) error {
		sources = append(sources, source)
		return nil
	})
	if err != nil {
		return Discovery{}, err
	}
	return Discovery{Projects: projects, Sources: sources}, nil
}

func DiscoverStream(ctx context.Context, root string, options DiscoverOptions, emit func(Source) error) ([]Project, int, error) {
	workspaceRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, 0, fmt.Errorf("resolve workspace root: %w", err)
	}
	sourceRules, err := loadSourceRules(workspaceRoot)
	if err != nil {
		return nil, 0, err
	}

	projectRoots := make([]string, 0, len(options.ConfiguredRoots))
	for _, configuredRoot := range options.ConfiguredRoots {
		normalizedRoot, err := normalizeRoot(workspaceRoot, configuredRoot)
		if err != nil {
			return nil, 0, err
		}
		projectRoots = append(projectRoots, normalizedRoot)
	}
	if err := filepath.WalkDir(workspaceRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}

		relativePath, err := filepath.Rel(workspaceRoot, path)
		if err != nil {
			return fmt.Errorf("make path relative: %w", err)
		}
		relativePath = filepath.ToSlash(relativePath)
		if nonSourcePathExcluded(relativePath, sourceRules) {
			return nil
		}
		if projectManifest(filepath.Base(path)) {
			projectRoots = append(projectRoots, projectRoot(relativePath))
		}
		return nil
	}); err != nil {
		return nil, 0, fmt.Errorf("walk workspace for projects: %w", err)
	}

	projectRoots = uniqueSorted(projectRoots)
	projects := make([]Project, len(projectRoots))
	for index, root := range projectRoots {
		projects[index] = Project{ID: projectID(root), Root: root}
	}

	sourceCount := 0
	if err := filepath.WalkDir(workspaceRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relativePath, err := filepath.Rel(workspaceRoot, path)
		if err != nil {
			return fmt.Errorf("make path relative: %w", err)
		}
		relativePath = filepath.ToSlash(relativePath)
		if sourceExcluded(relativePath, sourceRules) || !supportedSource(relativePath) {
			return nil
		}
		ownerRoot, found := mostSpecificRoot(relativePath, projectRoots)
		if !found {
			return nil
		}
		if err := emit(Source{Path: relativePath, ProjectID: projectID(ownerRoot)}); err != nil {
			return err
		}
		sourceCount++
		return nil
	}); err != nil {
		return nil, sourceCount, fmt.Errorf("walk workspace for sources: %w", err)
	}
	return projects, sourceCount, nil
}

func loadSourceRules(workspaceRoot string) (sourceRules, error) {
	gitIgnores, err := loadGitIgnoreRules(workspaceRoot)
	if err != nil {
		return sourceRules{}, err
	}
	selection, err := configuration.ReadSourceSelection(workspaceRoot)
	if err != nil {
		return sourceRules{}, err
	}
	return sourceRules{include: selection.Include, exclude: selection.Exclude, gitIgnores: gitIgnores}, nil
}

func nonSourcePathExcluded(path string, rules sourceRules) bool {
	return internalDirectory(path) || gitIgnored(path, rules.gitIgnores)
}

func sourceExcluded(sourcePath string, rules sourceRules) bool {
	if internalDirectory(sourcePath) {
		return true
	}
	if gitIgnored(sourcePath, rules.gitIgnores) {
		return true
	}

	if rules.include != nil && !matchesAny(sourcePath, rules.include) {
		return true
	}
	return matchesAny(sourcePath, rules.exclude)
}

func matchesAny(sourcePath string, patterns []string) bool {
	for _, pattern := range patterns {
		matched, _ := doublestar.Match(pattern, sourcePath)
		if matched {
			return true
		}
	}
	return false
}

func loadGitIgnoreRules(workspaceRoot string) ([]gitIgnoreRule, error) {
	rules := make([]gitIgnoreRule, 0)
	if err := filepath.WalkDir(workspaceRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relativePath, err := filepath.Rel(workspaceRoot, path)
		if err != nil {
			return fmt.Errorf("make Git ignore path relative: %w", err)
		}
		relativePath = filepath.ToSlash(relativePath)
		if entry.IsDir() {
			if relativePath != "." && internalDirectory(relativePath) {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Name() != ".gitignore" {
			return nil
		}
		patterns, err := loadGitIgnorePatterns(path)
		if err != nil {
			return fmt.Errorf("read Git ignore file %q: %w", relativePath, err)
		}
		rules = append(rules, gitIgnoreRule{root: filepath.ToSlash(filepath.Dir(relativePath)), patterns: patterns})
		return nil
	}); err != nil {
		return nil, fmt.Errorf("walk workspace for Git ignore files: %w", err)
	}
	sort.Slice(rules, func(left, right int) bool { return rules[left].root < rules[right].root })
	return rules, nil
}

func loadGitIgnorePatterns(path string) ([]gitIgnorePattern, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	patterns := make([]gitIgnorePattern, 0)
	for _, line := range strings.Split(string(contents), "\n") {
		pattern := strings.TrimSpace(line)
		if pattern == "" || strings.HasPrefix(pattern, "#") {
			continue
		}
		negated := strings.HasPrefix(pattern, "!")
		lines := []string{pattern}
		if negated {
			lines = append([]string{"*"}, lines...)
		}
		patterns = append(patterns, gitIgnorePattern{
			matcher: gitignore.CompileIgnoreLines(lines...),
			negated: negated,
		})
	}
	return patterns, nil
}

func gitIgnored(sourcePath string, rules []gitIgnoreRule) bool {
	for directory := path.Dir(sourcePath); directory != "."; directory = path.Dir(directory) {
		if gitIgnoredPath(directory, true, rules) {
			return true
		}
	}
	return gitIgnoredPath(sourcePath, false, rules)
}

func gitIgnoredPath(sourcePath string, directory bool, rules []gitIgnoreRule) bool {
	excluded := false
	for _, rule := range rules {
		relativePath := sourcePath
		if rule.root != "." {
			if !strings.HasPrefix(sourcePath, rule.root+"/") {
				continue
			}
			relativePath = strings.TrimPrefix(sourcePath, rule.root+"/")
		}
		for _, pattern := range rule.patterns {
			if !matchesGitIgnorePattern(pattern, relativePath, directory) {
				continue
			}
			excluded = !pattern.negated
		}
	}
	return excluded
}

func matchesGitIgnorePattern(pattern gitIgnorePattern, sourcePath string, directory bool) bool {
	if directory {
		sourcePath += "/"
	}
	matched := pattern.matcher.MatchesPath(sourcePath)
	if pattern.negated {
		return !matched
	}
	return matched
}

func internalDirectory(sourcePath string) bool {
	for _, component := range strings.Split(sourcePath, "/") {
		switch component {
		case ".agent-wayfinder", ".git", "node_modules":
			return true
		}
	}
	return false
}

func projectManifest(name string) bool {
	switch name {
	case "go.mod", "package.json", "tsconfig.json", "jsconfig.json":
		return true
	default:
		return false
	}
}

func normalizeRoot(workspaceRoot, root string) (string, error) {
	candidate := root
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(workspaceRoot, candidate)
	}
	relativeRoot, err := filepath.Rel(workspaceRoot, candidate)
	if err != nil {
		return "", fmt.Errorf("make configured root relative: %w", err)
	}
	if relativeRoot == ".." || strings.HasPrefix(relativeRoot, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("configured root %q is outside workspace", root)
	}
	if relativeRoot == "." {
		return ".", nil
	}
	return filepath.ToSlash(filepath.Clean(relativeRoot)), nil
}

func uniqueSorted(values []string) []string {
	sort.Strings(values)
	if len(values) < 2 {
		return values
	}

	unique := values[:1]
	for _, value := range values[1:] {
		if value != unique[len(unique)-1] {
			unique = append(unique, value)
		}
	}
	return unique
}

func projectRoot(manifestPath string) string {
	directory := filepath.ToSlash(filepath.Dir(manifestPath))
	if directory == "." {
		return "."
	}
	return directory
}

func projectID(root string) string {
	return "project:" + root
}

func supportedSource(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".go", ".js", ".jsx", ".ts", ".tsx":
		return true
	default:
		return false
	}
}

func mostSpecificRoot(sourcePath string, roots []string) (string, bool) {
	bestRoot := ""
	for _, root := range roots {
		if root == "." || sourcePath == root || strings.HasPrefix(sourcePath, root+"/") {
			if len(root) > len(bestRoot) {
				bestRoot = root
			}
		}
	}
	return bestRoot, bestRoot != ""
}
