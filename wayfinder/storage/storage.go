package storage

import (
	"context"
	"errors"
	"time"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
)

var (
	ErrWorkspaceNotFound    = errors.New("storage workspace not found")
	ErrGraphVersionNotFound = errors.New("storage graph version not found")
	ErrGraphVersionPruned   = errors.New("storage graph version pruned")
	ErrInvalidRequest       = errors.New("storage invalid request")
	ErrSpendLimitExceeded   = errors.New("storage spend limit exceeded")
)

type GraphVersion uint64

type OpenSnapshotRequest struct {
	Workspace string
	// Version selects one published version. Nil selects the version current when opening begins.
	Version *GraphVersion
}

type Snapshot struct {
	Workspace   string
	Version     GraphVersion
	PublishedAt time.Time
}

type SnapshotOpener interface {
	OpenSnapshot(context.Context, OpenSnapshotRequest) (Snapshot, error)
}

type PublishRequest struct {
	Workspace                   string
	Update                      extractor.GraphUpdate
	WorkspaceFacts              graph.Facts
	ReplacedWorkspaceFactOwners []string
	Measurement                 func(PublishMeasurement)
	SQLiteWriteMeasurement      func(PublishMeasurement)
}

type PublishMeasurement struct {
	Name          string
	Duration      time.Duration
	NotApplicable bool
}

const (
	PublicationPreparationMeasurement = "publication_preparation"
	SQLiteWriteMeasurement            = "sqlite_write"
	CommitMeasurement                 = "commit"
	StagedTransactionMeasurement      = "staged_transaction"
)

type Publisher interface {
	// Publish either returns an error without exposing partial facts or returns a snapshot that exposes the complete update.
	Publish(context.Context, PublishRequest) (Snapshot, error)
}

type ResolverStageSource struct {
	ProjectID  string
	Language   string
	SourcePath string
}

type ResolverStager interface {
	Snapshot() Snapshot
	StageResolverSources(context.Context, []ResolverStageSource) error
	ResolverProjectionPageReader
	ResolverTargetReader
	ResolverPackagePageReader
}

type StagedPublisher interface {
	// PublishStaged runs stage and publication in one transaction. The callback returns the complete request to publish.
	PublishStaged(context.Context, PublishRequest, func(context.Context, ResolverStager) (PublishRequest, error)) (Snapshot, error)
}

type CommitRequest struct {
	Measurement            func(PublishMeasurement)
	SQLiteWriteMeasurement func(PublishMeasurement)
}

// ContributionSession accepts contribution writes and staged resolver reads before one final commit.
// A session either commits one complete graph version, or rolls back and exposes no partial facts.
type ContributionSession interface {
	ResolverProjectionPageReader
	ResolverTargetReader
	ResolverPackagePageReader
	StageSource(context.Context, string) error
	WriteContribution(context.Context, extractor.Contribution) error
	SealContributions(context.Context) error
	ReplaceContributionDependencies(context.Context, []extractor.Contribution) error
	WriteWorkspaceFacts(context.Context, graph.Facts) error
	SealWorkspaceFacts(context.Context) (FactCounts, error)
	Commit(context.Context, CommitRequest) (Snapshot, error)
	Rollback(context.Context) error
}

type ContributionSessionStore interface {
	BeginContributionSession(context.Context, string) (ContributionSession, error)
}

type PublishProgress struct {
	CompletedContributions int
	TotalContributions     int
	WrittenNodes           int
	TotalNodes             int
	WrittenEdges           int
	TotalEdges             int
}

type ProgressPublisher interface {
	PublishWithProgress(context.Context, PublishRequest, func(PublishProgress)) (Snapshot, error)
}

type AffectedSourcesRequest struct {
	Update extractor.GraphUpdate
}

type AffectedSourceFinder interface {
	AffectedSources(context.Context, Snapshot, AffectedSourcesRequest) ([]string, error)
}

type SourceContribution struct {
	SourcePath           string
	Metadata             extractor.Metadata
	Facts                graph.Facts
	CatalogUnits         []extractor.CatalogUnit
	CatalogUnitsCovered  bool
	UnresolvedReferences []extractor.UnresolvedReference
	SymbolReferences     []extractor.SymbolReference
	ExportedSurfaces     []extractor.ExportedSurface
	Dependencies         []extractor.Dependency
	Diagnostics          []extractor.Diagnostic
}

type SourceContributionReader interface {
	SourceContributions(context.Context, Snapshot) ([]SourceContribution, error)
}

type CatalogUnitCoverageReader interface {
	CatalogUnitsCovered(context.Context, Snapshot) (bool, error)
}

type ResolverProjection = extractor.ResolverProjection

type ResolverProjectionReader interface {
	ResolverProjections(context.Context, Snapshot) ([]ResolverProjection, error)
}

type ResolverProjectionPageRequest struct {
	ProjectID       string
	Language        string
	AfterSourcePath string
	Limit           int
}

type ResolverProjectionPageReader interface {
	ResolverProjectionPage(context.Context, Snapshot, ResolverProjectionPageRequest) ([]ResolverProjection, error)
}

type ResolverTargetReader interface {
	ResolverTarget(context.Context, Snapshot, extractor.ResolverTargetRequest) (extractor.ResolverTarget, bool, error)
}

type ResolverPackagePageReader interface {
	ResolverPackagePage(context.Context, Snapshot, extractor.ResolverPackagePageRequest) ([]extractor.ResolverTarget, error)
}

type NodeLookupRequest struct {
	Text       string
	Kinds      []graph.NodeKind
	ProjectIDs []string
	Limit      int
}

type NodeMatch struct {
	Node  graph.Node
	Score float64
}

type LexicalSearchRequest struct {
	Text        string           `json:"text"`
	Phrases     []string         `json:"phrases,omitempty"`
	TokenGroups [][]string       `json:"tokenGroups,omitempty"`
	Kinds       []graph.NodeKind `json:"kinds,omitempty"`
	ProjectIDs  []string         `json:"projectIds,omitempty"`
	SourcePath  string           `json:"sourcePath,omitempty"`
	Limit       int              `json:"limit"`
}

type LexicalMatch struct {
	Node          graph.Node `json:"node"`
	Score         float64    `json:"score"`
	MatchedFields []string   `json:"matchedFields"`
}

type LexicalSearcher interface {
	SearchNodes(context.Context, Snapshot, LexicalSearchRequest) ([]LexicalMatch, error)
}

type CatalogEntry struct {
	NodeID                string
	Name                  string
	InputFingerprint      string
	DeterministicSynopsis string
	CopilotSynopsis       string
	OllamaSynopsis        string
	ClaudeSynopsis        string
}

type CatalogWriteRequest struct {
	Entries []CatalogEntry
}

type CatalogWriter interface {
	WriteCatalog(context.Context, Snapshot, CatalogWriteRequest) error
}

type CatalogTaskState string

const (
	CatalogTaskQueued      CatalogTaskState = "queued"
	CatalogTaskRunning     CatalogTaskState = "running"
	CatalogTaskInterrupted CatalogTaskState = "interrupted"
	CatalogTaskComplete    CatalogTaskState = "complete"
	CatalogTaskFailed      CatalogTaskState = "failed"
)

type CatalogTask struct {
	Workspace      string
	GraphVersion   GraphVersion
	State          CatalogTaskState
	ProcessID      int
	StartedAt      time.Time
	FinishedAt     time.Time
	CompletedUnits int
	TotalUnits     int
	Stage          string
	ChangedPaths   []string
	Failure        string
}

type CatalogTaskWriter interface {
	WriteCatalogTask(context.Context, CatalogTask) error
}

type CatalogTaskReader interface {
	ReadCatalogTask(context.Context, string) (CatalogTask, bool, error)
}

type CatalogEntryReadRequest struct {
	NodeIDs []string
}

type CatalogEntryReader interface {
	ReadCatalogEntries(context.Context, Snapshot, CatalogEntryReadRequest) ([]CatalogEntry, error)
}

type CatalogEmbeddingSource string

const (
	CatalogEmbeddingDeterministic CatalogEmbeddingSource = "deterministic"
	CatalogEmbeddingCopilot       CatalogEmbeddingSource = "copilot"
	CatalogEmbeddingOllama        CatalogEmbeddingSource = "ollama"
	CatalogEmbeddingClaude        CatalogEmbeddingSource = "claude"
)

type CatalogEmbedding struct {
	NodeID string
	Source CatalogEmbeddingSource
	Text   string
	Vector []float32
}

type CatalogEmbeddingWriteRequest struct {
	Embeddings []CatalogEmbedding
}

type CatalogEmbeddingWriter interface {
	WriteCatalogEmbeddings(context.Context, Snapshot, CatalogEmbeddingWriteRequest) error
}

type CatalogEmbeddingReadRequest struct {
	NodeIDs []string
}

type CatalogEmbeddingReader interface {
	ReadCatalogEmbeddings(context.Context, Snapshot, CatalogEmbeddingReadRequest) ([]CatalogEmbedding, error)
}

type CatalogVectorSearchRequest struct {
	Vector []float32
	Limit  int
}

type CatalogVectorSearcher interface {
	SearchCatalogVectors(context.Context, Snapshot, CatalogVectorSearchRequest) ([]CatalogMatch, error)
}

type CatalogSearchRequest struct {
	Text  string
	Limit int
}

type CatalogMatch struct {
	Node  graph.Node
	Entry CatalogEntry
	Score float64
}

type CatalogSearcher interface {
	SearchCatalog(context.Context, Snapshot, CatalogSearchRequest) ([]CatalogMatch, error)
}

type CopilotPlannerOutcome string

type SpendLimits struct {
	Daily   float64
	Weekly  float64
	Monthly float64
}

type SpendReservationRequest struct {
	Provider      string
	Unit          string
	MaximumAmount float64
	MinimumAmount float64
	Limits        SpendLimits
}

type SpendReservation struct {
	ID     int64
	Amount float64
}

type SpendReservationStore interface {
	ReserveSpend(context.Context, SpendReservationRequest) (SpendReservation, error)
	SettleSpend(context.Context, int64, float64) error
}

const (
	CopilotPlannerOutcomeSuccess CopilotPlannerOutcome = "success"
	CopilotPlannerOutcomeFailure CopilotPlannerOutcome = "failure"
	CopilotPlannerOutcomeTimeout CopilotPlannerOutcome = "timeout"
)

type MetricValueAvailability string

const (
	MetricValueExact       MetricValueAvailability = "exact"
	MetricValueUnavailable MetricValueAvailability = "unavailable"
	MetricValueEstimate    MetricValueAvailability = "estimate"
)

type MetricValue struct {
	Value          int64                   `json:"value,omitempty"`
	Availability   MetricValueAvailability `json:"availability"`
	EstimateMethod string                  `json:"estimateMethod,omitempty"`
}

type DollarValue struct {
	Value          float64                 `json:"value,omitempty"`
	Availability   MetricValueAvailability `json:"availability"`
	EstimateMethod string                  `json:"estimateMethod,omitempty"`
}

func ExactMetricValue(value int64) MetricValue {
	return MetricValue{Value: value, Availability: MetricValueExact}
}

type CopilotPlannerMetric struct {
	RecordedAt              time.Time
	Model                   string
	ActualModel             string
	MaxAICredits            int
	Outcome                 CopilotPlannerOutcome
	Duration                time.Duration
	PromptBytes             int64
	ResponseBytes           int64
	InputTokens             MetricValue
	OutputTokens            MetricValue
	CacheReadTokens         MetricValue
	CacheWriteTokens        MetricValue
	ReasoningTokens         MetricValue
	SessionTotalNanoAiu     MetricValue
	PremiumRequestCredits   MetricValue
	UserRequests            MetricValue
	APIDurationMilliseconds MetricValue
}

type CopilotPlannerMetricRecorder interface {
	RecordCopilotPlannerMetric(context.Context, CopilotPlannerMetric) error
}

type CopilotPlannerDailyMetricsRequest struct {
	Day time.Time
}

type CopilotPlannerDailyMetrics struct {
	Day                     time.Time     `json:"day"`
	Model                   string        `json:"model"`
	ActualModel             string        `json:"actualModel"`
	MaxAICredits            int           `json:"maxAiCredits"`
	Successes               int           `json:"successes"`
	Failures                int           `json:"failures"`
	Timeouts                int           `json:"timeouts"`
	Duration                time.Duration `json:"durationNs"`
	PromptBytes             int64         `json:"promptBytes"`
	ResponseBytes           int64         `json:"responseBytes"`
	InputTokens             MetricValue   `json:"inputTokens"`
	OutputTokens            MetricValue   `json:"outputTokens"`
	CacheReadTokens         MetricValue   `json:"cacheReadTokens"`
	CacheWriteTokens        MetricValue   `json:"cacheWriteTokens"`
	ReasoningTokens         MetricValue   `json:"reasoningTokens"`
	SessionTotalNanoAiu     MetricValue   `json:"sessionTotalNanoAiu"`
	PremiumRequestCredits   MetricValue   `json:"premiumRequestCredits"`
	UserRequests            MetricValue   `json:"userRequests"`
	APIDurationMilliseconds MetricValue   `json:"apiDurationMilliseconds"`
	CostUSD                 DollarValue   `json:"costUsd"`
}

type CopilotPlannerDailyMetricsReader interface {
	ReadCopilotPlannerDailyMetrics(context.Context, CopilotPlannerDailyMetricsRequest) ([]CopilotPlannerDailyMetrics, error)
}

type CopilotPlannerMonthlyMetricsRequest struct {
	Month time.Time
}

type ClaudePlannerOutcome string

const (
	ClaudePlannerOutcomeSuccess          ClaudePlannerOutcome = "success"
	ClaudePlannerOutcomeFallback         ClaudePlannerOutcome = "fallback"
	ClaudePlannerOutcomeTimeout          ClaudePlannerOutcome = "timeout"
	ClaudePlannerOutcomeBudget           ClaudePlannerOutcome = "budget"
	ClaudePlannerOutcomeModelUnavailable ClaudePlannerOutcome = "model_unavailable"
	ClaudePlannerOutcomeUnavailable      ClaudePlannerOutcome = "unavailable"
)

type ClaudePlannerMetric struct {
	RecordedAt              time.Time
	Model                   string
	ActualModel             string
	FallbackModel           string
	MaxBudgetUSD            float64
	Effort                  string
	Outcome                 ClaudePlannerOutcome
	Duration                time.Duration
	PromptBytes             int64
	ResponseBytes           int64
	InputTokens             MetricValue
	OutputTokens            MetricValue
	APIDurationMilliseconds MetricValue
	CostUSD                 DollarValue
}

type ClaudePlannerMetricRecorder interface {
	RecordClaudePlannerMetric(context.Context, ClaudePlannerMetric) error
}

type ClaudePlannerDailyMetricsRequest struct {
	Day time.Time
}

type ClaudePlannerMonthlyMetricsRequest struct {
	Month time.Time
}

type ClaudePlannerDailyMetrics struct {
	Day                     time.Time     `json:"day"`
	Model                   string        `json:"model"`
	ActualModel             string        `json:"actualModel"`
	FallbackModel           string        `json:"fallbackModel"`
	MaxBudgetUSD            float64       `json:"maxBudgetUsd"`
	Effort                  string        `json:"effort"`
	Successes               int           `json:"successes"`
	Fallbacks               int           `json:"fallbacks"`
	Timeouts                int           `json:"timeouts"`
	BudgetFailures          int           `json:"budgetFailures"`
	ModelUnavailables       int           `json:"modelUnavailables"`
	Unavailables            int           `json:"unavailables"`
	Duration                time.Duration `json:"durationNs"`
	PromptBytes             int64         `json:"promptBytes"`
	ResponseBytes           int64         `json:"responseBytes"`
	InputTokens             MetricValue   `json:"inputTokens"`
	OutputTokens            MetricValue   `json:"outputTokens"`
	APIDurationMilliseconds MetricValue   `json:"apiDurationMilliseconds"`
	CostUSD                 DollarValue   `json:"costUsd"`
}

type ClaudePlannerDailyMetricsReader interface {
	ReadClaudePlannerDailyMetrics(context.Context, ClaudePlannerDailyMetricsRequest) ([]ClaudePlannerDailyMetrics, error)
}

type ClaudePlannerMonthlyMetricsReader interface {
	ReadClaudePlannerMonthlyMetrics(context.Context, ClaudePlannerMonthlyMetricsRequest) ([]ClaudePlannerDailyMetrics, error)
}

type CopilotPlannerMonthlyMetricsReader interface {
	ReadCopilotPlannerMonthlyMetrics(context.Context, CopilotPlannerMonthlyMetricsRequest) ([]CopilotPlannerDailyMetrics, error)
}

type CatalogRemover interface {
	DeleteCatalogEntries(context.Context, Snapshot, []string) error
}

type LexicalIndexRebuilder interface {
	RebuildLexicalIndex(context.Context, string) error
}

type NodeLookup interface {
	LookupNodes(context.Context, Snapshot, NodeLookupRequest) ([]NodeMatch, error)
}

// ExactNodeLookup finds nodes whose ID, qualified name, or source path exactly matches the identifier.
type ExactNodeLookup interface {
	LookupExactNodes(context.Context, Snapshot, string) ([]NodeMatch, error)
}

type TraversalDirection string

const (
	TraverseIncoming TraversalDirection = "incoming"
	TraverseOutgoing TraversalDirection = "outgoing"
	TraverseBoth     TraversalDirection = "both"
)

type TraversalRequest struct {
	StartNodeIDs []string
	ProjectIDs   []string
	Direction    TraversalDirection
	Relations    []graph.RelationKind
	MaxDepth     int
	MaxNodes     int
}

type TruncationReason string

const (
	TruncatedByDepthLimit TruncationReason = "depth_limit"
	TruncatedByNodeLimit  TruncationReason = "node_limit"
)

type TraversalResult struct {
	Facts             graph.Facts
	TruncationReasons []TruncationReason
	ScopeBoundary     *graph.Node
}

func (result TraversalResult) Truncated() bool {
	return len(result.TruncationReasons) > 0
}

type Traverser interface {
	Traverse(context.Context, Snapshot, TraversalRequest) (TraversalResult, error)
}

type ExplainRequest struct {
	NodeID string
}

type Explanation struct {
	Node            graph.Node
	SupportingFacts graph.Facts
}

type Explainer interface {
	Explain(context.Context, Snapshot, ExplainRequest) (Explanation, error)
}

type ExportRequest struct {
	NodeKinds []graph.NodeKind
	Relations []graph.RelationKind
}

func (request ExportRequest) IsUnfiltered() bool {
	return len(request.NodeKinds) == 0 && len(request.Relations) == 0
}

type ExportSink interface {
	WriteNode(graph.Node) error
	WriteEdge(graph.Edge) error
}

type Exporter interface {
	Export(context.Context, Snapshot, ExportRequest, ExportSink) error
}

type FactCounts struct {
	Nodes int
	Edges int
}

type FactCounter interface {
	FactCounts(context.Context, Snapshot) (FactCounts, error)
}

type RollbackRequest struct {
	Workspace string
	Version   GraphVersion
}

type Rollbacker interface {
	Rollback(context.Context, RollbackRequest) (Snapshot, error)
}

type PruneRequest struct {
	Workspace     string
	BeforeVersion GraphVersion
}

type PruneResult struct {
	PrunedVersions int
}

type Pruner interface {
	Prune(context.Context, PruneRequest) (PruneResult, error)
}

type Store interface {
	SnapshotOpener
	Publisher
	AffectedSourceFinder
	SourceContributionReader
	ResolverProjectionReader
	ResolverProjectionPageReader
	ResolverTargetReader
	ResolverPackagePageReader
	NodeLookup
	LexicalSearcher
	CatalogWriter
	CatalogTaskWriter
	CatalogTaskReader
	CatalogEntryReader
	CatalogSearcher
	CatalogRemover
	Traverser
	Explainer
	Exporter
	FactCounter
	Rollbacker
	Pruner
}
