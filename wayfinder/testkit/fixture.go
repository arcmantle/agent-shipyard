package testkit

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type Workspace struct {
	Root string
}

func (workspace Workspace) WriteFile(t testing.TB, sourcePath, contents string) {
	t.Helper()

	destination := workspace.filePath(t, sourcePath)
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		t.Fatalf("create fixture directory for %q: %v", sourcePath, err)
	}
	if err := os.WriteFile(destination, []byte(contents), 0o644); err != nil {
		t.Fatalf("write fixture file %q: %v", sourcePath, err)
	}
}

func (workspace Workspace) RemoveFile(t testing.TB, sourcePath string) {
	t.Helper()

	if err := os.Remove(workspace.filePath(t, sourcePath)); err != nil {
		t.Fatalf("remove fixture file %q: %v", sourcePath, err)
	}
}

func (workspace Workspace) filePath(t testing.TB, sourcePath string) string {
	t.Helper()

	path, err := fixturePath(workspace.Root, sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func fixturePath(root, sourcePath string) (string, error) {
	cleanPath := filepath.Clean(sourcePath)
	if filepath.IsAbs(cleanPath) || cleanPath == ".." || strings.HasPrefix(cleanPath, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("fixture path %q escapes workspace", sourcePath)
	}
	currentPath := root
	for _, component := range strings.Split(cleanPath, string(filepath.Separator)) {
		currentPath = filepath.Join(currentPath, component)
		info, err := os.Lstat(currentPath)
		if os.IsNotExist(err) {
			break
		}
		if err != nil {
			return "", fmt.Errorf("inspect fixture path %q: %w", sourcePath, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("fixture path %q contains a symbolic link", sourcePath)
		}
	}
	return filepath.Join(root, cleanPath), nil
}

func ReadFixture(t testing.TB, path string) []byte {
	t.Helper()

	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %q: %v", path, err)
	}
	return contents
}

func NewWorkspace(t testing.TB, files map[string]string) Workspace {
	t.Helper()

	root := t.TempDir()
	paths := make([]string, 0, len(files))
	for sourcePath := range files {
		paths = append(paths, sourcePath)
	}
	sort.Strings(paths)

	for _, sourcePath := range paths {
		workspace := Workspace{Root: root}
		workspace.WriteFile(t, sourcePath, files[sourcePath])
	}

	return Workspace{Root: root}
}

func CompareJSON(reference, candidate []byte) error {
	normalizedReference, err := NormalizeJSON(reference)
	if err != nil {
		return fmt.Errorf("normalize reference JSON: %w", err)
	}
	normalizedCandidate, err := NormalizeJSON(candidate)
	if err != nil {
		return fmt.Errorf("normalize candidate JSON: %w", err)
	}
	if !bytes.Equal(normalizedReference, normalizedCandidate) {
		return fmt.Errorf("normalized JSON differs\nreference: %s\ncandidate: %s", normalizedReference, normalizedCandidate)
	}
	return nil
}

func NormalizeJSON(input []byte) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()

	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("decode JSON: %w", err)
	}
	if decoder.More() {
		return nil, fmt.Errorf("decode JSON: multiple values")
	}

	normalized := normalizeJSONValue(value, "")
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return nil, fmt.Errorf("encode normalized JSON: %w", err)
	}
	return encoded, nil
}

func normalizeJSONValue(value any, key string) any {
	switch typed := value.(type) {
	case map[string]any:
		normalized := make(map[string]any, len(typed))
		for mapKey, mapValue := range typed {
			if ignoredJSONKey(mapKey) {
				continue
			}
			normalized[mapKey] = normalizeJSONValue(mapValue, mapKey)
		}
		return normalized
	case []any:
		normalized := make([]any, len(typed))
		for index, item := range typed {
			normalized[index] = normalizeJSONValue(item, key)
		}
		sort.Slice(normalized, func(left, right int) bool {
			return normalizedJSONKey(normalized[left]) < normalizedJSONKey(normalized[right])
		})
		return normalized
	case string:
		if pathJSONKey(key) {
			normalizedPath := strings.ReplaceAll(typed, "\\", "/")
			if absoluteJSONPath(normalizedPath) {
				return "<absolute-path>"
			}
			return normalizedPath
		}
		return typed
	default:
		return value
	}
}

func normalizedJSONKey(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(fmt.Sprintf("encode normalized JSON key: %v", err))
	}
	return string(encoded)
}

func ignoredJSONKey(key string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(key, "_", ""))
	switch normalized {
	case "createdat", "generatedat", "publishedat", "runid", "timestamp", "graphifymetadata", "community", "communitylabel":
		return true
	default:
		return strings.HasPrefix(normalized, "graphify")
	}
}

func pathJSONKey(key string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(key, "_", ""))
	return normalized == "path" || normalized == "sourcefile" || normalized == "sourcepath"
}

func absoluteJSONPath(value string) bool {
	if filepath.IsAbs(value) || strings.HasPrefix(value, "//") {
		return true
	}
	return len(value) >= 3 && value[1] == ':' && value[2] == '/' && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z'))
}
