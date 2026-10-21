package query

import (
	"fmt"
	"strings"

	"agent-wayfinder/query"
	"agent-wayfinder/storage"
)

func GraphQueryText(result query.GraphQueryResult) string {
	var text strings.Builder
	for _, row := range result.Rows {
		fmt.Fprintf(&text, "Row: %v\n", row)
	}
	for _, node := range result.Graph.Nodes {
		fmt.Fprintf(&text, "%s [%s] %s:%d\n", node.Label, node.Kind, node.Evidence.Span.Path, node.Evidence.Span.StartLine)
	}
	for _, warning := range result.Warnings {
		fmt.Fprintf(&text, "Warning: %s\n", warning)
	}
	if result.Diagnostics != nil {
		fmt.Fprintf(&text, "SQL: %s\nParameters: %v\n", result.Diagnostics.SQL, result.Diagnostics.Parameters)
	}
	return strings.TrimSpace(text.String())
}

type CatalogSynopsisEvidence struct {
	Generator string `json:"generator"`
	Synopsis  string `json:"synopsis"`
}

func CatalogEvidenceData(entries []storage.CatalogEntry) []CatalogSynopsisEvidence {
	evidence := make([]CatalogSynopsisEvidence, 0, len(entries)*2)
	for _, entry := range entries {
		if entry.DeterministicSynopsis != "" {
			evidence = append(evidence, CatalogSynopsisEvidence{Generator: "deterministic", Synopsis: entry.DeterministicSynopsis})
		}
		if entry.CopilotSynopsis != "" {
			evidence = append(evidence, CatalogSynopsisEvidence{Generator: "copilot", Synopsis: entry.CopilotSynopsis})
		}
		if entry.OllamaSynopsis != "" {
			evidence = append(evidence, CatalogSynopsisEvidence{Generator: "ollama", Synopsis: entry.OllamaSynopsis})
		}
		if entry.ClaudeSynopsis != "" {
			evidence = append(evidence, CatalogSynopsisEvidence{Generator: "claude", Synopsis: entry.ClaudeSynopsis})
		}
	}
	return evidence
}
