package acceptance_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sync"
	"testing"
	"time"

	"agent-wayfinder/graph"
	"agent-wayfinder/index"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
	"agent-wayfinder/workspace"
)

const clientFlexRootEnvironment = "AGENT_WAYFINDER_CLIENTFLEX_ROOT"

const clientFlexAuthInfoQualifiedName = "core-auth/src/auth-info.ts::AuthInfo"
const clientFlexAuthIndexPath = "core-auth/src/index.ts"

type clientFlexRun struct {
	SourceFiles     int
	NodeCount       int
	EdgeCount       int
	Diagnostics     int
	Elapsed         time.Duration
	MaxObservedHeap uint64
	DatabaseBytes   int64
	Checksum        string
	Operations      []clientFlexOperation
	Failures        []clientFlexFailure
}

type clientFlexOperation struct {
	Name      string
	Succeeded bool
}

type clientFlexFailure struct {
	Operation string
	Error     string
}

func TestClientFlexAcceptanceIndexesIntoTemporaryDatabase(t *testing.T) {
	root := clientFlexRoot(t)
	run := &clientFlexRun{}
	t.Cleanup(func() {
		if t.Failed() && len(run.Failures) == 0 {
			run.Failures = append(run.Failures, clientFlexFailure{Operation: "acceptance", Error: "assertion failed"})
		}
		t.Logf("ClientFlex acceptance: %+v", *run)
	})
	manifest, err := clientFlexManifest(root)
	clientFlexRequire(t, run, "capture corpus manifest", err)
	t.Cleanup(func() {
		current, err := clientFlexManifest(root)
		if err != nil {
			clientFlexRecordFailure(run, "capture final corpus manifest", err)
			t.Errorf("capture final ClientFlex corpus manifest: %v", err)
			return
		}
		if !reflect.DeepEqual(current, manifest) {
			clientFlexRecordFailure(run, "verify corpus unchanged", fmt.Errorf("ClientFlex corpus changed during acceptance run"))
			t.Error("ClientFlex corpus changed during acceptance run")
		}
	})

	discovery, err := workspace.Discover(root, workspace.DiscoverOptions{})
	clientFlexRequire(t, run, "discover sources", err)
	if len(discovery.Sources) == 0 {
		clientFlexRecordFailure(run, "discover sources", fmt.Errorf("no supported source files"))
		t.Fatal("discover ClientFlex sources: no supported source files")
	}
	run.SourceFiles = len(discovery.Sources)

	database := filepath.Join(t.TempDir(), "clientflex.db")
	store, err := sqlite.Open(context.Background(), database)
	clientFlexRequire(t, run, "open temporary SQLite database", err)
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			clientFlexRecordFailure(run, "close temporary SQLite database", err)
			t.Errorf("close temporary SQLite database: %v", err)
		}
	})

	started := time.Now()
	heapMonitor := newClientFlexHeapMonitor()
	defer func() {
		run.MaxObservedHeap = heapMonitor.Stop()
	}()
	result, err := index.Index(context.Background(), store, index.Request{Root: root})
	clientFlexRequire(t, run, "index", err)
	parsed, err := query.ParseGraphQuery(fmt.Sprintf("MATCH (node {qualifiedName: %q}) RETURN node LIMIT 100", clientFlexAuthInfoQualifiedName))
	clientFlexRequire(t, run, "parse AuthInfo query", err)
	queryResult, err := query.ExecuteGraphQuerySnapshot(context.Background(), store, result.Snapshot, parsed, query.GraphQueryLimits{MaxDepth: 1, MaxNodes: 100}, query.GraphQueryOptions{})
	clientFlexRequire(t, run, "query AuthInfo", err)
	if len(queryResult.Graph.Nodes) != 1 {
		clientFlexRecordFailure(run, "query AuthInfo", fmt.Errorf("expected one exact result"))
		t.Fatalf("query ClientFlex AuthInfo nodes = %+v, want one exact result", queryResult.Graph.Nodes)
	}
	if got := queryResult.Graph.Nodes[0].Evidence.Span.Path; got != "core-auth/src/auth-info.ts" {
		clientFlexRecordFailure(run, "query AuthInfo", fmt.Errorf("source path = %q", got))
		t.Errorf("query ClientFlex AuthInfo source path = %q, want core-auth/src/auth-info.ts", got)
	}
	explanationResult, err := query.ExplainSnapshot(context.Background(), store, store, result.Snapshot, clientFlexAuthInfoQualifiedName)
	clientFlexRequire(t, run, "explain AuthInfo", err)
	if explanationResult.Explanation == nil {
		clientFlexRecordFailure(run, "explain AuthInfo", fmt.Errorf("source evidence is missing"))
		t.Fatalf("explain ClientFlex AuthInfo = %+v, want source evidence", explanationResult)
	}
	if got := explanationResult.Explanation.Node.Evidence.Span.Path; got != "core-auth/src/auth-info.ts" {
		clientFlexRecordFailure(run, "explain AuthInfo", fmt.Errorf("source path = %q", got))
		t.Errorf("explain ClientFlex AuthInfo source path = %q, want core-auth/src/auth-info.ts", got)
	}
	pathResult, err := query.FindPathSnapshot(context.Background(), store, store, result.Snapshot, query.PathRequest{
		Source:    clientFlexAuthIndexPath,
		Target:    clientFlexAuthInfoQualifiedName,
		Relations: []graph.RelationKind{"typescript:re_exports"},
		MaxDepth:  1,
		MaxNodes:  10,
	})
	clientFlexRequire(t, run, "find AuthInfo re-export path", err)
	if len(pathResult.Nodes) != 2 || len(pathResult.Edges) != 1 || pathResult.Edges[0].Relation != "typescript:re_exports" {
		clientFlexRecordFailure(run, "find AuthInfo re-export path", fmt.Errorf("expected one direct typescript:re_exports edge"))
		t.Fatalf("ClientFlex AuthInfo re-export path = %+v, want one direct typescript:re_exports edge", pathResult)
	}
	checksum, err := clientFlexExportChecksum(context.Background(), store, result.Snapshot)
	clientFlexRequire(t, run, "export initial graph", err)
	counts, err := store.FactCounts(context.Background(), result.Snapshot)
	clientFlexRequire(t, run, "count graph facts", err)
	run.NodeCount = counts.Nodes
	run.EdgeCount = counts.Edges
	run.Diagnostics = len(result.Diagnostics)
	run.Checksum = checksum
	repeat, err := index.Index(context.Background(), store, index.Request{Root: root})
	clientFlexRequire(t, run, "repeat index", err)
	if repeat.Snapshot.Version != result.Snapshot.Version+1 {
		clientFlexRecordFailure(run, "repeat index", fmt.Errorf("graph version = %d", repeat.Snapshot.Version))
		t.Errorf("repeat ClientFlex graph version = %d, want %d", repeat.Snapshot.Version, result.Snapshot.Version+1)
	}
	repeatChecksum, err := clientFlexExportChecksum(context.Background(), store, repeat.Snapshot)
	clientFlexRequire(t, run, "export repeated graph", err)
	if repeatChecksum != run.Checksum {
		clientFlexRecordFailure(run, "compare export checksums", fmt.Errorf("repeated checksum = %q", repeatChecksum))
		t.Errorf("repeated ClientFlex export checksum = %q, want %q", repeatChecksum, run.Checksum)
	}
	run.DatabaseBytes, err = clientFlexDatabaseSize(database)
	clientFlexRequire(t, run, "measure temporary database", err)
	run.Elapsed = time.Since(started)
	run.MaxObservedHeap = heapMonitor.Stop()
	if run.NodeCount == 0 || run.EdgeCount == 0 || run.DatabaseBytes <= 0 || run.MaxObservedHeap == 0 || run.Checksum == "" {
		clientFlexRecordFailure(run, "validate acceptance record", fmt.Errorf("source graph or resource measurement is missing"))
		t.Fatalf("ClientFlex acceptance record = %+v, want source graph and resource measurements", *run)
	}
}

func clientFlexRequire(t *testing.T, run *clientFlexRun, operation string, err error) {
	t.Helper()
	run.Operations = append(run.Operations, clientFlexOperation{Name: operation, Succeeded: err == nil})
	if err == nil {
		return
	}
	clientFlexRecordFailure(run, operation, err)
	t.Fatalf("%s: %v", operation, err)
}

func clientFlexRecordFailure(run *clientFlexRun, operation string, err error) {
	run.Failures = append(run.Failures, clientFlexFailure{Operation: operation, Error: err.Error()})
}

type clientFlexFactCollector struct {
	facts graph.Facts
}

func (collector *clientFlexFactCollector) WriteNode(node graph.Node) error {
	collector.facts.Nodes = append(collector.facts.Nodes, node)
	return nil
}

func (collector *clientFlexFactCollector) WriteEdge(edge graph.Edge) error {
	collector.facts.Edges = append(collector.facts.Edges, edge)
	return nil
}

func clientFlexExportChecksum(ctx context.Context, exporter storage.Exporter, snapshot storage.Snapshot) (string, error) {
	collector := &clientFlexFactCollector{}
	if err := exporter.Export(ctx, snapshot, storage.ExportRequest{}, collector); err != nil {
		return "", err
	}
	contents, err := json.Marshal(collector.facts)
	if err != nil {
		return "", err
	}
	checksum := sha256.Sum256(contents)
	return hex.EncodeToString(checksum[:]), nil
}

func clientFlexDatabaseSize(path string) (int64, error) {
	var size int64
	for _, suffix := range []string{"", "-wal", "-shm"} {
		info, err := os.Stat(path + suffix)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return 0, err
		}
		size += info.Size()
	}
	return size, nil
}

type clientFlexCorpusEntry struct {
	Mode    fs.FileMode
	Size    int64
	ModTime time.Time
}

func clientFlexManifest(root string) (map[string]clientFlexCorpusEntry, error) {
	manifest := make(map[string]clientFlexCorpusEntry)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relativePath, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		manifest[filepath.ToSlash(relativePath)] = clientFlexCorpusEntry{
			Mode:    info.Mode(),
			Size:    info.Size(),
			ModTime: info.ModTime(),
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return manifest, nil
}

type clientFlexHeapMonitor struct {
	mu       sync.Mutex
	maximum  uint64
	stop     chan struct{}
	done     chan struct{}
	stopOnce sync.Once
}

func newClientFlexHeapMonitor() *clientFlexHeapMonitor {
	monitor := &clientFlexHeapMonitor{stop: make(chan struct{}), done: make(chan struct{})}
	monitor.sample()
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		defer close(monitor.done)
		for {
			select {
			case <-ticker.C:
				monitor.sample()
			case <-monitor.stop:
				monitor.sample()
				return
			}
		}
	}()
	return monitor
}

func (monitor *clientFlexHeapMonitor) Stop() uint64 {
	monitor.stopOnce.Do(func() {
		close(monitor.stop)
		<-monitor.done
	})
	monitor.mu.Lock()
	defer monitor.mu.Unlock()
	return monitor.maximum
}

func (monitor *clientFlexHeapMonitor) sample() {
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	monitor.mu.Lock()
	monitor.maximum = max(monitor.maximum, memory.HeapAlloc)
	monitor.mu.Unlock()
}

func clientFlexRoot(t *testing.T) string {
	t.Helper()
	root := os.Getenv(clientFlexRootEnvironment)
	if root == "" {
		t.Skipf("set %s to run the ClientFlex acceptance test", clientFlexRootEnvironment)
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		t.Fatalf("resolve ClientFlex root: %v", err)
	}
	info, err := os.Stat(absoluteRoot)
	if err != nil {
		t.Fatalf("stat ClientFlex root %q: %v", absoluteRoot, err)
	}
	if !info.IsDir() {
		t.Fatalf("ClientFlex root %q is not a directory", absoluteRoot)
	}
	return absoluteRoot
}
