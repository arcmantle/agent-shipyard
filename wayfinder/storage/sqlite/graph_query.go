package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"agent-wayfinder/graph"
	"agent-wayfinder/query/graph_query"
	"agent-wayfinder/storage"
)

const graphQueryVisibleSQL = `WITH visible_nodes AS (
	SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
	FROM contribution_nodes WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
	UNION
	SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
	FROM workspace_nodes WHERE workspace = ? AND version = ?
), visible_edges AS (
	SELECT source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
	FROM contribution_edges WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
	UNION
	SELECT source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
	FROM workspace_edges WHERE workspace = ? AND version = ?
) `

const graphQueryNumberedEdgesSQL = `, numbered_edges AS (
	SELECT ROW_NUMBER() OVER (ORDER BY edge.source_id, edge.target_id, edge.relation, edge.span_path, edge.start_line, edge.start_column, edge.end_line, edge.end_column, edge.file_hash, edge.extractor, edge.provenance, edge.confidence) AS edge_id, edge.*
	FROM visible_edges edge JOIN visible_nodes source ON source.node_id = edge.source_id JOIN visible_nodes target ON target.node_id = edge.target_id
) `

var graphQueryNodeColumns = []string{"node_id", "kind", "label", "qualified_name", "span_path", "start_line", "start_column", "end_line", "end_column", "file_hash", "extractor", "provenance", "confidence"}

var graphQueryNodeProperties = map[string]string{
	"id": "node_id", "kind": "kind", "name": "label", "label": "label", "qualifiedName": "qualified_name",
	"path": "span_path", "startLine": "start_line", "startColumn": "start_column", "endLine": "end_line", "endColumn": "end_column",
	"fileHash": "file_hash", "extractor": "extractor", "provenance": "provenance", "confidence": "confidence",
}

var graphQueryEdgeProperties = map[string]string{
	"sourceId": "source_id", "targetId": "target_id", "relation": "relation", "path": "span_path",
	"startLine": "start_line", "startColumn": "start_column", "endLine": "end_line", "endColumn": "end_column",
	"fileHash": "file_hash", "extractor": "extractor", "provenance": "provenance", "confidence": "confidence",
}

func graphQueryArguments(snapshot storage.Snapshot) []any {
	return []any{snapshot.Workspace, snapshot.Version, snapshot.Version, snapshot.Workspace, snapshot.Version, snapshot.Workspace, snapshot.Version, snapshot.Version, snapshot.Workspace, snapshot.Version}
}

type cachedGraphQuerySchema struct {
	workspace string
	version   storage.GraphVersion
	schema    graph_query.Schema
}

func cloneGraphQuerySchema(schema graph_query.Schema) graph_query.Schema {
	cloneKinds := func(kinds map[string][]string) map[string][]string {
		result := make(map[string][]string, len(kinds))
		for kind, properties := range kinds {
			result[kind] = append([]string(nil), properties...)
		}
		return result
	}
	return graph_query.Schema{NodeKinds: cloneKinds(schema.NodeKinds), RelationshipTypes: cloneKinds(schema.RelationshipTypes)}
}

func (store *Store) graphQuerySchemaForSnapshot(ctx context.Context, transaction *sql.Tx, snapshot storage.Snapshot) (graph_query.Schema, error) {
	store.graphQuerySchemaMu.Lock()
	defer store.graphQuerySchemaMu.Unlock()
	cached := store.graphQuerySchema
	if cached.schema.NodeKinds != nil && cached.workspace == snapshot.Workspace && cached.version == snapshot.Version {
		if err := verifyCatalogSnapshot(ctx, transaction, snapshot); err != nil {
			return graph_query.Schema{}, err
		}
		return cloneGraphQuerySchema(cached.schema), nil
	}
	schema, err := readGraphQuerySchema(ctx, transaction, snapshot)
	if err != nil {
		return graph_query.Schema{}, err
	}
	store.graphQuerySchema = cachedGraphQuerySchema{workspace: snapshot.Workspace, version: snapshot.Version, schema: schema}
	return cloneGraphQuerySchema(schema), nil
}

func (store *Store) GraphQuerySchema(ctx context.Context, snapshot storage.Snapshot) (graph_query.Schema, error) {
	transaction, err := store.database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return graph_query.Schema{}, err
	}
	defer transaction.Rollback()
	return store.graphQuerySchemaForSnapshot(ctx, transaction, snapshot)
}

func readGraphQuerySchema(ctx context.Context, transaction *sql.Tx, snapshot storage.Snapshot) (graph_query.Schema, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 {
		return graph_query.Schema{}, fmt.Errorf("graph query snapshot: %w", storage.ErrInvalidRequest)
	}
	if err := verifyCatalogSnapshot(ctx, transaction, snapshot); err != nil {
		return graph_query.Schema{}, err
	}
	schema := graph_query.Schema{NodeKinds: map[string][]string{}, RelationshipTypes: map[string][]string{}}
	for _, source := range []struct {
		query      string
		properties map[string]string
		target     map[string][]string
	}{
		{query: `SELECT DISTINCT kind FROM contribution_nodes
			WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
			UNION SELECT DISTINCT kind FROM workspace_nodes WHERE workspace = ? AND version = ?`, properties: graphQueryNodeProperties, target: schema.NodeKinds},
		{query: `SELECT DISTINCT relation FROM contribution_edges
			WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
			UNION SELECT DISTINCT relation FROM workspace_edges WHERE workspace = ? AND version = ?`, properties: graphQueryEdgeProperties, target: schema.RelationshipTypes},
	} {
		rows, err := transaction.QueryContext(ctx, source.query, snapshot.Workspace, snapshot.Version, snapshot.Version, snapshot.Workspace, snapshot.Version)
		if err != nil {
			return graph_query.Schema{}, err
		}
		for rows.Next() {
			var kind string
			if err := rows.Scan(&kind); err != nil {
				rows.Close()
				return graph_query.Schema{}, err
			}
			for property := range source.properties {
				source.target[kind] = append(source.target[kind], property)
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return graph_query.Schema{}, err
		}
	}
	return schema, nil
}

func (store *Store) ExecuteGraphQuery(ctx context.Context, snapshot storage.Snapshot, request storage.GraphQueryRequest) (storage.GraphQueryResult, error) {
	transaction, err := store.database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return storage.GraphQueryResult{}, err
	}
	defer transaction.Rollback()
	schema, err := store.graphQuerySchemaForSnapshot(ctx, transaction, snapshot)
	if err != nil {
		return storage.GraphQueryResult{}, err
	}
	parsed, err := graph_query.Validate(request.Query, schema, request.Limits)
	if err != nil {
		return storage.GraphQueryResult{}, err
	}
	if len(parsed.Match.Nodes) == 0 {
		parsed.Match.Nodes = []graph_query.NodePattern{{Alias: parsed.Search.Alias}}
	}
	statement, arguments := translateGraphQuery(snapshot, parsed, request.SeedNodeIDs, request.Limits)
	result, err := executeTranslatedGraphQuery(ctx, transaction, snapshot, parsed, request.Limits, statement, arguments)
	if err == nil && request.Diagnostics {
		result.Diagnostics = &storage.GraphQueryDiagnostics{SQL: statement, Parameters: arguments}
	}
	return result, err
}

type graphQueryBinding struct {
	index        int
	relationship bool
}

func graphQueryBindings(parsed graph_query.GraphQuery) map[string]graphQueryBinding {
	bindings := map[string]graphQueryBinding{}
	for index, node := range parsed.Match.Nodes {
		if node.Alias != "" {
			bindings[node.Alias] = graphQueryBinding{index: index}
		}
	}
	for index, relationship := range parsed.Match.Relationships {
		if relationship.Alias != "" {
			bindings[relationship.Alias] = graphQueryBinding{index: index, relationship: true}
		}
	}
	return bindings
}

func graphQueryProjectionSQL(binding graphQueryBinding, property, separator string) string {
	if !binding.relationship {
		column := "node_id"
		if property != "" {
			column = graphQueryNodeProperties[property]
		}
		return fmt.Sprintf("node%d%s%s", binding.index, separator, column)
	}
	if property == "" {
		return fmt.Sprintf("path%d%sedge_ids", binding.index, separator)
	}
	return fmt.Sprintf("(SELECT edge.%s FROM numbered_edges edge WHERE edge.edge_id = json_extract(path%d%sedge_ids, '$[0]'))", graphQueryEdgeProperties[property], binding.index, separator)
}

func graphQueryVisibleNodesSQL(snapshot storage.Snapshot, conditions []string, values []any) (string, []any) {
	filter := ""
	if len(conditions) > 0 {
		filter = " AND " + strings.Join(conditions, " AND ")
	}
	columns := strings.Join(graphQueryNodeColumns, ", ")
	statement := fmt.Sprintf(`WITH visible_nodes AS (
		SELECT %s FROM contribution_nodes
		WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)%s
		UNION SELECT %s FROM workspace_nodes WHERE workspace = ? AND version = ?%s
	) `, columns, filter, columns, filter)
	arguments := []any{snapshot.Workspace, snapshot.Version, snapshot.Version}
	arguments = append(arguments, values...)
	arguments = append(arguments, snapshot.Workspace, snapshot.Version)
	arguments = append(arguments, values...)
	return statement, arguments
}

func translateGraphQuery(snapshot storage.Snapshot, parsed graph_query.GraphQuery, seeds []string, limits graph_query.Limits) (string, []any) {
	arguments := graphQueryArguments(snapshot)
	statement := graphQueryVisibleSQL + graphQueryNumberedEdgesSQL
	if len(parsed.Match.Relationships) == 0 {
		node := parsed.Match.Nodes[0]
		conditions, values := []string{}, []any{}
		if node.Label != "" {
			conditions = append(conditions, "kind = ?")
			values = append(values, node.Label)
		}
		for _, predicate := range node.Properties {
			conditions = append(conditions, graphQueryNodeProperties[predicate.Property]+" = ?")
			values = append(values, predicate.Value)
		}
		for _, predicate := range parsed.Where {
			if predicate.Alias == node.Alias {
				conditions = append(conditions, graphQueryNodeProperties[predicate.Property]+" = ?")
				values = append(values, predicate.Value)
			}
		}
		statement, arguments = graphQueryVisibleNodesSQL(snapshot, conditions, values)
	}
	statement = strings.Replace(statement, "WITH ", "WITH RECURSIVE ", 1)
	workLimit := limits.MaxNodes
	if workLimit < int(^uint(0)>>1) {
		workLimit++
	}
	for index, relationship := range parsed.Match.Relationships {
		start, end := "source_id", "target_id"
		if relationship.Incoming {
			start, end = end, start
		}
		anchor := parsed.Match.Nodes[index]
		anchorConditions := []string{"edge.relation = ?"}
		arguments = append(arguments, relationship.Type)
		if anchor.Label != "" {
			anchorConditions = append(anchorConditions, "anchor.kind = ?")
			arguments = append(arguments, anchor.Label)
		}
		for _, predicate := range anchor.Properties {
			anchorConditions = append(anchorConditions, "anchor."+graphQueryNodeProperties[predicate.Property]+" = ?")
			arguments = append(arguments, predicate.Value)
		}
		for _, predicate := range parsed.Where {
			if predicate.Alias == anchor.Alias {
				anchorConditions = append(anchorConditions, "anchor."+graphQueryNodeProperties[predicate.Property]+" = ?")
				arguments = append(arguments, predicate.Value)
			}
		}
		if index > 0 {
			anchorConditions = append(anchorConditions, fmt.Sprintf("anchor.node_id IN (SELECT end_id FROM path%d WHERE depth >= ?)", index-1))
			arguments = append(arguments, parsed.Match.Relationships[index-1].MinHops)
		}
		if parsed.Search != nil && parsed.Search.Alias == anchor.Alias {
			encoded, _ := json.Marshal(seeds)
			anchorConditions = append(anchorConditions, "anchor.node_id IN (SELECT value FROM json_each(?))")
			arguments = append(arguments, string(encoded))
		}
		statement += fmt.Sprintf(`, seed%d(start_id, end_id, depth, node_ids, edge_ids) AS (
			SELECT edge.%s, edge.%s, 1, json_array(edge.%s, edge.%s), json_array(edge.edge_id)
			FROM numbered_edges edge JOIN visible_nodes anchor ON anchor.node_id = edge.%s
			WHERE %s ORDER BY edge.edge_id LIMIT ?
		), path%d(start_id, end_id, depth, node_ids, edge_ids) AS (
			SELECT * FROM seed%d
			UNION ALL
			SELECT path.start_id, edge.%s, path.depth + 1,
				json_insert(path.node_ids, '$[#]', edge.%s), json_insert(path.edge_ids, '$[#]', edge.edge_id)
			FROM path%d path JOIN numbered_edges edge ON edge.%s = path.end_id
			WHERE edge.relation = ? AND path.depth < ? AND NOT EXISTS (SELECT 1 FROM json_each(path.edge_ids) used WHERE used.value = edge.edge_id)
			ORDER BY 3, 1, 2, 5 LIMIT ?
		)`, index, start, end, start, end, start, strings.Join(anchorConditions, " AND "), index, index, end, end, index, start)
		arguments = append(arguments, workLimit, relationship.Type, relationship.MaxHops, workLimit)
	}
	columns, joins, conditions, order := []string{}, []string{}, []string{"1 = 1"}, []string{}
	bindings := graphQueryBindings(parsed)
	seenAliases := map[string]int{}
	for index, node := range parsed.Match.Nodes {
		alias := fmt.Sprintf("node%d", index)
		for _, column := range graphQueryNodeColumns {
			columns = append(columns, fmt.Sprintf("%s.%s AS %s_%s", alias, column, alias, column))
		}
		order = append(order, alias+"_node_id")
		if index == 0 {
			joins = append(joins, "visible_nodes "+alias)
		} else {
			joins = append(joins, fmt.Sprintf("JOIN path%d ON path%d.start_id = node%d.node_id AND path%d.depth >= ? JOIN visible_nodes %s ON %s.node_id = path%d.end_id", index-1, index-1, index-1, index-1, alias, alias, index-1))
			arguments = append(arguments, parsed.Match.Relationships[index-1].MinHops)
		}
		if previous, exists := seenAliases[node.Alias]; exists && node.Alias != "" {
			conditions = append(conditions, fmt.Sprintf("%s.node_id = node%d.node_id", alias, previous))
		}
		seenAliases[node.Alias] = index
		if node.Label != "" {
			conditions = append(conditions, alias+".kind = ?")
		}
		for _, predicate := range node.Properties {
			conditions = append(conditions, alias+"."+graphQueryNodeProperties[predicate.Property]+" = ?")
		}
	}
	for _, node := range parsed.Match.Nodes {
		if node.Label != "" {
			arguments = append(arguments, node.Label)
		}
		for _, predicate := range node.Properties {
			arguments = append(arguments, predicate.Value)
		}
	}
	for _, predicate := range parsed.Where {
		binding := bindings[predicate.Alias]
		if binding.relationship {
			conditions = append(conditions, fmt.Sprintf("NOT EXISTS (SELECT 1 FROM json_each(path%d.edge_ids) path_edge JOIN numbered_edges edge ON edge.edge_id = path_edge.value WHERE edge.%s != ?)", binding.index, graphQueryEdgeProperties[predicate.Property]))
		} else {
			conditions = append(conditions, graphQueryProjectionSQL(binding, predicate.Property, ".")+" = ?")
		}
		arguments = append(arguments, predicate.Value)
	}
	if parsed.Search != nil {
		seedColumn := graphQueryProjectionSQL(bindings[parsed.Search.Alias], "id", ".")
		if len(seeds) == 0 {
			conditions = append(conditions, "0 = 1")
		} else {
			conditions = append(conditions, seedColumn+" IN (SELECT value FROM json_each(?))")
			encoded, _ := json.Marshal(seeds)
			arguments = append(arguments, string(encoded))
		}
	}
	for index := range parsed.Match.Relationships {
		columns = append(columns, fmt.Sprintf("path%d.node_ids AS path%d_node_ids, path%d.edge_ids AS path%d_edge_ids", index, index, index, index))
		order = append(order, fmt.Sprintf("path%d_edge_ids", index))
	}
	explicitOrder := []string{}
	for _, term := range parsed.OrderBy {
		expression := graphQueryProjectionSQL(bindings[term.Projection.Alias], term.Projection.Property, "_")
		if term.Descending {
			expression += " DESC"
		}
		explicitOrder = append(explicitOrder, expression)
	}
	order = append(explicitOrder, order...)
	rowLimit := parsed.Limit
	if rowLimit < int(^uint(0)>>1) {
		rowLimit++
	}
	arguments = append(arguments, workLimit, rowLimit)
	statement += ", query_candidates AS MATERIALIZED (SELECT " + strings.Join(columns, ", ") + " FROM " + strings.Join(joins, " ") + " WHERE " + strings.Join(conditions, " AND ") + " LIMIT ?), query_matches AS (SELECT * FROM query_candidates ORDER BY " + strings.Join(order, ", ") + " LIMIT ?)"
	workCaps, emptyColumns := []string{"EXISTS (SELECT 1 FROM query_candidates LIMIT 1 OFFSET ?)"}, []string{}
	arguments = append(arguments, limits.MaxNodes)
	for range parsed.Match.Nodes {
		emptyColumns = append(emptyColumns, "'', '', '', '', '', 0, 0, 0, 0, '', '', '', ''")
	}
	for index := range parsed.Match.Relationships {
		workCaps = append(workCaps, fmt.Sprintf("EXISTS (SELECT 1 FROM path%d LIMIT 1 OFFSET ?)", index))
		arguments = append(arguments, limits.MaxNodes)
		emptyColumns = append(emptyColumns, "'[]', '[]'")
	}
	return statement + " SELECT 1, 0, query_matches.* FROM query_matches UNION ALL SELECT 0, (" + strings.Join(workCaps, " OR ") + "), " + strings.Join(emptyColumns, ", "), arguments
}

type graphQueryMatch struct {
	nodes   []graph.Node
	edgeIDs [][]int
}

func executeTranslatedGraphQuery(ctx context.Context, transaction *sql.Tx, snapshot storage.Snapshot, parsed graph_query.GraphQuery, limits graph_query.Limits, statement string, arguments []any) (storage.GraphQueryResult, error) {
	rows, err := transaction.QueryContext(ctx, statement, arguments...)
	if err != nil {
		return storage.GraphQueryResult{}, fmt.Errorf("execute graph query: %w", err)
	}
	defer rows.Close()
	result := storage.GraphQueryResult{Rows: [][]any{}, Facts: graph.Facts{Nodes: []graph.Node{}, Edges: []graph.Edge{}}}
	matches := []graphQueryMatch{}
	selectedIDs := map[string]bool{}
	selectedEdgeIDs := map[int]bool{}
	for rows.Next() {
		var hasMatch, workCapReached bool
		matched := graphQueryMatch{nodes: make([]graph.Node, len(parsed.Match.Nodes)), edgeIDs: make([][]int, len(parsed.Match.Relationships))}
		targets := []any{&hasMatch, &workCapReached}
		for index := range matched.nodes {
			node := &matched.nodes[index]
			targets = append(targets, &node.ID, &node.Kind, &node.Label, &node.QualifiedName)
			targets = append(targets, evidenceScanTargets(&node.Evidence)...)
		}
		pathNodes, pathEdges := make([]string, len(matched.edgeIDs)), make([]string, len(matched.edgeIDs))
		for index := range matched.edgeIDs {
			targets = append(targets, &pathNodes[index], &pathEdges[index])
		}
		if err := rows.Scan(targets...); err != nil {
			return storage.GraphQueryResult{}, err
		}
		if !hasMatch {
			result.Truncated = result.Truncated || workCapReached
			continue
		}
		if len(matches) >= parsed.Limit {
			result.Truncated = true
			break
		}
		rowIDs := map[string]bool{}
		for _, node := range matched.nodes {
			rowIDs[node.ID] = true
		}
		for index := range pathNodes {
			var nodeIDs []string
			if err := json.Unmarshal([]byte(pathNodes[index]), &nodeIDs); err != nil {
				return storage.GraphQueryResult{}, err
			}
			if err := json.Unmarshal([]byte(pathEdges[index]), &matched.edgeIDs[index]); err != nil {
				return storage.GraphQueryResult{}, err
			}
			for _, nodeID := range nodeIDs {
				rowIDs[nodeID] = true
			}
		}
		newCount := len(selectedIDs)
		for nodeID := range rowIDs {
			if !selectedIDs[nodeID] {
				newCount++
			}
		}
		if newCount > limits.MaxNodes {
			result.Truncated = true
			break
		}
		for nodeID := range rowIDs {
			selectedIDs[nodeID] = true
		}
		for _, edgeIDs := range matched.edgeIDs {
			for _, edgeID := range edgeIDs {
				selectedEdgeIDs[edgeID] = true
			}
		}
		matches = append(matches, matched)
	}
	if err := rows.Err(); err != nil {
		return storage.GraphQueryResult{}, err
	}
	rows.Close()
	nodesByID := map[string]graph.Node{}
	if len(selectedIDs) > 0 {
		ids := []string{}
		for nodeID := range selectedIDs {
			ids = append(ids, nodeID)
		}
		encoded, _ := json.Marshal(ids)
		var facts graph.Facts
		nodeSQL, nodeArguments := graphQueryVisibleNodesSQL(snapshot, []string{"node_id IN (SELECT value FROM json_each(?))"}, []any{string(encoded)})
		if err := appendNodes(ctx, transaction, &facts, nodeSQL+"SELECT * FROM visible_nodes ORDER BY node_id", nodeArguments...); err != nil {
			return storage.GraphQueryResult{}, err
		}
		for _, node := range facts.Nodes {
			nodesByID[node.ID] = node
		}
	}
	edgesByID := map[int]graph.Edge{}
	if len(selectedEdgeIDs) > 0 {
		ids := []int{}
		for edgeID := range selectedEdgeIDs {
			ids = append(ids, edgeID)
		}
		encoded, _ := json.Marshal(ids)
		edgeSQL := graphQueryVisibleSQL + graphQueryNumberedEdgesSQL + `SELECT * FROM numbered_edges WHERE edge_id IN (SELECT value FROM json_each(?)) ORDER BY edge_id`
		edgeRows, err := transaction.QueryContext(ctx, edgeSQL, append(graphQueryArguments(snapshot), string(encoded))...)
		if err != nil {
			return storage.GraphQueryResult{}, err
		}
		defer edgeRows.Close()
		for edgeRows.Next() {
			var edgeID int
			var edge graph.Edge
			targets := append([]any{&edgeID, &edge.SourceID, &edge.TargetID, &edge.Relation}, evidenceScanTargets(&edge.Evidence)...)
			if err := edgeRows.Scan(targets...); err != nil {
				return storage.GraphQueryResult{}, err
			}
			edgesByID[edgeID] = edge
			result.Facts.Edges = append(result.Facts.Edges, edge)
		}
		if err := edgeRows.Err(); err != nil {
			return storage.GraphQueryResult{}, err
		}
	}
	for _, node := range nodesByID {
		result.Facts.Nodes = append(result.Facts.Nodes, node)
	}
	sort.Slice(result.Facts.Nodes, func(left, right int) bool { return result.Facts.Nodes[left].ID < result.Facts.Nodes[right].ID })
	bindings := graphQueryBindings(parsed)
	for _, matched := range matches {
		row := []any{}
		for _, projection := range parsed.Return {
			binding := bindings[projection.Alias]
			if !binding.relationship {
				row = append(row, graphQueryNodeValue(matched.nodes[binding.index], projection.Property))
				continue
			}
			values := []any{}
			for _, edgeID := range matched.edgeIDs[binding.index] {
				values = append(values, graphQueryEdgeValue(edgesByID[edgeID], projection.Property))
			}
			if parsed.Match.Relationships[binding.index].MaxHops == 1 {
				row = append(row, values[0])
			} else {
				row = append(row, values)
			}
		}
		result.Rows = append(result.Rows, row)
	}
	return result, nil
}

func graphQueryEdgeValue(edge graph.Edge, property string) any {
	if property == "" {
		return edge
	}
	if property == "sourceId" {
		return edge.SourceID
	}
	if property == "targetId" {
		return edge.TargetID
	}
	if property == "relation" {
		return string(edge.Relation)
	}
	return graphQueryNodeValue(graph.Node{Evidence: edge.Evidence}, property)
}

func graphQueryNodeValue(node graph.Node, property string) any {
	values := map[string]any{
		"id": node.ID, "kind": string(node.Kind), "name": node.Label, "label": node.Label, "qualifiedName": node.QualifiedName,
		"path": node.Evidence.Span.Path, "startLine": node.Evidence.Span.StartLine, "startColumn": node.Evidence.Span.StartColumn,
		"endLine": node.Evidence.Span.EndLine, "endColumn": node.Evidence.Span.EndColumn,
		"fileHash": node.Evidence.FileHash, "extractor": node.Evidence.Extractor, "provenance": node.Evidence.Provenance, "confidence": string(node.Evidence.Confidence),
	}
	if property == "" {
		return node
	}
	return values[property]
}
