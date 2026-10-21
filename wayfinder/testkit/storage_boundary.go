package testkit

import (
	"errors"
	"fmt"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

var sqliteImplementationImports = map[string]struct{}{
	"database/sql":                    {},
	"github.com/arcmantle/go-sqlite3": {},
}

func CheckStorageAdapterBoundary(root string) error {
	root = filepath.Clean(root)
	violations := make([]string, 0)
	fileSet := token.NewFileSet()
	moduleRoots := []string{root}

	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if path != root {
				moduleFile, err := os.Stat(filepath.Join(path, "go.mod"))
				if err == nil && !moduleFile.IsDir() {
					moduleRoots = append(moduleRoots, path)
				} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
					return fmt.Errorf("check module root %s: %w", path, err)
				}
			}
			return nil
		}
		if filepath.Ext(path) != ".go" {
			return nil
		}

		relativePath, err := filepath.Rel(root, path)
		if err != nil {
			return fmt.Errorf("make boundary path relative: %w", err)
		}
		relativePath = filepath.ToSlash(relativePath)
		moduleRelativePath := relativePath
		for moduleIndex := len(moduleRoots) - 1; moduleIndex > 0; moduleIndex-- {
			candidate, err := filepath.Rel(moduleRoots[moduleIndex], path)
			if err != nil {
				return fmt.Errorf("make module boundary path relative: %w", err)
			}
			if candidate == ".." || strings.HasPrefix(candidate, ".."+string(filepath.Separator)) {
				continue
			}
			moduleRelativePath = filepath.ToSlash(candidate)
			break
		}
		if strings.HasPrefix(moduleRelativePath, "storage/sqlite/") {
			return nil
		}

		file, err := parser.ParseFile(fileSet, path, nil, parser.ImportsOnly)
		if err != nil {
			return fmt.Errorf("parse %s: %w", relativePath, err)
		}
		for _, importSpec := range file.Imports {
			importPath, err := strconv.Unquote(importSpec.Path.Value)
			if err != nil {
				return fmt.Errorf("parse import in %s: %w", relativePath, err)
			}
			if _, prohibited := sqliteImplementationImports[importPath]; prohibited {
				violations = append(violations, fmt.Sprintf("%s imports %s", relativePath, importPath))
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("check storage adapter boundary: %w", err)
	}
	if len(violations) == 0 {
		return nil
	}
	sort.Strings(violations)
	return fmt.Errorf("SQLite implementation details outside storage/sqlite: %s", strings.Join(violations, "; "))
}
