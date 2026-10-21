package benchmark

import "agent-wayfinder/graph"

type QuestionIntent string

type QuestionFeature string

const (
	IntentLookup         QuestionIntent = "lookup"
	IntentExplain        QuestionIntent = "explain"
	IntentCalls          QuestionIntent = "calls"
	IntentCalledBy       QuestionIntent = "called_by"
	IntentDependencies   QuestionIntent = "dependencies"
	IntentDependents     QuestionIntent = "dependents"
	IntentPath           QuestionIntent = "path"
	IntentReachability   QuestionIntent = "reachability"
	IntentSharedContract QuestionIntent = "shared_contract"
	IntentImpact         QuestionIntent = "impact"
)

const (
	FeatureAlias        QuestionFeature = "alias"
	FeatureCamelCase    QuestionFeature = "camel_case"
	FeatureSnakeCase    QuestionFeature = "snake_case"
	FeaturePackageName  QuestionFeature = "package_name"
	FeatureFileName     QuestionFeature = "file_name"
	FeatureQuotedSymbol QuestionFeature = "quoted_symbol"
	FeaturePlural       QuestionFeature = "plural"
	FeatureFillerWords  QuestionFeature = "filler_words"
	FeatureNoMatch      QuestionFeature = "no_match"
)

type QuestionEntityRole struct {
	Role  string
	Value string
}

type ArchitectureQuestion struct {
	Text              string
	Intent            QuestionIntent
	EntityRoles       []QuestionEntityRole
	AcceptableSeeds   []string
	AcceptablePaths   []string
	RequiredRelations []graph.RelationKind
	ForbiddenClaims   []string
	Features          []QuestionFeature
	NoMatch           bool
}

func ArchitectureQuestions() []ArchitectureQuestion {
	return []ArchitectureQuestion{
		featured(question("Where is QuerySnapshot?", IntentLookup, roles("entity", "QuerySnapshot"), seeds("QuerySnapshot", "query.QuerySnapshot"), nil, nil, claims("The function has a caller not present in the evidence.")), FeatureCamelCase),
		featured(question("find query_snapshot", IntentLookup, roles("entity", "query_snapshot"), seeds("QuerySnapshot", "query_snapshot"), nil, nil, claims("The snake_case alias is an exact source identifier.")), FeatureAlias, FeatureSnakeCase),
		featured(question("show me storage/sqlite/sqlite.go", IntentLookup, roles("entity", "storage/sqlite/sqlite.go"), seeds("storage/sqlite/sqlite.go"), paths("storage/sqlite/sqlite.go"), nil, claims("The file implements PostgreSQL storage.")), FeatureFileName, FeatureFillerWords),
		featured(question("Explain \"LookupExactNodes\"", IntentExplain, roles("entity", "LookupExactNodes"), seeds("LookupExactNodes"), nil, nil, claims("An ambiguous candidate is the requested node.")), FeatureQuotedSymbol),
		question("what does nodeLookupQuery do?", IntentExplain, roles("entity", "nodeLookupQuery"), seeds("nodeLookupQuery"), paths("storage/sqlite/sqlite.go"), nil, claims("The function uses FTS5.")),
		featured(question("describe the query package", IntentExplain, roles("entity", "query"), seeds("query"), paths("query"), nil, claims("Every package dependency is shown.")), FeaturePackageName),
		question("what does QuerySnapshot call?", IntentCalls, roles("caller", "QuerySnapshot"), seeds("QuerySnapshot"), nil, relations("calls"), claims("Incoming callers are outgoing calls.")),
		featured(question("which functions does runQuery invoke", IntentCalls, roles("caller", "runQuery"), seeds("runQuery"), paths("cmd/agent-wayfinder/main.go"), relations("calls"), claims("Functions outside call-like relations are invoked.")), FeaturePlural),
		question("show calls from PublishStaged", IntentCalls, roles("caller", "PublishStaged"), seeds("PublishStaged"), nil, relations("calls"), claims("Called-by edges are outgoing calls.")),
		question("who calls QuerySnapshot?", IntentCalledBy, roles("callee", "QuerySnapshot"), seeds("QuerySnapshot"), nil, relations("calls"), claims("Callees are callers.")),
		question("show callers of cli.Render", IntentCalledBy, roles("callee", "cli.Render"), seeds("cli.Render", "Render"), paths("cli/result.go"), relations("calls"), claims("Import edges prove a function call.")),
		question("where is LookupNodes called by other code", IntentCalledBy, roles("callee", "LookupNodes"), seeds("LookupNodes"), nil, relations("calls"), claims("All implementations call the interface method.")),
		question("what does the query package import?", IntentDependencies, roles("dependent", "query"), seeds("query"), paths("query"), relations("imports_from"), claims("Incoming imports are dependencies of query.")),
		question("which packages does cmd/agent-wayfinder depend on", IntentDependencies, roles("dependent", "cmd/agent-wayfinder"), seeds("cmd/agent-wayfinder"), paths("cmd/agent-wayfinder"), relations("imports_from"), claims("Call edges are package dependencies.")),
		question("what modules are required by storage/sqlite", IntentDependencies, roles("dependent", "storage/sqlite"), seeds("storage/sqlite"), paths("storage/sqlite"), relations("imports_from"), claims("Dependents are dependencies.")),
		question("what depends on the storage package?", IntentDependents, roles("dependency", "storage"), seeds("storage"), paths("storage"), relations("imports_from"), claims("Outgoing imports are dependents of storage.")),
		question("find users of graph.Facts", IntentDependents, roles("dependency", "graph.Facts"), seeds("graph.Facts", "Facts"), nil, relations("references", "imports_from"), claims("A textual match proves a dependency.")),
		question("which packages use cli", IntentDependents, roles("dependency", "cli"), seeds("cli"), paths("cli"), relations("imports_from"), claims("The cli package imports all returned packages.")),
		question("find a path from runQuery to Traverse", IntentPath, pairRoles("source", "runQuery", "target", "Traverse"), seeds("runQuery", "Traverse"), paths("cmd/agent-wayfinder/main.go", "storage/storage.go"), relations("calls"), claims("An undirected path proves directed flow.")),
		question("how does main reach QuerySnapshot?", IntentPath, pairRoles("source", "main", "target", "QuerySnapshot"), seeds("main", "QuerySnapshot"), nil, relations("calls"), claims("A path exists when no directed evidence is returned.")),
		question("trace cli.Render from runQuery", IntentPath, pairRoles("source", "runQuery", "target", "cli.Render"), seeds("runQuery", "cli.Render"), nil, relations("calls"), claims("Node proximity proves a call path.")),
		question("can QuerySnapshot reach Traverse?", IntentReachability, pairRoles("source", "QuerySnapshot", "target", "Traverse"), seeds("QuerySnapshot", "Traverse"), nil, relations("calls"), claims("No directed path means an undirected path exists.")),
		question("does runExplain flow to LookupNodes", IntentReachability, pairRoles("source", "runExplain", "target", "LookupNodes"), seeds("runExplain", "LookupNodes"), nil, relations("calls"), claims("A shared package proves reachability.")),
		question("is main connected to Publish through calls", IntentReachability, pairRoles("source", "main", "target", "Publish"), seeds("main", "Publish"), nil, relations("calls"), claims("Containment alone proves reachability.")),
		question("what is the shared contract between postgres and sqlite", IntentSharedContract, pairRoles("left", "postgres", "right", "sqlite"), seeds("postgres", "sqlite", "storage"), paths("storage", "storage/conformance"), relations("implements", "contains"), claims("One adapter's behavior is shared by both adapters.")),
		question("which interfaces are common to Store and a PostgreSQL adapter?", IntentSharedContract, pairRoles("left", "Store", "right", "PostgreSQL adapter"), seeds("Store", "storage"), paths("storage/storage.go"), relations("implements"), claims("A contract is shared without evidence from both sides.")),
		question("show the common storage contracts for SQLite and Postgres", IntentSharedContract, pairRoles("left", "SQLite", "right", "Postgres"), seeds("SQLite", "Postgres", "storage"), paths("storage", "storage/conformance"), relations("implements", "contains"), claims("Side-specific tests are common contracts.")),
		question("what is affected if NodeLookup changes?", IntentImpact, roles("changed", "NodeLookup"), seeds("NodeLookup"), paths("storage/storage.go"), relations("references", "implements", "contains"), claims("Outgoing dependencies are impacted dependents.")),
		question("impact of changing graph_version", IntentImpact, roles("changed", "graph_version"), seeds("graphVersion", "GraphVersion"), nil, relations("references", "contains"), claims("Distant containment ranks above a direct dependent.")),
		featured(noMatchQuestion("what calls the lunarTelemetryGateway?", IntentCalledBy, roles("callee", "lunarTelemetryGateway"), claims("The missing symbol exists.", "A caller exists without returned evidence.")), FeatureNoMatch),
	}
}

func question(text string, intent QuestionIntent, entityRoles []QuestionEntityRole, acceptableSeeds, acceptablePaths []string, requiredRelations []graph.RelationKind, forbiddenClaims []string) ArchitectureQuestion {
	return ArchitectureQuestion{Text: text, Intent: intent, EntityRoles: entityRoles, AcceptableSeeds: acceptableSeeds, AcceptablePaths: acceptablePaths, RequiredRelations: requiredRelations, ForbiddenClaims: forbiddenClaims}
}

func noMatchQuestion(text string, intent QuestionIntent, entityRoles []QuestionEntityRole, forbiddenClaims []string) ArchitectureQuestion {
	return ArchitectureQuestion{Text: text, Intent: intent, EntityRoles: entityRoles, ForbiddenClaims: forbiddenClaims, NoMatch: true}
}

func featured(question ArchitectureQuestion, features ...QuestionFeature) ArchitectureQuestion {
	question.Features = features
	return question
}

func roles(role, value string) []QuestionEntityRole {
	return []QuestionEntityRole{{Role: role, Value: value}}
}

func pairRoles(firstRole, firstValue, secondRole, secondValue string) []QuestionEntityRole {
	return []QuestionEntityRole{{Role: firstRole, Value: firstValue}, {Role: secondRole, Value: secondValue}}
}

func seeds(values ...string) []string { return values }

func paths(values ...string) []string { return values }

func relations(values ...graph.RelationKind) []graph.RelationKind { return values }

func claims(values ...string) []string { return values }
