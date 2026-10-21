package configuration

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"

	"github.com/bmatcuk/doublestar/v4"
)

type SourceSelection struct {
	Include []string
	Exclude []string
}

type sourceSelectionFile struct {
	Include *[]string `json:"include"`
	Exclude *[]string `json:"exclude"`
}

func ReadSourceSelection(workspaceRoot string) (SourceSelection, error) {
	selection := SourceSelection{}
	for _, path := range Paths(workspaceRoot) {
		file, err := readSourceSelectionFile(path)
		if err != nil {
			return SourceSelection{}, err
		}
		if file.Include != nil {
			selection.Include = copyPatterns(*file.Include)
			if err := validatePatterns("include", selection.Include); err != nil {
				return SourceSelection{}, err
			}
		}
		if file.Exclude != nil {
			selection.Exclude = copyPatterns(*file.Exclude)
			if err := validatePatterns("exclude", selection.Exclude); err != nil {
				return SourceSelection{}, err
			}
		}
	}
	return selection, nil
}

func readSourceSelectionFile(path string) (sourceSelectionFile, error) {
	contents, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return sourceSelectionFile{}, nil
	}
	if err != nil {
		return sourceSelectionFile{}, fmt.Errorf("read source configuration: %w", err)
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(contents, &root); err != nil {
		if !bytes.Contains(contents, []byte(`"sources"`)) {
			return sourceSelectionFile{}, nil
		}
		return sourceSelectionFile{}, fmt.Errorf("parse source configuration: %w", err)
	}
	sources, exists := root["sources"]
	if !exists || string(sources) == "null" {
		return sourceSelectionFile{}, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(sources))
	decoder.DisallowUnknownFields()
	var file sourceSelectionFile
	if err := decoder.Decode(&file); err != nil {
		return sourceSelectionFile{}, fmt.Errorf("parse source configuration: %w", err)
	}
	return file, nil
}

func copyPatterns(patterns []string) []string {
	values := make([]string, len(patterns))
	copy(values, patterns)
	return values
}

func validatePatterns(kind string, patterns []string) error {
	for _, pattern := range patterns {
		if _, err := doublestar.Match(pattern, ""); err != nil {
			return fmt.Errorf("invalid sources.%s pattern %q: %w", kind, pattern, err)
		}
	}
	return nil
}
