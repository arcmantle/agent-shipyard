package testkit

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// RunGraphifyComparisonCorpus compares an agent-wayfinder JSON export with the
// stored Graphify-compatible facts for one supported corpus.
func RunGraphifyComparisonCorpus(name string, candidate []byte) error {
	reference, err := os.ReadFile(filepath.Join("testdata", "graphify", name+".json"))
	if err != nil {
		return fmt.Errorf("read Graphify comparison corpus %q: %w", name, err)
	}

	normalizedCandidate, err := NormalizeGraphifyExport(candidate)
	if err != nil {
		return fmt.Errorf("normalize agent-wayfinder export: %w", err)
	}
	if err := CompareJSON(reference, normalizedCandidate); err != nil {
		return fmt.Errorf("compare Graphify corpus %q: %w", name, err)
	}
	return nil
}

// RunGraphifyIndexComparisonCorpus compares index command semantics with the
// stored Graphify-compatible diagnostics for one supported corpus.
func RunGraphifyIndexComparisonCorpus(name string, candidate []byte) error {
	reference, err := os.ReadFile(filepath.Join("testdata", "graphify", name+".json"))
	if err != nil {
		return fmt.Errorf("read Graphify index comparison corpus %q: %w", name, err)
	}

	normalizedCandidate, err := NormalizeGraphifyIndexResult(candidate)
	if err != nil {
		return fmt.Errorf("normalize agent-wayfinder index result: %w", err)
	}
	if err := CompareJSON(reference, normalizedCandidate); err != nil {
		return fmt.Errorf("compare Graphify index corpus %q: %w", name, err)
	}
	return nil
}

// NormalizeGraphifyExport converts agent-wayfinder storage identifiers into the
// source-based identities that Graphify exposes for supported facts.
func NormalizeGraphifyExport(input []byte) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	var envelope map[string]any
	if err := decoder.Decode(&envelope); err != nil {
		return nil, fmt.Errorf("decode export JSON: %w", err)
	}
	if decoder.More() {
		return nil, fmt.Errorf("decode export JSON: multiple values")
	}

	graphVersion, found := envelope["graphVersion"]
	if !found {
		return nil, fmt.Errorf("export JSON has no graph version")
	}
	result, ok := envelope["result"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("export JSON result is not an object")
	}
	nodes, ok := result["nodes"].([]any)
	if !ok {
		return nil, fmt.Errorf("export JSON nodes are not an array")
	}
	edges, ok := result["edges"].([]any)
	if !ok {
		return nil, fmt.Errorf("export JSON edges are not an array")
	}

	identities := make(map[string]map[string]any, len(nodes))
	normalizedNodes := make([]any, 0, len(nodes))
	for _, item := range nodes {
		node, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("export JSON node is not an object")
		}
		identity, err := graphifyNodeIdentity(node)
		if err != nil {
			return nil, err
		}
		id, ok := node["id"].(string)
		if !ok || id == "" {
			return nil, fmt.Errorf("export JSON node has no ID")
		}
		identities[id] = identity
		if node["kind"] == "project" {
			continue
		}
		evidence, err := graphifyEvidence(node["evidence"])
		if err != nil {
			return nil, fmt.Errorf("normalize node %q evidence: %w", id, err)
		}
		normalizedNodes = append(normalizedNodes, map[string]any{
			"identity": identity,
			"evidence": evidence,
		})
	}

	normalizedEdges := make([]any, 0, len(edges))
	for _, item := range edges {
		edge, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("export JSON edge is not an object")
		}
		sourceID, sourceOK := edge["sourceId"].(string)
		targetID, targetOK := edge["targetId"].(string)
		source, sourceFound := identities[sourceID]
		target, targetFound := identities[targetID]
		if !sourceOK || !targetOK || !sourceFound || !targetFound {
			return nil, fmt.Errorf("export JSON edge has an unknown endpoint")
		}
		if source["kind"] == "project" || target["kind"] == "project" {
			continue
		}
		relation, ok := edge["relation"].(string)
		if !ok || relation == "" {
			return nil, fmt.Errorf("export JSON edge has no relation")
		}
		evidence, err := graphifyEvidence(edge["evidence"])
		if err != nil {
			return nil, fmt.Errorf("normalize edge evidence: %w", err)
		}
		normalizedEdges = append(normalizedEdges, map[string]any{
			"source":   source,
			"target":   target,
			"relation": normalizeGraphifyRelation(relation),
			"evidence": evidence,
		})
	}

	sortJSONValues(normalizedNodes)
	sortJSONValues(normalizedEdges)
	return json.Marshal(map[string]any{
		"graphVersion": graphVersion,
		"result": map[string]any{
			"nodes": normalizedNodes,
			"edges": normalizedEdges,
		},
	})
}

// NormalizeGraphifyIndexResult retains the command envelope and diagnostics
// while removing machine-specific workspace paths and publication times.
func NormalizeGraphifyIndexResult(input []byte) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	var envelope map[string]any
	if err := decoder.Decode(&envelope); err != nil {
		return nil, fmt.Errorf("decode index JSON: %w", err)
	}
	if decoder.More() {
		return nil, fmt.Errorf("decode index JSON: multiple values")
	}

	graphVersion, found := envelope["graphVersion"]
	if !found {
		return nil, fmt.Errorf("index JSON has no graph version")
	}
	result, ok := envelope["result"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("index JSON result is not an object")
	}
	if _, ok := result["workspace"].(string); !ok {
		return nil, fmt.Errorf("index JSON result has no workspace")
	}
	diagnostics, ok := result["diagnostics"].([]any)
	if !ok {
		return nil, fmt.Errorf("index JSON diagnostics are not an array")
	}
	normalizedDiagnostics := make([]any, 0, len(diagnostics))
	for _, item := range diagnostics {
		diagnostic, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("index JSON diagnostic is not an object")
		}
		severity, ok := stringField(diagnostic, "severity", "Severity")
		if !ok || severity == "" {
			return nil, fmt.Errorf("index JSON diagnostic has no severity")
		}
		message, ok := stringField(diagnostic, "message", "Message")
		if !ok || message == "" {
			return nil, fmt.Errorf("index JSON diagnostic has no message")
		}
		normalizedDiagnostics = append(normalizedDiagnostics, map[string]any{
			"severity": severity,
			"message":  message,
		})
	}
	sortJSONValues(normalizedDiagnostics)
	return json.Marshal(map[string]any{
		"graphVersion": graphVersion,
		"result": map[string]any{
			"workspace":   "<workspace>",
			"diagnostics": normalizedDiagnostics,
		},
	})
}

func stringField(value map[string]any, names ...string) (string, bool) {
	for _, name := range names {
		text, ok := value[name].(string)
		if ok {
			return text, true
		}
	}
	return "", false
}

func graphifyNodeIdentity(node map[string]any) (map[string]any, error) {
	kind, ok := node["kind"].(string)
	if !ok || kind == "" {
		return nil, fmt.Errorf("export JSON node has no kind")
	}
	qualifiedName, ok := node["qualifiedName"].(string)
	if !ok || qualifiedName == "" {
		return nil, fmt.Errorf("export JSON node has no qualified name")
	}
	return map[string]any{
		"kind":          strings.TrimPrefix(kind, "typescript:"),
		"qualifiedName": qualifiedName,
	}, nil
}

func graphifyEvidence(value any) (map[string]any, error) {
	evidence, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("is not an object")
	}
	span, ok := evidence["span"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("has no span")
	}
	for _, key := range []string{"path", "startLine", "startColumn", "endLine", "endColumn"} {
		if _, found := span[key]; !found {
			return nil, fmt.Errorf("span has no %s", key)
		}
	}
	provenance, ok := evidence["provenance"].(string)
	if !ok || provenance == "" {
		return nil, fmt.Errorf("has no provenance")
	}
	confidence, ok := evidence["confidence"].(string)
	if !ok || confidence == "" {
		return nil, fmt.Errorf("has no confidence")
	}
	return map[string]any{
		"span": map[string]any{
			"path":        span["path"],
			"startLine":   span["startLine"],
			"startColumn": span["startColumn"],
			"endLine":     span["endLine"],
			"endColumn":   span["endColumn"],
		},
		"provenance": provenance,
		"confidence": confidence,
	}, nil
}

func normalizeGraphifyRelation(relation string) string {
	if strings.HasSuffix(relation, ":imports_from") {
		return "imports_from"
	}
	if strings.HasSuffix(relation, ":calls") {
		return "calls"
	}
	return relation
}

func sortJSONValues(values []any) {
	sort.Slice(values, func(left, right int) bool {
		return normalizedJSONKey(values[left]) < normalizedJSONKey(values[right])
	})
}
