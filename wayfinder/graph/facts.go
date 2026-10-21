package graph

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
)

type NodeKind string

type RelationKind string

type SourceSpan struct {
	Path        string `json:"path"`
	StartLine   int    `json:"startLine"`
	StartColumn int    `json:"startColumn"`
	EndLine     int    `json:"endLine"`
	EndColumn   int    `json:"endColumn"`
}

type Confidence string

const (
	ConfidenceExtracted Confidence = "extracted"
	ConfidenceInferred  Confidence = "inferred"
	ConfidenceAmbiguous Confidence = "ambiguous"
)

type FactEvidence struct {
	Span       SourceSpan `json:"span"`
	FileHash   string     `json:"fileHash"`
	Extractor  string     `json:"extractor"`
	Provenance string     `json:"provenance"`
	Confidence Confidence `json:"confidence"`
}

func NewNodeID(kind NodeKind, span SourceSpan) string {
	hash := sha256.New()
	writeIdentityString(hash, string(kind))
	writeIdentityString(hash, span.Path)
	writeIdentityInt(hash, span.StartLine)
	writeIdentityInt(hash, span.StartColumn)
	writeIdentityInt(hash, span.EndLine)
	writeIdentityInt(hash, span.EndColumn)

	return fmt.Sprintf("%s:%s", kind, hex.EncodeToString(hash.Sum(nil)))
}

func writeIdentityString(hash interface{ Write([]byte) (int, error) }, value string) {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(value)))
	_, _ = hash.Write(length[:])
	_, _ = hash.Write([]byte(value))
}

func writeIdentityInt(hash interface{ Write([]byte) (int, error) }, value int) {
	var encoded [8]byte
	binary.BigEndian.PutUint64(encoded[:], uint64(value))
	_, _ = hash.Write(encoded[:])
}

type Node struct {
	ID            string       `json:"id"`
	Kind          NodeKind     `json:"kind"`
	Label         string       `json:"label"`
	QualifiedName string       `json:"qualifiedName"`
	Evidence      FactEvidence `json:"evidence"`
}

type Edge struct {
	SourceID string       `json:"sourceId"`
	TargetID string       `json:"targetId"`
	Relation RelationKind `json:"relation"`
	Evidence FactEvidence `json:"evidence"`
}

type Facts struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

type EndpointRule struct {
	Source NodeKind
	Target NodeKind
}

type RelationDefinition struct {
	Kind      RelationKind
	Endpoints []EndpointRule
}

type VocabularyDefinition struct {
	NodeKinds []NodeKind
	Relations []RelationDefinition
}

type ValidationCode string

const (
	UnknownNodeKind         ValidationCode = "unknown_node_kind"
	UnknownRelationKind     ValidationCode = "unknown_relation_kind"
	InvalidRelationEndpoint ValidationCode = "invalid_relation_endpoint"
	MissingSourceNode       ValidationCode = "missing_source_node"
	MissingTargetNode       ValidationCode = "missing_target_node"
	DuplicateNodeID         ValidationCode = "duplicate_node_id"
	EmptyNodeID             ValidationCode = "empty_node_id"
	EmptyNodeKind           ValidationCode = "empty_node_kind"
	DuplicateNodeKind       ValidationCode = "duplicate_node_kind"
	EmptyRelationKind       ValidationCode = "empty_relation_kind"
	DuplicateRelationKind   ValidationCode = "duplicate_relation_kind"
	EmptyRelationEndpoints  ValidationCode = "empty_relation_endpoints"
	MissingFactEvidence     ValidationCode = "missing_fact_evidence"
	InvalidFactConfidence   ValidationCode = "invalid_fact_confidence"
	InvalidSourceSpan       ValidationCode = "invalid_source_span"
)

type ValidationError struct {
	Code   ValidationCode
	Detail string
}

func (err *ValidationError) Error() string {
	return fmt.Sprintf("graph validation failed: %s: %s", err.Code, err.Detail)
}

type Vocabulary struct {
	nodeKinds map[NodeKind]struct{}
	relations map[RelationKind]RelationDefinition
}

func NewVocabulary(def VocabularyDefinition) (Vocabulary, error) {
	nodeKinds := make(map[NodeKind]struct{}, len(def.NodeKinds))
	for _, kind := range def.NodeKinds {
		if kind == "" {
			return Vocabulary{}, &ValidationError{Code: EmptyNodeKind, Detail: "node kind is empty"}
		}
		if _, ok := nodeKinds[kind]; ok {
			return Vocabulary{}, &ValidationError{
				Code:   DuplicateNodeKind,
				Detail: fmt.Sprintf("node kind %q is duplicated", kind),
			}
		}
		nodeKinds[kind] = struct{}{}
	}

	relations := make(map[RelationKind]RelationDefinition, len(def.Relations))
	for _, relation := range def.Relations {
		if relation.Kind == "" {
			return Vocabulary{}, &ValidationError{Code: EmptyRelationKind, Detail: "relation kind is empty"}
		}
		if _, ok := relations[relation.Kind]; ok {
			return Vocabulary{}, &ValidationError{
				Code:   DuplicateRelationKind,
				Detail: fmt.Sprintf("relation kind %q is duplicated", relation.Kind),
			}
		}
		if len(relation.Endpoints) == 0 {
			return Vocabulary{}, &ValidationError{
				Code:   EmptyRelationEndpoints,
				Detail: fmt.Sprintf("relation %q has no endpoint rules", relation.Kind),
			}
		}
		for _, endpoint := range relation.Endpoints {
			if _, ok := nodeKinds[endpoint.Source]; !ok {
				return Vocabulary{}, &ValidationError{
					Code:   UnknownNodeKind,
					Detail: fmt.Sprintf("relation %q has unregistered source kind %q", relation.Kind, endpoint.Source),
				}
			}
			if _, ok := nodeKinds[endpoint.Target]; !ok {
				return Vocabulary{}, &ValidationError{
					Code:   UnknownNodeKind,
					Detail: fmt.Sprintf("relation %q has unregistered target kind %q", relation.Kind, endpoint.Target),
				}
			}
		}
		relations[relation.Kind] = relation
	}

	return Vocabulary{nodeKinds: nodeKinds, relations: relations}, nil
}

func (v Vocabulary) Validate(facts Facts) error {
	nodeKindsByID := make(map[string]NodeKind, len(facts.Nodes))
	for _, node := range facts.Nodes {
		if node.ID == "" {
			return &ValidationError{
				Code:   EmptyNodeID,
				Detail: "node ID is empty",
			}
		}
		if _, ok := v.nodeKinds[node.Kind]; !ok {
			return &ValidationError{
				Code:   UnknownNodeKind,
				Detail: fmt.Sprintf("node %q has unregistered kind %q", node.ID, node.Kind),
			}
		}
		if err := validateEvidence(node.Evidence); err != nil {
			return err
		}
		if _, ok := nodeKindsByID[node.ID]; ok {
			return &ValidationError{
				Code:   DuplicateNodeID,
				Detail: fmt.Sprintf("node ID %q is duplicated", node.ID),
			}
		}
		nodeKindsByID[node.ID] = node.Kind
	}

	for _, edge := range facts.Edges {
		relation, ok := v.relations[edge.Relation]
		if !ok {
			return &ValidationError{
				Code:   UnknownRelationKind,
				Detail: fmt.Sprintf("edge %q -> %q has unregistered relation %q", edge.SourceID, edge.TargetID, edge.Relation),
			}
		}
		if err := validateEvidence(edge.Evidence); err != nil {
			return err
		}

		sourceKind, ok := nodeKindsByID[edge.SourceID]
		if !ok {
			return &ValidationError{
				Code:   MissingSourceNode,
				Detail: fmt.Sprintf("edge source %q does not exist", edge.SourceID),
			}
		}

		targetKind, ok := nodeKindsByID[edge.TargetID]
		if !ok {
			return &ValidationError{
				Code:   MissingTargetNode,
				Detail: fmt.Sprintf("edge target %q does not exist", edge.TargetID),
			}
		}

		endpointAllowed := false
		for _, endpoint := range relation.Endpoints {
			if endpoint.Source == sourceKind && endpoint.Target == targetKind {
				endpointAllowed = true
				break
			}
		}

		if !endpointAllowed {
			return &ValidationError{
				Code:   InvalidRelationEndpoint,
				Detail: fmt.Sprintf("relation %q does not permit %q -> %q at %s:%d:%d", edge.Relation, sourceKind, targetKind, edge.Evidence.Span.Path, edge.Evidence.Span.StartLine, edge.Evidence.Span.StartColumn),
			}
		}
	}

	return nil
}

func validateEvidence(evidence FactEvidence) error {
	if evidence.Span.Path == "" || evidence.Span.StartLine < 1 || evidence.Span.StartColumn < 1 || evidence.Span.EndLine < 1 || evidence.Span.EndColumn < 1 || evidence.FileHash == "" || evidence.Extractor == "" || evidence.Provenance == "" {
		return &ValidationError{Code: MissingFactEvidence, Detail: "fact evidence is incomplete"}
	}
	if evidence.Span.StartLine > evidence.Span.EndLine || evidence.Span.StartLine == evidence.Span.EndLine && evidence.Span.StartColumn > evidence.Span.EndColumn {
		return &ValidationError{Code: InvalidSourceSpan, Detail: "source span starts after it ends"}
	}
	if evidence.Confidence != ConfidenceExtracted && evidence.Confidence != ConfidenceInferred && evidence.Confidence != ConfidenceAmbiguous {
		return &ValidationError{Code: InvalidFactConfidence, Detail: fmt.Sprintf("fact evidence has unsupported confidence %q", evidence.Confidence)}
	}
	return nil
}
