package workspace

import (
	"encoding/xml"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// CSharpReferencedProjects returns the IDs of the C# projects a project reaches
// through local <ProjectReference> paths, direct and transitive, sorted and
// without the project itself. Solution membership is not a reference.
//
// Only references to a .csproj file inside the workspace count. A reference
// that names an MSBuild property or a wildcard, a missing file, or a project
// file that is not valid XML is ignored.
func CSharpReferencedProjects(workspaceRoot, fromProjectID string) []string {
	start, found := strings.CutPrefix(fromProjectID, "project:")
	if !found {
		return nil
	}
	visited := map[string]struct{}{start: {}}
	queue := []string{start}
	var referenced []string
	for len(queue) > 0 {
		root := queue[0]
		queue = queue[1:]
		for _, reference := range directProjectReferences(workspaceRoot, root) {
			if _, seen := visited[reference]; seen {
				continue
			}
			visited[reference] = struct{}{}
			queue = append(queue, reference)
			referenced = append(referenced, projectID(reference))
		}
	}
	sort.Strings(referenced)
	return referenced
}

// directProjectReferences lists the roots of the projects the .csproj files in
// one project root reference.
func directProjectReferences(workspaceRoot, root string) []string {
	entries, err := os.ReadDir(filepath.Join(workspaceRoot, filepath.FromSlash(root)))
	if err != nil {
		return nil
	}
	var references []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".csproj") {
			continue
		}
		contents, err := os.ReadFile(filepath.Join(workspaceRoot, filepath.FromSlash(root), entry.Name()))
		if err != nil {
			continue
		}
		for _, include := range projectReferenceIncludes(contents) {
			target := path.Join(root, strings.ReplaceAll(include, `\`, "/"))
			if !strings.EqualFold(path.Ext(target), ".csproj") || target == ".." || strings.HasPrefix(target, "../") || path.IsAbs(target) {
				continue
			}
			if info, err := os.Stat(filepath.Join(workspaceRoot, filepath.FromSlash(target))); err != nil || info.IsDir() {
				continue
			}
			references = append(references, projectRoot(target))
		}
	}
	return references
}

// projectReferenceIncludes returns the Include paths of the ProjectReference
// items of a project file, or none when it is not well-formed XML.
func projectReferenceIncludes(contents []byte) []string {
	decoder := xml.NewDecoder(strings.NewReader(string(contents)))
	var includes []string
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return includes
		}
		if err != nil {
			return nil
		}
		element, isStart := token.(xml.StartElement)
		if !isStart || !strings.EqualFold(element.Name.Local, "ProjectReference") {
			continue
		}
		for _, attribute := range element.Attr {
			include := strings.TrimSpace(attribute.Value)
			if strings.EqualFold(attribute.Name.Local, "Include") && include != "" && !strings.ContainsAny(include, "*$?") {
				includes = append(includes, include)
			}
		}
	}
}
