package extractor

import (
	"bytes"
	"strings"
	"unicode"

	"agent-wayfinder/graph"
)

const (
	maxDeterministicSynopsisLength       = 300
	DefaultCatalogDeclarationSourceLimit = 4 * 1024
)

func CatalogUnitsForSource(source Source, facts graph.Facts) []CatalogUnit {
	if source.OmitCatalogUnits {
		return nil
	}
	units := make([]CatalogUnit, 0)
	for _, node := range facts.Nodes {
		if !isCatalogKind(node.Kind) {
			continue
		}
		start, end, found := spanOffsets(source.Contents, node.Evidence.Span)
		if !found {
			continue
		}
		unit := CatalogUnit{
			NodeID:            node.ID,
			Name:              node.Label,
			Kind:              node.Kind,
			Owner:             catalogUnitOwner(node),
			Signature:         declarationSignature(source.Contents[start:end]),
			DeclarationSource: boundedDeclarationSource(source.Contents[start:end]),
			Comments:          leadingComments(source.Contents, start),
			IdentifierTokens:  identifierTokens(node.Label),
		}
		if unit.Signature != "" {
			units = append(units, unit)
		}
	}
	return units
}

func isCatalogKind(kind graph.NodeKind) bool {
	return strings.HasSuffix(string(kind), ":function") ||
		strings.HasSuffix(string(kind), ":type") ||
		strings.HasSuffix(string(kind), ":struct") ||
		strings.HasSuffix(string(kind), ":class") ||
		strings.HasSuffix(string(kind), ":interface") ||
		strings.HasSuffix(string(kind), ":method")
}

func (unit CatalogUnit) DeterministicSynopsis() string {
	name := unit.Name
	if unit.Owner != "" {
		name = unit.Owner + "." + name
	}
	parts := []string{name + " (" + string(unit.Kind) + ")."}
	if len(unit.Comments) > 0 {
		parts = append(parts, strings.Join(unit.Comments, " "))
	}
	parts = append(parts, "Signature: "+unit.Signature+".")
	if len(unit.IdentifierTokens) > 0 {
		parts = append(parts, "Identifiers: "+strings.Join(unit.IdentifierTokens, " "))
	}
	return truncateSynopsis(strings.Join(parts, " "))
}

func truncateSynopsis(value string) string {
	runes := []rune(value)
	if len(runes) <= maxDeterministicSynopsisLength {
		return value
	}
	return string(runes[:maxDeterministicSynopsisLength])
}

func spanOffsets(contents []byte, span graph.SourceSpan) (int, int, bool) {
	if span.StartLine < 1 || span.StartColumn < 1 || span.EndLine < span.StartLine || span.EndColumn < 1 {
		return 0, 0, false
	}
	lineStarts := []int{0}
	for index, value := range contents {
		if value == '\n' {
			lineStarts = append(lineStarts, index+1)
		}
	}
	if span.EndLine > len(lineStarts) || span.StartLine > len(lineStarts) {
		return 0, 0, false
	}
	start := lineStarts[span.StartLine-1] + span.StartColumn - 1
	end := lineStarts[span.EndLine-1] + span.EndColumn - 1
	if start < 0 || end < start || end > len(contents) {
		return 0, 0, false
	}
	return start, end, true
}

func declarationSignature(declaration []byte) string {
	if bodyStart := bytes.IndexByte(declaration, '{'); bodyStart >= 0 {
		declaration = declaration[:bodyStart]
	}
	return strings.TrimSpace(string(declaration))
}

func boundedDeclarationSource(declaration []byte) string {
	if len(declaration) > DefaultCatalogDeclarationSourceLimit {
		declaration = declaration[:DefaultCatalogDeclarationSourceLimit]
	}
	return string(declaration)
}

func leadingComments(contents []byte, declarationStart int) []string {
	prefix := strings.TrimRightFunc(string(contents[:declarationStart]), unicode.IsSpace)
	if strings.HasSuffix(prefix, "*/") {
		blockStart := strings.LastIndex(prefix, "/*")
		if blockStart >= 0 {
			return []string{normalizeBlockComment(prefix[blockStart+2 : len(prefix)-2])}
		}
	}
	lines := strings.Split(prefix, "\n")
	comments := make([]string, 0)
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.TrimSpace(lines[index])
		if !strings.HasPrefix(line, "//") {
			break
		}
		comments = append(comments, normalizeComment(strings.TrimSpace(strings.TrimPrefix(line, "//"))))
	}
	for left, right := 0, len(comments)-1; left < right; left, right = left+1, right-1 {
		comments[left], comments[right] = comments[right], comments[left]
	}
	return comments
}

func normalizeComment(comment string) string {
	return strings.Join(strings.Fields(comment), " ")
}

func normalizeBlockComment(comment string) string {
	lines := strings.Split(comment, "\n")
	for index, line := range lines {
		lines[index] = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "*"))
	}
	return normalizeComment(strings.Join(lines, " "))
}

func identifierTokens(identifier string) []string {
	tokens := make([]string, 0)
	current := make([]rune, 0)
	runes := []rune(identifier)
	appendToken := func() {
		if len(current) == 0 {
			return
		}
		tokens = append(tokens, strings.ToLower(string(current)))
		current = current[:0]
	}
	for index, value := range runes {
		if !unicode.IsLetter(value) && !unicode.IsDigit(value) {
			appendToken()
			continue
		}
		if len(current) > 0 && unicode.IsUpper(value) && (unicode.IsLower(runes[index-1]) || index+1 < len(runes) && unicode.IsLower(runes[index+1])) {
			appendToken()
		}
		current = append(current, value)
	}
	appendToken()
	return tokens
}

func catalogUnitOwner(node graph.Node) string {
	if !strings.HasSuffix(string(node.Kind), ":method") {
		return ""
	}
	qualifiedName := node.QualifiedName
	if separator := strings.LastIndex(qualifiedName, "::"); separator >= 0 {
		qualifiedName = qualifiedName[separator+2:]
	}
	parts := strings.Split(qualifiedName, ".")
	if len(parts) < 2 {
		return ""
	}
	return parts[len(parts)-2]
}
