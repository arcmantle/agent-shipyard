package sqlite

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
	"agent-wayfinder/storage"

	"github.com/arcmantle/go-sqlite3"
)

const (
	CurrentSchemaVersion                         = 27
	retainedGraphVersions                        = 25
	defaultMaxDatabaseBytes                int64 = 4 << 30
	defaultMaxResolverProjectionCacheBytes int64 = 64 << 20
	pageCacheKiB                                 = 256 << 10
	maximumBatchRows                             = 500
	maximumPublicationWorkers                    = 4
	publicationQueueDepth                        = 2
	defaultContributionBatchRows                 = 5_000
	defaultContributionBatchBytes                = 4 << 20
	defaultContributionBatchSources              = 64
	defaultWorkspaceFactBatchRows                = 500
	defaultWorkspaceFactBatchBytes               = 4 << 20
)

var errSchemaMismatch = errors.New("SQLite schema mismatch")

type Store struct {
	database                 *sql.DB
	now                      func() time.Time
	maxDatabaseBytes         int64
	variableLimit            int
	projectionMu             sync.Mutex
	projections              map[projectionCacheKey]cachedProjections
	projectionBytes          int64
	projectionOrder          uint64
	maxProjectionBytes       int64
	contributionBatchLimits  contributionBatchLimits
	workspaceFactBatchLimits factBatchLimits
	lexicalBatchLimits       factBatchLimits
	disableNodeFTS           bool
	graphQuerySchemaMu       sync.Mutex
	graphQuerySchema         cachedGraphQuerySchema
}

type projectionCacheKey struct {
	workspace string
	version   storage.GraphVersion
}

type cachedProjections struct {
	values []storage.ResolverProjection
	bytes  int64
	order  uint64
}

type Options struct {
	DisableNodeFTS                  bool
	MaxDatabaseBytes                int64
	MaxResolverProjectionCacheBytes int64
	Now                             func() time.Time
}

type MemoryLimits struct {
	ContributionBatchRows    int
	ContributionBatchBytes   int
	ContributionBatchSources int
	WorkspaceFactBatchRows   int
	WorkspaceFactBatchBytes  int
	LexicalBatchRows         int
	LexicalBatchBytes        int
}

func (store *Store) MemoryLimits() MemoryLimits {
	return MemoryLimits{
		ContributionBatchRows:    store.contributionBatchLimits.maximumRows,
		ContributionBatchBytes:   store.contributionBatchLimits.maximumBytes,
		ContributionBatchSources: store.contributionBatchLimits.maximumSources,
		WorkspaceFactBatchRows:   store.workspaceFactBatchLimits.maximumRows,
		WorkspaceFactBatchBytes:  store.workspaceFactBatchLimits.maximumBytes,
		LexicalBatchRows:         store.lexicalBatchLimits.maximumRows,
		LexicalBatchBytes:        store.lexicalBatchLimits.maximumBytes,
	}
}

var _ storage.Publisher = (*Store)(nil)
var _ storage.ProgressPublisher = (*Store)(nil)
var _ storage.StagedPublisher = (*Store)(nil)
var _ storage.ContributionSessionStore = (*Store)(nil)
var _ storage.ContributionSession = (*contributionSession)(nil)
var _ storage.AffectedSourceFinder = (*Store)(nil)
var _ storage.SourceContributionReader = (*Store)(nil)
var _ storage.CatalogUnitCoverageReader = (*Store)(nil)
var _ storage.ResolverProjectionReader = (*Store)(nil)
var _ storage.ResolverProjectionPageReader = (*Store)(nil)
var _ storage.ResolverTargetReader = (*Store)(nil)
var _ storage.ResolverPackagePageReader = (*Store)(nil)
var _ storage.CopilotPlannerMetricRecorder = (*Store)(nil)
var _ storage.CopilotPlannerDailyMetricsReader = (*Store)(nil)
var _ storage.ClaudePlannerMetricRecorder = (*Store)(nil)
var _ storage.ClaudePlannerDailyMetricsReader = (*Store)(nil)
var _ storage.ClaudePlannerMonthlyMetricsReader = (*Store)(nil)
var _ storage.SpendReservationStore = (*Store)(nil)
var _ storage.SnapshotOpener = (*Store)(nil)
var _ storage.NodeLookup = (*Store)(nil)
var _ storage.ExactNodeLookup = (*Store)(nil)
var _ storage.LexicalSearcher = (*Store)(nil)
var _ storage.CatalogEmbeddingWriter = (*Store)(nil)
var _ storage.CatalogEmbeddingReader = (*Store)(nil)
var _ storage.CatalogVectorSearcher = (*Store)(nil)
var _ storage.CatalogTaskWriter = (*Store)(nil)
var _ storage.CatalogTaskReader = (*Store)(nil)
var _ storage.LexicalIndexRebuilder = (*Store)(nil)
var _ storage.Traverser = (*Store)(nil)
var _ storage.Explainer = (*Store)(nil)
var _ storage.Exporter = (*Store)(nil)
var _ storage.FactCounter = (*Store)(nil)
var _ storage.Rollbacker = (*Store)(nil)
var _ storage.Pruner = (*Store)(nil)

func Open(ctx context.Context, path string) (*Store, error) {
	return OpenWithOptions(ctx, path, Options{})
}

func OpenWithOptions(ctx context.Context, path string, options Options) (*Store, error) {
	if path == "" {
		return nil, fmt.Errorf("open SQLite database: path is required")
	}
	if options.MaxDatabaseBytes < 0 {
		return nil, fmt.Errorf("open SQLite database: maximum database bytes cannot be negative")
	}
	if options.MaxDatabaseBytes == 0 {
		options.MaxDatabaseBytes = defaultMaxDatabaseBytes
	}
	if options.MaxResolverProjectionCacheBytes < 0 {
		return nil, fmt.Errorf("open SQLite database: maximum resolver projection cache bytes cannot be negative")
	}
	if options.MaxResolverProjectionCacheBytes == 0 {
		options.MaxResolverProjectionCacheBytes = defaultMaxResolverProjectionCacheBytes
	}
	if options.Now == nil {
		options.Now = time.Now
	}

	database, err := openDatabase(ctx, path)
	if errors.Is(err, errSchemaMismatch) {
		_ = database.Close()
		if err := os.Remove(path); err != nil {
			return nil, fmt.Errorf("recreate SQLite database: %w", err)
		}
		database, err = openDatabase(ctx, path)
	}
	if err != nil {
		return nil, err
	}
	variableLimit, err := sqliteVariableLimit(ctx, database)
	if err != nil {
		_ = database.Close()
		return nil, err
	}

	return &Store{
		disableNodeFTS:     options.DisableNodeFTS,
		database:           database,
		now:                options.Now,
		maxDatabaseBytes:   options.MaxDatabaseBytes,
		variableLimit:      variableLimit,
		projections:        make(map[projectionCacheKey]cachedProjections),
		maxProjectionBytes: options.MaxResolverProjectionCacheBytes,
		contributionBatchLimits: contributionBatchLimits{
			maximumRows:    defaultContributionBatchRows,
			maximumBytes:   defaultContributionBatchBytes,
			maximumSources: defaultContributionBatchSources,
		},
		workspaceFactBatchLimits: factBatchLimits{
			maximumRows:  defaultWorkspaceFactBatchRows,
			maximumBytes: defaultWorkspaceFactBatchBytes,
		},
		lexicalBatchLimits: factBatchLimits{
			maximumRows:  maximumBatchRows,
			maximumBytes: defaultWorkspaceFactBatchBytes,
		},
	}, nil
}

func sqliteVariableLimit(ctx context.Context, database *sql.DB) (int, error) {
	connection, err := database.Conn(ctx)
	if err != nil {
		return 0, fmt.Errorf("read SQLite variable limit: %w", err)
	}
	defer connection.Close()
	var limit int
	if err := connection.Raw(func(driverConnection any) error {
		sqliteConnection, ok := driverConnection.(*sqlite3.SQLiteConn)
		if !ok {
			return fmt.Errorf("unexpected driver connection %T", driverConnection)
		}
		limit = sqliteConnection.GetLimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER)
		return nil
	}); err != nil {
		return 0, fmt.Errorf("read SQLite variable limit: %w", err)
	}
	return limit, nil
}

func openDatabase(ctx context.Context, path string) (*sql.DB, error) {
	// _journal_mode=WAL lets one writer and multiple readers use the database at the
	// same time, so a contribution session can hold an open write transaction while
	// plain Store reads keep seeing the prior committed snapshot. _txlock=immediate
	// serializes writers before they read a graph version.
	// _foreign_keys and _busy_timeout are per-connection settings; setting them in the
	// DSN applies them to every pooled connection, not only the first one opened.
	database, err := sql.Open("sqlite3", path+"?_foreign_keys=1&_journal_mode=WAL&_busy_timeout=5000&_txlock=immediate")
	if err != nil {
		return nil, fmt.Errorf("open SQLite database: %w", err)
	}
	database.SetMaxOpenConns(4)
	if _, err := database.ExecContext(ctx, fmt.Sprintf("PRAGMA cache_size = -%d", pageCacheKiB)); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("set SQLite page cache size: %w", err)
	}
	if err := migrate(ctx, database); err != nil {
		return database, err
	}
	return database, nil
}

func (store *Store) Close() error {
	return store.database.Close()
}

func (store *Store) SchemaVersion(ctx context.Context) (int, error) {
	var version int
	if err := store.database.QueryRowContext(ctx, "SELECT COALESCE(MAX(version), 0) FROM schema_migrations").Scan(&version); err != nil {
		return 0, fmt.Errorf("read SQLite schema version: %w", err)
	}
	return version, nil
}

func (store *Store) Publish(ctx context.Context, request storage.PublishRequest) (storage.Snapshot, error) {
	return store.PublishWithProgress(ctx, request, nil)
}

func (store *Store) PublishWithProgress(ctx context.Context, request storage.PublishRequest, progress func(storage.PublishProgress)) (storage.Snapshot, error) {
	return store.publish(ctx, request, progress, nil)
}

func (store *Store) PublishStaged(ctx context.Context, request storage.PublishRequest, stage func(context.Context, storage.ResolverStager) (storage.PublishRequest, error)) (storage.Snapshot, error) {
	if stage == nil {
		return storage.Snapshot{}, fmt.Errorf("publish staged graph update: %w: stage is required", storage.ErrInvalidRequest)
	}
	return store.publish(ctx, request, nil, stage)
}

func (store *Store) publish(ctx context.Context, request storage.PublishRequest, progress func(storage.PublishProgress), stage func(context.Context, storage.ResolverStager) (storage.PublishRequest, error)) (storage.Snapshot, error) {
	if request.Workspace == "" {
		return storage.Snapshot{}, fmt.Errorf("publish graph update: %w: workspace is required", storage.ErrInvalidRequest)
	}

	writeStarted := time.Now()
	transaction, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("start graph publication: %w", err)
	}
	defer transaction.Rollback()
	if stage != nil {
		var currentVersion storage.GraphVersion
		if err := transaction.QueryRowContext(ctx, "SELECT COALESCE(MAX(version), 0) FROM graph_versions WHERE workspace = ?", request.Workspace).Scan(&currentVersion); err != nil {
			return storage.Snapshot{}, fmt.Errorf("read staged publication snapshot: %w", err)
		}
		stager := resolverStager{
			transaction:   transaction,
			workspace:     request.Workspace,
			snapshot:      storage.Snapshot{Workspace: request.Workspace, Version: currentVersion},
			variableLimit: store.variableLimit,
		}
		defer stager.Close(context.Background())
		stagedRequest, err := stage(ctx, &stager)
		if err != nil {
			return storage.Snapshot{}, fmt.Errorf("stage graph publication: %w", err)
		}
		if stagedRequest.Workspace != request.Workspace {
			return storage.Snapshot{}, fmt.Errorf("stage graph publication: %w: workspace cannot change", storage.ErrInvalidRequest)
		}
		request = stagedRequest
		if err := stager.Close(ctx); err != nil {
			return storage.Snapshot{}, err
		}
	}
	preparationStarted := time.Now()
	contributions, err := encodeContributions(request.Update)
	if err != nil {
		return storage.Snapshot{}, err
	}
	totalNodes, totalEdges := factTotals(contributions, request.WorkspaceFacts)
	reportPublishMeasurement(request.Measurement, storage.PublicationPreparationMeasurement, time.Since(preparationStarted))
	reportProgress := func(completed, writtenNodes, writtenEdges int) {
		if progress != nil {
			progress(storage.PublishProgress{
				CompletedContributions: completed,
				TotalContributions:     len(contributions),
				WrittenNodes:           writtenNodes,
				TotalNodes:             totalNodes,
				WrittenEdges:           writtenEdges,
				TotalEdges:             totalEdges,
			})
		}
	}

	var version storage.GraphVersion
	if err := transaction.QueryRowContext(ctx, "SELECT COALESCE(MAX(version), 0) + 1 FROM graph_versions WHERE workspace = ?", request.Workspace).Scan(&version); err != nil {
		return storage.Snapshot{}, fmt.Errorf("allocate graph version: %w", err)
	}
	publishedAt := time.Now().UTC()
	if err := insertRows(ctx, transaction, store.variableLimit, maximumBatchRows,
		"INSERT INTO graph_versions (workspace, version, published_at) VALUES ",
		[][]any{{request.Workspace, version, publishedAt.Format(time.RFC3339Nano)}}); err != nil {
		return storage.Snapshot{}, fmt.Errorf("record graph publication: %w", err)
	}
	if err := storePreparedPublication(ctx, transaction, store.variableLimit, factBatchLimits{maximumRows: maximumBatchRows}, request.Workspace, version, request.WorkspaceFacts, request.ReplacedWorkspaceFactOwners, request.SQLiteWriteMeasurement, contributions, reportProgress); err != nil {
		return storage.Snapshot{}, err
	}
	if err := closeInvalidCatalogRecords(ctx, transaction, request.Workspace, version); err != nil {
		return storage.Snapshot{}, err
	}
	if version > retainedGraphVersions {
		if _, err := pruneVersions(ctx, transaction, request.Workspace, version-retainedGraphVersions+1); err != nil {
			return storage.Snapshot{}, err
		}
	}
	if err := store.rebuildLexicalSnapshot(ctx, transaction, request.Workspace, version); err != nil {
		return storage.Snapshot{}, err
	}
	if err := ensureDatabaseBudget(ctx, transaction, store.maxDatabaseBytes); err != nil {
		return storage.Snapshot{}, err
	}
	reportPublishMeasurement(request.Measurement, storage.SQLiteWriteMeasurement, time.Since(writeStarted))

	commitStarted := time.Now()
	if err := transaction.Commit(); err != nil {
		return storage.Snapshot{}, fmt.Errorf("commit graph publication: %w", err)
	}
	reportPublishMeasurement(request.Measurement, storage.CommitMeasurement, time.Since(commitStarted))
	store.invalidateWorkspaceCaches(request.Workspace, func(cachedVersion storage.GraphVersion) bool {
		return cachedVersion == version
	})
	_ = reclaimFreePages(ctx, store.database)
	return storage.Snapshot{Workspace: request.Workspace, Version: version, PublishedAt: publishedAt}, nil
}

// BeginContributionSession opens one SQLite transaction that accepts contribution writes
// before final workspace facts are resolved and one graph version is committed.
func (store *Store) BeginContributionSession(ctx context.Context, workspace string) (storage.ContributionSession, error) {
	if workspace == "" {
		return nil, fmt.Errorf("begin contribution session: %w: workspace is required", storage.ErrInvalidRequest)
	}
	beganAt := time.Now()
	transaction, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("start contribution session: %w", err)
	}
	session := &contributionSession{
		store:             store,
		transaction:       transaction,
		workspace:         workspace,
		beganAt:           beganAt,
		writeMeasurements: make(map[string]time.Duration),
	}
	session.batch = newPublicationBatch(store.variableLimit, session.recordWriteMeasurement)
	session.batch.limits = store.contributionBatchLimits
	if err := transaction.QueryRowContext(ctx, "SELECT COALESCE(MAX(version), 0) + 1 FROM graph_versions WHERE workspace = ?", workspace).Scan(&session.pendingVersion); err != nil {
		_ = transaction.Rollback()
		return nil, fmt.Errorf("allocate contribution session graph version: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, `
		CREATE TEMP TABLE IF NOT EXISTS contribution_session_sources (
			workspace TEXT NOT NULL,
			pending_version INTEGER NOT NULL,
			source_path TEXT NOT NULL,
			contribution_written INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (workspace, pending_version, source_path)
		)`); err != nil {
		_ = transaction.Rollback()
		return nil, fmt.Errorf("create contribution session source table: %w", err)
	}
	return session, nil
}

// contributionSession stages contribution writes in one transaction and resolves reads
// against its own pending, uncommitted graph version. It exposes no partial facts: a
// write failure or an explicit rollback rolls back the whole transaction, and the new
// version becomes visible to other readers only when Commit succeeds.
type contributionSession struct {
	store                 *Store
	transaction           *sql.Tx
	workspace             string
	beganAt               time.Time
	pendingVersion        storage.GraphVersion
	batch                 publicationBatch
	writeMeasurements     map[string]time.Duration
	sealed                bool
	missingSourcesClosed  bool
	workspaceFactsWritten bool
	workspaceFactsSealed  bool
	closed                bool
}

// fail rolls back the session's transaction and marks the session closed, so it exposes no partial facts.
func (session *contributionSession) fail(err error) error {
	if !session.closed {
		session.closed = true
		_ = session.transaction.Rollback()
	}
	return err
}

func (session *contributionSession) StageSource(ctx context.Context, sourcePath string) error {
	if session.closed {
		return fmt.Errorf("stage contribution source: %w: session is closed", storage.ErrInvalidRequest)
	}
	if session.sealed {
		return fmt.Errorf("stage contribution source: %w: contributions are sealed", storage.ErrInvalidRequest)
	}
	if sourcePath == "" {
		return session.fail(fmt.Errorf("stage contribution source: %w: source path is required", storage.ErrInvalidRequest))
	}
	if _, err := session.transaction.ExecContext(ctx, `
		INSERT INTO contribution_session_sources (workspace, pending_version, source_path)
		VALUES (?, ?, ?)`, session.workspace, session.pendingVersion, sourcePath); err != nil {
		return session.fail(fmt.Errorf("stage contribution source %q: %w", sourcePath, err))
	}
	return nil
}

func (session *contributionSession) WriteContribution(ctx context.Context, contribution extractor.Contribution) error {
	if session.closed {
		return fmt.Errorf("write contribution: %w: session is closed", storage.ErrInvalidRequest)
	}
	if session.sealed {
		return fmt.Errorf("write contribution: %w: contributions are sealed", storage.ErrInvalidRequest)
	}
	if err := ctx.Err(); err != nil {
		return session.fail(fmt.Errorf("write contribution: %w", err))
	}
	sourcePath := contribution.SourcePath()
	result, err := session.transaction.ExecContext(ctx, `
		UPDATE contribution_session_sources
		SET contribution_written = 1
		WHERE workspace = ? AND pending_version = ? AND source_path = ? AND contribution_written = 0`,
		session.workspace, session.pendingVersion, sourcePath)
	if err != nil {
		return session.fail(fmt.Errorf("write contribution: mark source %q: %w", sourcePath, err))
	}
	written, err := result.RowsAffected()
	if err != nil {
		return session.fail(fmt.Errorf("write contribution: inspect source %q: %w", sourcePath, err))
	}
	if written != 1 {
		return session.fail(fmt.Errorf("write contribution: %w: source path %q is not staged or already has a contribution", storage.ErrInvalidRequest, sourcePath))
	}
	update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
	if err != nil {
		return session.fail(fmt.Errorf("write contribution: %w", err))
	}
	encoded, err := encodeContributions(update)
	if err != nil {
		return session.fail(err)
	}
	prepared, err := prepareContribution(session.workspace, session.pendingVersion, 0, encoded[0])
	if err != nil {
		return session.fail(err)
	}
	if err := session.batch.add(ctx, session.transaction, session.workspace, session.pendingVersion, prepared); err != nil {
		return session.fail(fmt.Errorf("write contribution: %w", err))
	}
	return nil
}

func (session *contributionSession) SealContributions(ctx context.Context) error {
	if session.closed {
		return fmt.Errorf("seal contributions: %w: session is closed", storage.ErrInvalidRequest)
	}
	if session.sealed {
		return nil
	}
	if err := session.batch.flush(ctx, session.transaction); err != nil {
		return session.fail(fmt.Errorf("seal contributions: %w", err))
	}
	session.sealed = true
	return nil
}

func (session *contributionSession) recordWriteMeasurement(measurement storage.PublishMeasurement) {
	if measurement.NotApplicable {
		return
	}
	session.writeMeasurements[measurement.Name] += measurement.Duration
}

func (session *contributionSession) reportWriteMeasurements(callback func(storage.PublishMeasurement)) {
	for _, insertion := range session.batch.insertions {
		if duration, found := session.writeMeasurements[insertion.name]; found {
			reportPublishMeasurement(callback, insertion.name, duration)
		} else if callback != nil {
			callback(storage.PublishMeasurement{Name: insertion.name, NotApplicable: true})
		}
	}
}

func (session *contributionSession) ReplaceContributionDependencies(ctx context.Context, contributions []extractor.Contribution) error {
	if session.closed {
		return fmt.Errorf("replace contribution dependencies: %w: session is closed", storage.ErrInvalidRequest)
	}
	if !session.sealed {
		return fmt.Errorf("replace contribution dependencies: %w: contributions are not sealed", storage.ErrInvalidRequest)
	}
	updated := make(map[string]extractor.Contribution, len(contributions))
	for _, contribution := range contributions {
		sourcePath := contribution.SourcePath()
		var contributionWritten int
		err := session.transaction.QueryRowContext(ctx, `
			SELECT contribution_written
			FROM contribution_session_sources
			WHERE workspace = ? AND pending_version = ? AND source_path = ?`,
			session.workspace, session.pendingVersion, sourcePath).Scan(&contributionWritten)
		if errors.Is(err, sql.ErrNoRows) {
			return session.fail(fmt.Errorf("replace contribution dependencies: %w: source path %q is not staged", storage.ErrInvalidRequest, sourcePath))
		}
		if err != nil {
			return session.fail(fmt.Errorf("replace contribution dependencies: read staged source %q: %w", sourcePath, err))
		}
		if contributionWritten != 1 {
			return session.fail(fmt.Errorf("replace contribution dependencies: %w: source path %q has no written contribution", storage.ErrInvalidRequest, sourcePath))
		}
		if _, exists := updated[sourcePath]; exists {
			return session.fail(fmt.Errorf("replace contribution dependencies: %w: duplicate source path %q", storage.ErrInvalidRequest, sourcePath))
		}
		updated[sourcePath] = contribution
	}
	for sourcePath := range updated {
		if _, err := session.transaction.ExecContext(ctx, "DELETE FROM contribution_dependencies WHERE workspace = ? AND source_path = ? AND valid_from_version = ?", session.workspace, sourcePath, session.pendingVersion); err != nil {
			return session.fail(fmt.Errorf("replace contribution dependencies: %w", err))
		}
	}
	rows := make([][]any, 0)
	for _, contribution := range contributions {
		for _, dependency := range contribution.Dependencies() {
			rows = append(rows, []any{session.workspace, contribution.SourcePath(), session.pendingVersion, dependency.TargetPath})
		}
	}
	if err := insertRows(ctx, session.transaction, session.store.variableLimit, maximumBatchRows,
		"INSERT OR IGNORE INTO contribution_dependencies (workspace, source_path, valid_from_version, target_path) VALUES ", rows); err != nil {
		return session.fail(fmt.Errorf("replace contribution dependencies: %w", err))
	}
	return nil
}

func (session *contributionSession) WriteWorkspaceFacts(ctx context.Context, facts graph.Facts) error {
	if session.closed {
		return fmt.Errorf("write workspace facts: %w: session is closed", storage.ErrInvalidRequest)
	}
	if !session.sealed {
		return fmt.Errorf("write workspace facts: %w: contributions are not sealed", storage.ErrInvalidRequest)
	}
	if session.workspaceFactsSealed {
		return fmt.Errorf("write workspace facts: %w: workspace facts are sealed", storage.ErrInvalidRequest)
	}
	if err := ctx.Err(); err != nil {
		return session.fail(fmt.Errorf("write workspace facts: %w", err))
	}
	if err := storeWorkspaceFacts(ctx, session.transaction, session.store.variableLimit, session.store.workspaceFactBatchLimits, session.workspace, session.pendingVersion, facts, session.recordWriteMeasurement); err != nil {
		return session.fail(err)
	}
	session.workspaceFactsWritten = true
	return nil
}

func (session *contributionSession) SealWorkspaceFacts(ctx context.Context) (storage.FactCounts, error) {
	if session.closed {
		return storage.FactCounts{}, fmt.Errorf("seal workspace facts: %w: session is closed", storage.ErrInvalidRequest)
	}
	if !session.sealed {
		return storage.FactCounts{}, fmt.Errorf("seal workspace facts: %w: contributions are not sealed", storage.ErrInvalidRequest)
	}
	if err := ctx.Err(); err != nil {
		return storage.FactCounts{}, session.fail(fmt.Errorf("seal workspace facts: %w", err))
	}
	if err := session.closeMissingSources(ctx); err != nil {
		return storage.FactCounts{}, err
	}
	counts := storage.FactCounts{}
	if err := session.transaction.QueryRowContext(ctx, "SELECT COUNT(*) FROM workspace_nodes WHERE workspace = ? AND version = ?", session.workspace, session.pendingVersion).Scan(&counts.Nodes); err != nil {
		return storage.FactCounts{}, session.fail(fmt.Errorf("count staged workspace nodes: %w", err))
	}
	if err := session.transaction.QueryRowContext(ctx, "SELECT COUNT(*) FROM workspace_edges WHERE workspace = ? AND version = ?", session.workspace, session.pendingVersion).Scan(&counts.Edges); err != nil {
		return storage.FactCounts{}, session.fail(fmt.Errorf("count staged workspace edges: %w", err))
	}
	session.workspaceFactsSealed = true
	return counts, nil
}

func (session *contributionSession) closeMissingSources(ctx context.Context) error {
	if session.missingSourcesClosed {
		return nil
	}
	if session.pendingVersion == 1 {
		session.missingSourcesClosed = true
		return nil
	}
	if err := closeContributionsMissingFromStagedSources(ctx, session.transaction, session.workspace, session.pendingVersion); err != nil {
		return session.fail(fmt.Errorf("close missing source contributions: %w", err))
	}
	session.missingSourcesClosed = true
	return nil
}

func (session *contributionSession) Commit(ctx context.Context, request storage.CommitRequest) (storage.Snapshot, error) {
	if session.closed {
		return storage.Snapshot{}, fmt.Errorf("commit contribution session: %w: session is closed", storage.ErrInvalidRequest)
	}
	if session.workspaceFactsWritten && !session.workspaceFactsSealed {
		return storage.Snapshot{}, fmt.Errorf("commit contribution session: %w: workspace facts are not sealed", storage.ErrInvalidRequest)
	}
	if err := session.batch.flush(ctx, session.transaction); err != nil {
		return storage.Snapshot{}, session.fail(err)
	}
	if err := session.closeMissingSources(ctx); err != nil {
		return storage.Snapshot{}, err
	}
	session.reportWriteMeasurements(request.SQLiteWriteMeasurement)
	publishedAt := time.Now().UTC()
	if err := insertRows(ctx, session.transaction, session.store.variableLimit, maximumBatchRows,
		"INSERT INTO graph_versions (workspace, version, published_at) VALUES ",
		[][]any{{session.workspace, session.pendingVersion, publishedAt.Format(time.RFC3339Nano)}}); err != nil {
		return storage.Snapshot{}, session.fail(fmt.Errorf("record graph publication: %w", err))
	}
	for _, name := range []string{"workspace_nodes", "workspace_edges"} {
		if duration, found := session.writeMeasurements[name]; found {
			reportPublishMeasurement(request.SQLiteWriteMeasurement, name, duration)
		} else if request.SQLiteWriteMeasurement != nil {
			request.SQLiteWriteMeasurement(storage.PublishMeasurement{Name: name, NotApplicable: true})
		}
	}
	if err := closeInvalidCatalogRecords(ctx, session.transaction, session.workspace, session.pendingVersion); err != nil {
		return storage.Snapshot{}, session.fail(err)
	}
	if session.pendingVersion > retainedGraphVersions {
		if _, err := pruneVersions(ctx, session.transaction, session.workspace, session.pendingVersion-retainedGraphVersions+1); err != nil {
			return storage.Snapshot{}, session.fail(err)
		}
	}
	if err := session.store.rebuildLexicalSnapshot(ctx, session.transaction, session.workspace, session.pendingVersion); err != nil {
		return storage.Snapshot{}, session.fail(err)
	}
	if err := ensureDatabaseBudget(ctx, session.transaction, session.store.maxDatabaseBytes); err != nil {
		return storage.Snapshot{}, session.fail(err)
	}
	if _, err := session.transaction.ExecContext(ctx,
		"DELETE FROM contribution_session_sources WHERE workspace = ? AND pending_version = ?",
		session.workspace, session.pendingVersion); err != nil {
		return storage.Snapshot{}, session.fail(fmt.Errorf("remove contribution session sources: %w", err))
	}

	commitStarted := time.Now()
	if err := session.transaction.Commit(); err != nil {
		return storage.Snapshot{}, session.fail(fmt.Errorf("commit contribution session: %w", err))
	}
	session.closed = true
	reportPublishMeasurement(request.Measurement, storage.CommitMeasurement, time.Since(commitStarted))
	reportPublishMeasurement(request.Measurement, storage.StagedTransactionMeasurement, time.Since(session.beganAt))

	session.store.invalidateWorkspaceCaches(session.workspace, func(cachedVersion storage.GraphVersion) bool {
		return cachedVersion == session.pendingVersion
	})
	_ = reclaimFreePages(ctx, session.store.database)
	return storage.Snapshot{Workspace: session.workspace, Version: session.pendingVersion, PublishedAt: publishedAt}, nil
}

func (session *contributionSession) Rollback(ctx context.Context) error {
	if session.closed {
		return nil
	}
	session.closed = true
	if err := session.transaction.Rollback(); err != nil {
		return fmt.Errorf("rollback contribution session: %w", err)
	}
	return nil
}

func (session *contributionSession) ResolverProjectionPage(ctx context.Context, snapshot storage.Snapshot, request storage.ResolverProjectionPageRequest) ([]storage.ResolverProjection, error) {
	if session.closed {
		return nil, fmt.Errorf("read contribution session resolver projection page: %w: session is closed", storage.ErrInvalidRequest)
	}
	if !session.sealed {
		return nil, fmt.Errorf("read contribution session resolver projection page: %w: contributions are not sealed", storage.ErrInvalidRequest)
	}
	if snapshot.Workspace != session.workspace || request.ProjectID == "" || request.Language == "" || request.Limit <= 0 {
		return nil, fmt.Errorf("read contribution session resolver projection page: %w: snapshot, project, language, and positive limit are required", storage.ErrInvalidRequest)
	}
	rows, err := session.transaction.QueryContext(ctx, `
		SELECT contributions.source_path, contributions.project_id, contributions.extractor_name, contributions.extractor_version
		FROM file_contributions contributions
		JOIN contribution_session_sources sources
			ON sources.workspace = contributions.workspace
			AND sources.pending_version = ?
			AND sources.source_path = contributions.source_path
		WHERE contributions.workspace = ?
			AND contributions.valid_from_version <= ?
			AND (contributions.valid_to_version IS NULL OR contributions.valid_to_version >= ?)
			AND contributions.project_id = ?
			AND contributions.extractor_name = ?
			AND contributions.source_path > ?
		ORDER BY contributions.source_path
		LIMIT ?`,
		session.pendingVersion, session.workspace, session.pendingVersion, session.pendingVersion,
		request.ProjectID, request.Language, request.AfterSourcePath, request.Limit)
	if err != nil {
		return nil, fmt.Errorf("read contribution session resolver projection page: %w", err)
	}
	defer rows.Close()
	projections := make([]storage.ResolverProjection, 0, request.Limit)
	for rows.Next() {
		var projection storage.ResolverProjection
		if err := rows.Scan(&projection.SourcePath, &projection.ProjectID, &projection.Metadata.Name, &projection.Metadata.Version); err != nil {
			return nil, fmt.Errorf("read contribution session resolver projection page: %w", err)
		}
		projections = append(projections, projection)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate contribution session resolver projection page: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close contribution session resolver projection page: %w", err)
	}
	pendingSnapshot := storage.Snapshot{Workspace: session.workspace, Version: session.pendingVersion}
	if err := readResolverProjectionNodes(ctx, session.transaction, pendingSnapshot, projections, session.store.variableLimit); err != nil {
		return nil, err
	}
	if err := readResolverProjectionData(ctx, session.transaction, pendingSnapshot, projections, session.store.variableLimit); err != nil {
		return nil, err
	}
	for projectionIndex := range projections {
		projection := &projections[projectionIndex]
		if err := projection.Metadata.Validate(); err != nil {
			return nil, fmt.Errorf("read contribution session resolver projection %q: metadata: %w", projection.SourcePath, err)
		}
	}
	return projections, nil
}

func readResolverProjectionData(ctx context.Context, queries queryer, snapshot storage.Snapshot, projections []storage.ResolverProjection, variableLimit int) error {
	bySource := make(map[string]*storage.ResolverProjection, len(projections))
	for projectionIndex := range projections {
		projection := &projections[projectionIndex]
		bySource[projection.SourcePath] = projection
	}
	referenceIndexes := make(map[[4]string]int)
	readers := []struct {
		selection string
		ordering  string
		readRow   func(*sql.Rows) error
	}{
		{`SELECT source_path, extension FROM contribution_extensions`, "extension", func(rows *sql.Rows) error {
			var sourcePath, extension string
			if err := rows.Scan(&sourcePath, &extension); err != nil {
				return err
			}
			projection := bySource[sourcePath]
			projection.Metadata.Extensions = append(projection.Metadata.Extensions, extension)
			return nil
		}},
		{`SELECT source_path, target_path FROM contribution_dependencies`, "target_path", func(rows *sql.Rows) error {
			var dependency extractor.Dependency
			if err := rows.Scan(&dependency.SourcePath, &dependency.TargetPath); err != nil {
				return err
			}
			projection := bySource[dependency.SourcePath]
			projection.Dependencies = append(projection.Dependencies, dependency)
			return nil
		}},
		{`SELECT source_path, node_id, name FROM contribution_exported_surfaces`, "node_id, name", func(rows *sql.Rows) error {
			var sourcePath string
			var surface extractor.ExportedSurface
			if err := rows.Scan(&sourcePath, &surface.NodeID, &surface.Name); err != nil {
				return err
			}
			projection := bySource[sourcePath]
			projection.ExportedSurfaces = append(projection.ExportedSurfaces, surface)
			return nil
		}},
		{`SELECT source_path, severity, message FROM contribution_diagnostics`, "severity, message", func(rows *sql.Rows) error {
			var sourcePath string
			var diagnostic extractor.Diagnostic
			if err := rows.Scan(&sourcePath, &diagnostic.Severity, &diagnostic.Message); err != nil {
				return err
			}
			projection := bySource[sourcePath]
			projection.Diagnostics = append(projection.Diagnostics, diagnostic)
			return nil
		}},
		{`SELECT source_path, source_id, target, kind, ambiguous FROM contribution_unresolved_references`, "source_id, target, kind", func(rows *sql.Rows) error {
			var sourcePath string
			var reference extractor.UnresolvedReference
			if err := rows.Scan(&sourcePath, &reference.SourceID, &reference.Target, &reference.Kind, &reference.Ambiguous); err != nil {
				return err
			}
			reference.Bindings = make([]extractor.ModuleBinding, 0)
			projection := bySource[sourcePath]
			referenceIndexes[[4]string{sourcePath, string(reference.SourceID), reference.Target, string(reference.Kind)}] = len(projection.UnresolvedReferences)
			projection.UnresolvedReferences = append(projection.UnresolvedReferences, reference)
			return nil
		}},
		{`SELECT source_path, source_id, target, kind, imported_name, exported_name, local_name FROM contribution_module_bindings`, "source_id, target, kind, imported_name, exported_name, local_name", func(rows *sql.Rows) error {
			var sourcePath string
			var reference extractor.UnresolvedReference
			var binding extractor.ModuleBinding
			if err := rows.Scan(&sourcePath, &reference.SourceID, &reference.Target, &reference.Kind, &binding.ImportedName, &binding.ExportedName, &binding.LocalName); err != nil {
				return err
			}
			if referenceIndex, found := referenceIndexes[[4]string{sourcePath, string(reference.SourceID), reference.Target, string(reference.Kind)}]; found {
				stored := &bySource[sourcePath].UnresolvedReferences[referenceIndex]
				stored.Bindings = append(stored.Bindings, binding)
			}
			return nil
		}},
		{`SELECT source_path, source_id, target, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence FROM contribution_symbol_references`, "source_id, target, relation", func(rows *sql.Rows) error {
			var sourcePath string
			var reference extractor.SymbolReference
			targets := append([]any{&sourcePath, &reference.SourceID, &reference.Target, &reference.Relation}, evidenceScanTargets(&reference.Evidence)...)
			if err := rows.Scan(targets...); err != nil {
				return err
			}
			projection := bySource[sourcePath]
			projection.SymbolReferences = append(projection.SymbolReferences, reference)
			return nil
		}},
	}
	for _, reader := range readers {
		if err := readResolverProjectionRows(ctx, queries, snapshot, projections, variableLimit, reader.selection, reader.ordering, reader.readRow); err != nil {
			return err
		}
	}
	return nil
}

func readResolverProjectionRows(ctx context.Context, queries queryer, snapshot storage.Snapshot, projections []storage.ResolverProjection, variableLimit int, selection, ordering string, readRow func(*sql.Rows) error) error {
	maximumPaths := max(1, variableLimit-3)
	for start := 0; start < len(projections); start += maximumPaths {
		chunk := projections[start:min(start+maximumPaths, len(projections))]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		arguments := []any{snapshot.Workspace, snapshot.Version, snapshot.Version}
		for _, projection := range chunk {
			arguments = append(arguments, projection.SourcePath)
		}
		rows, err := queries.QueryContext(ctx, selection+`
			WHERE workspace = ?
				AND valid_from_version <= ?
				AND (valid_to_version IS NULL OR valid_to_version >= ?)
				AND source_path IN (`+placeholders+`)
			ORDER BY source_path, `+ordering, arguments...)
		if err != nil {
			return fmt.Errorf("read initial resolver projection rows: %w", err)
		}
		for rows.Next() {
			if err := readRow(rows); err != nil {
				_ = rows.Close()
				return fmt.Errorf("scan initial resolver projection row: %w", err)
			}
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return fmt.Errorf("iterate initial resolver projection rows: %w", err)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close initial resolver projection rows: %w", err)
		}
	}
	return nil
}

func readResolverProjectionNodes(ctx context.Context, queries queryer, snapshot storage.Snapshot, projections []storage.ResolverProjection, variableLimit int) error {
	projectionIndexes := make(map[string]int, len(projections))
	for projectionIndex, projection := range projections {
		projectionIndexes[projection.SourcePath] = projectionIndex
	}
	return readResolverProjectionRows(ctx, queries, snapshot, projections, variableLimit,
		`SELECT source_path, node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence FROM contribution_nodes`, "node_id",
		func(rows *sql.Rows) error {
			var sourcePath string
			var node graph.Node
			targets := append([]any{&sourcePath, &node.ID, &node.Kind, &node.Label, &node.QualifiedName}, evidenceScanTargets(&node.Evidence)...)
			if err := rows.Scan(targets...); err != nil {
				return err
			}
			projection := &projections[projectionIndexes[sourcePath]]
			projection.Nodes = append(projection.Nodes, node)
			return nil
		})
}

func (session *contributionSession) ResolverTarget(ctx context.Context, snapshot storage.Snapshot, request extractor.ResolverTargetRequest) (extractor.ResolverTarget, bool, error) {
	if session.closed {
		return extractor.ResolverTarget{}, false, fmt.Errorf("read contribution session resolver target: %w: session is closed", storage.ErrInvalidRequest)
	}
	if !session.sealed {
		return extractor.ResolverTarget{}, false, fmt.Errorf("read contribution session resolver target: %w: contributions are not sealed", storage.ErrInvalidRequest)
	}
	if snapshot.Workspace != session.workspace || request.ProjectID == "" || request.Language == "" || request.SourcePath == "" {
		return extractor.ResolverTarget{}, false, fmt.Errorf("read contribution session resolver target: %w: snapshot, project, language, and source path are required", storage.ErrInvalidRequest)
	}
	target := extractor.ResolverTarget{ProjectID: request.ProjectID, SourcePath: request.SourcePath}
	err := session.transaction.QueryRowContext(ctx, `
		SELECT contributions.extractor_name, contributions.extractor_version
		FROM file_contributions contributions
		JOIN contribution_session_sources sources
			ON sources.workspace = contributions.workspace
			AND sources.pending_version = ?
			AND sources.source_path = contributions.source_path
		WHERE contributions.workspace = ?
			AND contributions.valid_from_version <= ?
			AND (contributions.valid_to_version IS NULL OR contributions.valid_to_version >= ?)
			AND contributions.project_id = ?
			AND contributions.extractor_name = ?
			AND contributions.source_path = ?`,
		session.pendingVersion, session.workspace, session.pendingVersion, session.pendingVersion,
		request.ProjectID, request.Language, request.SourcePath,
	).Scan(&target.Metadata.Name, &target.Metadata.Version)
	if errors.Is(err, sql.ErrNoRows) {
		return extractor.ResolverTarget{}, false, nil
	}
	if err != nil {
		return extractor.ResolverTarget{}, false, fmt.Errorf("read contribution session resolver target: %w", err)
	}
	pendingSnapshot := storage.Snapshot{Workspace: session.workspace, Version: session.pendingVersion}
	data, err := storeResolutionDataForSource(ctx, session.transaction, pendingSnapshot, request.SourcePath)
	if err != nil {
		return extractor.ResolverTarget{}, false, err
	}
	target.Metadata.Extensions = data.Metadata.Extensions
	if err := target.Metadata.Validate(); err != nil {
		return extractor.ResolverTarget{}, false, fmt.Errorf("read contribution session resolver target %q: metadata: %w", request.SourcePath, err)
	}
	var facts graph.Facts
	if err := appendNodes(ctx, session.transaction, &facts, `
		SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM contribution_nodes
		WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
		ORDER BY node_id`, session.workspace, request.SourcePath, session.pendingVersion, session.pendingVersion); err != nil {
		return extractor.ResolverTarget{}, false, err
	}
	target.Nodes = facts.Nodes
	target.UnresolvedReferences = data.UnresolvedReferences
	target.SymbolReferences = data.SymbolReferences
	target.ExportedSurfaces = data.ExportedSurfaces
	target.Diagnostics = data.Diagnostics
	return target, true, nil
}

func (session *contributionSession) ResolverPackagePage(ctx context.Context, snapshot storage.Snapshot, request extractor.ResolverPackagePageRequest) ([]extractor.ResolverTarget, error) {
	if session.closed {
		return nil, fmt.Errorf("read contribution session resolver package page: %w: session is closed", storage.ErrInvalidRequest)
	}
	if !session.sealed {
		return nil, fmt.Errorf("read contribution session resolver package page: %w: contributions are not sealed", storage.ErrInvalidRequest)
	}
	if snapshot.Workspace != session.workspace || request.ProjectID == "" || request.Language == "" || request.PackagePath == "" || request.Limit <= 0 {
		return nil, fmt.Errorf("read contribution session resolver package page: %w: snapshot, project, language, package path, and positive limit are required", storage.ErrInvalidRequest)
	}
	pathFilter := "contributions.source_path LIKE ? AND INSTR(contributions.source_path, '/') = 0"
	pathArguments := []any{"%"}
	if request.PackagePath != "." {
		prefix := request.PackagePath + "/"
		pathFilter = "contributions.source_path LIKE ? AND INSTR(SUBSTR(contributions.source_path, LENGTH(?) + 1), '/') = 0"
		pathArguments = []any{prefix + "%", prefix}
	}
	query := `SELECT contributions.source_path FROM file_contributions contributions JOIN contribution_session_sources sources ON sources.workspace = contributions.workspace AND sources.pending_version = ? AND sources.source_path = contributions.source_path WHERE contributions.workspace = ? AND contributions.valid_from_version <= ? AND (contributions.valid_to_version IS NULL OR contributions.valid_to_version >= ?) AND contributions.project_id = ? AND contributions.extractor_name = ? AND ` + pathFilter + ` AND contributions.source_path > ? ORDER BY contributions.source_path LIMIT ?`
	arguments := []any{session.pendingVersion, session.workspace, session.pendingVersion, session.pendingVersion, request.ProjectID, request.Language}
	arguments = append(arguments, pathArguments...)
	arguments = append(arguments, request.AfterSourcePath, request.Limit)
	rows, err := session.transaction.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("read contribution session resolver package page: %w", err)
	}
	defer rows.Close()
	targets := make([]extractor.ResolverTarget, 0, request.Limit)
	for rows.Next() {
		var sourcePath string
		if err := rows.Scan(&sourcePath); err != nil {
			return nil, fmt.Errorf("read contribution session resolver package page: %w", err)
		}
		target, found, err := session.ResolverTarget(ctx, snapshot, extractor.ResolverTargetRequest{ProjectID: request.ProjectID, Language: request.Language, SourcePath: sourcePath})
		if err != nil {
			return nil, err
		}
		if found {
			targets = append(targets, target)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate contribution session resolver package page: %w", err)
	}
	return targets, nil
}

const stagedResolverSourcesTable = "staged_resolver_sources"

type resolverStager struct {
	transaction   *sql.Tx
	workspace     string
	snapshot      storage.Snapshot
	variableLimit int
	created       bool
}

func (stager *resolverStager) Snapshot() storage.Snapshot {
	return stager.snapshot
}

func (stager *resolverStager) StageResolverSources(ctx context.Context, sources []storage.ResolverStageSource) error {
	if len(sources) == 0 {
		return nil
	}
	staged := append([]storage.ResolverStageSource(nil), sources...)
	sort.Slice(staged, func(left, right int) bool {
		if staged[left].ProjectID != staged[right].ProjectID {
			return staged[left].ProjectID < staged[right].ProjectID
		}
		if staged[left].Language != staged[right].Language {
			return staged[left].Language < staged[right].Language
		}
		return staged[left].SourcePath < staged[right].SourcePath
	})
	rows := make([][]any, 0, len(staged))
	for _, source := range staged {
		if source.ProjectID == "" || source.Language == "" || source.SourcePath == "" {
			return fmt.Errorf("stage resolver sources: %w: project, language, and source path are required", storage.ErrInvalidRequest)
		}
		if len(rows) > 0 {
			previous := rows[len(rows)-1]
			if previous[0] == source.ProjectID && previous[1] == source.Language && previous[2] == source.SourcePath {
				continue
			}
		}
		rows = append(rows, []any{source.ProjectID, source.Language, source.SourcePath})
	}
	if !stager.created {
		if _, err := stager.transaction.ExecContext(ctx, "CREATE TEMP TABLE "+stagedResolverSourcesTable+" (project_id TEXT NOT NULL, language TEXT NOT NULL, source_path TEXT NOT NULL, PRIMARY KEY (project_id, language, source_path))"); err != nil {
			return fmt.Errorf("create staged resolver sources: %w", err)
		}
		stager.created = true
	}
	if err := insertRows(ctx, stager.transaction, stager.variableLimit, maximumBatchRows,
		"INSERT OR IGNORE INTO "+stagedResolverSourcesTable+" (project_id, language, source_path) VALUES ", rows); err != nil {
		return fmt.Errorf("store staged resolver sources: %w", err)
	}
	return nil
}

func (stager *resolverStager) ResolverProjectionPage(ctx context.Context, snapshot storage.Snapshot, request storage.ResolverProjectionPageRequest) ([]storage.ResolverProjection, error) {
	if snapshot.Workspace != stager.snapshot.Workspace || snapshot.Version != stager.snapshot.Version || stager.snapshot.Version == 0 || request.ProjectID == "" || request.Language == "" || request.Limit <= 0 {
		return nil, fmt.Errorf("read staged resolver projection page: %w: snapshot, project, language, and positive limit are required", storage.ErrInvalidRequest)
	}
	if !stager.created {
		return nil, fmt.Errorf("read staged resolver projection page: %w: no resolver sources are staged", storage.ErrInvalidRequest)
	}
	rows, err := stager.transaction.QueryContext(ctx, `
		SELECT contribution.source_path, contribution.project_id, contribution.extractor_name, contribution.extractor_version
		FROM `+stagedResolverSourcesTable+` AS staged
		JOIN file_contributions AS contribution
			ON contribution.workspace = ?
			AND contribution.source_path = staged.source_path
			AND contribution.valid_from_version <= ?
			AND (contribution.valid_to_version IS NULL OR contribution.valid_to_version >= ?)
			AND contribution.project_id = staged.project_id
			AND contribution.extractor_name = staged.language
		WHERE staged.project_id = ? AND staged.language = ? AND staged.source_path > ?
		ORDER BY staged.source_path
		LIMIT ?`,
		stager.workspace, stager.snapshot.Version, stager.snapshot.Version,
		request.ProjectID, request.Language, request.AfterSourcePath, request.Limit)
	if err != nil {
		return nil, fmt.Errorf("read staged resolver projection page: %w", err)
	}
	defer rows.Close()
	projections := make([]storage.ResolverProjection, 0, request.Limit)
	for rows.Next() {
		var projection storage.ResolverProjection
		if err := rows.Scan(&projection.SourcePath, &projection.ProjectID, &projection.Metadata.Name, &projection.Metadata.Version); err != nil {
			return nil, fmt.Errorf("read staged resolver projection page: %w", err)
		}
		data, err := storeResolutionDataForSource(ctx, stager.transaction, stager.snapshot, projection.SourcePath)
		if err != nil {
			return nil, err
		}
		projection.Metadata.Extensions = data.Metadata.Extensions
		var facts graph.Facts
		if err := appendNodes(ctx, stager.transaction, &facts, `SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence FROM contribution_nodes WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY node_id`, stager.workspace, projection.SourcePath, stager.snapshot.Version, stager.snapshot.Version); err != nil {
			return nil, err
		}
		projection.Nodes = facts.Nodes
		if err := appendEdges(ctx, stager.transaction, &facts, `SELECT source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence FROM contribution_edges WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY source_id, target_id, relation`, stager.workspace, projection.SourcePath, stager.snapshot.Version, stager.snapshot.Version); err != nil {
			return nil, err
		}
		projection.Edges = facts.Edges
		projection.UnresolvedReferences = data.UnresolvedReferences
		projection.SymbolReferences = data.SymbolReferences
		projection.ExportedSurfaces = data.ExportedSurfaces
		projection.Dependencies = data.Dependencies
		projection.Diagnostics = data.Diagnostics
		projections = append(projections, projection)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate staged resolver projection page: %w", err)
	}
	return projections, nil
}

func (stager *resolverStager) ResolverTarget(ctx context.Context, snapshot storage.Snapshot, request extractor.ResolverTargetRequest) (extractor.ResolverTarget, bool, error) {
	if snapshot.Workspace != stager.snapshot.Workspace || snapshot.Version != stager.snapshot.Version || stager.snapshot.Version == 0 || request.ProjectID == "" || request.Language == "" || request.SourcePath == "" {
		return extractor.ResolverTarget{}, false, fmt.Errorf("read staged resolver target: %w: snapshot, project, language, and source path are required", storage.ErrInvalidRequest)
	}
	target := extractor.ResolverTarget{ProjectID: request.ProjectID, SourcePath: request.SourcePath}
	err := stager.transaction.QueryRowContext(ctx, `
		SELECT extractor_name, extractor_version
		FROM file_contributions
		WHERE workspace = ?
			AND valid_from_version <= ?
			AND (valid_to_version IS NULL OR valid_to_version >= ?)
			AND project_id = ?
			AND extractor_name = ?
			AND source_path = ?`,
		stager.workspace, stager.snapshot.Version, stager.snapshot.Version,
		request.ProjectID, request.Language, request.SourcePath,
	).Scan(&target.Metadata.Name, &target.Metadata.Version)
	if errors.Is(err, sql.ErrNoRows) {
		return extractor.ResolverTarget{}, false, nil
	}
	if err != nil {
		return extractor.ResolverTarget{}, false, fmt.Errorf("read staged resolver target: %w", err)
	}
	data, err := storeResolutionDataForSource(ctx, stager.transaction, stager.snapshot, request.SourcePath)
	if err != nil {
		return extractor.ResolverTarget{}, false, err
	}
	target.Metadata.Extensions = data.Metadata.Extensions
	if err := target.Metadata.Validate(); err != nil {
		return extractor.ResolverTarget{}, false, fmt.Errorf("read staged resolver target %q: metadata: %w", request.SourcePath, err)
	}
	var facts graph.Facts
	if err := appendNodes(ctx, stager.transaction, &facts, `
		SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM contribution_nodes
		WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
		ORDER BY node_id`, stager.workspace, request.SourcePath, stager.snapshot.Version, stager.snapshot.Version); err != nil {
		return extractor.ResolverTarget{}, false, err
	}
	target.Nodes = facts.Nodes
	target.UnresolvedReferences = data.UnresolvedReferences
	target.SymbolReferences = data.SymbolReferences
	target.ExportedSurfaces = data.ExportedSurfaces
	target.Diagnostics = data.Diagnostics
	return target, true, nil
}

func (stager *resolverStager) ResolverPackagePage(ctx context.Context, snapshot storage.Snapshot, request extractor.ResolverPackagePageRequest) ([]extractor.ResolverTarget, error) {
	if snapshot.Workspace != stager.snapshot.Workspace || snapshot.Version != stager.snapshot.Version || stager.snapshot.Version == 0 || request.ProjectID == "" || request.Language == "" || request.PackagePath == "" || request.Limit <= 0 {
		return nil, fmt.Errorf("read staged resolver package page: %w: snapshot, project, language, package path, and positive limit are required", storage.ErrInvalidRequest)
	}
	pathFilter := "source_path LIKE ? AND INSTR(source_path, '/') = 0"
	pathArguments := []any{"%"}
	if request.PackagePath != "." {
		prefix := request.PackagePath + "/"
		pathFilter = "source_path LIKE ? AND INSTR(SUBSTR(source_path, LENGTH(?) + 1), '/') = 0"
		pathArguments = []any{prefix + "%", prefix}
	}
	query := `SELECT source_path FROM file_contributions WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) AND project_id = ? AND extractor_name = ? AND ` + pathFilter + ` AND source_path > ? ORDER BY source_path LIMIT ?`
	arguments := []any{stager.workspace, stager.snapshot.Version, stager.snapshot.Version, request.ProjectID, request.Language}
	arguments = append(arguments, pathArguments...)
	arguments = append(arguments, request.AfterSourcePath, request.Limit)
	rows, err := stager.transaction.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("read staged resolver package page: %w", err)
	}
	defer rows.Close()
	targets := make([]extractor.ResolverTarget, 0, request.Limit)
	for rows.Next() {
		var sourcePath string
		if err := rows.Scan(&sourcePath); err != nil {
			return nil, fmt.Errorf("read staged resolver package page: %w", err)
		}
		target, found, err := stager.ResolverTarget(ctx, stager.snapshot, extractor.ResolverTargetRequest{ProjectID: request.ProjectID, Language: request.Language, SourcePath: sourcePath})
		if err != nil {
			return nil, err
		}
		if found {
			targets = append(targets, target)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate staged resolver package page: %w", err)
	}
	return targets, nil
}

func (stager *resolverStager) Close(ctx context.Context) error {
	if !stager.created {
		return nil
	}
	stager.created = false
	if _, err := stager.transaction.ExecContext(ctx, "DROP TABLE "+stagedResolverSourcesTable); err != nil {
		return fmt.Errorf("drop staged resolver sources: %w", err)
	}
	return nil
}

func reportPublishMeasurement(callback func(storage.PublishMeasurement), name string, duration time.Duration) {
	if callback != nil {
		callback(storage.PublishMeasurement{Name: name, Duration: duration})
	}
}

func factTotals(contributions []encodedContribution, workspaceFacts graph.Facts) (int, int) {
	nodes, edges := len(workspaceFacts.Nodes), len(workspaceFacts.Edges)
	for _, contribution := range contributions {
		nodes += len(contribution.graphFacts.Nodes)
		edges += len(contribution.graphFacts.Edges)
	}
	return nodes, edges
}

type preparedContribution struct {
	index               int
	contribution        encodedContribution
	contributionRows    [][]any
	nodeRows            [][]any
	edgeRows            [][]any
	catalogUnitRows     [][]any
	catalogCoverageRows [][]any
	extensionRows       [][]any
	dependencyRows      [][]any
	surfaceRows         [][]any
	diagnosticRows      [][]any
	unresolvedRows      [][]any
	bindingRows         [][]any
	symbolRows          [][]any
}

func storePreparedPublication(ctx context.Context, transaction *sql.Tx, variableLimit int, factLimits factBatchLimits, workspace string, version storage.GraphVersion, workspaceFacts graph.Facts, replacedOwners []string, reportWriteMeasurement func(storage.PublishMeasurement), contributions []encodedContribution, reportProgress func(int, int, int)) error {
	if err := retainWorkspaceFacts(ctx, transaction, workspace, version, replacedOwners); err != nil {
		return err
	}
	if err := storeWorkspaceFacts(ctx, transaction, variableLimit, factLimits, workspace, version, workspaceFacts, reportWriteMeasurement); err != nil {
		return err
	}
	writtenNodes, writtenEdges := len(workspaceFacts.Nodes), len(workspaceFacts.Edges)
	reportProgress(0, writtenNodes, writtenEdges)

	preparationContext, cancel := context.WithCancel(ctx)
	defer cancel()
	workerCount := publicationWorkerCount(len(contributions))
	prepared, completed, released := prepareContributions(preparationContext, workspace, version, contributions, workerCount)
	nextIndex := 0
	pending := make(map[int]preparedContribution, workerCount+publicationQueueDepth*workerCount)
	batch := newPublicationBatch(variableLimit, reportWriteMeasurement)
	var preparationErr error
	for result := range prepared {
		if result.err != nil {
			preparationErr = result.err
			cancel()
			continue
		}
		if preparationErr != nil {
			continue
		}
		pending[result.value.index] = result.value
		for {
			contribution, found := pending[nextIndex]
			if !found {
				break
			}
			delete(pending, nextIndex)
			if err := batch.add(ctx, transaction, workspace, version, contribution); err != nil {
				preparationErr = err
				cancel()
				break
			}
			writtenNodes += len(contribution.contribution.graphFacts.Nodes)
			writtenEdges += len(contribution.contribution.graphFacts.Edges)
			reportProgress(nextIndex+1, writtenNodes, writtenEdges)
			released <- struct{}{}
			nextIndex++
		}
	}
	if err := <-completed; err != nil && preparationErr == nil {
		preparationErr = err
	}
	if preparationErr != nil {
		return preparationErr
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if nextIndex != len(contributions) {
		return fmt.Errorf("prepare publication contributions: received %d of %d contributions", nextIndex, len(contributions))
	}
	if err := batch.flush(ctx, transaction); err != nil {
		return err
	}
	return nil
}

func retainWorkspaceFacts(ctx context.Context, transaction *sql.Tx, workspace string, version storage.GraphVersion, replacedOwners []string) error {
	if len(replacedOwners) == 0 || version <= 1 {
		return nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(replacedOwners)), ",")
	arguments := make([]any, 0, len(replacedOwners)+2)
	arguments = append(arguments, workspace, version-1)
	for _, owner := range replacedOwners {
		arguments = append(arguments, owner)
	}
	query := fmt.Sprintf(`
		INSERT INTO workspace_edges (workspace, version, source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence, resolved_fact_owner)
		SELECT workspace, ?, source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence, resolved_fact_owner
		FROM workspace_edges
		WHERE workspace = ? AND version = ? AND resolved_fact_owner NOT IN (%s)`, placeholders)
	arguments = append([]any{version}, arguments...)
	if _, err := transaction.ExecContext(ctx, query, arguments...); err != nil {
		return fmt.Errorf("retain unchanged workspace facts: %w", err)
	}
	return nil
}

type preparedResult struct {
	value preparedContribution
	err   error
}

func publicationWorkerCount(contributionCount int) int {
	return min(contributionCount, min(runtime.GOMAXPROCS(0), maximumPublicationWorkers))
}

func prepareContributions(ctx context.Context, workspace string, version storage.GraphVersion, contributions []encodedContribution, workerCount int) (<-chan preparedResult, <-chan error, chan<- struct{}) {
	results := make(chan preparedResult, publicationQueueDepth*workerCount)
	completed := make(chan error, 1)
	jobs := make(chan int)
	window := workerCount + publicationQueueDepth*workerCount
	released := make(chan struct{}, window)
	for range window {
		released <- struct{}{}
	}
	if workerCount == 0 {
		close(results)
		completed <- nil
		close(completed)
		return results, completed, released
	}
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			for index := range jobs {
				if err := ctx.Err(); err != nil {
					select {
					case results <- preparedResult{err: err}:
					case <-ctx.Done():
					}
					return
				}
				prepared, err := prepareContribution(workspace, version, index, contributions[index])
				if err != nil {
					results <- preparedResult{err: err}
					return
				}
				select {
				case results <- preparedResult{value: prepared}:
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	go func() {
		defer close(jobs)
		for index := range contributions {
			select {
			case <-ctx.Done():
				return
			case <-released:
			}
			select {
			case <-ctx.Done():
				return
			case jobs <- index:
			}
		}
	}()
	go func() {
		workers.Wait()
		close(results)
		completed <- nil
		close(completed)
	}()
	return results, completed, released
}

func prepareContribution(workspace string, version storage.GraphVersion, index int, contribution encodedContribution) (preparedContribution, error) {
	prepared := preparedContribution{
		index:        index,
		contribution: contribution,
		contributionRows: [][]any{{
			workspace, contribution.sourcePath, version, contribution.projectID, contribution.metadata.Name, contribution.metadata.Version,
		}},
	}
	for _, node := range contribution.graphFacts.Nodes {
		prepared.nodeRows = append(prepared.nodeRows, append([]any{workspace, contribution.sourcePath, version, node.ID, node.Kind, node.Label, node.QualifiedName}, evidenceValues(node.Evidence)...))
	}
	for _, edge := range contribution.graphFacts.Edges {
		prepared.edgeRows = append(prepared.edgeRows, append([]any{workspace, contribution.sourcePath, version, edge.SourceID, edge.TargetID, edge.Relation}, evidenceValues(edge.Evidence)...))
	}
	for _, unit := range contribution.catalogUnits {
		comments, err := json.Marshal(unit.Comments)
		if err != nil {
			return preparedContribution{}, fmt.Errorf("encode catalog unit comments: %w", err)
		}
		identifierTokens, err := json.Marshal(unit.IdentifierTokens)
		if err != nil {
			return preparedContribution{}, fmt.Errorf("encode catalog unit identifier tokens: %w", err)
		}
		prepared.catalogUnitRows = append(prepared.catalogUnitRows, []any{workspace, contribution.sourcePath, version, unit.NodeID, unit.Name, unit.Kind, unit.Owner, unit.Signature, string(comments), string(identifierTokens), unit.DeclarationSource})
	}
	if !contribution.catalogUnitsOmitted {
		prepared.catalogCoverageRows = [][]any{{workspace, contribution.sourcePath, version}}
	}
	for _, extension := range contribution.metadata.Extensions {
		prepared.extensionRows = append(prepared.extensionRows, []any{workspace, contribution.sourcePath, version, extension})
	}
	for _, dependency := range contribution.dependencies {
		prepared.dependencyRows = append(prepared.dependencyRows, []any{workspace, contribution.sourcePath, version, dependency.TargetPath})
	}
	for _, surface := range contribution.exportedSurfaces {
		prepared.surfaceRows = append(prepared.surfaceRows, []any{workspace, contribution.sourcePath, version, surface.NodeID, surface.Name})
	}
	for _, diagnostic := range contribution.diagnostics {
		prepared.diagnosticRows = append(prepared.diagnosticRows, []any{workspace, contribution.sourcePath, version, diagnostic.Severity, diagnostic.Message})
	}
	for _, reference := range contribution.unresolvedReferences {
		prepared.unresolvedRows = append(prepared.unresolvedRows, []any{workspace, contribution.sourcePath, version, reference.SourceID, reference.Target, reference.Kind, reference.Ambiguous})
		for _, binding := range reference.Bindings {
			prepared.bindingRows = append(prepared.bindingRows, []any{workspace, contribution.sourcePath, version, reference.SourceID, reference.Target, reference.Kind, binding.ImportedName, binding.ExportedName, binding.LocalName})
		}
	}
	for _, reference := range contribution.symbolReferences {
		prepared.symbolRows = append(prepared.symbolRows, append([]any{workspace, contribution.sourcePath, version, reference.SourceID, reference.Target, reference.Relation}, evidenceValues(reference.Evidence)...))
	}
	return prepared, nil
}

type publicationInsertion struct {
	prefix string
	name   string
	rows   [][]any
}

type publicationBatch struct {
	variableLimit          int
	reportWriteMeasurement func(storage.PublishMeasurement)
	insertions             []publicationInsertion
	limits                 contributionBatchLimits
	rowCount               int
	estimatedBytes         int
	sourceCount            int
}

type contributionBatchLimits struct {
	maximumRows    int
	maximumBytes   int
	maximumSources int
}

type factBatchLimits struct {
	maximumRows  int
	maximumBytes int
}

func newPublicationBatch(variableLimit int, reportWriteMeasurement func(storage.PublishMeasurement)) publicationBatch {
	return publicationBatch{variableLimit: variableLimit, reportWriteMeasurement: reportWriteMeasurement, insertions: []publicationInsertion{
		{prefix: "INSERT INTO file_contributions (workspace, source_path, valid_from_version, project_id, extractor_name, extractor_version) VALUES ", name: "file_contributions"},
		{prefix: "INSERT OR IGNORE INTO contribution_nodes (workspace, source_path, valid_from_version, node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence) VALUES ", name: "contribution_nodes"},
		{prefix: "INSERT OR IGNORE INTO contribution_edges (workspace, source_path, valid_from_version, source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence) VALUES ", name: "contribution_edges"},
		{prefix: "INSERT OR IGNORE INTO contribution_catalog_units (workspace, source_path, valid_from_version, node_id, name, kind, owner, signature, comments, identifier_tokens, declaration_source) VALUES ", name: "contribution_catalog_units"},
		{prefix: "INSERT OR IGNORE INTO contribution_catalog_unit_coverage (workspace, source_path, valid_from_version) VALUES ", name: "contribution_catalog_unit_coverage"},
		{prefix: "INSERT OR IGNORE INTO contribution_extensions (workspace, source_path, valid_from_version, extension) VALUES ", name: "contribution_extensions"},
		{prefix: "INSERT OR IGNORE INTO contribution_dependencies (workspace, source_path, valid_from_version, target_path) VALUES ", name: "contribution_dependencies"},
		{prefix: "INSERT OR IGNORE INTO contribution_exported_surfaces (workspace, source_path, valid_from_version, node_id, name) VALUES ", name: "contribution_exported_surfaces"},
		{prefix: "INSERT OR IGNORE INTO contribution_diagnostics (workspace, source_path, valid_from_version, severity, message) VALUES ", name: "contribution_diagnostics"},
		{prefix: "INSERT OR IGNORE INTO contribution_unresolved_references (workspace, source_path, valid_from_version, source_id, target, kind, ambiguous) VALUES ", name: "contribution_unresolved_references"},
		{prefix: "INSERT OR IGNORE INTO contribution_module_bindings (workspace, source_path, valid_from_version, source_id, target, kind, imported_name, exported_name, local_name) VALUES ", name: "contribution_module_bindings"},
		{prefix: "INSERT OR IGNORE INTO contribution_symbol_references (workspace, source_path, valid_from_version, source_id, target, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence) VALUES ", name: "contribution_symbol_references"},
	}}
}

func (batch *publicationBatch) add(ctx context.Context, transaction *sql.Tx, workspace string, version storage.GraphVersion, prepared preparedContribution) error {
	contribution := prepared.contribution
	rows := [][][]any{
		prepared.contributionRows,
		prepared.nodeRows,
		prepared.edgeRows,
		prepared.catalogUnitRows,
		prepared.catalogCoverageRows,
		prepared.extensionRows,
		prepared.dependencyRows,
		prepared.surfaceRows,
		prepared.diagnosticRows,
		prepared.unresolvedRows,
		prepared.bindingRows,
		prepared.symbolRows,
	}
	preparedRowCount := 0
	for _, insertionRows := range rows {
		preparedRowCount += len(insertionRows)
	}
	preparedBytes := estimateContributionRowsBytes(rows)
	if batch.sourceCount > 0 && (batch.limits.maximumRows > 0 && batch.rowCount+preparedRowCount > batch.limits.maximumRows ||
		batch.limits.maximumBytes > 0 && batch.estimatedBytes+preparedBytes > batch.limits.maximumBytes) {
		if err := batch.flush(ctx, transaction); err != nil {
			return err
		}
	}
	if version > 1 {
		if err := closeContributionRecords(ctx, transaction, workspace, contribution.sourcePath, int64(version)-1); err != nil {
			return fmt.Errorf("close prior source contribution: %w", err)
		}
	}
	legacyBatch := batch.limits.maximumRows == 0 && batch.limits.maximumBytes == 0 && batch.limits.maximumSources == 0
	for index, insertionRows := range rows {
		batch.insertions[index].rows = append(batch.insertions[index].rows, insertionRows...)
		if legacyBatch && len(batch.insertions[index].rows) >= maximumBatchRows {
			if err := batch.flushInsertion(ctx, transaction, index); err != nil {
				return err
			}
		}
	}
	batch.rowCount += preparedRowCount
	batch.estimatedBytes += preparedBytes
	batch.sourceCount++
	if batch.limits.maximumRows > 0 && batch.rowCount >= batch.limits.maximumRows ||
		batch.limits.maximumBytes > 0 && batch.estimatedBytes >= batch.limits.maximumBytes ||
		batch.limits.maximumSources > 0 && batch.sourceCount >= batch.limits.maximumSources {
		return batch.flush(ctx, transaction)
	}
	return nil
}

func (batch *publicationBatch) flush(ctx context.Context, transaction *sql.Tx) error {
	for index := range batch.insertions {
		if err := batch.flushInsertion(ctx, transaction, index); err != nil {
			return err
		}
	}
	batch.rowCount = 0
	batch.estimatedBytes = 0
	batch.sourceCount = 0
	return nil
}

func estimateContributionRowsBytes(groups [][][]any) int {
	estimatedBytes := 0
	for _, rows := range groups {
		for _, row := range rows {
			estimatedBytes += 8
			for _, value := range row {
				switch typed := value.(type) {
				case string:
					estimatedBytes += len(typed)
				case []byte:
					estimatedBytes += len(typed)
				default:
					estimatedBytes += 8
				}
			}
		}
	}
	return estimatedBytes
}

func (batch *publicationBatch) flushInsertion(ctx context.Context, transaction *sql.Tx, index int) error {
	insertion := &batch.insertions[index]
	if len(insertion.rows) == 0 {
		return nil
	}
	started := time.Now()
	maximumRows := batch.limits.maximumRows
	if maximumRows <= 0 {
		maximumRows = maximumBatchRows
	}
	if err := insertRows(ctx, transaction, batch.variableLimit, maximumRows, insertion.prefix, insertion.rows); err != nil {
		return fmt.Errorf("store %s: %w", insertion.name, err)
	}
	reportPublishMeasurement(batch.reportWriteMeasurement, insertion.name, time.Since(started))
	insertion.rows = insertion.rows[:0]
	return nil
}

func ensureDatabaseBudget(ctx context.Context, transaction *sql.Tx, maxBytes int64) error {
	var pageCount, pageSize int64
	if err := transaction.QueryRowContext(ctx, "PRAGMA page_count").Scan(&pageCount); err != nil {
		return fmt.Errorf("measure SQLite database pages: %w", err)
	}
	if err := transaction.QueryRowContext(ctx, "PRAGMA page_size").Scan(&pageSize); err != nil {
		return fmt.Errorf("measure SQLite page size: %w", err)
	}
	if pageCount > maxBytes/pageSize {
		return fmt.Errorf("publish graph update: SQLite database exceeds %d byte budget", maxBytes)
	}
	return nil
}

func reclaimFreePages(ctx context.Context, database *sql.DB) error {
	if _, err := database.ExecContext(ctx, "PRAGMA incremental_vacuum"); err != nil {
		return fmt.Errorf("reclaim SQLite pages: %w", err)
	}
	return nil
}

func (store *Store) AffectedSources(ctx context.Context, snapshot storage.Snapshot, request storage.AffectedSourcesRequest) ([]string, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 || len(request.Update.Contributions()) == 0 {
		return nil, fmt.Errorf("find affected sources: %w: snapshot and update are required", storage.ErrInvalidRequest)
	}

	updates := request.Update.Contributions()
	changedTargets := make(map[string]struct{}, len(updates))
	for _, contribution := range updates {
		current, found, err := store.readExportedSurfaces(ctx, snapshot, contribution.SourcePath())
		if err != nil {
			return nil, err
		}
		if !found || !sameSurfaces(current, contribution.ExportedSurfaces()) {
			changedTargets[contribution.SourcePath()] = struct{}{}
		}
	}
	if len(changedTargets) == 0 {
		return nil, nil
	}
	paths := make([]string, 0, len(changedTargets))
	for path := range changedTargets {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	maximumPaths := max(1, store.variableLimit-3)
	affected := make(map[string]struct{})
	for start := 0; start < len(paths); start += maximumPaths {
		end := min(start+maximumPaths, len(paths))
		chunk := paths[start:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		arguments := []any{snapshot.Workspace, snapshot.Version, snapshot.Version}
		for _, path := range chunk {
			arguments = append(arguments, path)
		}
		rows, err := store.database.QueryContext(ctx, `
			SELECT DISTINCT source_path
			FROM contribution_dependencies
			WHERE workspace = ?
				AND valid_from_version <= ?
				AND (valid_to_version IS NULL OR valid_to_version >= ?)
				AND target_path IN (`+placeholders+`)
			ORDER BY source_path`, arguments...)
		if err != nil {
			return nil, fmt.Errorf("find affected source dependencies: %w", err)
		}
		for rows.Next() {
			var sourcePath string
			if err := rows.Scan(&sourcePath); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("read affected source dependency: %w", err)
			}
			if _, changed := changedTargets[sourcePath]; !changed {
				affected[sourcePath] = struct{}{}
			}
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("iterate affected source dependencies: %w", err)
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("close affected source dependencies: %w", err)
		}
	}
	return uniqueSortedStringsMap(affected), nil
}

func (store *Store) readExportedSurfaces(ctx context.Context, snapshot storage.Snapshot, sourcePath string) ([]extractor.ExportedSurface, bool, error) {
	var exists int
	if err := store.database.QueryRowContext(ctx, `SELECT COUNT(*) FROM file_contributions WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)`, snapshot.Workspace, sourcePath, snapshot.Version, snapshot.Version).Scan(&exists); err != nil {
		return nil, false, fmt.Errorf("read affected source contribution: %w", err)
	}
	if exists == 0 {
		return nil, false, nil
	}
	rows, err := store.database.QueryContext(ctx, `SELECT node_id, name FROM contribution_exported_surfaces WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY node_id, name`, snapshot.Workspace, sourcePath, snapshot.Version, snapshot.Version)
	if err != nil {
		return nil, false, fmt.Errorf("read affected source exported surfaces: %w", err)
	}
	defer rows.Close()
	surfaces := make([]extractor.ExportedSurface, 0)
	for rows.Next() {
		var surface extractor.ExportedSurface
		if err := rows.Scan(&surface.NodeID, &surface.Name); err != nil {
			return nil, false, fmt.Errorf("read affected source exported surface: %w", err)
		}
		surfaces = append(surfaces, surface)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("iterate affected source exported surfaces: %w", err)
	}
	return surfaces, true, nil
}

func (store *Store) SourceContributions(ctx context.Context, snapshot storage.Snapshot) ([]storage.SourceContribution, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 {
		return nil, fmt.Errorf("read source contributions: %w: snapshot is required", storage.ErrInvalidRequest)
	}

	rows, err := store.database.QueryContext(ctx, `
		SELECT source_path, extractor_name, extractor_version,
			EXISTS (SELECT 1 FROM contribution_catalog_unit_coverage AS coverage
				WHERE coverage.workspace = file_contributions.workspace
					AND coverage.source_path = file_contributions.source_path
					AND coverage.valid_from_version <= ?
					AND (coverage.valid_to_version IS NULL OR coverage.valid_to_version >= ?))
		FROM file_contributions
		WHERE workspace = ?
			AND valid_from_version <= ?
			AND (valid_to_version IS NULL OR valid_to_version >= ?)
		ORDER BY source_path`,
		snapshot.Version,
		snapshot.Version,
		snapshot.Workspace,
		snapshot.Version,
		snapshot.Version,
	)
	if err != nil {
		return nil, fmt.Errorf("read source contributions: %w", err)
	}
	defer rows.Close()

	type contributionIdentity struct {
		sourcePath string
		metadata   extractor.Metadata
		covered    bool
	}
	identities := make([]contributionIdentity, 0)
	for rows.Next() {
		var sourcePath string
		var metadata extractor.Metadata
		var covered bool
		if err := rows.Scan(&sourcePath, &metadata.Name, &metadata.Version, &covered); err != nil {
			return nil, fmt.Errorf("read source contributions: %w", err)
		}
		identities = append(identities, contributionIdentity{sourcePath: sourcePath, metadata: metadata, covered: covered})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate source contributions: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close source contributions: %w", err)
	}
	contributions := make([]storage.SourceContribution, 0, len(identities))
	for _, identity := range identities {
		sourcePath := identity.sourcePath
		metadata := identity.metadata
		data, err := store.readResolutionDataForSource(ctx, snapshot, sourcePath)
		if err != nil {
			return nil, err
		}
		metadata.Extensions = data.Metadata.Extensions
		if err := metadata.Validate(); err != nil {
			return nil, fmt.Errorf("read source contribution %q: metadata: %w", sourcePath, err)
		}
		facts, err := store.readContributionFacts(ctx, snapshot, sourcePath)
		if err != nil {
			return nil, err
		}
		catalogUnits, err := store.readCatalogUnits(ctx, snapshot, sourcePath)
		if err != nil {
			return nil, err
		}
		contributions = append(contributions, storage.SourceContribution{
			SourcePath:           sourcePath,
			Metadata:             metadata,
			Facts:                facts,
			CatalogUnits:         catalogUnits,
			CatalogUnitsCovered:  identity.covered,
			UnresolvedReferences: data.UnresolvedReferences,
			SymbolReferences:     data.SymbolReferences,
			ExportedSurfaces:     data.ExportedSurfaces,
			Dependencies:         data.Dependencies,
			Diagnostics:          data.Diagnostics,
		})
	}
	return contributions, nil
}

func (store *Store) CatalogUnitsCovered(ctx context.Context, snapshot storage.Snapshot) (bool, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 {
		return false, fmt.Errorf("read catalog-unit coverage: %w: snapshot is required", storage.ErrInvalidRequest)
	}
	var missing int
	if err := store.database.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM file_contributions AS contributions
			WHERE contributions.workspace = ?
				AND contributions.valid_from_version <= ?
				AND (contributions.valid_to_version IS NULL OR contributions.valid_to_version >= ?)
				AND NOT EXISTS (
					SELECT 1
					FROM contribution_catalog_unit_coverage AS coverage
					WHERE coverage.workspace = contributions.workspace
						AND coverage.source_path = contributions.source_path
						AND coverage.valid_from_version <= ?
						AND (coverage.valid_to_version IS NULL OR coverage.valid_to_version >= ?)
				)
		)`, snapshot.Workspace, snapshot.Version, snapshot.Version, snapshot.Version, snapshot.Version).Scan(&missing); err != nil {
		return false, fmt.Errorf("read catalog-unit coverage: %w", err)
	}
	return missing == 0, nil
}

func (store *Store) ResolverProjections(ctx context.Context, snapshot storage.Snapshot) ([]storage.ResolverProjection, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 {
		return nil, fmt.Errorf("read resolver projections: %w: snapshot is required", storage.ErrInvalidRequest)
	}
	if projections, found := store.cachedResolverProjections(snapshot); found {
		return projections, nil
	}
	rows, err := store.database.QueryContext(ctx, `
		SELECT source_path, project_id, extractor_name, extractor_version
		FROM file_contributions
		WHERE workspace = ?
			AND valid_from_version <= ?
			AND (valid_to_version IS NULL OR valid_to_version >= ?)
		ORDER BY source_path`,
		snapshot.Workspace,
		snapshot.Version,
		snapshot.Version,
	)
	if err != nil {
		return nil, fmt.Errorf("read resolver projections: %w", err)
	}
	defer rows.Close()

	projections := make([]storage.ResolverProjection, 0)
	for rows.Next() {
		var projection storage.ResolverProjection
		if err := rows.Scan(&projection.SourcePath, &projection.ProjectID, &projection.Metadata.Name, &projection.Metadata.Version); err != nil {
			return nil, fmt.Errorf("read resolver projections: %w", err)
		}
		projections = append(projections, projection)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate resolver projections: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close resolver projections: %w", err)
	}
	for projectionIndex := range projections {
		projection := &projections[projectionIndex]
		data, err := store.readResolutionDataForSource(ctx, snapshot, projection.SourcePath)
		if err != nil {
			return nil, err
		}
		projection.Metadata.Extensions = data.Metadata.Extensions
		var facts graph.Facts
		if err := appendNodes(ctx, store.database, &facts, `SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence FROM contribution_nodes WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY node_id`, snapshot.Workspace, projection.SourcePath, snapshot.Version, snapshot.Version); err != nil {
			return nil, err
		}
		projection.Nodes = facts.Nodes
		if err := appendEdges(ctx, store.database, &facts, `SELECT source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence FROM contribution_edges WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY source_id, target_id, relation`, snapshot.Workspace, projection.SourcePath, snapshot.Version, snapshot.Version); err != nil {
			return nil, err
		}
		projection.Edges = facts.Edges
		if err := projection.Metadata.Validate(); err != nil {
			return nil, fmt.Errorf("read resolver projection %q: metadata: %w", projection.SourcePath, err)
		}
		projection.UnresolvedReferences = data.UnresolvedReferences
		projection.SymbolReferences = data.SymbolReferences
		projection.ExportedSurfaces = data.ExportedSurfaces
		projection.Dependencies = data.Dependencies
		projection.Diagnostics = data.Diagnostics
	}
	store.cacheResolverProjections(snapshot, projections)
	return projections, nil
}

func (store *Store) ResolverProjectionPage(ctx context.Context, snapshot storage.Snapshot, request storage.ResolverProjectionPageRequest) ([]storage.ResolverProjection, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 || request.ProjectID == "" || request.Language == "" || request.Limit <= 0 {
		return nil, fmt.Errorf("read resolver projection page: %w: snapshot, project, language, and positive limit are required", storage.ErrInvalidRequest)
	}
	rows, err := store.database.QueryContext(ctx, `
		SELECT source_path, project_id, extractor_name, extractor_version
		FROM file_contributions
		WHERE workspace = ?
			AND valid_from_version <= ?
			AND (valid_to_version IS NULL OR valid_to_version >= ?)
			AND project_id = ?
			AND extractor_name = ?
			AND source_path > ?
		ORDER BY source_path
		LIMIT ?`,
		snapshot.Workspace,
		snapshot.Version,
		snapshot.Version,
		request.ProjectID,
		request.Language,
		request.AfterSourcePath,
		request.Limit,
	)
	if err != nil {
		return nil, fmt.Errorf("read resolver projection page: %w", err)
	}
	defer rows.Close()

	projections := make([]storage.ResolverProjection, 0, request.Limit)
	for rows.Next() {
		var projection storage.ResolverProjection
		if err := rows.Scan(&projection.SourcePath, &projection.ProjectID, &projection.Metadata.Name, &projection.Metadata.Version); err != nil {
			return nil, fmt.Errorf("read resolver projection page: %w", err)
		}
		projections = append(projections, projection)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate resolver projection page: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close resolver projection page: %w", err)
	}
	for projectionIndex := range projections {
		projection := &projections[projectionIndex]
		data, err := store.readResolutionDataForSource(ctx, snapshot, projection.SourcePath)
		if err != nil {
			return nil, err
		}
		projection.Metadata.Extensions = data.Metadata.Extensions
		var facts graph.Facts
		if err := appendNodes(ctx, store.database, &facts, `SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence FROM contribution_nodes WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY node_id`, snapshot.Workspace, projection.SourcePath, snapshot.Version, snapshot.Version); err != nil {
			return nil, err
		}
		projection.Nodes = facts.Nodes
		if err := appendEdges(ctx, store.database, &facts, `SELECT source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence FROM contribution_edges WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY source_id, target_id, relation`, snapshot.Workspace, projection.SourcePath, snapshot.Version, snapshot.Version); err != nil {
			return nil, err
		}
		projection.Edges = facts.Edges
		if err := projection.Metadata.Validate(); err != nil {
			return nil, fmt.Errorf("read resolver projection %q: metadata: %w", projection.SourcePath, err)
		}
		projection.UnresolvedReferences = data.UnresolvedReferences
		projection.SymbolReferences = data.SymbolReferences
		projection.ExportedSurfaces = data.ExportedSurfaces
		projection.Dependencies = data.Dependencies
		projection.Diagnostics = data.Diagnostics
	}
	return projections, nil
}

func (store *Store) ResolverTarget(ctx context.Context, snapshot storage.Snapshot, request extractor.ResolverTargetRequest) (extractor.ResolverTarget, bool, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 || request.ProjectID == "" || request.Language == "" || request.SourcePath == "" {
		return extractor.ResolverTarget{}, false, fmt.Errorf("read resolver target: %w: snapshot, project, language, and source path are required", storage.ErrInvalidRequest)
	}
	target := extractor.ResolverTarget{ProjectID: request.ProjectID, SourcePath: request.SourcePath}
	err := store.database.QueryRowContext(ctx, `
		SELECT extractor_name, extractor_version
		FROM file_contributions
		WHERE workspace = ?
			AND valid_from_version <= ?
			AND (valid_to_version IS NULL OR valid_to_version >= ?)
			AND project_id = ?
			AND extractor_name = ?
			AND source_path = ?`,
		snapshot.Workspace,
		snapshot.Version,
		snapshot.Version,
		request.ProjectID,
		request.Language,
		request.SourcePath,
	).Scan(&target.Metadata.Name, &target.Metadata.Version)
	if errors.Is(err, sql.ErrNoRows) {
		return extractor.ResolverTarget{}, false, nil
	}
	if err != nil {
		return extractor.ResolverTarget{}, false, fmt.Errorf("read resolver target: %w", err)
	}
	data, err := store.readResolutionDataForSource(ctx, snapshot, request.SourcePath)
	if err != nil {
		return extractor.ResolverTarget{}, false, err
	}
	target.Metadata.Extensions = data.Metadata.Extensions
	if err := target.Metadata.Validate(); err != nil {
		return extractor.ResolverTarget{}, false, fmt.Errorf("read resolver target %q: metadata: %w", request.SourcePath, err)
	}
	var facts graph.Facts
	if err := appendNodes(ctx, store.database, &facts, `
		SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM contribution_nodes
		WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
		ORDER BY node_id`, snapshot.Workspace, request.SourcePath, snapshot.Version, snapshot.Version); err != nil {
		return extractor.ResolverTarget{}, false, err
	}
	target.Nodes = facts.Nodes
	target.UnresolvedReferences = data.UnresolvedReferences
	target.SymbolReferences = data.SymbolReferences
	target.ExportedSurfaces = data.ExportedSurfaces
	target.Diagnostics = data.Diagnostics
	return target, true, nil
}

func (store *Store) ResolverPackagePage(ctx context.Context, snapshot storage.Snapshot, request extractor.ResolverPackagePageRequest) ([]extractor.ResolverTarget, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 || request.ProjectID == "" || request.Language == "" || request.PackagePath == "" || request.Limit <= 0 {
		return nil, fmt.Errorf("read resolver package page: %w: snapshot, project, language, package path, and positive limit are required", storage.ErrInvalidRequest)
	}
	pathFilter := "source_path LIKE ? AND INSTR(source_path, '/') = 0"
	pathArgument := "%"
	pathArguments := []any{pathArgument}
	if request.PackagePath != "." {
		prefix := request.PackagePath + "/"
		pathFilter = "source_path LIKE ? AND INSTR(SUBSTR(source_path, LENGTH(?) + 1), '/') = 0"
		pathArguments = []any{prefix + "%", prefix}
	}
	query := `
		SELECT source_path
		FROM file_contributions
		WHERE workspace = ?
			AND valid_from_version <= ?
			AND (valid_to_version IS NULL OR valid_to_version >= ?)
			AND project_id = ?
			AND extractor_name = ?
			AND ` + pathFilter + `
			AND source_path > ?
		ORDER BY source_path
		LIMIT ?`
	arguments := []any{
		snapshot.Workspace,
		snapshot.Version,
		snapshot.Version,
		request.ProjectID,
		request.Language,
	}
	arguments = append(arguments, pathArguments...)
	arguments = append(arguments, request.AfterSourcePath, request.Limit)
	rows, err := store.database.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("read resolver package page: %w", err)
	}
	paths := make([]string, 0, request.Limit)
	for rows.Next() {
		var sourcePath string
		if err := rows.Scan(&sourcePath); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("read resolver package page: %w", err)
		}
		paths = append(paths, sourcePath)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("iterate resolver package page: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close resolver package page: %w", err)
	}
	targets := make([]extractor.ResolverTarget, 0, len(paths))
	for _, sourcePath := range paths {
		target, found, err := store.ResolverTarget(ctx, snapshot, extractor.ResolverTargetRequest{
			ProjectID:  request.ProjectID,
			Language:   request.Language,
			SourcePath: sourcePath,
		})
		if err != nil {
			return nil, err
		}
		if found {
			targets = append(targets, target)
		}
	}
	return targets, nil
}

func (store *Store) cachedResolverProjections(snapshot storage.Snapshot) ([]storage.ResolverProjection, bool) {
	key := projectionCacheKey{workspace: snapshot.Workspace, version: snapshot.Version}
	store.projectionMu.Lock()
	cached, found := store.projections[key]
	store.projectionMu.Unlock()
	if !found {
		return nil, false
	}
	return copyResolverProjections(cached.values), true
}

func (store *Store) cacheResolverProjections(snapshot storage.Snapshot, projections []storage.ResolverProjection) {
	values := copyResolverProjections(projections)
	bytes := resolverProjectionBytes(values)
	if bytes > store.maxProjectionBytes {
		return
	}

	key := projectionCacheKey{workspace: snapshot.Workspace, version: snapshot.Version}
	store.projectionMu.Lock()
	defer store.projectionMu.Unlock()
	if existing, found := store.projections[key]; found {
		store.projectionBytes -= existing.bytes
	}
	for store.projectionBytes+bytes > store.maxProjectionBytes {
		oldestKey, oldest, found := store.oldestResolverProjection()
		if !found {
			break
		}
		delete(store.projections, oldestKey)
		store.projectionBytes -= oldest.bytes
	}
	store.projectionOrder++
	store.projections[key] = cachedProjections{values: values, bytes: bytes, order: store.projectionOrder}
	store.projectionBytes += bytes
}

func (store *Store) oldestResolverProjection() (projectionCacheKey, cachedProjections, bool) {
	var oldestKey projectionCacheKey
	var oldest cachedProjections
	found := false
	for key, projection := range store.projections {
		if !found || projection.order < oldest.order {
			oldestKey, oldest, found = key, projection, true
		}
	}
	return oldestKey, oldest, found
}

func (store *Store) invalidateWorkspaceCaches(workspace string, remove func(storage.GraphVersion) bool) {
	store.projectionMu.Lock()
	defer store.projectionMu.Unlock()
	for key, projection := range store.projections {
		if key.workspace != workspace || !remove(key.version) {
			continue
		}
		delete(store.projections, key)
		store.projectionBytes -= projection.bytes
	}
}

func resolverProjectionBytes(projections []storage.ResolverProjection) int64 {
	var bytes int64
	for _, projection := range projections {
		bytes += int64(len(projection.ProjectID) + len(projection.SourcePath) + len(projection.Metadata.Name) + len(projection.Metadata.Version))
		for _, node := range projection.Nodes {
			bytes += int64(len(node.ID)+len(node.Kind)+len(node.Label)+len(node.QualifiedName)) + evidenceBytes(node.Evidence)
		}
		for _, edge := range projection.Edges {
			bytes += int64(len(edge.SourceID)+len(edge.TargetID)+len(edge.Relation)) + evidenceBytes(edge.Evidence)
		}
		for _, extension := range projection.Metadata.Extensions {
			bytes += int64(len(extension))
		}
		for _, reference := range projection.UnresolvedReferences {
			bytes += int64(len(reference.SourceID) + len(reference.Target) + len(reference.Kind))
			for _, binding := range reference.Bindings {
				bytes += int64(len(binding.ImportedName) + len(binding.ExportedName) + len(binding.LocalName))
			}
		}
		for _, reference := range projection.SymbolReferences {
			bytes += int64(len(reference.SourceID) + len(reference.Target) + len(reference.Relation))
			bytes += evidenceBytes(reference.Evidence)
		}
		for _, surface := range projection.ExportedSurfaces {
			bytes += int64(len(surface.NodeID) + len(surface.Name))
		}
		for _, dependency := range projection.Dependencies {
			bytes += int64(len(dependency.SourcePath) + len(dependency.TargetPath))
		}
		for _, diagnostic := range projection.Diagnostics {
			bytes += int64(len(diagnostic.Severity) + len(diagnostic.Message))
		}
	}
	return bytes
}

func evidenceBytes(evidence graph.FactEvidence) int64 {
	return int64(len(evidence.Span.Path) + len(evidence.FileHash) + len(evidence.Extractor) + len(evidence.Provenance) + len(evidence.Confidence))
}

func copyResolverProjections(projections []storage.ResolverProjection) []storage.ResolverProjection {
	copied := make([]storage.ResolverProjection, len(projections))
	for index, projection := range projections {
		copied[index] = storage.ResolverProjection{
			ProjectID:            projection.ProjectID,
			SourcePath:           projection.SourcePath,
			Metadata:             extractor.Metadata{Name: projection.Metadata.Name, Version: projection.Metadata.Version, Extensions: append([]string(nil), projection.Metadata.Extensions...)},
			Nodes:                append([]graph.Node(nil), projection.Nodes...),
			Edges:                append([]graph.Edge(nil), projection.Edges...),
			UnresolvedReferences: copyUnresolvedReferences(projection.UnresolvedReferences),
			SymbolReferences:     append([]extractor.SymbolReference(nil), projection.SymbolReferences...),
			ExportedSurfaces:     append([]extractor.ExportedSurface(nil), projection.ExportedSurfaces...),
			Dependencies:         append([]extractor.Dependency(nil), projection.Dependencies...),
			Diagnostics:          append([]extractor.Diagnostic(nil), projection.Diagnostics...),
		}
	}
	return copied
}

func sourceContributionFromStorage(contribution storage.SourceContribution) storage.SourceContribution {
	return storage.SourceContribution{
		SourcePath:           contribution.SourcePath,
		Metadata:             extractor.Metadata{Name: contribution.Metadata.Name, Version: contribution.Metadata.Version, Extensions: append([]string(nil), contribution.Metadata.Extensions...)},
		Facts:                graph.Facts{Nodes: append([]graph.Node(nil), contribution.Facts.Nodes...), Edges: append([]graph.Edge(nil), contribution.Facts.Edges...)},
		CatalogUnits:         copyCatalogUnits(contribution.CatalogUnits),
		UnresolvedReferences: copyUnresolvedReferences(contribution.UnresolvedReferences),
		SymbolReferences:     append([]extractor.SymbolReference(nil), contribution.SymbolReferences...),
		ExportedSurfaces:     append([]extractor.ExportedSurface(nil), contribution.ExportedSurfaces...),
		Dependencies:         append([]extractor.Dependency(nil), contribution.Dependencies...),
		Diagnostics:          append([]extractor.Diagnostic(nil), contribution.Diagnostics...),
	}
}

func copyCatalogUnits(units []extractor.CatalogUnit) []extractor.CatalogUnit {
	copied := make([]extractor.CatalogUnit, len(units))
	for index, unit := range units {
		copied[index] = unit
		copied[index].Comments = append([]string(nil), unit.Comments...)
		copied[index].IdentifierTokens = append([]string(nil), unit.IdentifierTokens...)
	}
	return copied
}

func copyUnresolvedReferences(references []extractor.UnresolvedReference) []extractor.UnresolvedReference {
	copied := make([]extractor.UnresolvedReference, len(references))
	for index, reference := range references {
		copied[index] = reference
		copied[index].Bindings = append([]extractor.ModuleBinding(nil), reference.Bindings...)
	}
	return copied
}

func (store *Store) OpenSnapshot(ctx context.Context, request storage.OpenSnapshotRequest) (storage.Snapshot, error) {
	if request.Workspace == "" {
		return storage.Snapshot{}, fmt.Errorf("open graph snapshot: %w: workspace is required", storage.ErrInvalidRequest)
	}

	query := "SELECT version, published_at FROM graph_versions WHERE workspace = ? ORDER BY version DESC LIMIT 1"
	arguments := []any{request.Workspace}
	notFound := storage.ErrWorkspaceNotFound
	if request.Version != nil {
		query = "SELECT version, published_at FROM graph_versions WHERE workspace = ? AND version = ?"
		arguments = append(arguments, *request.Version)
		notFound = storage.ErrGraphVersionNotFound
	}

	var snapshot storage.Snapshot
	var publishedAt string
	if err := store.database.QueryRowContext(ctx, query, arguments...).Scan(&snapshot.Version, &publishedAt); err != nil {
		if err == sql.ErrNoRows {
			if request.Version != nil && graphVersionWasPruned(ctx, store.database, request.Workspace, *request.Version) {
				return storage.Snapshot{}, fmt.Errorf("open graph snapshot: %w", storage.ErrGraphVersionPruned)
			}
			return storage.Snapshot{}, fmt.Errorf("open graph snapshot: %w", notFound)
		}
		return storage.Snapshot{}, fmt.Errorf("read graph snapshot: %w", err)
	}

	parsedPublishedAt, err := time.Parse(time.RFC3339Nano, publishedAt)
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("parse graph publication time: %w", err)
	}
	snapshot.Workspace = request.Workspace
	snapshot.PublishedAt = parsedPublishedAt
	return snapshot, nil
}

func (store *Store) LookupNodes(ctx context.Context, snapshot storage.Snapshot, request storage.NodeLookupRequest) ([]storage.NodeMatch, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 || request.Text == "" || request.Limit <= 0 {
		return nil, fmt.Errorf("look up graph nodes: %w: snapshot, search text, and positive limit are required", storage.ErrInvalidRequest)
	}

	query, arguments := nodeLookupQuery(snapshot, request)
	rows, err := store.database.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("look up graph nodes: %w", err)
	}
	defer rows.Close()

	matches := make([]storage.NodeMatch, 0)
	for rows.Next() {
		var match storage.NodeMatch
		targets := append([]any{&match.Score, &match.Node.ID, &match.Node.Kind, &match.Node.Label, &match.Node.QualifiedName}, evidenceScanTargets(&match.Node.Evidence)...)
		if err := rows.Scan(targets...); err != nil {
			return nil, fmt.Errorf("read graph node match: %w", err)
		}
		matches = append(matches, match)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate graph node matches: %w", err)
	}
	return matches, nil
}

func (store *Store) LookupExactNodes(ctx context.Context, snapshot storage.Snapshot, identifier string) ([]storage.NodeMatch, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 || identifier == "" {
		return nil, fmt.Errorf("look up exact graph nodes: %w: snapshot and identifier are required", storage.ErrInvalidRequest)
	}

	rows, err := store.database.QueryContext(ctx, exactNodeLookupSQL, snapshot.Workspace, snapshot.Version, snapshot.Version, snapshot.Workspace, snapshot.Version, identifier, identifier, identifier)
	if err != nil {
		return nil, fmt.Errorf("look up exact graph nodes: %w", err)
	}
	defer rows.Close()

	matches := make([]storage.NodeMatch, 0)
	for rows.Next() {
		var match storage.NodeMatch
		targets := append([]any{&match.Score, &match.Node.ID, &match.Node.Kind, &match.Node.Label, &match.Node.QualifiedName}, evidenceScanTargets(&match.Node.Evidence)...)
		if err := rows.Scan(targets...); err != nil {
			return nil, fmt.Errorf("read exact graph node match: %w", err)
		}
		matches = append(matches, match)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate exact graph node matches: %w", err)
	}
	return matches, nil
}

func (store *Store) SearchNodes(ctx context.Context, snapshot storage.Snapshot, request storage.LexicalSearchRequest) ([]storage.LexicalMatch, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 || request.Limit <= 0 {
		return nil, fmt.Errorf("search graph nodes: %w: snapshot and positive limit are required", storage.ErrInvalidRequest)
	}
	matchExpression := lexicalMatchExpression(request)
	if matchExpression == "" {
		return nil, fmt.Errorf("search graph nodes: %w: search text, phrase, or token group is required", storage.ErrInvalidRequest)
	}
	var scopedNodeIDs []string
	if len(request.ProjectIDs) > 0 {
		scoped, err := store.readScopedNodeIDs(ctx, snapshot, request.ProjectIDs)
		if err != nil {
			return nil, fmt.Errorf("search graph nodes: %w", err)
		}
		if len(scoped) == 0 {
			return []storage.LexicalMatch{}, nil
		}
		scopedNodeIDs = make([]string, 0, len(scoped))
		for nodeID := range scoped {
			scopedNodeIDs = append(scopedNodeIDs, nodeID)
		}
		sort.Strings(scopedNodeIDs)
	}

	query, arguments := lexicalSearchQuery(snapshot, request, matchExpression, scopedNodeIDs)
	rows, err := store.database.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("search graph nodes: %w", err)
	}
	defer rows.Close()

	matches := make([]storage.LexicalMatch, 0)
	for rows.Next() {
		var match storage.LexicalMatch
		targets := append([]any{&match.Score, &match.Node.ID, &match.Node.Kind, &match.Node.Label, &match.Node.QualifiedName}, evidenceScanTargets(&match.Node.Evidence)...)
		if err := rows.Scan(targets...); err != nil {
			return nil, fmt.Errorf("read lexical graph node match: %w", err)
		}
		tokens := identifierTokens(strings.Join([]string{match.Node.ID, match.Node.Label, match.Node.QualifiedName, match.Node.Evidence.Span.Path, string(match.Node.Kind)}, " "))
		match.MatchedFields = lexicalMatchedFields(request, match.Node.Label, match.Node.QualifiedName, match.Node.Evidence.Span.Path, string(match.Node.Kind), tokens)
		matches = append(matches, match)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate lexical graph node matches: %w", err)
	}
	return matches, nil
}

func (store *Store) RebuildLexicalIndex(ctx context.Context, workspace string) error {
	if workspace == "" {
		return fmt.Errorf("rebuild lexical index: %w: workspace is required", storage.ErrInvalidRequest)
	}
	transaction, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("start lexical index rebuild: %w", err)
	}
	defer transaction.Rollback()
	if err := deleteLexicalRows(ctx, transaction, workspace, "1", "1"); err != nil {
		return fmt.Errorf("clear lexical index: %w", err)
	}
	var version storage.GraphVersion
	if err := transaction.QueryRowContext(ctx, "SELECT COALESCE(MAX(version), 0) FROM graph_versions WHERE workspace = ?", workspace).Scan(&version); err != nil {
		return fmt.Errorf("read lexical rebuild snapshots: %w", err)
	}
	if err := store.rebuildLexicalSnapshot(ctx, transaction, workspace, version); err != nil {
		return err
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit lexical index rebuild: %w", err)
	}
	return nil
}

func (store *Store) RecordCopilotPlannerMetric(ctx context.Context, metric storage.CopilotPlannerMetric) error {
	metric = normalizeCopilotPlannerMetric(metric)
	if err := validateCopilotPlannerMetric(metric); err != nil {
		return err
	}
	_, err := store.database.ExecContext(ctx, `
		INSERT INTO copilot_planner_metrics (
			recorded_at, day, model, max_ai_credits, outcome, duration_ns, prompt_bytes, response_bytes,
			output_tokens, output_tokens_availability, output_tokens_estimate_method,
			session_total_nano_aiu, session_total_nano_aiu_availability, session_total_nano_aiu_estimate_method,
			actual_model, input_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
			premium_request_credits, user_requests, api_duration_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		metric.RecordedAt.UTC().Format(time.RFC3339Nano),
		metric.RecordedAt.UTC().Format("2006-01-02"),
		metric.Model,
		metric.MaxAICredits,
		metric.Outcome,
		metric.Duration.Nanoseconds(),
		metric.PromptBytes,
		metric.ResponseBytes,
		metricValueDatabaseValue(metric.OutputTokens),
		metric.OutputTokens.Availability,
		metric.OutputTokens.EstimateMethod,
		metricValueDatabaseValue(metric.SessionTotalNanoAiu),
		metric.SessionTotalNanoAiu.Availability,
		metric.SessionTotalNanoAiu.EstimateMethod,
		metric.ActualModel,
		metricValueDatabaseValue(metric.InputTokens),
		metricValueDatabaseValue(metric.CacheReadTokens),
		metricValueDatabaseValue(metric.CacheWriteTokens),
		metricValueDatabaseValue(metric.ReasoningTokens),
		metricValueDatabaseValue(metric.PremiumRequestCredits),
		metricValueDatabaseValue(metric.UserRequests),
		metricValueDatabaseValue(metric.APIDurationMilliseconds),
	)
	if err != nil {
		return fmt.Errorf("record Copilot planner metric: %w", err)
	}
	return nil
}

func (store *Store) RecordClaudePlannerMetric(ctx context.Context, metric storage.ClaudePlannerMetric) error {
	if metric.RecordedAt.IsZero() || metric.Model == "" || metric.Outcome == "" {
		return fmt.Errorf("record Claude planner metric: %w: recorded time, model, and outcome are required", storage.ErrInvalidRequest)
	}
	_, err := store.database.ExecContext(ctx, `
		INSERT INTO claude_planner_metrics (
			recorded_at, day, model, actual_model, fallback_model, max_budget_usd, effort, outcome,
			duration_ns, prompt_bytes, response_bytes, input_tokens, input_tokens_availability,
			output_tokens, output_tokens_availability, api_duration_ms, api_duration_ms_availability,
			cost_usd, cost_usd_availability
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		metric.RecordedAt.UTC().Format(time.RFC3339Nano),
		metric.RecordedAt.UTC().Format("2006-01-02"),
		metric.Model,
		metric.ActualModel,
		metric.FallbackModel,
		metric.MaxBudgetUSD,
		metric.Effort,
		metric.Outcome,
		metric.Duration.Nanoseconds(),
		metric.PromptBytes,
		metric.ResponseBytes,
		metricValueDatabaseValue(metric.InputTokens),
		metric.InputTokens.Availability,
		metricValueDatabaseValue(metric.OutputTokens),
		metric.OutputTokens.Availability,
		metricValueDatabaseValue(metric.APIDurationMilliseconds),
		metric.APIDurationMilliseconds.Availability,
		dollarValueDatabaseValue(metric.CostUSD),
		metric.CostUSD.Availability,
	)
	if err != nil {
		return fmt.Errorf("record Claude planner metric: %w", err)
	}
	return nil
}

func (store *Store) ReserveSpend(ctx context.Context, request storage.SpendReservationRequest) (storage.SpendReservation, error) {
	if request.Provider == "" || request.Unit == "" || request.MaximumAmount < 0 || request.MinimumAmount < 0 || request.MaximumAmount > 0 && request.MinimumAmount > request.MaximumAmount || request.Limits.Daily < 0 || request.Limits.Weekly < 0 || request.Limits.Monthly < 0 {
		return storage.SpendReservation{}, fmt.Errorf("reserve spend: %w", storage.ErrInvalidRequest)
	}
	if request.Limits.Daily == 0 && request.Limits.Weekly == 0 && request.Limits.Monthly == 0 {
		return storage.SpendReservation{Amount: request.MaximumAmount}, nil
	}
	transaction, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return storage.SpendReservation{}, fmt.Errorf("reserve spend: %w", err)
	}
	defer transaction.Rollback()
	now := store.now().UTC()
	limits := []struct {
		amount float64
		start  time.Time
	}{
		{amount: request.Limits.Daily, start: time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)},
		{amount: request.Limits.Weekly, start: time.Date(now.Year(), now.Month(), now.Day()-int((now.Weekday()+6)%7), 0, 0, 0, 0, time.UTC)},
		{amount: request.Limits.Monthly, start: time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)},
	}
	amount := request.MaximumAmount
	if amount == 0 {
		amount = math.Inf(1)
	}
	for _, limit := range limits {
		if limit.amount == 0 {
			continue
		}
		var used float64
		if err := transaction.QueryRowContext(ctx, "SELECT COALESCE(SUM(amount), 0) FROM spending_reservations WHERE provider = ? AND unit = ? AND recorded_at >= ?", request.Provider, request.Unit, limit.start.Format(time.RFC3339Nano)).Scan(&used); err != nil {
			return storage.SpendReservation{}, fmt.Errorf("reserve spend: read usage: %w", err)
		}
		amount = min(amount, limit.amount-used)
	}
	if amount < request.MinimumAmount || amount <= 0 {
		return storage.SpendReservation{}, storage.ErrSpendLimitExceeded
	}
	result, err := transaction.ExecContext(ctx, "INSERT INTO spending_reservations (recorded_at, provider, unit, amount) VALUES (?, ?, ?, ?)", now.Format(time.RFC3339Nano), request.Provider, request.Unit, amount)
	if err != nil {
		return storage.SpendReservation{}, fmt.Errorf("reserve spend: write reservation: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return storage.SpendReservation{}, fmt.Errorf("reserve spend: read reservation identifier: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return storage.SpendReservation{}, fmt.Errorf("reserve spend: commit: %w", err)
	}
	return storage.SpendReservation{ID: id, Amount: amount}, nil
}

func (store *Store) SettleSpend(ctx context.Context, reservationID int64, exactAmount float64) error {
	if reservationID <= 0 || exactAmount < 0 || math.IsNaN(exactAmount) || math.IsInf(exactAmount, 0) {
		return fmt.Errorf("settle spend: %w", storage.ErrInvalidRequest)
	}
	result, err := store.database.ExecContext(ctx, "UPDATE spending_reservations SET amount = ? WHERE reservation_id = ? AND amount >= ?", exactAmount, reservationID, exactAmount)
	if err != nil {
		return fmt.Errorf("settle spend: %w", err)
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("settle spend: read affected rows: %w", err)
	}
	if updated != 1 {
		return fmt.Errorf("settle spend: %w", storage.ErrInvalidRequest)
	}
	return nil
}

func dollarValueDatabaseValue(value storage.DollarValue) any {
	if value.Availability != storage.MetricValueExact && value.Availability != storage.MetricValueEstimate {
		return nil
	}
	return value.Value
}

func (store *Store) ReadClaudePlannerDailyMetrics(ctx context.Context, request storage.ClaudePlannerDailyMetricsRequest) ([]storage.ClaudePlannerDailyMetrics, error) {
	if request.Day.IsZero() {
		return nil, fmt.Errorf("read Claude planner daily metrics: %w: day is required", storage.ErrInvalidRequest)
	}
	day := request.Day.UTC()
	return store.readClaudePlannerMetrics(ctx, time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC), time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1))
}

func (store *Store) ReadClaudePlannerMonthlyMetrics(ctx context.Context, request storage.ClaudePlannerMonthlyMetricsRequest) ([]storage.ClaudePlannerDailyMetrics, error) {
	if request.Month.IsZero() {
		return nil, fmt.Errorf("read Claude planner monthly metrics: %w: month is required", storage.ErrInvalidRequest)
	}
	month := request.Month.UTC()
	start := time.Date(month.Year(), month.Month(), 1, 0, 0, 0, 0, time.UTC)
	return store.readClaudePlannerMetrics(ctx, start, start.AddDate(0, 1, 0))
}

func (store *Store) readClaudePlannerMetrics(ctx context.Context, start, end time.Time) ([]storage.ClaudePlannerDailyMetrics, error) {
	rows, err := store.database.QueryContext(ctx, `
		SELECT day, model, COALESCE(NULLIF(actual_model, ''), model), fallback_model, MAX(max_budget_usd), effort,
		SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END),
		SUM(CASE WHEN outcome = 'fallback' THEN 1 ELSE 0 END),
		SUM(CASE WHEN outcome = 'timeout' THEN 1 ELSE 0 END),
		SUM(CASE WHEN outcome = 'budget' THEN 1 ELSE 0 END),
		SUM(CASE WHEN outcome = 'model_unavailable' THEN 1 ELSE 0 END),
		SUM(CASE WHEN outcome = 'unavailable' THEN 1 ELSE 0 END),
		SUM(duration_ns), SUM(prompt_bytes), SUM(response_bytes),
		COUNT(input_tokens), COALESCE(SUM(input_tokens), 0),
		COUNT(output_tokens), COALESCE(SUM(output_tokens), 0),
		COUNT(api_duration_ms), COALESCE(SUM(api_duration_ms), 0),
		COUNT(cost_usd), COALESCE(SUM(cost_usd), 0)
		FROM claude_planner_metrics
		WHERE day >= ? AND day < ?
		GROUP BY day, model, actual_model, fallback_model, effort
		ORDER BY day, model, effort`, start.Format(time.DateOnly), end.Format(time.DateOnly))
	if err != nil {
		return nil, fmt.Errorf("read Claude planner daily metrics: %w", err)
	}
	defer rows.Close()
	metrics := make([]storage.ClaudePlannerDailyMetrics, 0)
	for rows.Next() {
		var metric storage.ClaudePlannerDailyMetrics
		var day string
		var durationNS, inputCount, inputTokens, outputCount, outputTokens, apiCount, apiDuration, costCount int64
		var cost float64
		if err := rows.Scan(&day, &metric.Model, &metric.ActualModel, &metric.FallbackModel, &metric.MaxBudgetUSD, &metric.Effort, &metric.Successes, &metric.Fallbacks, &metric.Timeouts, &metric.BudgetFailures, &metric.ModelUnavailables, &metric.Unavailables, &durationNS, &metric.PromptBytes, &metric.ResponseBytes, &inputCount, &inputTokens, &outputCount, &outputTokens, &apiCount, &apiDuration, &costCount, &cost); err != nil {
			return nil, fmt.Errorf("scan Claude planner daily metrics: %w", err)
		}
		parsedDay, err := time.Parse(time.DateOnly, day)
		if err != nil {
			return nil, fmt.Errorf("parse Claude planner metric day: %w", err)
		}
		metric.Day = parsedDay
		metric.Duration = time.Duration(durationNS)
		requests := metric.Successes + metric.Fallbacks + metric.Timeouts + metric.BudgetFailures + metric.ModelUnavailables + metric.Unavailables
		if inputCount > 0 && inputCount == int64(requests) {
			metric.InputTokens = storage.ExactMetricValue(inputTokens)
		} else {
			metric.InputTokens.Availability = storage.MetricValueUnavailable
		}
		if outputCount > 0 && outputCount == int64(requests) {
			metric.OutputTokens = storage.ExactMetricValue(outputTokens)
		} else {
			metric.OutputTokens.Availability = storage.MetricValueUnavailable
		}
		if apiCount > 0 && apiCount == int64(requests) {
			metric.APIDurationMilliseconds = storage.ExactMetricValue(apiDuration)
		} else {
			metric.APIDurationMilliseconds.Availability = storage.MetricValueUnavailable
		}
		if costCount > 0 && costCount == int64(requests) {
			metric.CostUSD = storage.DollarValue{Value: cost, Availability: storage.MetricValueExact}
		} else {
			metric.CostUSD.Availability = storage.MetricValueUnavailable
		}
		metrics = append(metrics, metric)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read Claude planner daily metrics: %w", err)
	}
	return metrics, nil
}

func normalizeCopilotPlannerMetric(metric storage.CopilotPlannerMetric) storage.CopilotPlannerMetric {
	for _, value := range []*storage.MetricValue{
		&metric.InputTokens,
		&metric.CacheReadTokens,
		&metric.CacheWriteTokens,
		&metric.ReasoningTokens,
		&metric.PremiumRequestCredits,
		&metric.UserRequests,
		&metric.APIDurationMilliseconds,
	} {
		if value.Availability == "" && value.Value == 0 && value.EstimateMethod == "" {
			value.Availability = storage.MetricValueUnavailable
		}
	}
	return metric
}

func (store *Store) ReadCopilotPlannerDailyMetrics(ctx context.Context, request storage.CopilotPlannerDailyMetricsRequest) ([]storage.CopilotPlannerDailyMetrics, error) {
	if request.Day.IsZero() {
		return nil, fmt.Errorf("read Copilot planner daily metrics: %w: day is required", storage.ErrInvalidRequest)
	}
	day := request.Day.UTC()
	start := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC)
	return store.readCopilotPlannerMetrics(ctx, start, start.AddDate(0, 0, 1))
}

func (store *Store) ReadCopilotPlannerMonthlyMetrics(ctx context.Context, request storage.CopilotPlannerMonthlyMetricsRequest) ([]storage.CopilotPlannerDailyMetrics, error) {
	if request.Month.IsZero() {
		return nil, fmt.Errorf("read Copilot planner monthly metrics: %w: month is required", storage.ErrInvalidRequest)
	}
	month := request.Month.UTC()
	start := time.Date(month.Year(), month.Month(), 1, 0, 0, 0, 0, time.UTC)
	return store.readCopilotPlannerMetrics(ctx, start, start.AddDate(0, 1, 0))
}

func (store *Store) readCopilotPlannerMetrics(ctx context.Context, start, end time.Time) ([]storage.CopilotPlannerDailyMetrics, error) {
	rows, err := store.database.QueryContext(ctx, `
		SELECT
			day,
			COALESCE(NULLIF(actual_model, ''), model),
			MAX(max_ai_credits),
			SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END),
			SUM(CASE WHEN outcome NOT IN ('success', 'timeout') THEN 1 ELSE 0 END),
			SUM(CASE WHEN outcome = 'timeout' THEN 1 ELSE 0 END),
			SUM(duration_ns),
			SUM(prompt_bytes),
			SUM(response_bytes),
			COUNT(*),
			SUM(CASE WHEN output_tokens_availability = 'exact' THEN 1 ELSE 0 END),
			COALESCE(SUM(CASE WHEN output_tokens_availability = 'exact' THEN output_tokens ELSE 0 END), 0),
			SUM(CASE WHEN output_tokens_availability = 'estimate' THEN 1 ELSE 0 END),
			COALESCE(SUM(CASE WHEN output_tokens_availability = 'estimate' THEN output_tokens ELSE 0 END), 0),
			COALESCE(MIN(CASE WHEN output_tokens_availability = 'estimate' THEN output_tokens_estimate_method END), ''),
			COUNT(DISTINCT CASE WHEN output_tokens_availability = 'estimate' THEN output_tokens_estimate_method END),
			SUM(CASE WHEN session_total_nano_aiu_availability = 'exact' THEN 1 ELSE 0 END),
			COALESCE(SUM(CASE WHEN session_total_nano_aiu_availability = 'exact' THEN session_total_nano_aiu ELSE 0 END), 0),
			SUM(CASE WHEN session_total_nano_aiu_availability = 'estimate' THEN 1 ELSE 0 END),
			COALESCE(SUM(CASE WHEN session_total_nano_aiu_availability = 'estimate' THEN session_total_nano_aiu ELSE 0 END), 0),
			COALESCE(MIN(CASE WHEN session_total_nano_aiu_availability = 'estimate' THEN session_total_nano_aiu_estimate_method END), ''),
			COUNT(DISTINCT CASE WHEN session_total_nano_aiu_availability = 'estimate' THEN session_total_nano_aiu_estimate_method END),
			COUNT(input_tokens), COALESCE(SUM(input_tokens), 0),
			COUNT(cache_read_tokens), COALESCE(SUM(cache_read_tokens), 0),
			COUNT(cache_write_tokens), COALESCE(SUM(cache_write_tokens), 0),
			COUNT(reasoning_tokens), COALESCE(SUM(reasoning_tokens), 0),
			COUNT(premium_request_credits), COALESCE(SUM(premium_request_credits), 0),
			COUNT(user_requests), COALESCE(SUM(user_requests), 0),
			COUNT(api_duration_ms), COALESCE(SUM(api_duration_ms), 0)
		FROM copilot_planner_metrics
		WHERE day >= ? AND day < ?
		GROUP BY day, COALESCE(NULLIF(actual_model, ''), model)
		ORDER BY day, COALESCE(NULLIF(actual_model, ''), model)`, start.Format(time.DateOnly), end.Format(time.DateOnly))
	if err != nil {
		return nil, fmt.Errorf("read Copilot planner daily metrics: %w", err)
	}
	defer rows.Close()

	metrics := make([]storage.CopilotPlannerDailyMetrics, 0)
	for rows.Next() {
		var metric storage.CopilotPlannerDailyMetrics
		var durationNS int64
		var recordCount, exactOutputTokenCount, estimatedOutputTokenCount, estimatedOutputTokenMethodCount int
		var exactNanoAiuCount, estimatedNanoAiuCount, estimatedNanoAiuMethodCount int
		var exactOutputTokens, estimatedOutputTokens, exactNanoAiu, estimatedNanoAiu int64
		var inputTokenCount, cacheReadTokenCount, cacheWriteTokenCount, reasoningTokenCount int
		var premiumRequestCreditCount, userRequestCount, apiDurationMillisecondsCount int
		var inputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens int64
		var premiumRequestCredits, userRequests, apiDurationMilliseconds int64
		var estimatedOutputTokenMethod, estimatedNanoAiuMethod string
		var metricDay string
		if err := rows.Scan(
			&metricDay,
			&metric.ActualModel,
			&metric.MaxAICredits,
			&metric.Successes,
			&metric.Failures,
			&metric.Timeouts,
			&durationNS,
			&metric.PromptBytes,
			&metric.ResponseBytes,
			&recordCount,
			&exactOutputTokenCount,
			&exactOutputTokens,
			&estimatedOutputTokenCount,
			&estimatedOutputTokens,
			&estimatedOutputTokenMethod,
			&estimatedOutputTokenMethodCount,
			&exactNanoAiuCount,
			&exactNanoAiu,
			&estimatedNanoAiuCount,
			&estimatedNanoAiu,
			&estimatedNanoAiuMethod,
			&estimatedNanoAiuMethodCount,
			&inputTokenCount,
			&inputTokens,
			&cacheReadTokenCount,
			&cacheReadTokens,
			&cacheWriteTokenCount,
			&cacheWriteTokens,
			&reasoningTokenCount,
			&reasoningTokens,
			&premiumRequestCreditCount,
			&premiumRequestCredits,
			&userRequestCount,
			&userRequests,
			&apiDurationMillisecondsCount,
			&apiDurationMilliseconds,
		); err != nil {
			return nil, fmt.Errorf("read Copilot planner daily metrics: %w", err)
		}
		day, err := time.Parse(time.DateOnly, metricDay)
		if err != nil {
			return nil, fmt.Errorf("read Copilot planner daily metrics: parse day: %w", err)
		}
		metric.Model = metric.ActualModel
		metric.Day = day.UTC()
		metric.Duration = time.Duration(durationNS)
		metric.OutputTokens = aggregateMetricValue(recordCount, exactOutputTokenCount, exactOutputTokens, estimatedOutputTokenCount, estimatedOutputTokens, estimatedOutputTokenMethod, estimatedOutputTokenMethodCount)
		metric.SessionTotalNanoAiu = aggregateMetricValue(recordCount, exactNanoAiuCount, exactNanoAiu, estimatedNanoAiuCount, estimatedNanoAiu, estimatedNanoAiuMethod, estimatedNanoAiuMethodCount)
		metric.InputTokens = aggregateExactMetricValue(recordCount, inputTokenCount, inputTokens)
		metric.CacheReadTokens = aggregateExactMetricValue(recordCount, cacheReadTokenCount, cacheReadTokens)
		metric.CacheWriteTokens = aggregateExactMetricValue(recordCount, cacheWriteTokenCount, cacheWriteTokens)
		metric.ReasoningTokens = aggregateExactMetricValue(recordCount, reasoningTokenCount, reasoningTokens)
		metric.PremiumRequestCredits = aggregateExactMetricValue(recordCount, premiumRequestCreditCount, premiumRequestCredits)
		metric.UserRequests = aggregateExactMetricValue(recordCount, userRequestCount, userRequests)
		metric.APIDurationMilliseconds = aggregateExactMetricValue(recordCount, apiDurationMillisecondsCount, apiDurationMilliseconds)
		metric.CostUSD = dollarValue(metric.PremiumRequestCredits)
		metrics = append(metrics, metric)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read Copilot planner daily metrics: %w", err)
	}
	return metrics, nil
}

func validateCopilotPlannerMetric(metric storage.CopilotPlannerMetric) error {
	if metric.RecordedAt.IsZero() || metric.Model == "" || metric.MaxAICredits < 1 || metric.Duration < 0 || metric.PromptBytes < 0 || metric.ResponseBytes < 0 {
		return fmt.Errorf("record Copilot planner metric: %w", storage.ErrInvalidRequest)
	}
	if metric.Outcome != storage.CopilotPlannerOutcomeSuccess && metric.Outcome != storage.CopilotPlannerOutcomeFailure && metric.Outcome != storage.CopilotPlannerOutcomeTimeout {
		return fmt.Errorf("record Copilot planner metric: %w", storage.ErrInvalidRequest)
	}
	if !validMetricValue(metric.InputTokens) || !validMetricValue(metric.OutputTokens) || !validMetricValue(metric.CacheReadTokens) || !validMetricValue(metric.CacheWriteTokens) || !validMetricValue(metric.ReasoningTokens) || !validMetricValue(metric.SessionTotalNanoAiu) || !validMetricValue(metric.PremiumRequestCredits) || !validMetricValue(metric.UserRequests) || !validMetricValue(metric.APIDurationMilliseconds) {
		return fmt.Errorf("record Copilot planner metric: %w", storage.ErrInvalidRequest)
	}
	return nil
}

func validMetricValue(value storage.MetricValue) bool {
	if value.Value < 0 {
		return false
	}
	switch value.Availability {
	case storage.MetricValueExact, storage.MetricValueUnavailable:
		return value.EstimateMethod == ""
	case storage.MetricValueEstimate:
		return value.EstimateMethod != ""
	default:
		return false
	}
}

func metricValueDatabaseValue(value storage.MetricValue) any {
	if value.Availability != storage.MetricValueExact && value.Availability != storage.MetricValueEstimate {
		return nil
	}
	return value.Value
}

func aggregateMetricValue(recordCount, exactCount int, exactValue int64, estimatedCount int, estimatedValue int64, estimateMethod string, estimateMethodCount int) storage.MetricValue {
	if recordCount > 0 && recordCount == exactCount {
		return storage.ExactMetricValue(exactValue)
	}
	if recordCount > 0 && recordCount == estimatedCount && estimateMethodCount == 1 {
		return storage.MetricValue{Value: estimatedValue, Availability: storage.MetricValueEstimate, EstimateMethod: estimateMethod}
	}
	return storage.MetricValue{Availability: storage.MetricValueUnavailable}
}

func aggregateExactMetricValue(recordCount, exactCount int, value int64) storage.MetricValue {
	if recordCount > 0 && recordCount == exactCount {
		return storage.ExactMetricValue(value)
	}
	return storage.MetricValue{Availability: storage.MetricValueUnavailable}
}

func dollarValue(credits storage.MetricValue) storage.DollarValue {
	if credits.Availability != storage.MetricValueExact {
		return storage.DollarValue{Availability: storage.MetricValueUnavailable}
	}
	return storage.DollarValue{Value: float64(credits.Value) / 100, Availability: storage.MetricValueEstimate, EstimateMethod: "used credits / 100"}
}

const catalogUnitInputSQL = "json_array(unit.name, unit.kind, unit.owner, unit.signature, unit.comments, unit.identifier_tokens, unit.declaration_source)"

func closeInvalidCatalogRecords(ctx context.Context, transaction *sql.Tx, workspace string, version storage.GraphVersion) error {
	if _, err := transaction.ExecContext(ctx, `UPDATE catalog_entries SET valid_to_version = ?
		WHERE workspace = ? AND version < ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
		AND NOT EXISTS (SELECT 1 FROM contribution_catalog_units AS unit
			WHERE unit.workspace = catalog_entries.workspace AND unit.node_id = catalog_entries.node_id
			AND unit.valid_from_version <= ? AND (unit.valid_to_version IS NULL OR unit.valid_to_version >= ?)
			AND (catalog_entries.unit_input = '' OR catalog_entries.unit_input = `+catalogUnitInputSQL+`))
		AND NOT (unit_input = '' AND (
			EXISTS (SELECT 1 FROM contribution_nodes AS node WHERE node.workspace = catalog_entries.workspace AND node.node_id = catalog_entries.node_id
				AND node.valid_from_version <= ? AND (node.valid_to_version IS NULL OR node.valid_to_version >= ?))
			OR EXISTS (SELECT 1 FROM workspace_nodes AS node WHERE node.workspace = catalog_entries.workspace AND node.node_id = catalog_entries.node_id AND node.version = ?)))`,
		version-1, workspace, version, version, version, version, version, version, version); err != nil {
		return fmt.Errorf("close changed catalog records: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE catalog_embeddings SET valid_to_version = ?
		WHERE workspace = ? AND version < ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
		AND NOT EXISTS (SELECT 1 FROM contribution_nodes AS node WHERE node.workspace = catalog_embeddings.workspace AND node.node_id = catalog_embeddings.node_id
			AND node.valid_from_version <= ? AND (node.valid_to_version IS NULL OR node.valid_to_version >= ?))
		AND NOT EXISTS (SELECT 1 FROM workspace_nodes AS node WHERE node.workspace = catalog_embeddings.workspace AND node.node_id = catalog_embeddings.node_id AND node.version = ?)`,
		version-1, workspace, version, version, version, version, version); err != nil {
		return fmt.Errorf("close removed catalog embeddings: %w", err)
	}
	return nil
}

func catalogRecordValidity(ctx context.Context, transaction *sql.Tx, snapshot storage.Snapshot, nodeID string) (string, sql.NullInt64, error) {
	var unitInput string
	err := transaction.QueryRowContext(ctx, `SELECT `+catalogUnitInputSQL+` FROM contribution_catalog_units AS unit
		WHERE workspace = ? AND node_id = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) LIMIT 1`,
		snapshot.Workspace, nodeID, snapshot.Version, snapshot.Version).Scan(&unitInput)
	if err != nil && err != sql.ErrNoRows {
		return "", sql.NullInt64{}, fmt.Errorf("read catalog unit input: %w", err)
	}
	var validTo sql.NullInt64
	err = transaction.QueryRowContext(ctx, `SELECT MIN(boundary) - 1 FROM (
		SELECT future.version AS boundary FROM graph_versions AS future WHERE future.workspace = ? AND future.version > ?
		AND NOT EXISTS (SELECT 1 FROM contribution_catalog_units AS unit WHERE unit.workspace = future.workspace AND unit.node_id = ?
			AND unit.valid_from_version <= future.version AND (unit.valid_to_version IS NULL OR unit.valid_to_version >= future.version)
			AND (? = '' OR `+catalogUnitInputSQL+` = ?))
		AND NOT (? = '' AND (
			EXISTS (SELECT 1 FROM contribution_nodes AS node WHERE node.workspace = future.workspace AND node.node_id = ?
				AND node.valid_from_version <= future.version AND (node.valid_to_version IS NULL OR node.valid_to_version >= future.version))
			OR EXISTS (SELECT 1 FROM workspace_nodes AS node WHERE node.workspace = future.workspace AND node.node_id = ? AND node.version = future.version)))
		UNION ALL SELECT version FROM catalog_entries WHERE workspace = ? AND node_id = ? AND version > ?)`,
		snapshot.Workspace, snapshot.Version, nodeID, unitInput, unitInput, unitInput, nodeID, nodeID,
		snapshot.Workspace, nodeID, snapshot.Version).Scan(&validTo)
	if err != nil {
		return "", sql.NullInt64{}, fmt.Errorf("read catalog validity boundary: %w", err)
	}
	return unitInput, validTo, nil
}

func (store *Store) WriteCatalog(ctx context.Context, snapshot storage.Snapshot, request storage.CatalogWriteRequest) error {
	if snapshot.Workspace == "" || snapshot.Version == 0 || len(request.Entries) == 0 {
		return fmt.Errorf("write catalog: %w: snapshot and catalog entries are required", storage.ErrInvalidRequest)
	}

	transaction, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("start catalog write: %w", err)
	}
	defer transaction.Rollback()
	if err := verifyCatalogSnapshot(ctx, transaction, snapshot); err != nil {
		return err
	}
	for _, entry := range request.Entries {
		if entry.NodeID == "" || entry.Name == "" || entry.DeterministicSynopsis == "" {
			return fmt.Errorf("write catalog: %w: node ID, name, and deterministic synopsis are required", storage.ErrInvalidRequest)
		}
		var stored storage.CatalogEntry
		readErr := transaction.QueryRowContext(ctx, `SELECT node_id, name, input_fingerprint, deterministic_synopsis, copilot_synopsis, ollama_synopsis, claude_synopsis
			FROM catalog_entries WHERE workspace = ? AND node_id = ? AND version <= ?
			AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY version DESC LIMIT 1`,
			snapshot.Workspace, entry.NodeID, snapshot.Version, snapshot.Version).Scan(&stored.NodeID, &stored.Name, &stored.InputFingerprint, &stored.DeterministicSynopsis, &stored.CopilotSynopsis, &stored.OllamaSynopsis, &stored.ClaudeSynopsis)
		if readErr != nil && readErr != sql.ErrNoRows {
			return fmt.Errorf("read prior catalog entry: %w", readErr)
		}
		if readErr == nil && stored == entry {
			continue
		}
		unitInput, validTo, err := catalogRecordValidity(ctx, transaction, snapshot, entry.NodeID)
		if err != nil {
			return err
		}
		if _, err := transaction.ExecContext(ctx, `UPDATE catalog_entries SET valid_to_version = ?
			WHERE workspace = ? AND node_id = ? AND version < ? AND (valid_to_version IS NULL OR valid_to_version >= ?)`,
			snapshot.Version-1, snapshot.Workspace, entry.NodeID, snapshot.Version, snapshot.Version); err != nil {
			return fmt.Errorf("close prior catalog entry: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO catalog_entries (workspace, version, valid_to_version, unit_input, node_id, name, input_fingerprint, deterministic_synopsis, copilot_synopsis, ollama_synopsis, claude_synopsis)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (workspace, version, node_id) DO UPDATE SET
				valid_to_version = excluded.valid_to_version,
				unit_input = excluded.unit_input,
				name = excluded.name,
				input_fingerprint = excluded.input_fingerprint,
				deterministic_synopsis = excluded.deterministic_synopsis,
				copilot_synopsis = excluded.copilot_synopsis,
				ollama_synopsis = excluded.ollama_synopsis,
				claude_synopsis = excluded.claude_synopsis`,
			snapshot.Workspace, snapshot.Version, validTo, unitInput, entry.NodeID, entry.Name, entry.InputFingerprint, entry.DeterministicSynopsis, entry.CopilotSynopsis, entry.OllamaSynopsis, entry.ClaudeSynopsis); err != nil {
			return fmt.Errorf("store catalog entry: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "DELETE FROM catalog_search WHERE workspace = ? AND version = ? AND node_id = ?", snapshot.Workspace, snapshot.Version, entry.NodeID); err != nil {
			return fmt.Errorf("replace catalog search entry: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO catalog_search (workspace, version, node_id, name, deterministic_synopsis, copilot_synopsis, ollama_synopsis, claude_synopsis)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			snapshot.Workspace, snapshot.Version, entry.NodeID, entry.Name, entry.DeterministicSynopsis, entry.CopilotSynopsis, entry.OllamaSynopsis, entry.ClaudeSynopsis); err != nil {
			return fmt.Errorf("index catalog entry: %w", err)
		}
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit catalog write: %w", err)
	}
	return nil
}

func (store *Store) WriteCatalogTask(ctx context.Context, task storage.CatalogTask) error {
	if task.Workspace == "" || task.GraphVersion == 0 || task.State == "" || task.ProcessID < 0 || task.StartedAt.IsZero() || task.CompletedUnits < 0 || task.TotalUnits < 0 || task.CompletedUnits > task.TotalUnits {
		return fmt.Errorf("write catalog task: %w: workspace, graph version, state, start time, and valid progress are required", storage.ErrInvalidRequest)
	}
	changedPaths, err := json.Marshal(task.ChangedPaths)
	if err != nil {
		return fmt.Errorf("write catalog task: encode changed paths: %w", err)
	}
	if _, err := store.database.ExecContext(ctx, `
		INSERT INTO catalog_tasks (workspace, graph_version, state, process_id, started_at, finished_at, completed_units, total_units, stage, changed_paths, failure)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (workspace) DO UPDATE SET
			graph_version = excluded.graph_version,
			state = excluded.state,
			process_id = excluded.process_id,
			started_at = excluded.started_at,
			finished_at = excluded.finished_at,
			completed_units = excluded.completed_units,
			total_units = excluded.total_units,
			stage = excluded.stage,
			changed_paths = excluded.changed_paths,
			failure = excluded.failure
		WHERE excluded.graph_version >= catalog_tasks.graph_version`,
		task.Workspace, task.GraphVersion, task.State, task.ProcessID, task.StartedAt.UTC().Format(time.RFC3339Nano), nullableTime(task.FinishedAt), task.CompletedUnits, task.TotalUnits, task.Stage, string(changedPaths), task.Failure); err != nil {
		return fmt.Errorf("write catalog task: %w", err)
	}
	return nil
}

func (store *Store) ReadCatalogTask(ctx context.Context, workspace string) (storage.CatalogTask, bool, error) {
	if workspace == "" {
		return storage.CatalogTask{}, false, fmt.Errorf("read catalog task: %w: workspace is required", storage.ErrInvalidRequest)
	}
	var task storage.CatalogTask
	var startedAt, finishedAt, changedPaths string
	err := store.database.QueryRowContext(ctx, `SELECT graph_version, state, process_id, started_at, COALESCE(finished_at, ''), completed_units, total_units, stage, changed_paths, failure FROM catalog_tasks WHERE workspace = ?`, workspace).Scan(&task.GraphVersion, &task.State, &task.ProcessID, &startedAt, &finishedAt, &task.CompletedUnits, &task.TotalUnits, &task.Stage, &changedPaths, &task.Failure)
	if errors.Is(err, sql.ErrNoRows) {
		return storage.CatalogTask{}, false, nil
	}
	if err != nil {
		return storage.CatalogTask{}, false, fmt.Errorf("read catalog task: %w", err)
	}
	if task.StartedAt, err = time.Parse(time.RFC3339Nano, startedAt); err != nil {
		return storage.CatalogTask{}, false, fmt.Errorf("read catalog task start time: %w", err)
	}
	if finishedAt != "" {
		if task.FinishedAt, err = time.Parse(time.RFC3339Nano, finishedAt); err != nil {
			return storage.CatalogTask{}, false, fmt.Errorf("read catalog task finish time: %w", err)
		}
	}
	if err := json.Unmarshal([]byte(changedPaths), &task.ChangedPaths); err != nil {
		return storage.CatalogTask{}, false, fmt.Errorf("read catalog task changed paths: %w", err)
	}
	task.Workspace = workspace
	return task, true, nil
}

func nullableTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func copyCatalogEmbeddingVectors(ctx context.Context, transaction *sql.Tx, snapshot storage.Snapshot) error {
	rows, err := transaction.QueryContext(ctx, "SELECT DISTINCT dimensions FROM catalog_embeddings WHERE workspace = ? AND version = ?", snapshot.Workspace, snapshot.Version)
	if err != nil {
		return fmt.Errorf("read catalog embedding dimensions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var dimensions int
		if err := rows.Scan(&dimensions); err != nil {
			return fmt.Errorf("read catalog embedding dimension: %w", err)
		}
		if err := ensureCatalogEmbeddingVectorTable(ctx, transaction, dimensions); err != nil {
			return err
		}
		if _, err := transaction.ExecContext(ctx, "INSERT OR REPLACE INTO "+catalogEmbeddingVectorTable(dimensions)+" (rowid, embedding) SELECT embedding_id, vector FROM catalog_embeddings WHERE workspace = ? AND version = ? AND dimensions = ?", snapshot.Workspace, snapshot.Version, dimensions); err != nil {
			return fmt.Errorf("index catalog embeddings: %w", err)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate catalog embedding dimensions: %w", err)
	}
	return nil
}

func (store *Store) ReadCatalogEntries(ctx context.Context, snapshot storage.Snapshot, request storage.CatalogEntryReadRequest) ([]storage.CatalogEntry, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 || len(request.NodeIDs) == 0 {
		return nil, fmt.Errorf("read catalog entries: %w: snapshot and node IDs are required", storage.ErrInvalidRequest)
	}
	arguments := make([]any, 0, len(request.NodeIDs)+3)
	arguments = append(arguments, snapshot.Workspace, snapshot.Version, snapshot.Version)
	for _, nodeID := range request.NodeIDs {
		if nodeID == "" {
			return nil, fmt.Errorf("read catalog entries: %w: node ID is required", storage.ErrInvalidRequest)
		}
		arguments = append(arguments, nodeID)
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(request.NodeIDs)), ",")
	rows, err := store.database.QueryContext(ctx, `SELECT node_id, name, input_fingerprint, deterministic_synopsis, copilot_synopsis, ollama_synopsis, claude_synopsis
		FROM catalog_entries AS entry WHERE workspace = ? AND version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
		AND node_id IN (`+placeholders+`) AND NOT EXISTS (
			SELECT 1 FROM catalog_entries AS later WHERE later.workspace = entry.workspace AND later.node_id = entry.node_id
			AND later.version > entry.version AND later.version <= ? AND (later.valid_to_version IS NULL OR later.valid_to_version >= ?))
		AND EXISTS (SELECT 1 FROM graph_versions AS graph WHERE graph.workspace = entry.workspace AND graph.version = ?) ORDER BY node_id`, append(arguments, snapshot.Version, snapshot.Version, snapshot.Version)...)
	if err != nil {
		return nil, fmt.Errorf("read catalog entries: %w", err)
	}
	defer rows.Close()
	entries := make([]storage.CatalogEntry, 0)
	for rows.Next() {
		var entry storage.CatalogEntry
		if err := rows.Scan(&entry.NodeID, &entry.Name, &entry.InputFingerprint, &entry.DeterministicSynopsis, &entry.CopilotSynopsis, &entry.OllamaSynopsis, &entry.ClaudeSynopsis); err != nil {
			return nil, fmt.Errorf("read catalog entry: %w", err)
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate catalog entries: %w", err)
	}
	return entries, nil
}

func (store *Store) WriteCatalogEmbeddings(ctx context.Context, snapshot storage.Snapshot, request storage.CatalogEmbeddingWriteRequest) error {
	if snapshot.Workspace == "" || snapshot.Version == 0 || len(request.Embeddings) == 0 {
		return fmt.Errorf("write catalog embeddings: %w: snapshot and embeddings are required", storage.ErrInvalidRequest)
	}
	transaction, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("start catalog embedding write: %w", err)
	}
	defer transaction.Rollback()
	if err := verifyCatalogSnapshot(ctx, transaction, snapshot); err != nil {
		return err
	}
	for _, embedding := range request.Embeddings {
		if err := writeCatalogEmbedding(ctx, transaction, snapshot, embedding); err != nil {
			return err
		}
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit catalog embedding write: %w", err)
	}
	return nil
}

func writeCatalogEmbedding(ctx context.Context, transaction *sql.Tx, snapshot storage.Snapshot, embedding storage.CatalogEmbedding) error {
	if embedding.NodeID == "" || embedding.Text == "" || len(embedding.Vector) == 0 || (embedding.Source != storage.CatalogEmbeddingDeterministic && embedding.Source != storage.CatalogEmbeddingCopilot && embedding.Source != storage.CatalogEmbeddingOllama && embedding.Source != storage.CatalogEmbeddingClaude) {
		return fmt.Errorf("write catalog embeddings: %w: node ID, source, text, and vector are required", storage.ErrInvalidRequest)
	}
	dimensions := len(embedding.Vector)
	if err := ensureCatalogEmbeddingVectorTable(ctx, transaction, dimensions); err != nil {
		return err
	}
	serialized := serializeCatalogEmbedding(embedding.Vector)
	var storedText string
	var storedVector []byte
	readErr := transaction.QueryRowContext(ctx, `SELECT text, vector FROM catalog_embeddings
		WHERE workspace = ? AND node_id = ? AND source = ? AND version <= ?
		AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY version DESC LIMIT 1`,
		snapshot.Workspace, embedding.NodeID, embedding.Source, snapshot.Version, snapshot.Version).Scan(&storedText, &storedVector)
	if readErr != nil && readErr != sql.ErrNoRows {
		return fmt.Errorf("read prior catalog embedding: %w", readErr)
	}
	if readErr == nil && storedText == embedding.Text && bytes.Equal(storedVector, serialized) {
		return nil
	}
	var validTo sql.NullInt64
	if err := transaction.QueryRowContext(ctx, `SELECT MIN(boundary) - 1 FROM (
		SELECT version AS boundary FROM catalog_embeddings WHERE workspace = ? AND node_id = ? AND source = ? AND version > ?
		UNION ALL SELECT future.version FROM graph_versions AS future WHERE future.workspace = ? AND future.version > ?
		AND NOT EXISTS (SELECT 1 FROM contribution_nodes AS node WHERE node.workspace = future.workspace AND node.node_id = ?
			AND node.valid_from_version <= future.version AND (node.valid_to_version IS NULL OR node.valid_to_version >= future.version))
		AND NOT EXISTS (SELECT 1 FROM workspace_nodes AS node WHERE node.workspace = future.workspace AND node.node_id = ? AND node.version = future.version))`,
		snapshot.Workspace, embedding.NodeID, embedding.Source, snapshot.Version, snapshot.Workspace, snapshot.Version, embedding.NodeID, embedding.NodeID).Scan(&validTo); err != nil {
		return fmt.Errorf("read embedding validity boundary: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE catalog_embeddings SET valid_to_version = ?
		WHERE workspace = ? AND node_id = ? AND source = ? AND version < ? AND (valid_to_version IS NULL OR valid_to_version >= ?)`,
		snapshot.Version-1, snapshot.Workspace, embedding.NodeID, embedding.Source, snapshot.Version, snapshot.Version); err != nil {
		return fmt.Errorf("close prior catalog embedding: %w", err)
	}
	var priorID int64
	var priorDimensions int
	err := transaction.QueryRowContext(ctx, "SELECT embedding_id, dimensions FROM catalog_embeddings WHERE workspace = ? AND version = ? AND node_id = ? AND source = ?", snapshot.Workspace, snapshot.Version, embedding.NodeID, embedding.Source).Scan(&priorID, &priorDimensions)
	if err != nil && err != sql.ErrNoRows {
		return fmt.Errorf("read existing catalog embedding: %w", err)
	}
	if err == nil {
		if _, err := transaction.ExecContext(ctx, "DELETE FROM "+catalogEmbeddingVectorTable(priorDimensions)+" WHERE rowid = ?", priorID); err != nil {
			return fmt.Errorf("replace catalog embedding vector: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "DELETE FROM catalog_embeddings WHERE embedding_id = ?", priorID); err != nil {
			return fmt.Errorf("replace catalog embedding: %w", err)
		}
	}
	result, err := transaction.ExecContext(ctx, "INSERT INTO catalog_embeddings (workspace, version, valid_to_version, node_id, source, text, dimensions, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", snapshot.Workspace, snapshot.Version, validTo, embedding.NodeID, embedding.Source, embedding.Text, dimensions, serialized)
	if err != nil {
		return fmt.Errorf("store catalog embedding: %w", err)
	}
	embeddingID, err := result.LastInsertId()
	if err != nil {
		return fmt.Errorf("read catalog embedding ID: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, "INSERT INTO "+catalogEmbeddingVectorTable(dimensions)+" (rowid, embedding) VALUES (?, ?)", embeddingID, serialized); err != nil {
		return fmt.Errorf("index catalog embedding: %w", err)
	}
	return nil
}

func ensureCatalogEmbeddingVectorTable(ctx context.Context, transaction *sql.Tx, dimensions int) error {
	if dimensions <= 0 || dimensions > 8192 {
		return fmt.Errorf("write catalog embeddings: %w: vector dimensions must be between 1 and 8192", storage.ErrInvalidRequest)
	}
	if _, err := transaction.ExecContext(ctx, "CREATE VIRTUAL TABLE IF NOT EXISTS "+catalogEmbeddingVectorTable(dimensions)+" USING vec0(embedding float["+strconv.Itoa(dimensions)+"])"); err != nil {
		return fmt.Errorf("create catalog embedding vector table: %w", err)
	}
	return nil
}

func catalogEmbeddingVectorTable(dimensions int) string {
	return "catalog_embedding_vectors_" + strconv.Itoa(dimensions)
}

func serializeCatalogEmbedding(vector []float32) []byte {
	serialized := make([]byte, len(vector)*4)
	for index, value := range vector {
		binary.LittleEndian.PutUint32(serialized[index*4:], math.Float32bits(value))
	}
	return serialized
}

func (store *Store) ReadCatalogEmbeddings(ctx context.Context, snapshot storage.Snapshot, request storage.CatalogEmbeddingReadRequest) ([]storage.CatalogEmbedding, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 || len(request.NodeIDs) == 0 {
		return nil, fmt.Errorf("read catalog embeddings: %w: snapshot and node IDs are required", storage.ErrInvalidRequest)
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(request.NodeIDs)), ",")
	arguments := make([]any, 0, len(request.NodeIDs)+3)
	arguments = append(arguments, snapshot.Workspace, snapshot.Version, snapshot.Version)
	for _, nodeID := range request.NodeIDs {
		if nodeID == "" {
			return nil, fmt.Errorf("read catalog embeddings: %w: node ID is required", storage.ErrInvalidRequest)
		}
		arguments = append(arguments, nodeID)
	}
	rows, err := store.database.QueryContext(ctx, `SELECT node_id, source, text, vector FROM catalog_embeddings AS embedding
		WHERE workspace = ? AND version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) AND node_id IN (`+placeholders+`)
		AND NOT EXISTS (SELECT 1 FROM catalog_embeddings AS later WHERE later.workspace = embedding.workspace AND later.node_id = embedding.node_id
			AND later.source = embedding.source AND later.version > embedding.version AND later.version <= ?
			AND (later.valid_to_version IS NULL OR later.valid_to_version >= ?))
		AND EXISTS (SELECT 1 FROM graph_versions AS graph WHERE graph.workspace = embedding.workspace AND graph.version = ?)
		ORDER BY node_id, CASE source WHEN 'deterministic' THEN 0 ELSE 1 END`, append(arguments, snapshot.Version, snapshot.Version, snapshot.Version)...)
	if err != nil {
		return nil, fmt.Errorf("read catalog embeddings: %w", err)
	}
	defer rows.Close()
	embeddings := make([]storage.CatalogEmbedding, 0)
	for rows.Next() {
		var embedding storage.CatalogEmbedding
		var serialized []byte
		if err := rows.Scan(&embedding.NodeID, &embedding.Source, &embedding.Text, &serialized); err != nil {
			return nil, fmt.Errorf("read catalog embedding: %w", err)
		}
		vector, err := deserializeCatalogEmbedding(serialized)
		if err != nil {
			return nil, err
		}
		embedding.Vector = vector
		embeddings = append(embeddings, embedding)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate catalog embeddings: %w", err)
	}
	return embeddings, nil
}

func deserializeCatalogEmbedding(serialized []byte) ([]float32, error) {
	if len(serialized) == 0 || len(serialized)%4 != 0 {
		return nil, fmt.Errorf("read catalog embedding: invalid vector encoding")
	}
	vector := make([]float32, len(serialized)/4)
	for index := range vector {
		vector[index] = math.Float32frombits(binary.LittleEndian.Uint32(serialized[index*4:]))
	}
	return vector, nil
}

func (store *Store) DeleteCatalogEntries(ctx context.Context, snapshot storage.Snapshot, nodeIDs []string) error {
	if snapshot.Workspace == "" || snapshot.Version == 0 || len(nodeIDs) == 0 {
		return fmt.Errorf("delete catalog entries: %w: snapshot and node IDs are required", storage.ErrInvalidRequest)
	}

	transaction, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("start catalog cleanup: %w", err)
	}
	defer transaction.Rollback()
	if err := verifyCatalogSnapshot(ctx, transaction, snapshot); err != nil {
		return err
	}
	for _, nodeID := range nodeIDs {
		if nodeID == "" {
			return fmt.Errorf("delete catalog entries: %w: node ID is required", storage.ErrInvalidRequest)
		}
		for _, table := range []string{"catalog_entries", "catalog_embeddings"} {
			if _, err := transaction.ExecContext(ctx, "UPDATE "+table+" SET valid_to_version = ? WHERE workspace = ? AND node_id = ? AND version < ? AND (valid_to_version IS NULL OR valid_to_version >= ?)",
				snapshot.Version-1, snapshot.Workspace, nodeID, snapshot.Version, snapshot.Version); err != nil {
				return fmt.Errorf("close deleted catalog record: %w", err)
			}
		}
		if err := deleteCatalogEmbeddings(ctx, transaction, snapshot.Workspace, snapshot.Version, nodeID); err != nil {
			return err
		}
		if _, err := transaction.ExecContext(ctx, "DELETE FROM catalog_entries WHERE workspace = ? AND version = ? AND node_id = ?", snapshot.Workspace, snapshot.Version, nodeID); err != nil {
			return fmt.Errorf("remove catalog entry: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "DELETE FROM catalog_search WHERE workspace = ? AND version = ? AND node_id = ?", snapshot.Workspace, snapshot.Version, nodeID); err != nil {
			return fmt.Errorf("remove catalog search entry: %w", err)
		}
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit catalog cleanup: %w", err)
	}
	return nil
}

func deleteCatalogEmbeddings(ctx context.Context, transaction *sql.Tx, workspace string, version storage.GraphVersion, nodeID string) error {
	if err := deleteCatalogEmbeddingVectors(ctx, transaction, "workspace = ? AND version = ? AND node_id = ?", workspace, version, nodeID); err != nil {
		return err
	}
	if _, err := transaction.ExecContext(ctx, "DELETE FROM catalog_embeddings WHERE workspace = ? AND version = ? AND node_id = ?", workspace, version, nodeID); err != nil {
		return fmt.Errorf("remove catalog embeddings: %w", err)
	}
	return nil
}

func deleteCatalogEmbeddingVectors(ctx context.Context, transaction *sql.Tx, condition string, arguments ...any) error {
	rows, err := transaction.QueryContext(ctx, "SELECT embedding_id, dimensions FROM catalog_embeddings WHERE "+condition, arguments...)
	if err != nil {
		return fmt.Errorf("read catalog embeddings for deletion: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var embeddingID int64
		var dimensions int
		if err := rows.Scan(&embeddingID, &dimensions); err != nil {
			return fmt.Errorf("read catalog embedding for deletion: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "DELETE FROM "+catalogEmbeddingVectorTable(dimensions)+" WHERE rowid = ?", embeddingID); err != nil {
			return fmt.Errorf("remove catalog embedding vector: %w", err)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate catalog embeddings for deletion: %w", err)
	}
	return nil
}

func verifyCatalogSnapshot(ctx context.Context, transaction *sql.Tx, snapshot storage.Snapshot) error {
	var found storage.GraphVersion
	if err := transaction.QueryRowContext(ctx, "SELECT version FROM graph_versions WHERE workspace = ? AND version = ?", snapshot.Workspace, snapshot.Version).Scan(&found); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("catalog snapshot: %w", storage.ErrGraphVersionNotFound)
		}
		return fmt.Errorf("read catalog snapshot: %w", err)
	}
	return nil
}

func (store *Store) SearchCatalog(ctx context.Context, snapshot storage.Snapshot, request storage.CatalogSearchRequest) ([]storage.CatalogMatch, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 || request.Limit <= 0 {
		return nil, fmt.Errorf("search catalog: %w: snapshot and positive limit are required", storage.ErrInvalidRequest)
	}
	expression := strings.Join(quotedLexicalTerms(lexicalTerms(request.Text), true), " OR ")
	if expression == "" {
		return nil, fmt.Errorf("search catalog: %w: search text is required", storage.ErrInvalidRequest)
	}
	rows, err := store.database.QueryContext(ctx, `
		WITH visible_nodes AS (
			SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
			FROM contribution_nodes WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
			UNION
			SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
			FROM workspace_nodes WHERE workspace = ? AND version = ?
		)
		SELECT -bm25(catalog_search, 0, 0, 0, 8, 5, 1, 1, 1), catalog_search.node_id, catalog_search.name,
			catalog_search.deterministic_synopsis, catalog_search.copilot_synopsis, catalog_search.ollama_synopsis, catalog_search.claude_synopsis,
			visible_nodes.node_id, visible_nodes.kind, visible_nodes.label, visible_nodes.qualified_name,
			visible_nodes.span_path, visible_nodes.start_line, visible_nodes.start_column, visible_nodes.end_line, visible_nodes.end_column,
			visible_nodes.file_hash, visible_nodes.extractor, visible_nodes.provenance, visible_nodes.confidence
		FROM catalog_search JOIN visible_nodes ON visible_nodes.node_id = catalog_search.node_id
		JOIN catalog_entries AS entry ON entry.workspace = catalog_search.workspace AND entry.version = catalog_search.version AND entry.node_id = catalog_search.node_id
		WHERE catalog_search.workspace = ? AND entry.version <= ? AND (entry.valid_to_version IS NULL OR entry.valid_to_version >= ?) AND catalog_search MATCH ?
		ORDER BY bm25(catalog_search, 0, 0, 0, 8, 5, 1, 1, 1), visible_nodes.qualified_name, visible_nodes.node_id
		LIMIT ?`,
		snapshot.Workspace, snapshot.Version, snapshot.Version, snapshot.Workspace, snapshot.Version,
		snapshot.Workspace, snapshot.Version, snapshot.Version, expression, request.Limit)
	if err != nil {
		return nil, fmt.Errorf("search catalog: %w", err)
	}
	defer rows.Close()

	matches := make([]storage.CatalogMatch, 0)
	for rows.Next() {
		var match storage.CatalogMatch
		targets := append([]any{&match.Score, &match.Entry.NodeID, &match.Entry.Name, &match.Entry.DeterministicSynopsis, &match.Entry.CopilotSynopsis, &match.Entry.OllamaSynopsis, &match.Entry.ClaudeSynopsis, &match.Node.ID, &match.Node.Kind, &match.Node.Label, &match.Node.QualifiedName}, evidenceScanTargets(&match.Node.Evidence)...)
		if err := rows.Scan(targets...); err != nil {
			return nil, fmt.Errorf("read catalog match: %w", err)
		}
		matches = append(matches, match)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate catalog matches: %w", err)
	}
	return matches, nil
}

func (store *Store) SearchCatalogVectors(ctx context.Context, snapshot storage.Snapshot, request storage.CatalogVectorSearchRequest) ([]storage.CatalogMatch, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 || len(request.Vector) == 0 || request.Limit <= 0 {
		return nil, fmt.Errorf("search catalog vectors: %w: snapshot, vector, and positive limit are required", storage.ErrInvalidRequest)
	}
	table := catalogEmbeddingVectorTable(len(request.Vector))
	var found string
	if err := store.database.QueryRowContext(ctx, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table).Scan(&found); err != nil {
		if err == sql.ErrNoRows {
			return []storage.CatalogMatch{}, nil
		}
		return nil, fmt.Errorf("search catalog vectors: inspect vector table: %w", err)
	}
	rows, err := store.database.QueryContext(ctx, fmt.Sprintf(`
		WITH visible_nodes AS (
			SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
			FROM contribution_nodes WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
			UNION
			SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
			FROM workspace_nodes WHERE workspace = ? AND version = ?
		), visible_entries AS (
			SELECT entry.* FROM catalog_entries AS entry JOIN visible_nodes ON visible_nodes.node_id = entry.node_id
			WHERE entry.workspace = ? AND entry.version <= ? AND (entry.valid_to_version IS NULL OR entry.valid_to_version >= ?)
		), visible_embeddings AS (
			SELECT embedding.* FROM catalog_embeddings AS embedding JOIN visible_entries AS entry ON entry.node_id = embedding.node_id
			WHERE embedding.workspace = entry.workspace AND embedding.version <= ? AND (embedding.valid_to_version IS NULL OR embedding.valid_to_version >= ?)
			AND embedding.text = CASE embedding.source WHEN 'deterministic' THEN entry.deterministic_synopsis
				WHEN 'copilot' THEN entry.copilot_synopsis WHEN 'ollama' THEN entry.ollama_synopsis WHEN 'claude' THEN entry.claude_synopsis END
		), vector_matches AS (
			SELECT rowid, distance FROM %s WHERE embedding MATCH ? AND rowid IN (SELECT embedding_id FROM visible_embeddings) ORDER BY distance LIMIT ?
		), ranked_nodes AS (
			SELECT embedding.node_id, MIN(vector_matches.distance) AS distance
			FROM vector_matches JOIN visible_embeddings AS embedding ON embedding.embedding_id = vector_matches.rowid
			GROUP BY embedding.node_id
			ORDER BY distance, embedding.node_id
			LIMIT ?
		)
		SELECT -ranked_nodes.distance, entry.node_id, entry.name, entry.deterministic_synopsis, entry.copilot_synopsis, entry.ollama_synopsis, entry.claude_synopsis,
			visible_nodes.node_id, visible_nodes.kind, visible_nodes.label, visible_nodes.qualified_name,
			visible_nodes.span_path, visible_nodes.start_line, visible_nodes.start_column, visible_nodes.end_line, visible_nodes.end_column,
			visible_nodes.file_hash, visible_nodes.extractor, visible_nodes.provenance, visible_nodes.confidence
		FROM ranked_nodes JOIN visible_entries AS entry ON entry.node_id = ranked_nodes.node_id
		JOIN visible_nodes ON visible_nodes.node_id = entry.node_id
		ORDER BY ranked_nodes.distance, visible_nodes.qualified_name, visible_nodes.node_id`, table),
		snapshot.Workspace, snapshot.Version, snapshot.Version, snapshot.Workspace, snapshot.Version,
		snapshot.Workspace, snapshot.Version, snapshot.Version, snapshot.Version, snapshot.Version,
		serializeCatalogEmbedding(request.Vector), request.Limit*2,
		request.Limit)
	if err != nil {
		return nil, fmt.Errorf("search catalog vectors: %w", err)
	}
	defer rows.Close()
	matches := make([]storage.CatalogMatch, 0)
	for rows.Next() {
		var match storage.CatalogMatch
		targets := append([]any{&match.Score, &match.Entry.NodeID, &match.Entry.Name, &match.Entry.DeterministicSynopsis, &match.Entry.CopilotSynopsis, &match.Entry.OllamaSynopsis, &match.Entry.ClaudeSynopsis, &match.Node.ID, &match.Node.Kind, &match.Node.Label, &match.Node.QualifiedName}, evidenceScanTargets(&match.Node.Evidence)...)
		if err := rows.Scan(targets...); err != nil {
			return nil, fmt.Errorf("read catalog vector match: %w", err)
		}
		matches = append(matches, match)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate catalog vector matches: %w", err)
	}
	return matches, nil
}

func lexicalMatchExpression(request storage.LexicalSearchRequest) string {
	groups := make([]string, 0, len(request.TokenGroups)+len(request.Phrases)+1)
	for _, group := range request.TokenGroups {
		terms := lexicalTerms(strings.Join(group, " "))
		if len(terms) > 0 {
			groups = append(groups, "("+strings.Join(quotedLexicalTerms(terms, true), " AND ")+")")
		}
	}
	for _, phrase := range request.Phrases {
		if terms := lexicalTerms(phrase); len(terms) > 0 {
			groups = append(groups, quoteFTS(strings.Join(terms, " ")))
		}
	}
	if len(groups) == 0 {
		terms := lexicalTerms(request.Text)
		groups = append(groups, quotedLexicalTerms(terms, true)...)
	}
	return strings.Join(groups, " OR ")
}

func quotedLexicalTerms(terms []string, prefix bool) []string {
	quoted := make([]string, len(terms))
	for index, term := range terms {
		quoted[index] = quoteFTS(term)
		if prefix {
			quoted[index] += "*"
		}
	}
	return quoted
}

func quoteFTS(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func lexicalTerms(value string) []string {
	return strings.Fields(identifierTokens(value))
}

func identifierTokens(value string) string {
	var builder strings.Builder
	var prior rune
	for index, character := range []rune(value) {
		if unicode.IsLetter(character) || unicode.IsDigit(character) {
			if index > 0 && unicode.IsUpper(character) && (unicode.IsLower(prior) || unicode.IsDigit(prior)) {
				builder.WriteByte(' ')
			}
			builder.WriteRune(unicode.ToLower(character))
		} else if builder.Len() > 0 {
			builder.WriteByte(' ')
		}
		prior = character
	}
	return strings.Join(strings.Fields(builder.String()), " ")
}

func lexicalMatchedFields(request storage.LexicalSearchRequest, label, qualifiedName, spanPath, kind, tokens string) []string {
	terms := lexicalTerms(request.Text)
	for _, phrase := range request.Phrases {
		terms = append(terms, lexicalTerms(phrase)...)
	}
	for _, group := range request.TokenGroups {
		terms = append(terms, lexicalTerms(strings.Join(group, " "))...)
	}
	fields := []struct{ name, value string }{
		{"label", label}, {"qualifiedName", qualifiedName}, {"path", spanPath}, {"kind", kind}, {"identifierTokens", tokens},
	}
	matched := make([]string, 0, len(fields))
	for _, field := range fields {
		fieldValue := field.value
		if field.name != "identifierTokens" {
			fieldValue = identifierTokens(fieldValue)
		}
		fieldTokens := " " + fieldValue + " "
		for _, term := range terms {
			if strings.Contains(fieldTokens, " "+term+" ") {
				matched = append(matched, field.name)
				break
			}
		}
	}
	return matched
}

func lexicalSearchQuery(snapshot storage.Snapshot, request storage.LexicalSearchRequest, expression string, scopedNodeIDs []string) (string, []any) {
	kindFilter := ""
	scopeFilter := ""
	arguments := []any{
		snapshot.Workspace, snapshot.Version, snapshot.Version,
		snapshot.Workspace, snapshot.Version,
		expression, snapshot.Workspace, snapshot.Version,
	}
	if len(request.Kinds) > 0 {
		placeholders := make([]string, len(request.Kinds))
		for index, kind := range request.Kinds {
			placeholders[index] = "?"
			arguments = append(arguments, kind)
		}
		kindFilter = " AND visible_nodes.kind IN (" + strings.Join(placeholders, ", ") + ")"
	}
	if len(scopedNodeIDs) > 0 {
		placeholders := make([]string, len(scopedNodeIDs))
		for index, nodeID := range scopedNodeIDs {
			placeholders[index] = "?"
			arguments = append(arguments, nodeID)
		}
		scopeFilter = " AND visible_nodes.node_id IN (" + strings.Join(placeholders, ", ") + ")"
	}
	arguments = append(arguments, request.Text, request.Limit)
	return `
		WITH visible_nodes AS (
			SELECT rowid AS lexical_rowid, node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
			FROM contribution_nodes WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
			UNION ALL
			SELECT -rowid AS lexical_rowid, node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
			FROM workspace_nodes WHERE workspace = ? AND version = ?
		)
		SELECT -bm25(node_search, 10, 6, 3, 1, 5),
			visible_nodes.node_id, visible_nodes.kind, visible_nodes.label, visible_nodes.qualified_name,
			visible_nodes.span_path, visible_nodes.start_line, visible_nodes.start_column, visible_nodes.end_line, visible_nodes.end_column,
			visible_nodes.file_hash, visible_nodes.extractor, visible_nodes.provenance, visible_nodes.confidence
		FROM node_search JOIN visible_nodes ON visible_nodes.lexical_rowid = node_search.rowid
		WHERE node_search MATCH ? AND EXISTS (SELECT 1 FROM graph_versions WHERE workspace = ? AND version = ?)` + kindFilter + scopeFilter + `
		ORDER BY CASE WHEN replace(replace(replace(lower(visible_nodes.label), '_', ''), '-', ''), ' ', '') = replace(replace(replace(lower(?), '_', ''), '-', ''), ' ', '') THEN 0 ELSE 1 END,
			bm25(node_search, 10, 6, 3, 1, 5), visible_nodes.qualified_name, visible_nodes.node_id
		LIMIT ?`, arguments
}

func (store *Store) rebuildLexicalSnapshot(ctx context.Context, transaction *sql.Tx, workspace string, version storage.GraphVersion) error {
	if store.disableNodeFTS {
		return nil
	}
	return rebuildLexicalSnapshot(ctx, transaction, workspace, version, store.variableLimit, store.lexicalBatchLimits)
}

func rebuildLexicalSnapshot(ctx context.Context, transaction *sql.Tx, workspace string, version storage.GraphVersion, variableLimit int, limits factBatchLimits) error {
	rows, err := transaction.QueryContext(ctx, `
		SELECT rowid, node_id, label, qualified_name, span_path, kind
		FROM contribution_nodes AS node
		WHERE workspace = ? AND valid_from_version <= ?
			AND NOT EXISTS (SELECT 1 FROM node_search WHERE rowid = node.rowid)
		UNION ALL
		SELECT -rowid, node_id, label, qualified_name, span_path, kind
		FROM workspace_nodes AS node
		WHERE workspace = ? AND version <= ?
			AND NOT EXISTS (SELECT 1 FROM node_search WHERE rowid = -node.rowid)`, workspace, version, workspace, version)
	if err != nil {
		return fmt.Errorf("read lexical snapshot nodes: %w", err)
	}
	type lexicalRow struct {
		rowID                                        int64
		nodeID, label, qualifiedName, spanPath, kind string
	}
	defer rows.Close()
	indexed := make([][]any, 0, limits.maximumRows)
	estimatedBytes := 0
	flush := func() error {
		if err := insertRows(ctx, transaction, variableLimit, limits.maximumRows, `INSERT INTO node_search (rowid, label, qualified_name, span_path, kind, identifier_tokens) VALUES `, indexed); err != nil {
			return fmt.Errorf("index lexical snapshot nodes: %w", err)
		}
		clear(indexed)
		indexed = indexed[:0]
		estimatedBytes = 0
		return nil
	}
	for rows.Next() {
		var row lexicalRow
		if err := rows.Scan(&row.rowID, &row.nodeID, &row.label, &row.qualifiedName, &row.spanPath, &row.kind); err != nil {
			_ = rows.Close()
			return fmt.Errorf("read lexical snapshot node: %w", err)
		}
		tokens := identifierTokens(strings.Join([]string{row.nodeID, row.label, row.qualifiedName, row.spanPath, row.kind}, " "))
		values := []any{row.rowID, row.label, row.qualifiedName, row.spanPath, row.kind, tokens}
		rowBytes := estimateRowsBytes([][]any{values})
		if rowBytes > limits.maximumBytes {
			return fmt.Errorf("index lexical snapshot node: row exceeds %d byte limit", limits.maximumBytes)
		}
		if len(indexed) > 0 && (len(indexed) >= limits.maximumRows || estimatedBytes+rowBytes > limits.maximumBytes) {
			if err := flush(); err != nil {
				return err
			}
		}
		indexed = append(indexed, values)
		estimatedBytes += rowBytes
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("iterate lexical snapshot nodes: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close lexical snapshot nodes: %w", err)
	}
	return flush()
}

func deleteLexicalRows(ctx context.Context, transaction *sql.Tx, workspace, contributionCondition, workspaceCondition string, versions ...storage.GraphVersion) error {
	arguments := []any{workspace}
	for _, version := range versions {
		arguments = append(arguments, version)
	}
	for _, query := range []string{
		"DELETE FROM node_search WHERE rowid IN (SELECT rowid FROM contribution_nodes WHERE workspace = ? AND " + contributionCondition + ")",
		"DELETE FROM node_search WHERE rowid IN (SELECT -rowid FROM workspace_nodes WHERE workspace = ? AND " + workspaceCondition + ")",
	} {
		if _, err := transaction.ExecContext(ctx, query, arguments...); err != nil {
			return fmt.Errorf("remove lexical graph rows: %w", err)
		}
	}
	return nil
}

const exactNodeLookupSQL = `
	WITH visible_nodes AS (
		SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM contribution_nodes
		WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
		UNION
		SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM workspace_nodes
		WHERE workspace = ? AND version = ?
	)
	SELECT 0, node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
	FROM visible_nodes
	WHERE node_id = ? OR qualified_name = ? OR (kind = 'file' AND span_path = ?)
	ORDER BY qualified_name, label, node_id`

func nodeLookupQuery(snapshot storage.Snapshot, request storage.NodeLookupRequest) (string, []any) {
	term := request.Text
	foldedTerm := strings.ToLower(term)
	arguments := []any{
		snapshot.Workspace, snapshot.Version, snapshot.Version,
		snapshot.Workspace, snapshot.Version,
		snapshot.Workspace, snapshot.Version, snapshot.Version,
		snapshot.Workspace, snapshot.Version,
	}
	scope := "1"
	if len(request.ProjectIDs) > 0 {
		seeds := make([]string, len(request.ProjectIDs))
		for index, projectID := range request.ProjectIDs {
			seeds[index] = "(?)"
			arguments = append(arguments, projectID)
		}
		scope = "node_id IN (SELECT node_id FROM scoped)"
		return nodeLookupSQL("VALUES "+strings.Join(seeds, ", "), scope, request.Kinds), appendNodeLookupArguments(arguments, term, foldedTerm, request.Kinds, request.Limit)
	}
	return nodeLookupSQL("SELECT NULL WHERE 0", scope, request.Kinds), appendNodeLookupArguments(arguments, term, foldedTerm, request.Kinds, request.Limit)
}

func appendNodeLookupArguments(arguments []any, term, foldedTerm string, kinds []graph.NodeKind, limit int) []any {
	arguments = append(arguments,
		term, term, foldedTerm,
		foldedTerm, foldedTerm, foldedTerm, foldedTerm, foldedTerm, foldedTerm, foldedTerm,
		term, term, foldedTerm,
		foldedTerm, foldedTerm, foldedTerm, foldedTerm, foldedTerm, foldedTerm, foldedTerm, foldedTerm, foldedTerm, foldedTerm,
	)
	for _, kind := range kinds {
		arguments = append(arguments, kind)
	}
	return append(arguments, limit)
}

func nodeLookupSQL(scopeSeeds, scope string, kinds []graph.NodeKind) string {
	kindFilter := ""
	if len(kinds) > 0 {
		placeholders := make([]string, len(kinds))
		for index := range kinds {
			placeholders[index] = "?"
		}
		kindFilter = " AND kind IN (" + strings.Join(placeholders, ", ") + ")"
	}
	return fmt.Sprintf(`
		WITH RECURSIVE
		visible_nodes AS (
			SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
			FROM contribution_nodes
			WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
			UNION
			SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
			FROM workspace_nodes
			WHERE workspace = ? AND version = ?
		),
		visible_edges AS (
			SELECT source_id, target_id, relation
			FROM contribution_edges
			WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
			UNION
			SELECT source_id, target_id, relation
			FROM workspace_edges
			WHERE workspace = ? AND version = ?
		),
		scope_seeds(node_id) AS (%s),
		scoped(node_id) AS (
			SELECT node_id FROM scope_seeds
			UNION
			SELECT visible_edges.target_id
			FROM scoped JOIN visible_edges ON visible_edges.source_id = scoped.node_id
			WHERE visible_edges.relation = 'contains'
		),
		matched AS (
			SELECT
				CASE
					WHEN node_id = ? THEN 0
					WHEN qualified_name = ? THEN 1
					WHEN LOWER(label) = ? THEN 2
					WHEN SUBSTR(LOWER(label), 1, LENGTH(?)) = ? OR SUBSTR(LOWER(qualified_name), 1, LENGTH(?)) = ? OR LOWER(label) GLOB '*[^a-z0-9]' || ? || '*' OR LOWER(qualified_name) GLOB '*[^a-z0-9]' || ? || '*' THEN 3
					WHEN INSTR(LOWER(span_path), ?) > 0 THEN 4
					ELSE 5
				END AS match_rank,
				*
			FROM visible_nodes
			WHERE %s
				AND (
					node_id = ?
					OR qualified_name = ?
					OR LOWER(label) = ?
					OR SUBSTR(LOWER(label), 1, LENGTH(?)) = ?
					OR SUBSTR(LOWER(qualified_name), 1, LENGTH(?)) = ?
					OR LOWER(label) GLOB '*[^a-z0-9]' || ? || '*'
					OR LOWER(qualified_name) GLOB '*[^a-z0-9]' || ? || '*'
					OR INSTR(LOWER(span_path), ?) > 0
					OR INSTR(LOWER(node_id), ?) > 0
					OR INSTR(LOWER(qualified_name), ?) > 0
					OR INSTR(LOWER(label), ?) > 0
				)%s
		)
		SELECT match_rank, node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM matched
		ORDER BY match_rank, qualified_name, label, node_id
		LIMIT ?`, scopeSeeds, scope, kindFilter)
}

func (store *Store) Traverse(ctx context.Context, snapshot storage.Snapshot, request storage.TraversalRequest) (storage.TraversalResult, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 || len(request.StartNodeIDs) == 0 || request.MaxDepth < 0 || request.MaxNodes <= 0 {
		return storage.TraversalResult{}, fmt.Errorf("traverse graph: %w: snapshot, start nodes, nonnegative depth, and positive node limit are required", storage.ErrInvalidRequest)
	}
	if request.Direction != storage.TraverseIncoming && request.Direction != storage.TraverseOutgoing && request.Direction != storage.TraverseBoth {
		return storage.TraversalResult{}, fmt.Errorf("traverse graph: %w: unsupported direction %q", storage.ErrInvalidRequest, request.Direction)
	}

	scopedNodeIDs, err := store.readScopedNodeIDs(ctx, snapshot, request.ProjectIDs)
	if err != nil {
		return storage.TraversalResult{}, err
	}
	relations := make(map[graph.RelationKind]struct{}, len(request.Relations))
	for _, relation := range request.Relations {
		relations[relation] = struct{}{}
	}

	selectedNodes := make(map[string]graph.Node, request.MaxNodes)
	frontier := make([]string, 0, len(request.StartNodeIDs))
	startNodeIDs := append([]string(nil), request.StartNodeIDs...)
	sort.Strings(startNodeIDs)
	for _, nodeID := range startNodeIDs {
		if _, selected := selectedNodes[nodeID]; selected {
			continue
		}
		node, found, err := store.readNode(ctx, snapshot, nodeID)
		if err != nil {
			return storage.TraversalResult{}, err
		}
		if !found {
			continue
		}
		if len(scopedNodeIDs) > 0 {
			if _, inScope := scopedNodeIDs[nodeID]; !inScope {
				return storage.TraversalResult{}, fmt.Errorf("traverse graph: %w: start node %q is outside the project scope", storage.ErrInvalidRequest, nodeID)
			}
		}
		if len(selectedNodes) == request.MaxNodes {
			return storage.TraversalResult{Facts: graph.Facts{Nodes: sortedNodes(selectedNodes)}, TruncationReasons: []storage.TruncationReason{storage.TruncatedByNodeLimit}}, nil
		}
		selectedNodes[nodeID] = node
		frontier = append(frontier, nodeID)
	}

	selectedEdges := make(map[string]graph.Edge)
	truncationReasons := make([]storage.TruncationReason, 0, 2)
	var scopeBoundary *graph.Node
	for depth := 0; depth < request.MaxDepth && len(frontier) > 0; depth++ {
		nextFrontier := make([]string, 0)
		for _, nodeID := range frontier {
			edges, err := store.readIncidentEdges(ctx, snapshot, nodeID)
			if err != nil {
				return storage.TraversalResult{}, err
			}
			for _, edge := range edges {
				if len(relations) > 0 {
					if _, includesRelation := relations[edge.Relation]; !includesRelation {
						continue
					}
				}
				neighborID, traversesEdge := traversalNeighbor(nodeID, edge, request.Direction)
				if !traversesEdge {
					continue
				}
				neighbor, found, err := store.readNode(ctx, snapshot, neighborID)
				if err != nil {
					return storage.TraversalResult{}, err
				}
				if !found {
					continue
				}
				if len(scopedNodeIDs) > 0 {
					if _, inScope := scopedNodeIDs[neighborID]; !inScope {
						if scopeBoundary == nil {
							boundary := neighbor
							scopeBoundary = &boundary
						}
						if len(selectedNodes) == request.MaxNodes {
							truncationReasons = addTruncationReason(truncationReasons, storage.TruncatedByNodeLimit)
							continue
						}
						selectedNodes[neighborID] = neighbor
						selectedEdges[edgeKey(edge)] = edge
						continue
					}
				}
				if _, selected := selectedNodes[neighborID]; !selected {
					if len(selectedNodes) == request.MaxNodes {
						truncationReasons = addTruncationReason(truncationReasons, storage.TruncatedByNodeLimit)
						continue
					}
					selectedNodes[neighborID] = neighbor
					nextFrontier = append(nextFrontier, neighborID)
				}
				selectedEdges[edgeKey(edge)] = edge
			}
		}
		frontier = uniqueSortedStrings(nextFrontier)
	}
	if len(frontier) > 0 {
		for _, nodeID := range frontier {
			edges, err := store.readIncidentEdges(ctx, snapshot, nodeID)
			if err != nil {
				return storage.TraversalResult{}, err
			}
			if hasTraversableNeighbor(edges, nodeID, request.Direction, relations, selectedNodes) {
				truncationReasons = addTruncationReason(truncationReasons, storage.TruncatedByDepthLimit)
				break
			}
		}
	}

	return storage.TraversalResult{
		Facts: graph.Facts{
			Nodes: sortedNodes(selectedNodes),
			Edges: sortedEdges(selectedEdges),
		},
		TruncationReasons: truncationReasons,
		ScopeBoundary:     scopeBoundary,
	}, nil
}

func (store *Store) Explain(ctx context.Context, snapshot storage.Snapshot, request storage.ExplainRequest) (storage.Explanation, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 || request.NodeID == "" {
		return storage.Explanation{}, fmt.Errorf("explain graph node: %w: snapshot and node ID are required", storage.ErrInvalidRequest)
	}

	node, found, err := store.readNode(ctx, snapshot, request.NodeID)
	if err != nil {
		return storage.Explanation{}, err
	}
	if !found {
		return storage.Explanation{}, fmt.Errorf("explain graph node: node %q not found", request.NodeID)
	}

	supportingNodes := map[string]graph.Node{node.ID: node}
	supportingEdges := make(map[string]graph.Edge)
	edges, err := store.readIncidentEdges(ctx, snapshot, node.ID)
	if err != nil {
		return storage.Explanation{}, err
	}
	for _, edge := range edges {
		supportingEdges[edgeKey(edge)] = edge
		if source, found, err := store.readNode(ctx, snapshot, edge.SourceID); err != nil {
			return storage.Explanation{}, err
		} else if found {
			supportingNodes[source.ID] = source
		}
		if target, found, err := store.readNode(ctx, snapshot, edge.TargetID); err != nil {
			return storage.Explanation{}, err
		} else if found {
			supportingNodes[target.ID] = target
		}
	}
	return storage.Explanation{
		Node: node,
		SupportingFacts: graph.Facts{
			Nodes: sortedNodes(supportingNodes),
			Edges: sortedEdges(supportingEdges),
		},
	}, nil
}

func (store *Store) readNode(ctx context.Context, snapshot storage.Snapshot, nodeID string) (graph.Node, bool, error) {
	row := store.database.QueryRowContext(ctx, `
		WITH visible_nodes AS (
			SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
			FROM contribution_nodes
			WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
			UNION ALL
			SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
			FROM workspace_nodes
			WHERE workspace = ? AND version = ?
		)
		SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM visible_nodes WHERE node_id = ? LIMIT 1`,
		snapshot.Workspace, snapshot.Version, snapshot.Version, snapshot.Workspace, snapshot.Version, nodeID)
	var node graph.Node
	targets := append([]any{&node.ID, &node.Kind, &node.Label, &node.QualifiedName}, evidenceScanTargets(&node.Evidence)...)
	if err := row.Scan(targets...); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return graph.Node{}, false, nil
		}
		return graph.Node{}, false, fmt.Errorf("read graph node %q: %w", nodeID, err)
	}
	return node, true, nil
}

func (store *Store) readIncidentEdges(ctx context.Context, snapshot storage.Snapshot, nodeID string) ([]graph.Edge, error) {
	rows, err := store.database.QueryContext(ctx, `
		WITH visible_edges AS (
			SELECT source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
			FROM contribution_edges
			WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
			UNION ALL
			SELECT source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
			FROM workspace_edges
			WHERE workspace = ? AND version = ?
		)
		SELECT source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM visible_edges
		WHERE source_id = ? OR target_id = ?
		ORDER BY source_id, target_id, relation`,
		snapshot.Workspace, snapshot.Version, snapshot.Version, snapshot.Workspace, snapshot.Version, nodeID, nodeID)
	if err != nil {
		return nil, fmt.Errorf("read incident graph edges for %q: %w", nodeID, err)
	}
	defer rows.Close()

	edges := make([]graph.Edge, 0)
	for rows.Next() {
		var edge graph.Edge
		targets := append([]any{&edge.SourceID, &edge.TargetID, &edge.Relation}, evidenceScanTargets(&edge.Evidence)...)
		if err := rows.Scan(targets...); err != nil {
			return nil, fmt.Errorf("read incident graph edge for %q: %w", nodeID, err)
		}
		edges = append(edges, edge)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate incident graph edges for %q: %w", nodeID, err)
	}
	return edges, nil
}

func (store *Store) readScopedNodeIDs(ctx context.Context, snapshot storage.Snapshot, projectIDs []string) (map[string]struct{}, error) {
	if len(projectIDs) == 0 {
		return nil, nil
	}
	seeds := make([]string, len(projectIDs))
	arguments := []any{
		snapshot.Workspace, snapshot.Version, snapshot.Version,
		snapshot.Workspace, snapshot.Version,
	}
	for index, projectID := range projectIDs {
		seeds[index] = "(?)"
		arguments = append(arguments, projectID)
	}
	rows, err := store.database.QueryContext(ctx, fmt.Sprintf(`
		WITH RECURSIVE visible_edges AS (
			SELECT source_id, target_id, relation
			FROM contribution_edges
			WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
			UNION ALL
			SELECT source_id, target_id, relation
			FROM workspace_edges
			WHERE workspace = ? AND version = ?
		),
		scope_seeds(node_id) AS (VALUES %s),
		scoped(node_id) AS (
			SELECT node_id FROM scope_seeds
			UNION
			SELECT visible_edges.target_id
			FROM scoped JOIN visible_edges ON visible_edges.source_id = scoped.node_id
			WHERE visible_edges.relation = 'contains'
		)
		SELECT node_id FROM scoped`, strings.Join(seeds, ", ")), arguments...)
	if err != nil {
		return nil, fmt.Errorf("read project scope: %w", err)
	}
	defer rows.Close()

	scoped := make(map[string]struct{})
	for rows.Next() {
		var nodeID string
		if err := rows.Scan(&nodeID); err != nil {
			return nil, fmt.Errorf("read scoped node: %w", err)
		}
		scoped[nodeID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate project scope: %w", err)
	}
	return scoped, nil
}

func (store *Store) Export(ctx context.Context, snapshot storage.Snapshot, request storage.ExportRequest, sink storage.ExportSink) error {
	if snapshot.Workspace == "" || snapshot.Version == 0 || sink == nil {
		return fmt.Errorf("export graph: %w: snapshot and sink are required", storage.ErrInvalidRequest)
	}
	if request.IsUnfiltered() {
		return store.exportUnfiltered(ctx, snapshot, sink)
	}

	facts, err := store.readFacts(ctx, snapshot)
	if err != nil {
		return err
	}
	nodeKinds := make(map[graph.NodeKind]struct{}, len(request.NodeKinds))
	for _, kind := range request.NodeKinds {
		nodeKinds[kind] = struct{}{}
	}
	relations := make(map[graph.RelationKind]struct{}, len(request.Relations))
	for _, relation := range request.Relations {
		relations[relation] = struct{}{}
	}

	exportedNodes := make(map[string]graph.Node, len(facts.Nodes))
	for _, node := range facts.Nodes {
		if len(nodeKinds) > 0 {
			if _, includesKind := nodeKinds[node.Kind]; !includesKind {
				continue
			}
		}
		exportedNodes[node.ID] = node
	}
	for _, node := range sortedNodes(exportedNodes) {
		if err := sink.WriteNode(node); err != nil {
			return fmt.Errorf("export graph node %q: %w", node.ID, err)
		}
	}

	exportedEdges := make(map[string]graph.Edge)
	for _, edge := range facts.Edges {
		if len(relations) > 0 {
			if _, includesRelation := relations[edge.Relation]; !includesRelation {
				continue
			}
		}
		if _, sourceExported := exportedNodes[edge.SourceID]; !sourceExported {
			continue
		}
		if _, targetExported := exportedNodes[edge.TargetID]; !targetExported {
			continue
		}
		exportedEdges[edgeKey(edge)] = edge
	}
	for _, edge := range sortedEdges(exportedEdges) {
		if err := sink.WriteEdge(edge); err != nil {
			return fmt.Errorf("export graph edge %q -> %q: %w", edge.SourceID, edge.TargetID, err)
		}
	}
	return nil
}

func (store *Store) exportUnfiltered(ctx context.Context, snapshot storage.Snapshot, sink storage.ExportSink) error {
	nodeRows, err := store.database.QueryContext(ctx, `
		WITH visible_nodes AS (
			SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence, source_path, 0 AS precedence
			FROM contribution_nodes
			WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
			UNION ALL
			SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence, '' AS source_path, 1 AS precedence
			FROM workspace_nodes
			WHERE workspace = ? AND version = ?
		), ranked_nodes AS (
			SELECT *, ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY precedence DESC, source_path DESC) AS rank
			FROM visible_nodes
		)
		SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM ranked_nodes WHERE rank = 1 ORDER BY node_id`,
		snapshot.Workspace, snapshot.Version, snapshot.Version, snapshot.Workspace, snapshot.Version)
	if err != nil {
		return fmt.Errorf("export graph nodes: %w", err)
	}
	for nodeRows.Next() {
		var node graph.Node
		targets := append([]any{&node.ID, &node.Kind, &node.Label, &node.QualifiedName}, evidenceScanTargets(&node.Evidence)...)
		if err := nodeRows.Scan(targets...); err != nil {
			_ = nodeRows.Close()
			return fmt.Errorf("export graph node: %w", err)
		}
		if err := sink.WriteNode(node); err != nil {
			_ = nodeRows.Close()
			return fmt.Errorf("export graph node %q: %w", node.ID, err)
		}
	}
	if err := nodeRows.Err(); err != nil {
		_ = nodeRows.Close()
		return fmt.Errorf("export graph nodes: %w", err)
	}
	if err := nodeRows.Close(); err != nil {
		return fmt.Errorf("export graph nodes: %w", err)
	}

	edgeRows, err := store.database.QueryContext(ctx, `
		WITH visible_edges AS (
			SELECT source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence, 0 AS precedence
			FROM contribution_edges
			WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
			UNION ALL
			SELECT source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence, 1 AS precedence
			FROM workspace_edges
			WHERE workspace = ? AND version = ?
		), ranked_edges AS (
			SELECT *, ROW_NUMBER() OVER (PARTITION BY source_id, target_id, relation ORDER BY precedence DESC) AS rank
			FROM visible_edges
		)
		SELECT source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM ranked_edges WHERE rank = 1 ORDER BY source_id, target_id, relation`,
		snapshot.Workspace, snapshot.Version, snapshot.Version, snapshot.Workspace, snapshot.Version)
	if err != nil {
		return fmt.Errorf("export graph edges: %w", err)
	}
	for edgeRows.Next() {
		var edge graph.Edge
		targets := append([]any{&edge.SourceID, &edge.TargetID, &edge.Relation}, evidenceScanTargets(&edge.Evidence)...)
		if err := edgeRows.Scan(targets...); err != nil {
			_ = edgeRows.Close()
			return fmt.Errorf("export graph edge: %w", err)
		}
		if err := sink.WriteEdge(edge); err != nil {
			_ = edgeRows.Close()
			return fmt.Errorf("export graph edge %q -> %q: %w", edge.SourceID, edge.TargetID, err)
		}
	}
	if err := edgeRows.Err(); err != nil {
		_ = edgeRows.Close()
		return fmt.Errorf("export graph edges: %w", err)
	}
	if err := edgeRows.Close(); err != nil {
		return fmt.Errorf("export graph edges: %w", err)
	}
	return nil
}

func (store *Store) FactCounts(ctx context.Context, snapshot storage.Snapshot) (storage.FactCounts, error) {
	if snapshot.Workspace == "" || snapshot.Version == 0 {
		return storage.FactCounts{}, fmt.Errorf("count graph facts: %w: snapshot is required", storage.ErrInvalidRequest)
	}
	return factCounts(ctx, store.database, snapshot)
}

type rowQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func factCounts(ctx context.Context, queries rowQueryer, snapshot storage.Snapshot) (storage.FactCounts, error) {
	counts := storage.FactCounts{}
	if err := queries.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM (
			SELECT node_id FROM (
				SELECT node_id
				FROM contribution_nodes
				WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
				UNION ALL
				SELECT node_id
				FROM workspace_nodes
				WHERE workspace = ? AND version = ?
			)
			GROUP BY node_id
		)`, snapshot.Workspace, snapshot.Version, snapshot.Version, snapshot.Workspace, snapshot.Version).Scan(&counts.Nodes); err != nil {
		return storage.FactCounts{}, fmt.Errorf("count visible graph nodes: %w", err)
	}
	if err := queries.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM (
			SELECT source_id, target_id, relation FROM (
				SELECT source_id, target_id, relation
				FROM contribution_edges
				WHERE workspace = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
				UNION ALL
				SELECT source_id, target_id, relation
				FROM workspace_edges
				WHERE workspace = ? AND version = ?
			)
			GROUP BY source_id, target_id, relation
		)`, snapshot.Workspace, snapshot.Version, snapshot.Version, snapshot.Workspace, snapshot.Version).Scan(&counts.Edges); err != nil {
		return storage.FactCounts{}, fmt.Errorf("count visible graph edges: %w", err)
	}
	return counts, nil
}

func (store *Store) Rollback(ctx context.Context, request storage.RollbackRequest) (storage.Snapshot, error) {
	if request.Workspace == "" {
		return storage.Snapshot{}, fmt.Errorf("roll back graph version: %w: workspace is required", storage.ErrInvalidRequest)
	}

	transaction, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("start graph rollback: %w", err)
	}
	defer transaction.Rollback()

	var publishedAt string
	if err := transaction.QueryRowContext(ctx,
		"SELECT published_at FROM graph_versions WHERE workspace = ? AND version = ?",
		request.Workspace,
		request.Version,
	).Scan(&publishedAt); err != nil {
		if err == sql.ErrNoRows {
			return storage.Snapshot{}, fmt.Errorf("roll back graph version: %w", storage.ErrGraphVersionNotFound)
		}
		return storage.Snapshot{}, fmt.Errorf("read rollback graph version: %w", err)
	}
	parsedPublishedAt, err := time.Parse(time.RFC3339Nano, publishedAt)
	if err != nil {
		return storage.Snapshot{}, fmt.Errorf("parse rollback publication time: %w", err)
	}

	if err := deleteLexicalRows(ctx, transaction, request.Workspace, "valid_from_version > ?", "version > ?", request.Version); err != nil {
		return storage.Snapshot{}, err
	}
	if err := deleteContributionRecords(ctx, transaction, request.Workspace, request.Version, "valid_from_version > ?"); err != nil {
		return storage.Snapshot{}, fmt.Errorf("remove rolled back contributions: %w", err)
	}
	if _, err := transaction.ExecContext(ctx,
		"DELETE FROM workspace_nodes WHERE workspace = ? AND version > ?",
		request.Workspace,
		request.Version,
	); err != nil {
		return storage.Snapshot{}, fmt.Errorf("remove rolled back workspace nodes: %w", err)
	}
	if _, err := transaction.ExecContext(ctx,
		"DELETE FROM workspace_edges WHERE workspace = ? AND version > ?",
		request.Workspace,
		request.Version,
	); err != nil {
		return storage.Snapshot{}, fmt.Errorf("remove rolled back workspace edges: %w", err)
	}
	if _, err := transaction.ExecContext(ctx,
		"DELETE FROM catalog_entries WHERE workspace = ? AND version > ?",
		request.Workspace,
		request.Version,
	); err != nil {
		return storage.Snapshot{}, fmt.Errorf("remove rolled back catalog entries: %w", err)
	}
	if _, err := transaction.ExecContext(ctx,
		"DELETE FROM catalog_search WHERE workspace = ? AND version > ?",
		request.Workspace,
		request.Version,
	); err != nil {
		return storage.Snapshot{}, fmt.Errorf("remove rolled back catalog search entries: %w", err)
	}
	if err := deleteCatalogEmbeddingsByVersion(ctx, transaction, request.Workspace, ">", request.Version); err != nil {
		return storage.Snapshot{}, fmt.Errorf("remove rolled back catalog embeddings: %w", err)
	}
	if err := reopenContributionRecords(ctx, transaction, request.Workspace, request.Version); err != nil {
		return storage.Snapshot{}, fmt.Errorf("reopen rolled back contributions: %w", err)
	}
	for _, table := range []string{"catalog_entries", "catalog_embeddings"} {
		if _, err := transaction.ExecContext(ctx, "UPDATE "+table+" SET valid_to_version = NULL WHERE workspace = ? AND valid_to_version >= ?", request.Workspace, request.Version); err != nil {
			return storage.Snapshot{}, fmt.Errorf("reopen rolled back catalog records: %w", err)
		}
	}
	if _, err := transaction.ExecContext(ctx,
		"DELETE FROM graph_versions WHERE workspace = ? AND version > ?",
		request.Workspace,
		request.Version,
	); err != nil {
		return storage.Snapshot{}, fmt.Errorf("remove rolled back graph versions: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return storage.Snapshot{}, fmt.Errorf("commit graph rollback: %w", err)
	}
	store.invalidateWorkspaceCaches(request.Workspace, func(version storage.GraphVersion) bool {
		return version > request.Version
	})

	return storage.Snapshot{Workspace: request.Workspace, Version: request.Version, PublishedAt: parsedPublishedAt}, nil
}

func (store *Store) Prune(ctx context.Context, request storage.PruneRequest) (storage.PruneResult, error) {
	if request.Workspace == "" || request.BeforeVersion == 0 {
		return storage.PruneResult{}, fmt.Errorf("prune graph versions: %w: workspace and retention boundary are required", storage.ErrInvalidRequest)
	}

	transaction, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return storage.PruneResult{}, fmt.Errorf("start graph version pruning: %w", err)
	}
	defer transaction.Rollback()

	result, err := pruneVersions(ctx, transaction, request.Workspace, request.BeforeVersion)
	if err != nil {
		return storage.PruneResult{}, err
	}
	if err := transaction.Commit(); err != nil {
		return storage.PruneResult{}, fmt.Errorf("commit graph version pruning: %w", err)
	}
	store.invalidateWorkspaceCaches(request.Workspace, func(version storage.GraphVersion) bool {
		return version < request.BeforeVersion
	})

	return result, nil
}

func pruneVersions(ctx context.Context, transaction *sql.Tx, workspace string, retainedVersion storage.GraphVersion) (storage.PruneResult, error) {
	var found storage.GraphVersion
	if err := transaction.QueryRowContext(ctx,
		"SELECT version FROM graph_versions WHERE workspace = ? AND version = ?",
		workspace,
		retainedVersion,
	).Scan(&found); err != nil {
		if err == sql.ErrNoRows {
			return storage.PruneResult{}, fmt.Errorf("prune graph versions: %w", storage.ErrGraphVersionNotFound)
		}
		return storage.PruneResult{}, fmt.Errorf("read retention boundary: %w", err)
	}

	var prunedVersions int
	if err := transaction.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM graph_versions WHERE workspace = ? AND version < ?",
		workspace,
		retainedVersion,
	).Scan(&prunedVersions); err != nil {
		return storage.PruneResult{}, fmt.Errorf("count graph versions to prune: %w", err)
	}
	if err := rebaseContributions(ctx, transaction, workspace, retainedVersion); err != nil {
		return storage.PruneResult{}, fmt.Errorf("rebase retained contributions: %w", err)
	}
	if err := deleteLexicalRows(ctx, transaction, workspace, "valid_from_version < ?", "version < ?", retainedVersion); err != nil {
		return storage.PruneResult{}, err
	}
	if err := deleteContributionRecords(ctx, transaction, workspace, retainedVersion, "valid_from_version < ?"); err != nil {
		return storage.PruneResult{}, fmt.Errorf("remove pruned contributions: %w", err)
	}
	if _, err := transaction.ExecContext(ctx,
		"DELETE FROM workspace_nodes WHERE workspace = ? AND version < ?",
		workspace,
		retainedVersion,
	); err != nil {
		return storage.PruneResult{}, fmt.Errorf("remove pruned workspace nodes: %w", err)
	}
	if _, err := transaction.ExecContext(ctx,
		"DELETE FROM workspace_edges WHERE workspace = ? AND version < ?",
		workspace,
		retainedVersion,
	); err != nil {
		return storage.PruneResult{}, fmt.Errorf("remove pruned workspace edges: %w", err)
	}
	if _, err := transaction.ExecContext(ctx,
		"DELETE FROM catalog_entries WHERE workspace = ? AND version < ? AND valid_to_version < ?",
		workspace,
		retainedVersion,
		retainedVersion,
	); err != nil {
		return storage.PruneResult{}, fmt.Errorf("remove pruned catalog entries: %w", err)
	}
	if _, err := transaction.ExecContext(ctx,
		"DELETE FROM catalog_search WHERE workspace = ? AND NOT EXISTS (SELECT 1 FROM catalog_entries AS entry WHERE entry.workspace = catalog_search.workspace AND entry.version = catalog_search.version AND entry.node_id = catalog_search.node_id)",
		workspace,
	); err != nil {
		return storage.PruneResult{}, fmt.Errorf("remove pruned catalog search entries: %w", err)
	}
	if err := deleteCatalogEmbeddingVectors(ctx, transaction, "workspace = ? AND version < ? AND valid_to_version < ?", workspace, retainedVersion, retainedVersion); err != nil {
		return storage.PruneResult{}, fmt.Errorf("remove pruned catalog vectors: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, "DELETE FROM catalog_embeddings WHERE workspace = ? AND version < ? AND valid_to_version < ?", workspace, retainedVersion, retainedVersion); err != nil {
		return storage.PruneResult{}, fmt.Errorf("remove pruned catalog embeddings: %w", err)
	}
	if _, err := transaction.ExecContext(ctx,
		"DELETE FROM graph_versions WHERE workspace = ? AND version < ?",
		workspace,
		retainedVersion,
	); err != nil {
		return storage.PruneResult{}, fmt.Errorf("remove pruned graph versions: %w", err)
	}

	return storage.PruneResult{PrunedVersions: prunedVersions}, nil
}

func graphVersionWasPruned(ctx context.Context, database *sql.DB, workspace string, version storage.GraphVersion) bool {
	var earliestRetained sql.NullInt64
	if err := database.QueryRowContext(ctx,
		"SELECT MIN(version) FROM graph_versions WHERE workspace = ?",
		workspace,
	).Scan(&earliestRetained); err != nil {
		return false
	}
	return earliestRetained.Valid && version > 0 && version < storage.GraphVersion(earliestRetained.Int64)
}

func deleteCatalogEmbeddingsByVersion(ctx context.Context, transaction *sql.Tx, workspace, comparison string, version storage.GraphVersion) error {
	if err := deleteCatalogEmbeddingVectors(ctx, transaction, "workspace = ? AND version "+comparison+" ?", workspace, version); err != nil {
		return err
	}
	if _, err := transaction.ExecContext(ctx, "DELETE FROM catalog_embeddings WHERE workspace = ? AND version "+comparison+" ?", workspace, version); err != nil {
		return fmt.Errorf("remove catalog embeddings: %w", err)
	}
	return nil
}

var contributionTables = []string{
	"file_contributions",
	"contribution_extensions",
	"contribution_nodes",
	"contribution_edges",
	"contribution_catalog_units",
	"contribution_catalog_unit_coverage",
	"contribution_dependencies",
	"contribution_exported_surfaces",
	"contribution_diagnostics",
	"contribution_unresolved_references",
	"contribution_module_bindings",
	"contribution_symbol_references",
}

func closeContributionRecords(ctx context.Context, transaction *sql.Tx, workspace, sourcePath string, version int64) error {
	for _, table := range contributionTables {
		if _, err := transaction.ExecContext(ctx, "UPDATE "+table+" SET valid_to_version = ? WHERE workspace = ? AND source_path = ? AND valid_to_version IS NULL", version, workspace, sourcePath); err != nil {
			return err
		}
	}
	return nil
}

func closeContributionsMissingFromStagedSources(ctx context.Context, transaction *sql.Tx, workspace string, version storage.GraphVersion) error {
	for _, table := range contributionTables {
		if _, err := transaction.ExecContext(ctx, `UPDATE `+table+`
			SET valid_to_version = ?
			WHERE workspace = ? AND valid_to_version IS NULL
				AND NOT EXISTS (
					SELECT 1
					FROM contribution_session_sources AS staged
					WHERE staged.workspace = ?
						AND staged.pending_version = ?
						AND staged.source_path = `+table+`.source_path
				)`, version-1, workspace, workspace, version); err != nil {
			return err
		}
	}
	return nil
}

func deleteContributionRecords(ctx context.Context, transaction *sql.Tx, workspace string, version storage.GraphVersion, condition string) error {
	for _, table := range contributionTables {
		if _, err := transaction.ExecContext(ctx, "DELETE FROM "+table+" WHERE workspace = ? AND "+condition, workspace, version); err != nil {
			return err
		}
	}
	return nil
}

func reopenContributionRecords(ctx context.Context, transaction *sql.Tx, workspace string, version storage.GraphVersion) error {
	for _, table := range contributionTables {
		if _, err := transaction.ExecContext(ctx, "UPDATE "+table+" SET valid_to_version = NULL WHERE workspace = ? AND valid_to_version >= ?", workspace, version); err != nil {
			return err
		}
	}
	return nil
}

func rebaseContributions(ctx context.Context, transaction *sql.Tx, workspace string, retainedVersion storage.GraphVersion) error {
	for _, table := range contributionTables {
		if _, err := transaction.ExecContext(ctx,
			"UPDATE "+table+" SET valid_from_version = ? WHERE workspace = ? AND valid_from_version < ? AND (valid_to_version IS NULL OR valid_to_version >= ?)",
			retainedVersion, workspace, retainedVersion, retainedVersion); err != nil {
			return err
		}
	}
	return nil
}

func (store *Store) readContributionFacts(ctx context.Context, snapshot storage.Snapshot, sourcePath string) (graph.Facts, error) {
	var facts graph.Facts
	if err := appendNodes(ctx, store.database, &facts, `
		SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM contribution_nodes
		WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
		ORDER BY node_id`, snapshot.Workspace, sourcePath, snapshot.Version, snapshot.Version); err != nil {
		return graph.Facts{}, err
	}
	if err := appendEdges(ctx, store.database, &facts, `
		SELECT source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM contribution_edges
		WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
		ORDER BY source_id, target_id, relation`, snapshot.Workspace, sourcePath, snapshot.Version, snapshot.Version); err != nil {
		return graph.Facts{}, err
	}
	return facts, nil
}

func (store *Store) readCatalogUnits(ctx context.Context, snapshot storage.Snapshot, sourcePath string) ([]extractor.CatalogUnit, error) {
	rows, err := store.database.QueryContext(ctx, `
		SELECT node_id, name, kind, owner, signature, comments, identifier_tokens, declaration_source
		FROM contribution_catalog_units
		WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?)
		ORDER BY node_id`, snapshot.Workspace, sourcePath, snapshot.Version, snapshot.Version)
	if err != nil {
		return nil, fmt.Errorf("read contribution catalog units: %w", err)
	}
	defer rows.Close()

	units := make([]extractor.CatalogUnit, 0)
	for rows.Next() {
		var unit extractor.CatalogUnit
		var kind, comments, identifierTokens string
		if err := rows.Scan(&unit.NodeID, &unit.Name, &kind, &unit.Owner, &unit.Signature, &comments, &identifierTokens, &unit.DeclarationSource); err != nil {
			return nil, fmt.Errorf("read contribution catalog unit: %w", err)
		}
		unit.Kind = graph.NodeKind(kind)
		if err := json.Unmarshal([]byte(comments), &unit.Comments); err != nil {
			return nil, fmt.Errorf("read contribution catalog unit comments: %w", err)
		}
		if err := json.Unmarshal([]byte(identifierTokens), &unit.IdentifierTokens); err != nil {
			return nil, fmt.Errorf("read contribution catalog unit identifier tokens: %w", err)
		}
		units = append(units, unit)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate contribution catalog units: %w", err)
	}
	return units, nil
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func (store *Store) readResolutionDataForSource(ctx context.Context, snapshot storage.Snapshot, sourcePath string) (resolutionData, error) {
	return storeResolutionDataForSource(ctx, store.database, snapshot, sourcePath)
}

func storeResolutionDataForSource(ctx context.Context, queries queryer, snapshot storage.Snapshot, sourcePath string) (resolutionData, error) {
	data := resolutionData{}
	extensions, err := readStrings(ctx, queries, `SELECT extension FROM contribution_extensions WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY extension`, snapshot, sourcePath)
	if err != nil {
		return resolutionData{}, err
	}
	data.Metadata.Extensions = extensions

	dependencies, err := readStrings(ctx, queries, `SELECT target_path FROM contribution_dependencies WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY target_path`, snapshot, sourcePath)
	if err != nil {
		return resolutionData{}, err
	}
	for _, targetPath := range dependencies {
		data.Dependencies = append(data.Dependencies, extractor.Dependency{SourcePath: sourcePath, TargetPath: targetPath})
	}
	rows, err := queries.QueryContext(ctx, `SELECT node_id, name FROM contribution_exported_surfaces WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY node_id, name`, snapshot.Workspace, sourcePath, snapshot.Version, snapshot.Version)
	if err != nil {
		return resolutionData{}, fmt.Errorf("read contribution exported surfaces: %w", err)
	}
	for rows.Next() {
		var surface extractor.ExportedSurface
		if err := rows.Scan(&surface.NodeID, &surface.Name); err != nil {
			return resolutionData{}, fmt.Errorf("read contribution exported surfaces: %w", err)
		}
		data.ExportedSurfaces = append(data.ExportedSurfaces, surface)
	}
	if err := rows.Err(); err != nil {
		return resolutionData{}, fmt.Errorf("iterate contribution exported surfaces: %w", err)
	}
	if err := rows.Close(); err != nil {
		return resolutionData{}, fmt.Errorf("close contribution exported surfaces: %w", err)
	}
	if err := readContributionDiagnostics(ctx, queries, snapshot, sourcePath, &data); err != nil {
		return resolutionData{}, err
	}
	if err := readUnresolvedReferences(ctx, queries, snapshot, sourcePath, &data); err != nil {
		return resolutionData{}, err
	}
	if err := readSymbolReferences(ctx, queries, snapshot, sourcePath, &data); err != nil {
		return resolutionData{}, err
	}
	return data, nil
}

func readContributionDiagnostics(ctx context.Context, queries queryer, snapshot storage.Snapshot, sourcePath string, data *resolutionData) error {
	rows, err := queries.QueryContext(ctx, `SELECT severity, message FROM contribution_diagnostics WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY severity, message`, snapshot.Workspace, sourcePath, snapshot.Version, snapshot.Version)
	if err != nil {
		return fmt.Errorf("read contribution diagnostics: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var diagnostic extractor.Diagnostic
		if err := rows.Scan(&diagnostic.Severity, &diagnostic.Message); err != nil {
			return fmt.Errorf("read contribution diagnostics: %w", err)
		}
		data.Diagnostics = append(data.Diagnostics, diagnostic)
	}
	return rows.Err()
}

func readUnresolvedReferences(ctx context.Context, queries queryer, snapshot storage.Snapshot, sourcePath string, data *resolutionData) error {
	rows, err := queries.QueryContext(ctx, `SELECT source_id, target, kind, ambiguous FROM contribution_unresolved_references WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY source_id, target, kind`, snapshot.Workspace, sourcePath, snapshot.Version, snapshot.Version)
	if err != nil {
		return fmt.Errorf("read contribution unresolved references: %w", err)
	}
	references := make([]extractor.UnresolvedReference, 0)
	for rows.Next() {
		var reference extractor.UnresolvedReference
		if err := rows.Scan(&reference.SourceID, &reference.Target, &reference.Kind, &reference.Ambiguous); err != nil {
			return fmt.Errorf("read contribution unresolved references: %w", err)
		}
		references = append(references, reference)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate contribution unresolved references: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close contribution unresolved references: %w", err)
	}
	for _, reference := range references {
		bindings, err := readModuleBindings(ctx, queries, snapshot, sourcePath, reference)
		if err != nil {
			return err
		}
		reference.Bindings = bindings
		data.UnresolvedReferences = append(data.UnresolvedReferences, reference)
	}
	return nil
}

func readModuleBindings(ctx context.Context, queries queryer, snapshot storage.Snapshot, sourcePath string, reference extractor.UnresolvedReference) ([]extractor.ModuleBinding, error) {
	rows, err := queries.QueryContext(ctx, `SELECT imported_name, exported_name, local_name FROM contribution_module_bindings WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) AND source_id = ? AND target = ? AND kind = ? ORDER BY imported_name, exported_name, local_name`, snapshot.Workspace, sourcePath, snapshot.Version, snapshot.Version, reference.SourceID, reference.Target, reference.Kind)
	if err != nil {
		return nil, fmt.Errorf("read contribution module bindings: %w", err)
	}
	defer rows.Close()
	bindings := make([]extractor.ModuleBinding, 0)
	for rows.Next() {
		var binding extractor.ModuleBinding
		if err := rows.Scan(&binding.ImportedName, &binding.ExportedName, &binding.LocalName); err != nil {
			return nil, fmt.Errorf("read contribution module bindings: %w", err)
		}
		bindings = append(bindings, binding)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate contribution module bindings: %w", err)
	}
	return bindings, nil
}

func readSymbolReferences(ctx context.Context, queries queryer, snapshot storage.Snapshot, sourcePath string, data *resolutionData) error {
	rows, err := queries.QueryContext(ctx, `SELECT source_id, target, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence FROM contribution_symbol_references WHERE workspace = ? AND source_path = ? AND valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version >= ?) ORDER BY source_id, target, relation`, snapshot.Workspace, sourcePath, snapshot.Version, snapshot.Version)
	if err != nil {
		return fmt.Errorf("read contribution symbol references: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var reference extractor.SymbolReference
		targets := append([]any{&reference.SourceID, &reference.Target, &reference.Relation}, evidenceScanTargets(&reference.Evidence)...)
		if err := rows.Scan(targets...); err != nil {
			return fmt.Errorf("read contribution symbol references: %w", err)
		}
		data.SymbolReferences = append(data.SymbolReferences, reference)
	}
	return rows.Err()
}

func readStrings(ctx context.Context, queries queryer, query string, snapshot storage.Snapshot, sourcePath string) ([]string, error) {
	rows, err := queries.QueryContext(ctx, query, snapshot.Workspace, sourcePath, snapshot.Version, snapshot.Version)
	if err != nil {
		return nil, fmt.Errorf("read contribution records: %w", err)
	}
	defer rows.Close()
	values := make([]string, 0)
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, fmt.Errorf("read contribution record: %w", err)
		}
		values = append(values, value)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate contribution records: %w", err)
	}
	return values, nil
}

func (store *Store) readFacts(ctx context.Context, snapshot storage.Snapshot) (graph.Facts, error) {
	var facts graph.Facts
	if err := appendNodes(ctx, store.database, &facts, `
		SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM contribution_nodes
		WHERE workspace = ?
			AND valid_from_version <= ?
			AND (valid_to_version IS NULL OR valid_to_version >= ?)
		ORDER BY node_id`, snapshot.Workspace, snapshot.Version, snapshot.Version); err != nil {
		return graph.Facts{}, err
	}
	if err := appendEdges(ctx, store.database, &facts, `
		SELECT source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM contribution_edges
		WHERE workspace = ?
			AND valid_from_version <= ?
			AND (valid_to_version IS NULL OR valid_to_version >= ?)
		ORDER BY source_id, target_id, relation`, snapshot.Workspace, snapshot.Version, snapshot.Version); err != nil {
		return graph.Facts{}, err
	}
	if err := appendNodes(ctx, store.database, &facts, `
		SELECT node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM workspace_nodes
		WHERE workspace = ? AND version = ?
		ORDER BY node_id`, snapshot.Workspace, snapshot.Version); err != nil {
		return graph.Facts{}, err
	}
	if err := appendEdges(ctx, store.database, &facts, `
		SELECT source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence
		FROM workspace_edges
		WHERE workspace = ? AND version = ?
		ORDER BY source_id, target_id, relation`, snapshot.Workspace, snapshot.Version); err != nil {
		return graph.Facts{}, err
	}
	return facts, nil
}

func appendNodes(ctx context.Context, queries queryer, facts *graph.Facts, query string, arguments ...any) error {
	rows, err := queries.QueryContext(ctx, query, arguments...)
	if err != nil {
		return fmt.Errorf("read workspace graph nodes: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var node graph.Node
		targets := append([]any{&node.ID, &node.Kind, &node.Label, &node.QualifiedName}, evidenceScanTargets(&node.Evidence)...)
		if err := rows.Scan(targets...); err != nil {
			return fmt.Errorf("read workspace graph nodes: %w", err)
		}
		facts.Nodes = append(facts.Nodes, node)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate workspace graph nodes: %w", err)
	}
	return nil
}

func appendEdges(ctx context.Context, queries queryer, facts *graph.Facts, query string, arguments ...any) error {
	rows, err := queries.QueryContext(ctx, query, arguments...)
	if err != nil {
		return fmt.Errorf("read graph edges: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var edge graph.Edge
		targets := append([]any{&edge.SourceID, &edge.TargetID, &edge.Relation}, evidenceScanTargets(&edge.Evidence)...)
		if err := rows.Scan(targets...); err != nil {
			return fmt.Errorf("read graph edges: %w", err)
		}
		facts.Edges = append(facts.Edges, edge)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate graph edges: %w", err)
	}
	return nil
}

func evidenceScanTargets(evidence *graph.FactEvidence) []any {
	return []any{
		&evidence.Span.Path,
		&evidence.Span.StartLine,
		&evidence.Span.StartColumn,
		&evidence.Span.EndLine,
		&evidence.Span.EndColumn,
		&evidence.FileHash,
		&evidence.Extractor,
		&evidence.Provenance,
		&evidence.Confidence,
	}
}

func traversalNeighbor(nodeID string, edge graph.Edge, direction storage.TraversalDirection) (string, bool) {
	if (direction == storage.TraverseOutgoing || direction == storage.TraverseBoth) && edge.SourceID == nodeID {
		return edge.TargetID, true
	}
	if (direction == storage.TraverseIncoming || direction == storage.TraverseBoth) && edge.TargetID == nodeID {
		return edge.SourceID, true
	}
	return "", false
}

func scopedNodeIDs(projectIDs []string, edges []graph.Edge) map[string]struct{} {
	if len(projectIDs) == 0 {
		return nil
	}

	children := make(map[string][]string)
	for _, edge := range edges {
		if edge.Relation == "contains" {
			children[edge.SourceID] = append(children[edge.SourceID], edge.TargetID)
		}
	}
	for nodeID := range children {
		sort.Strings(children[nodeID])
	}

	scoped := make(map[string]struct{})
	frontier := append([]string(nil), projectIDs...)
	sort.Strings(frontier)
	for len(frontier) > 0 {
		nodeID := frontier[0]
		frontier = frontier[1:]
		if _, found := scoped[nodeID]; found {
			continue
		}
		scoped[nodeID] = struct{}{}
		frontier = append(frontier, children[nodeID]...)
	}
	return scoped
}

func hasTraversableNeighbor(edges []graph.Edge, nodeID string, direction storage.TraversalDirection, relations map[graph.RelationKind]struct{}, selectedNodes map[string]graph.Node) bool {
	for _, edge := range edges {
		if len(relations) > 0 {
			if _, includesRelation := relations[edge.Relation]; !includesRelation {
				continue
			}
		}
		neighborID, traversesEdge := traversalNeighbor(nodeID, edge, direction)
		if traversesEdge {
			if _, selected := selectedNodes[neighborID]; !selected {
				return true
			}
		}
	}
	return false
}

func addTruncationReason(reasons []storage.TruncationReason, reason storage.TruncationReason) []storage.TruncationReason {
	for _, existing := range reasons {
		if existing == reason {
			return reasons
		}
	}
	return append(reasons, reason)
}

func sortedNodes(nodesByID map[string]graph.Node) []graph.Node {
	nodes := make([]graph.Node, 0, len(nodesByID))
	for _, node := range nodesByID {
		nodes = append(nodes, node)
	}
	sort.Slice(nodes, func(left, right int) bool {
		return nodes[left].ID < nodes[right].ID
	})
	return nodes
}

func sortedEdges(edgesByKey map[string]graph.Edge) []graph.Edge {
	edges := make([]graph.Edge, 0, len(edgesByKey))
	for _, edge := range edgesByKey {
		edges = append(edges, edge)
	}
	sort.Slice(edges, func(left, right int) bool {
		return edgeKey(edges[left]) < edgeKey(edges[right])
	})
	return edges
}

func edgeKey(edge graph.Edge) string {
	return edge.SourceID + "\x00" + edge.TargetID + "\x00" + string(edge.Relation)
}

func uniqueSortedStrings(values []string) []string {
	unique := make(map[string]struct{}, len(values))
	for _, value := range values {
		unique[value] = struct{}{}
	}
	sortedValues := make([]string, 0, len(unique))
	for value := range unique {
		sortedValues = append(sortedValues, value)
	}
	sort.Strings(sortedValues)
	return sortedValues
}

type encodedContribution struct {
	projectID            string
	sourcePath           string
	metadata             extractor.Metadata
	graphFacts           graph.Facts
	catalogUnits         []extractor.CatalogUnit
	catalogUnitsOmitted  bool
	unresolvedReferences []extractor.UnresolvedReference
	symbolReferences     []extractor.SymbolReference
	exportedSurfaces     []extractor.ExportedSurface
	dependencies         []extractor.Dependency
	diagnostics          []extractor.Diagnostic
}

type resolutionData struct {
	Metadata             extractor.Metadata              `json:"metadata"`
	UnresolvedReferences []extractor.UnresolvedReference `json:"unresolvedReferences"`
	SymbolReferences     []extractor.SymbolReference     `json:"symbolReferences"`
	ExportedSurfaces     []extractor.ExportedSurface     `json:"exportedSurfaces"`
	Dependencies         []extractor.Dependency          `json:"dependencies"`
	Diagnostics          []extractor.Diagnostic          `json:"diagnostics"`
}

func encodeContributions(update extractor.GraphUpdate) ([]encodedContribution, error) {
	contributions := update.Contributions()
	encoded := make([]encodedContribution, 0, len(contributions))
	sourcePaths := make(map[string]struct{}, len(contributions))
	for _, contribution := range contributions {
		sourcePath := contribution.SourcePath()
		if _, exists := sourcePaths[sourcePath]; exists {
			return nil, fmt.Errorf("publish graph update: %w: duplicate source path %q", storage.ErrInvalidRequest, sourcePath)
		}
		sourcePaths[sourcePath] = struct{}{}

		encoded = append(encoded, encodedContribution{
			projectID:            contribution.ProjectID(),
			sourcePath:           sourcePath,
			metadata:             contribution.Metadata(),
			graphFacts:           contribution.Facts(),
			catalogUnits:         contribution.CatalogUnits(),
			catalogUnitsOmitted:  contribution.CatalogUnitsOmitted(),
			unresolvedReferences: contribution.UnresolvedReferences(),
			symbolReferences:     contribution.SymbolReferences(),
			exportedSurfaces:     contribution.ExportedSurfaces(),
			dependencies:         contribution.Dependencies(),
			diagnostics:          contribution.Diagnostics(),
		})
	}
	return encoded, nil
}

func storeWorkspaceFacts(ctx context.Context, transaction *sql.Tx, variableLimit int, limits factBatchLimits, workspace string, version storage.GraphVersion, facts graph.Facts, reportWriteMeasurement func(storage.PublishMeasurement)) error {
	nodesStarted := time.Now()
	nodeRows := make([][]any, 0, limits.maximumRows)
	nodeBytes := 0
	for _, node := range facts.Nodes {
		row := append([]any{workspace, version, node.ID, node.Kind, node.Label, node.QualifiedName}, evidenceValues(node.Evidence)...)
		rowBytes := estimateRowsBytes([][]any{row})
		if limits.maximumBytes > 0 && rowBytes > limits.maximumBytes {
			return fmt.Errorf("store workspace nodes: workspace fact exceeds %d byte limit", limits.maximumBytes)
		}
		if len(nodeRows) > 0 && (limits.maximumRows > 0 && len(nodeRows) >= limits.maximumRows || limits.maximumBytes > 0 && nodeBytes+rowBytes > limits.maximumBytes) {
			if err := insertRows(ctx, transaction, variableLimit, maximumBatchRows, "INSERT OR IGNORE INTO workspace_nodes (workspace, version, node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence) VALUES ", nodeRows); err != nil {
				return fmt.Errorf("store workspace nodes: %w", err)
			}
			nodeRows = nodeRows[:0]
			nodeBytes = 0
		}
		nodeRows = append(nodeRows, row)
		nodeBytes += rowBytes
	}
	if len(nodeRows) > 0 {
		if err := insertRows(ctx, transaction, variableLimit, maximumBatchRows, "INSERT OR IGNORE INTO workspace_nodes (workspace, version, node_id, kind, label, qualified_name, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence) VALUES ", nodeRows); err != nil {
			return fmt.Errorf("store workspace nodes: %w", err)
		}
	}
	if len(facts.Nodes) == 0 {
		if reportWriteMeasurement != nil {
			reportWriteMeasurement(storage.PublishMeasurement{Name: "workspace_nodes", NotApplicable: true})
		}
	} else {
		reportPublishMeasurement(reportWriteMeasurement, "workspace_nodes", time.Since(nodesStarted))
	}
	edgesStarted := time.Now()
	edgeRows := make([][]any, 0, limits.maximumRows)
	edgeBytes := 0
	for _, edge := range facts.Edges {
		row := append([]any{workspace, version, edge.SourceID, edge.TargetID, edge.Relation}, evidenceValues(edge.Evidence)...)
		row = append(row, edge.Evidence.Span.Path)
		rowBytes := estimateRowsBytes([][]any{row})
		if limits.maximumBytes > 0 && rowBytes > limits.maximumBytes {
			return fmt.Errorf("store workspace edges: workspace fact exceeds %d byte limit", limits.maximumBytes)
		}
		if len(edgeRows) > 0 && (limits.maximumRows > 0 && len(edgeRows) >= limits.maximumRows || limits.maximumBytes > 0 && edgeBytes+rowBytes > limits.maximumBytes) {
			if err := insertRows(ctx, transaction, variableLimit, maximumBatchRows, "INSERT OR IGNORE INTO workspace_edges (workspace, version, source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence, resolved_fact_owner) VALUES ", edgeRows); err != nil {
				return fmt.Errorf("store workspace edges: %w", err)
			}
			edgeRows = edgeRows[:0]
			edgeBytes = 0
		}
		edgeRows = append(edgeRows, row)
		edgeBytes += rowBytes
	}
	if len(edgeRows) > 0 {
		if err := insertRows(ctx, transaction, variableLimit, maximumBatchRows, "INSERT OR IGNORE INTO workspace_edges (workspace, version, source_id, target_id, relation, span_path, start_line, start_column, end_line, end_column, file_hash, extractor, provenance, confidence, resolved_fact_owner) VALUES ", edgeRows); err != nil {
			return fmt.Errorf("store workspace edges: %w", err)
		}
	}
	if len(facts.Edges) == 0 {
		if reportWriteMeasurement != nil {
			reportWriteMeasurement(storage.PublishMeasurement{Name: "workspace_edges", NotApplicable: true})
		}
	} else {
		reportPublishMeasurement(reportWriteMeasurement, "workspace_edges", time.Since(edgesStarted))
	}
	return nil
}

func estimateRowsBytes(rows [][]any) int {
	return estimateContributionRowsBytes([][][]any{rows})
}

func evidenceValues(evidence graph.FactEvidence) []any {
	return []any{evidence.Span.Path, evidence.Span.StartLine, evidence.Span.StartColumn, evidence.Span.EndLine, evidence.Span.EndColumn, evidence.FileHash, evidence.Extractor, evidence.Provenance, evidence.Confidence}
}

func migrate(ctx context.Context, database *sql.DB) error {
	variableLimit, err := sqliteVariableLimit(ctx, database)
	if err != nil {
		return err
	}
	transaction, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("start SQLite migration: %w", err)
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, "PRAGMA auto_vacuum = INCREMENTAL"); err != nil {
		return fmt.Errorf("enable SQLite incremental auto-vacuum: %w", err)
	}

	if _, err := transaction.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL
		)`); err != nil {
		return fmt.Errorf("create SQLite migration table: %w", err)
	}

	var version int
	if err := transaction.QueryRowContext(ctx, "SELECT COALESCE(MAX(version), 0) FROM schema_migrations").Scan(&version); err != nil {
		return fmt.Errorf("read SQLite schema version: %w", err)
	}
	if version != 0 && version != 10 && version != 11 && version != 12 && version != 13 && version != 14 && version != 15 && version != 16 && version != 17 && version != 18 && version != 19 && version != 20 && version != 21 && version != 22 && version != 23 && version != 24 && version != 25 && version != 26 && version != CurrentSchemaVersion {
		return fmt.Errorf("%w: found version %d, need version %d", errSchemaMismatch, version, CurrentSchemaVersion)
	}

	if version == 0 {
		if _, err := transaction.ExecContext(ctx, `
			CREATE TABLE graph_versions (workspace TEXT NOT NULL, version INTEGER NOT NULL, published_at TEXT NOT NULL, PRIMARY KEY (workspace, version));
			CREATE TABLE file_contributions (workspace TEXT NOT NULL, source_path TEXT NOT NULL, valid_from_version INTEGER NOT NULL, valid_to_version INTEGER, project_id TEXT NOT NULL, extractor_name TEXT NOT NULL, extractor_version TEXT NOT NULL, PRIMARY KEY (workspace, source_path, valid_from_version));
			CREATE TABLE contribution_extensions (workspace TEXT NOT NULL, source_path TEXT NOT NULL, valid_from_version INTEGER NOT NULL, valid_to_version INTEGER, extension TEXT NOT NULL, PRIMARY KEY (workspace, source_path, valid_from_version, extension));
			CREATE TABLE contribution_nodes (workspace TEXT NOT NULL, source_path TEXT NOT NULL, valid_from_version INTEGER NOT NULL, valid_to_version INTEGER, node_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, qualified_name TEXT NOT NULL, span_path TEXT NOT NULL, start_line INTEGER NOT NULL, start_column INTEGER NOT NULL, end_line INTEGER NOT NULL, end_column INTEGER NOT NULL, file_hash TEXT NOT NULL, extractor TEXT NOT NULL, provenance TEXT NOT NULL, confidence TEXT NOT NULL, PRIMARY KEY (workspace, source_path, valid_from_version, node_id));
			CREATE TABLE contribution_edges (workspace TEXT NOT NULL, source_path TEXT NOT NULL, valid_from_version INTEGER NOT NULL, valid_to_version INTEGER, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, span_path TEXT NOT NULL, start_line INTEGER NOT NULL, start_column INTEGER NOT NULL, end_line INTEGER NOT NULL, end_column INTEGER NOT NULL, file_hash TEXT NOT NULL, extractor TEXT NOT NULL, provenance TEXT NOT NULL, confidence TEXT NOT NULL, PRIMARY KEY (workspace, source_path, valid_from_version, source_id, target_id, relation));
			CREATE TABLE contribution_catalog_units (workspace TEXT NOT NULL, source_path TEXT NOT NULL, valid_from_version INTEGER NOT NULL, valid_to_version INTEGER, node_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, signature TEXT NOT NULL, comments TEXT NOT NULL, identifier_tokens TEXT NOT NULL, declaration_source TEXT NOT NULL DEFAULT '', PRIMARY KEY (workspace, source_path, valid_from_version, node_id));
			CREATE INDEX contribution_catalog_units_node ON contribution_catalog_units (workspace, node_id, valid_from_version, valid_to_version);
			CREATE TABLE contribution_catalog_unit_coverage (workspace TEXT NOT NULL, source_path TEXT NOT NULL, valid_from_version INTEGER NOT NULL, valid_to_version INTEGER, PRIMARY KEY (workspace, source_path, valid_from_version));
			CREATE TABLE contribution_dependencies (workspace TEXT NOT NULL, source_path TEXT NOT NULL, valid_from_version INTEGER NOT NULL, valid_to_version INTEGER, target_path TEXT NOT NULL, PRIMARY KEY (workspace, source_path, valid_from_version, target_path));
			CREATE TABLE contribution_exported_surfaces (workspace TEXT NOT NULL, source_path TEXT NOT NULL, valid_from_version INTEGER NOT NULL, valid_to_version INTEGER, node_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (workspace, source_path, valid_from_version, node_id, name));
			CREATE TABLE contribution_diagnostics (workspace TEXT NOT NULL, source_path TEXT NOT NULL, valid_from_version INTEGER NOT NULL, valid_to_version INTEGER, severity TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY (workspace, source_path, valid_from_version, severity, message));
			CREATE TABLE contribution_unresolved_references (workspace TEXT NOT NULL, source_path TEXT NOT NULL, valid_from_version INTEGER NOT NULL, valid_to_version INTEGER, source_id TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, ambiguous INTEGER NOT NULL, PRIMARY KEY (workspace, source_path, valid_from_version, source_id, target, kind));
			CREATE TABLE contribution_module_bindings (workspace TEXT NOT NULL, source_path TEXT NOT NULL, valid_from_version INTEGER NOT NULL, valid_to_version INTEGER, source_id TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, imported_name TEXT NOT NULL, exported_name TEXT NOT NULL, local_name TEXT NOT NULL, PRIMARY KEY (workspace, source_path, valid_from_version, source_id, target, kind, imported_name, exported_name, local_name));
			CREATE TABLE contribution_symbol_references (workspace TEXT NOT NULL, source_path TEXT NOT NULL, valid_from_version INTEGER NOT NULL, valid_to_version INTEGER, source_id TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL, span_path TEXT NOT NULL, start_line INTEGER NOT NULL, start_column INTEGER NOT NULL, end_line INTEGER NOT NULL, end_column INTEGER NOT NULL, file_hash TEXT NOT NULL, extractor TEXT NOT NULL, provenance TEXT NOT NULL, confidence TEXT NOT NULL, PRIMARY KEY (workspace, source_path, valid_from_version, source_id, target, relation));
			CREATE TABLE workspace_nodes (workspace TEXT NOT NULL, version INTEGER NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, qualified_name TEXT NOT NULL, span_path TEXT NOT NULL, start_line INTEGER NOT NULL, start_column INTEGER NOT NULL, end_line INTEGER NOT NULL, end_column INTEGER NOT NULL, file_hash TEXT NOT NULL, extractor TEXT NOT NULL, provenance TEXT NOT NULL, confidence TEXT NOT NULL, PRIMARY KEY (workspace, version, node_id));
			CREATE TABLE workspace_edges (workspace TEXT NOT NULL, version INTEGER NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, span_path TEXT NOT NULL, start_line INTEGER NOT NULL, start_column INTEGER NOT NULL, end_line INTEGER NOT NULL, end_column INTEGER NOT NULL, file_hash TEXT NOT NULL, extractor TEXT NOT NULL, provenance TEXT NOT NULL, confidence TEXT NOT NULL, resolved_fact_owner TEXT NOT NULL, PRIMARY KEY (workspace, version, source_id, target_id, relation));
			CREATE VIRTUAL TABLE node_search USING fts5(label, qualified_name, span_path, kind, identifier_tokens, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2');
			CREATE TABLE catalog_entries (workspace TEXT NOT NULL, version INTEGER NOT NULL, valid_to_version INTEGER, unit_input TEXT NOT NULL DEFAULT '', node_id TEXT NOT NULL, name TEXT NOT NULL, input_fingerprint TEXT NOT NULL, deterministic_synopsis TEXT NOT NULL, copilot_synopsis TEXT NOT NULL, ollama_synopsis TEXT NOT NULL, claude_synopsis TEXT NOT NULL, PRIMARY KEY (workspace, version, node_id));
			CREATE INDEX catalog_entries_visible ON catalog_entries (workspace, node_id, version, valid_to_version);
			CREATE VIRTUAL TABLE catalog_search USING fts5(workspace UNINDEXED, version UNINDEXED, node_id UNINDEXED, name, deterministic_synopsis, copilot_synopsis, ollama_synopsis, claude_synopsis, tokenize = 'unicode61 remove_diacritics 2');
			CREATE TABLE catalog_embeddings (embedding_id INTEGER PRIMARY KEY, workspace TEXT NOT NULL, version INTEGER NOT NULL, valid_to_version INTEGER, node_id TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL, UNIQUE (workspace, version, node_id, source));
			CREATE INDEX catalog_embeddings_visible ON catalog_embeddings (workspace, node_id, source, version, valid_to_version);
			CREATE TABLE catalog_tasks (workspace TEXT PRIMARY KEY, graph_version INTEGER NOT NULL, state TEXT NOT NULL, process_id INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT, completed_units INTEGER NOT NULL, total_units INTEGER NOT NULL, stage TEXT NOT NULL DEFAULT '', changed_paths TEXT NOT NULL, failure TEXT NOT NULL);
			CREATE TABLE copilot_planner_metrics (metric_id INTEGER PRIMARY KEY, recorded_at TEXT NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL, max_ai_credits INTEGER NOT NULL, outcome TEXT NOT NULL, duration_ns INTEGER NOT NULL, prompt_bytes INTEGER NOT NULL, response_bytes INTEGER NOT NULL, output_tokens INTEGER, output_tokens_availability TEXT NOT NULL, output_tokens_estimate_method TEXT NOT NULL, session_total_nano_aiu INTEGER, session_total_nano_aiu_availability TEXT NOT NULL, session_total_nano_aiu_estimate_method TEXT NOT NULL, actual_model TEXT NOT NULL DEFAULT '', input_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, premium_request_credits INTEGER, user_requests INTEGER, api_duration_ms INTEGER);
			CREATE INDEX copilot_planner_metrics_daily ON copilot_planner_metrics (day, model, max_ai_credits);
			CREATE TABLE claude_planner_metrics (metric_id INTEGER PRIMARY KEY, recorded_at TEXT NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL, actual_model TEXT NOT NULL, fallback_model TEXT NOT NULL, max_budget_usd REAL NOT NULL, effort TEXT NOT NULL, outcome TEXT NOT NULL, duration_ns INTEGER NOT NULL, prompt_bytes INTEGER NOT NULL, response_bytes INTEGER NOT NULL, input_tokens INTEGER, input_tokens_availability TEXT NOT NULL, output_tokens INTEGER, output_tokens_availability TEXT NOT NULL, api_duration_ms INTEGER, api_duration_ms_availability TEXT NOT NULL, cost_usd REAL, cost_usd_availability TEXT NOT NULL);
			CREATE INDEX claude_planner_metrics_daily ON claude_planner_metrics (day, model, effort);
			CREATE TABLE spending_reservations (reservation_id INTEGER PRIMARY KEY, recorded_at TEXT NOT NULL, provider TEXT NOT NULL, unit TEXT NOT NULL, amount REAL NOT NULL);
			CREATE INDEX spending_reservations_usage ON spending_reservations (provider, unit, recorded_at);
			CREATE INDEX contribution_dependencies_visible ON contribution_dependencies (workspace, target_path, valid_from_version, valid_to_version);
		`); err != nil {
			return fmt.Errorf("create SQLite normalized graph tables: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", CurrentSchemaVersion, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record SQLite schema version: %w", err)
		}
	}
	if version == 10 {
		var graphVersionsTable string
		if err := transaction.QueryRowContext(ctx, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'graph_versions'").Scan(&graphVersionsTable); err != nil {
			if err == sql.ErrNoRows {
				return fmt.Errorf("%w: version 10 database has no graph tables", errSchemaMismatch)
			}
			return fmt.Errorf("inspect version 10 SQLite schema: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, `CREATE VIRTUAL TABLE node_search USING fts5(workspace UNINDEXED, version UNINDEXED, node_id UNINDEXED, label, qualified_name, span_path, kind, identifier_tokens, tokenize = 'unicode61 remove_diacritics 2')`); err != nil {
			return fmt.Errorf("create SQLite lexical index: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 11, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record SQLite lexical migration: %w", err)
		}
		version = 11
	}
	if version == 11 {
		if _, err := transaction.ExecContext(ctx, `
			CREATE TABLE catalog_entries (workspace TEXT NOT NULL, version INTEGER NOT NULL, node_id TEXT NOT NULL, name TEXT NOT NULL, deterministic_synopsis TEXT NOT NULL, copilot_synopsis TEXT NOT NULL, ollama_synopsis TEXT NOT NULL DEFAULT '', claude_synopsis TEXT NOT NULL DEFAULT '', PRIMARY KEY (workspace, version, node_id));
			CREATE VIRTUAL TABLE catalog_search USING fts5(workspace UNINDEXED, version UNINDEXED, node_id UNINDEXED, name, deterministic_synopsis, copilot_synopsis, ollama_synopsis, claude_synopsis, tokenize = 'unicode61 remove_diacritics 2')`); err != nil {
			return fmt.Errorf("create SQLite catalog tables: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 12, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record SQLite catalog migration: %w", err)
		}
		version = 12
	}
	if version == 12 {
		if _, err := transaction.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS catalog_embeddings (embedding_id INTEGER PRIMARY KEY, workspace TEXT NOT NULL, version INTEGER NOT NULL, node_id TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL, UNIQUE (workspace, version, node_id, source))"); err != nil {
			return fmt.Errorf("create SQLite catalog embedding table: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 13, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record SQLite catalog embedding migration: %w", err)
		}
		version = 13
	}
	if version == 13 {
		rows, err := transaction.QueryContext(ctx, "SELECT DISTINCT workspace, version FROM catalog_embeddings")
		if err != nil {
			return fmt.Errorf("read catalog snapshots for vector index: %w", err)
		}
		snapshots := make([]storage.Snapshot, 0)
		for rows.Next() {
			var snapshot storage.Snapshot
			if err := rows.Scan(&snapshot.Workspace, &snapshot.Version); err != nil {
				_ = rows.Close()
				return fmt.Errorf("read catalog snapshot for vector index: %w", err)
			}
			snapshots = append(snapshots, snapshot)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close catalog snapshots for vector index: %w", err)
		}
		for _, snapshot := range snapshots {
			if err := copyCatalogEmbeddingVectors(ctx, transaction, snapshot); err != nil {
				return err
			}
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 14, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record SQLite catalog vector migration: %w", err)
		}
		version = 14
	}
	if version == 14 {
		if _, err := transaction.ExecContext(ctx, `
			CREATE TABLE IF NOT EXISTS copilot_planner_metrics (metric_id INTEGER PRIMARY KEY, recorded_at TEXT NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL, max_ai_credits INTEGER NOT NULL, outcome TEXT NOT NULL, duration_ns INTEGER NOT NULL, prompt_bytes INTEGER NOT NULL, response_bytes INTEGER NOT NULL, output_tokens INTEGER, output_tokens_availability TEXT NOT NULL, output_tokens_estimate_method TEXT NOT NULL, session_total_nano_aiu INTEGER, session_total_nano_aiu_availability TEXT NOT NULL, session_total_nano_aiu_estimate_method TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS copilot_planner_metrics_daily ON copilot_planner_metrics (day, model, max_ai_credits)`); err != nil {
			return fmt.Errorf("create Copilot planner metrics table: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 15, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record Copilot planner metrics migration: %w", err)
		}
		version = 15
	}
	if version == 15 {
		for _, migration := range []struct {
			column    string
			statement string
		}{
			{"actual_model", "ALTER TABLE copilot_planner_metrics ADD COLUMN actual_model TEXT NOT NULL DEFAULT ''"},
			{"input_tokens", "ALTER TABLE copilot_planner_metrics ADD COLUMN input_tokens INTEGER"},
			{"cache_read_tokens", "ALTER TABLE copilot_planner_metrics ADD COLUMN cache_read_tokens INTEGER"},
			{"cache_write_tokens", "ALTER TABLE copilot_planner_metrics ADD COLUMN cache_write_tokens INTEGER"},
			{"reasoning_tokens", "ALTER TABLE copilot_planner_metrics ADD COLUMN reasoning_tokens INTEGER"},
			{"premium_request_credits", "ALTER TABLE copilot_planner_metrics ADD COLUMN premium_request_credits INTEGER"},
			{"user_requests", "ALTER TABLE copilot_planner_metrics ADD COLUMN user_requests INTEGER"},
			{"api_duration_ms", "ALTER TABLE copilot_planner_metrics ADD COLUMN api_duration_ms INTEGER"},
		} {
			_, err := addColumnIfMissing(ctx, transaction, "copilot_planner_metrics", migration.column, migration.statement)
			if err != nil {
				return fmt.Errorf("add Copilot planner usage column: %w", err)
			}
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 16, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record Copilot planner usage migration: %w", err)
		}
		version = 16
	}
	if version == 16 {
		if _, err := transaction.ExecContext(ctx, `
			CREATE TABLE IF NOT EXISTS claude_planner_metrics (metric_id INTEGER PRIMARY KEY, recorded_at TEXT NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL, actual_model TEXT NOT NULL, fallback_model TEXT NOT NULL, max_budget_usd REAL NOT NULL, effort TEXT NOT NULL, outcome TEXT NOT NULL, duration_ns INTEGER NOT NULL, prompt_bytes INTEGER NOT NULL, response_bytes INTEGER NOT NULL, input_tokens INTEGER, input_tokens_availability TEXT NOT NULL, output_tokens INTEGER, output_tokens_availability TEXT NOT NULL, api_duration_ms INTEGER, api_duration_ms_availability TEXT NOT NULL, cost_usd REAL, cost_usd_availability TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS claude_planner_metrics_daily ON claude_planner_metrics (day, model, effort)`); err != nil {
			return fmt.Errorf("create Claude planner metrics table: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 17, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record Claude planner metrics migration: %w", err)
		}
		version = 17
	}
	if version == 17 {
		if _, err := transaction.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS catalog_tasks (workspace TEXT PRIMARY KEY, graph_version INTEGER NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, completed_units INTEGER NOT NULL, total_units INTEGER NOT NULL, changed_paths TEXT NOT NULL, failure TEXT NOT NULL)"); err != nil {
			return fmt.Errorf("create catalog task table: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 18, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record catalog task migration: %w", err)
		}
		version = 18
	}
	if version == 18 {
		if _, err := transaction.ExecContext(ctx, `
			CREATE TABLE IF NOT EXISTS contribution_catalog_units (workspace TEXT NOT NULL, source_path TEXT NOT NULL, valid_from_version INTEGER NOT NULL, valid_to_version INTEGER, node_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, signature TEXT NOT NULL, comments TEXT NOT NULL, identifier_tokens TEXT NOT NULL, PRIMARY KEY (workspace, source_path, valid_from_version, node_id));
			CREATE TABLE IF NOT EXISTS contribution_catalog_unit_coverage (workspace TEXT NOT NULL, source_path TEXT NOT NULL, valid_from_version INTEGER NOT NULL, valid_to_version INTEGER, PRIMARY KEY (workspace, source_path, valid_from_version));
		`); err != nil {
			return fmt.Errorf("create contribution catalog units table: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 19, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record contribution catalog units migration: %w", err)
		}
		version = 19
	}
	if version == 19 {
		for _, migration := range []struct {
			column    string
			statement string
		}{
			{"ollama_synopsis", "ALTER TABLE catalog_entries ADD COLUMN ollama_synopsis TEXT NOT NULL DEFAULT ''"},
			{"claude_synopsis", "ALTER TABLE catalog_entries ADD COLUMN claude_synopsis TEXT NOT NULL DEFAULT ''"},
		} {
			if _, err := addColumnIfMissing(ctx, transaction, "catalog_entries", migration.column, migration.statement); err != nil {
				return fmt.Errorf("add catalog synopsis provider column: %w", err)
			}
		}
		if _, err := transaction.ExecContext(ctx, "DROP TABLE catalog_search"); err != nil {
			return fmt.Errorf("replace SQLite catalog lexical index: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, `CREATE VIRTUAL TABLE catalog_search USING fts5(workspace UNINDEXED, version UNINDEXED, node_id UNINDEXED, name, deterministic_synopsis, copilot_synopsis, ollama_synopsis, claude_synopsis, tokenize = 'unicode61 remove_diacritics 2')`); err != nil {
			return fmt.Errorf("create SQLite catalog lexical index: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO catalog_search (workspace, version, node_id, name, deterministic_synopsis, copilot_synopsis, ollama_synopsis, claude_synopsis)
			SELECT workspace, version, node_id, name, deterministic_synopsis, copilot_synopsis, ollama_synopsis, claude_synopsis
			FROM catalog_entries`); err != nil {
			return fmt.Errorf("rebuild SQLite catalog lexical index: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 20, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record catalog synopsis provider migration: %w", err)
		}
		version = 20
	}
	if version == 20 {
		if _, err := transaction.ExecContext(ctx, `
			CREATE TABLE IF NOT EXISTS spending_reservations (reservation_id INTEGER PRIMARY KEY, recorded_at TEXT NOT NULL, provider TEXT NOT NULL, unit TEXT NOT NULL, amount REAL NOT NULL);
			CREATE INDEX IF NOT EXISTS spending_reservations_usage ON spending_reservations (provider, unit, recorded_at)`); err != nil {
			return fmt.Errorf("create spending reservation table: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 21, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record spending reservation migration: %w", err)
		}
		version = 21
	}
	if version == 21 {
		if _, err := addColumnIfMissing(ctx, transaction, "catalog_entries", "input_fingerprint", "ALTER TABLE catalog_entries ADD COLUMN input_fingerprint TEXT NOT NULL DEFAULT ''"); err != nil {
			return fmt.Errorf("add catalog input fingerprint column: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 22, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record catalog input fingerprint migration: %w", err)
		}
		version = 22
	}
	if version == 22 {
		if _, err := addColumnIfMissing(ctx, transaction, "catalog_tasks", "process_id", "ALTER TABLE catalog_tasks ADD COLUMN process_id INTEGER NOT NULL DEFAULT 0"); err != nil {
			return fmt.Errorf("add catalog process ID column: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 23, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record catalog process ID migration: %w", err)
		}
		version = 23
	}
	if version == 23 {
		if _, err := addColumnIfMissing(ctx, transaction, "catalog_tasks", "stage", "ALTER TABLE catalog_tasks ADD COLUMN stage TEXT NOT NULL DEFAULT ''"); err != nil {
			return fmt.Errorf("add catalog task stage column: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 24, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record catalog task stage migration: %w", err)
		}
		version = 24
	}
	if version == 24 {
		if _, err := addColumnIfMissing(ctx, transaction, "contribution_catalog_units", "declaration_source", "ALTER TABLE contribution_catalog_units ADD COLUMN declaration_source TEXT NOT NULL DEFAULT ''"); err != nil {
			return fmt.Errorf("add catalog declaration source column: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 25, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record catalog declaration source migration: %w", err)
		}
		version = 25
	}
	if version == 25 {
		for _, column := range []struct {
			table, name, statement string
		}{
			{"catalog_entries", "valid_to_version", "ALTER TABLE catalog_entries ADD COLUMN valid_to_version INTEGER"},
			{"catalog_entries", "unit_input", "ALTER TABLE catalog_entries ADD COLUMN unit_input TEXT NOT NULL DEFAULT ''"},
			{"catalog_embeddings", "valid_to_version", "ALTER TABLE catalog_embeddings ADD COLUMN valid_to_version INTEGER"},
		} {
			if _, err := addColumnIfMissing(ctx, transaction, column.table, column.name, column.statement); err != nil {
				return fmt.Errorf("add catalog validity column: %w", err)
			}
		}
		if _, err := transaction.ExecContext(ctx, `
			UPDATE catalog_entries SET unit_input = COALESCE((
				SELECT json_array(unit.name, unit.kind, unit.owner, unit.signature, unit.comments, unit.identifier_tokens, unit.declaration_source)
				FROM contribution_catalog_units AS unit
				WHERE unit.workspace = catalog_entries.workspace AND unit.node_id = catalog_entries.node_id
					AND unit.valid_from_version <= catalog_entries.version
					AND (unit.valid_to_version IS NULL OR unit.valid_to_version >= catalog_entries.version)
				LIMIT 1), '');
			UPDATE catalog_entries SET valid_to_version = (
				SELECT MIN(later.version) - 1 FROM catalog_entries AS later
				WHERE later.workspace = catalog_entries.workspace AND later.node_id = catalog_entries.node_id AND later.version > catalog_entries.version);
			UPDATE catalog_embeddings SET valid_to_version = (
				SELECT MIN(later.version) - 1 FROM catalog_embeddings AS later
				WHERE later.workspace = catalog_embeddings.workspace AND later.node_id = catalog_embeddings.node_id
					AND later.source = catalog_embeddings.source AND later.version > catalog_embeddings.version);
			CREATE INDEX IF NOT EXISTS catalog_entries_visible ON catalog_entries (workspace, node_id, version, valid_to_version);
			CREATE INDEX IF NOT EXISTS catalog_embeddings_visible ON catalog_embeddings (workspace, node_id, source, version, valid_to_version);
			CREATE INDEX IF NOT EXISTS contribution_catalog_units_node ON contribution_catalog_units (workspace, node_id, valid_from_version, valid_to_version);
		`); err != nil {
			return fmt.Errorf("migrate catalog validity ranges: %w", err)
		}
		rows, err := transaction.QueryContext(ctx, "SELECT workspace, version FROM graph_versions ORDER BY workspace, version")
		if err != nil {
			return fmt.Errorf("read catalog migration snapshots: %w", err)
		}
		var snapshots []storage.Snapshot
		for rows.Next() {
			var snapshot storage.Snapshot
			if err := rows.Scan(&snapshot.Workspace, &snapshot.Version); err != nil {
				rows.Close()
				return fmt.Errorf("read catalog migration snapshot: %w", err)
			}
			snapshots = append(snapshots, snapshot)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("iterate catalog migration snapshots: %w", err)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close catalog migration snapshots: %w", err)
		}
		for _, snapshot := range snapshots {
			if err := closeInvalidCatalogRecords(ctx, transaction, snapshot.Workspace, snapshot.Version); err != nil {
				return fmt.Errorf("migrate catalog validity: %w", err)
			}
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", 26, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record catalog validity migration: %w", err)
		}
		version = 26
	}
	if version == 26 {
		if _, err := transaction.ExecContext(ctx, `DROP TABLE node_search;
			CREATE VIRTUAL TABLE node_search USING fts5(label, qualified_name, span_path, kind, identifier_tokens, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2')`); err != nil {
			return fmt.Errorf("create shared lexical index: %w", err)
		}
		rows, err := transaction.QueryContext(ctx, "SELECT workspace, MAX(version) FROM graph_versions GROUP BY workspace")
		if err != nil {
			return fmt.Errorf("read shared lexical migration workspaces: %w", err)
		}
		var snapshots []storage.Snapshot
		for rows.Next() {
			var snapshot storage.Snapshot
			if err := rows.Scan(&snapshot.Workspace, &snapshot.Version); err != nil {
				rows.Close()
				return fmt.Errorf("read shared lexical migration snapshot: %w", err)
			}
			snapshots = append(snapshots, snapshot)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("iterate shared lexical migration snapshots: %w", err)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close shared lexical migration snapshots: %w", err)
		}
		for _, snapshot := range snapshots {
			if err := rebuildLexicalSnapshot(ctx, transaction, snapshot.Workspace, snapshot.Version, variableLimit, factBatchLimits{maximumRows: maximumBatchRows, maximumBytes: defaultWorkspaceFactBatchBytes}); err != nil {
				return fmt.Errorf("rebuild shared lexical migration snapshot: %w", err)
			}
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", CurrentSchemaVersion, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("record shared lexical migration: %w", err)
		}
	}

	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit SQLite migration: %w", err)
	}
	return nil
}

func addColumnIfMissing(ctx context.Context, transaction *sql.Tx, table, column, statement string) (bool, error) {
	rows, err := transaction.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var columnID int
		var name, dataType string
		var notNull int
		var defaultValue any
		var primaryKey int
		if err := rows.Scan(&columnID, &name, &dataType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, err
		}
		if name == column {
			return false, rows.Err()
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	if _, err := transaction.ExecContext(ctx, statement); err != nil {
		return false, err
	}
	return true, nil
}

func (store *Store) readResolutionData(ctx context.Context, snapshot storage.Snapshot) (map[string]resolutionData, error) {
	rows, err := store.database.QueryContext(ctx, `
		SELECT source_path
		FROM file_contributions
		WHERE workspace = ?
			AND valid_from_version <= ?
			AND (valid_to_version IS NULL OR valid_to_version >= ?)
		ORDER BY source_path`,
		snapshot.Workspace,
		snapshot.Version,
		snapshot.Version,
	)
	if err != nil {
		return nil, fmt.Errorf("read resolution data: %w", err)
	}
	defer rows.Close()

	sourcePaths := make([]string, 0)
	for rows.Next() {
		var sourcePath string
		if err := rows.Scan(&sourcePath); err != nil {
			return nil, fmt.Errorf("read resolution data: %w", err)
		}
		sourcePaths = append(sourcePaths, sourcePath)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate resolution data: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close resolution data: %w", err)
	}
	dataByPath := make(map[string]resolutionData, len(sourcePaths))
	for _, sourcePath := range sourcePaths {
		data, err := store.readResolutionDataForSource(ctx, snapshot, sourcePath)
		if err != nil {
			return nil, err
		}
		dataByPath[sourcePath] = data
	}
	return dataByPath, nil
}

func sameSurfaces(left, right []extractor.ExportedSurface) bool {
	if len(left) != len(right) {
		return false
	}
	leftByKey := make(map[string]struct{}, len(left))
	for _, surface := range left {
		leftByKey[surface.Name+"\x00"+surface.NodeID] = struct{}{}
	}
	for _, surface := range right {
		if _, found := leftByKey[surface.Name+"\x00"+surface.NodeID]; !found {
			return false
		}
	}
	return true
}

func uniqueSortedStringsMap(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
