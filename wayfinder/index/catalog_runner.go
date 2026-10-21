package index

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"

	"agent-wayfinder/extractor"
	"agent-wayfinder/storage"
)

type CatalogRequest struct {
	Root                string
	ConfiguredRoots     []string
	Snapshot            storage.Snapshot
	PreviousSnapshot    storage.Snapshot
	ChangedPaths        []string
	CatalogWriteOptions CatalogWriteOptions
	Progress            func(CatalogProgress)
}

type CatalogProgress struct {
	CompletedUnits int
	TotalUnits     int
	Stage          string
}

type CatalogResult struct {
	Snapshot storage.Snapshot
	Units    int
	Write    CatalogWriteResult
}

type catalogStore interface {
	storage.SnapshotOpener
	storage.SourceContributionReader
	storage.CatalogWriter
	storage.CatalogEntryReader
	storage.CatalogEmbeddingReader
}

const catalogCheckpointUnits = 8

func Catalog(ctx context.Context, store catalogStore, request CatalogRequest) (catalogResult CatalogResult, catalogErr error) {
	if request.Root == "" {
		return CatalogResult{}, fmt.Errorf("catalog workspace: root is required")
	}
	if store == nil {
		return CatalogResult{}, fmt.Errorf("catalog workspace: catalog store is required")
	}

	root, err := filepath.Abs(request.Root)
	if err != nil {
		return CatalogResult{}, fmt.Errorf("catalog workspace: resolve root: %w", err)
	}
	snapshot := request.Snapshot
	if snapshot.Version == 0 {
		var err error
		snapshot, err = store.OpenSnapshot(ctx, storage.OpenSnapshotRequest{Workspace: root})
		if err != nil {
			return CatalogResult{}, fmt.Errorf("catalog workspace: open current snapshot: %w", err)
		}
	} else if snapshot.Workspace != root {
		return CatalogResult{}, fmt.Errorf("catalog workspace: snapshot workspace does not match root")
	}
	contributions, err := store.SourceContributions(ctx, snapshot)
	if err != nil {
		return CatalogResult{}, fmt.Errorf("catalog workspace: read snapshot sources: %w", err)
	}
	if request.PreviousSnapshot.Version != 0 && len(request.ChangedPaths) > 0 {
		changed := make(map[string]struct{}, len(request.ChangedPaths))
		for _, changedPath := range request.ChangedPaths {
			normalizedPath, err := normalizeChangedPath(root, changedPath)
			if err != nil {
				return CatalogResult{}, fmt.Errorf("catalog workspace: %w", err)
			}
			changed[normalizedPath] = struct{}{}
		}
		filtered := make([]storage.SourceContribution, 0, len(changed))
		for _, contribution := range contributions {
			if _, found := changed[contribution.SourcePath]; found {
				filtered = append(filtered, contribution)
			}
		}
		contributions = filtered
	}
	units := make([]extractor.CatalogUnit, 0)
	for _, contribution := range contributions {
		if err := ctx.Err(); err != nil {
			return CatalogResult{}, err
		}
		if !contribution.CatalogUnitsCovered {
			derived, err := catalogUnitsFromSnapshotSource(root, contribution)
			if err != nil {
				return CatalogResult{}, err
			}
			units = append(units, derived...)
			continue
		}
		units = append(units, contribution.CatalogUnits...)
	}
	unitCount := len(units)
	reportCatalogProgress(request.Progress, CatalogProgress{TotalUnits: unitCount, Stage: "Preparing catalog units"})
	writeOptions := request.CatalogWriteOptions
	writeResult := CatalogWriteResult{}
	embeddingModelReleased := false
	synopsisModelReleased := false
	defer func() {
		if !embeddingModelReleased {
			if releaseErr := releaseCatalogEmbeddingModel(writeOptions.EmbeddingGenerator); releaseErr != nil {
				catalogErr = appendCatalogCleanupError(catalogErr, "release catalog embedding model", releaseErr)
			}
		}
		if !synopsisModelReleased {
			if releaseErr := releaseCatalogSynopsisModel(writeOptions.SynopsisGenerator); releaseErr != nil {
				catalogErr = appendCatalogCleanupError(catalogErr, "release catalog synopsis model", releaseErr)
			}
		}
	}()
	if writeOptions.SynopsisGenerator != nil && writeOptions.EmbeddingGenerator != nil {
		synopsisOptions := writeOptions
		synopsisOptions.EmbeddingGenerator = nil
		for start := 0; start < unitCount; start += catalogCheckpointUnits {
			end := min(start+catalogCheckpointUnits, unitCount)
			batch := units[start:end]
			nodeIDs := make([]string, len(batch))
			for index, unit := range batch {
				nodeIDs[index] = unit.NodeID
			}
			existingEntries, err := store.ReadCatalogEntries(ctx, snapshot, storage.CatalogEntryReadRequest{NodeIDs: nodeIDs})
			if err != nil {
				return CatalogResult{}, fmt.Errorf("catalog workspace: read catalog checkpoint: %w", err)
			}
			batchResult, err := writeCatalogUnits(ctx, store, snapshot, batch, existingEntries, nil, synopsisOptions)
			if err != nil {
				return CatalogResult{}, fmt.Errorf("catalog workspace: write synopsis checkpoint: %w", err)
			}
			mergeCatalogWriteResult(&writeResult, batchResult)
			reportCatalogProgress(request.Progress, CatalogProgress{CompletedUnits: end, TotalUnits: unitCount, Stage: "Generating catalog synopses"})
			if end < unitCount {
				if releaseErr := releaseCatalogSynopsisModel(writeOptions.SynopsisGenerator); releaseErr != nil {
					synopsisModelReleased = true
					return CatalogResult{}, fmt.Errorf("catalog workspace: release synopsis checkpoint: %w", releaseErr)
				}
			}
		}
		releaseErr := releaseCatalogSynopsisModel(writeOptions.SynopsisGenerator)
		synopsisModelReleased = true
		if releaseErr != nil {
			return CatalogResult{}, fmt.Errorf("catalog workspace: release synopsis model: %w", releaseErr)
		}

		embeddingOptions := writeOptions
		embeddingOptions.SynopsisGenerator = nil
		for start := 0; start < unitCount; start += catalogCheckpointUnits {
			end := min(start+catalogCheckpointUnits, unitCount)
			batch := units[start:end]
			nodeIDs := make([]string, len(batch))
			for index, unit := range batch {
				nodeIDs[index] = unit.NodeID
			}
			existingEntries, err := store.ReadCatalogEntries(ctx, snapshot, storage.CatalogEntryReadRequest{NodeIDs: nodeIDs})
			if err != nil {
				return CatalogResult{}, fmt.Errorf("catalog workspace: read catalog checkpoint: %w", err)
			}
			existingEmbeddings, err := store.ReadCatalogEmbeddings(ctx, snapshot, storage.CatalogEmbeddingReadRequest{NodeIDs: nodeIDs})
			if err != nil {
				return CatalogResult{}, fmt.Errorf("catalog workspace: read embedding checkpoint: %w", err)
			}
			batchResult, err := writeCatalogUnits(ctx, store, snapshot, batch, existingEntries, existingEmbeddings, embeddingOptions)
			if err != nil {
				return CatalogResult{}, fmt.Errorf("catalog workspace: write embedding checkpoint: %w", err)
			}
			mergeCatalogWriteResult(&writeResult, batchResult)
			reportCatalogProgress(request.Progress, CatalogProgress{CompletedUnits: end, TotalUnits: unitCount, Stage: "Generating catalog embeddings"})
		}
		recordCatalogEmbeddingRelease(&writeResult, releaseCatalogEmbeddingModel(writeOptions.EmbeddingGenerator))
		embeddingModelReleased = true
		return CatalogResult{Snapshot: snapshot, Units: unitCount, Write: writeResult}, nil
	}
	for start := 0; start < unitCount; start += catalogCheckpointUnits {
		end := min(start+catalogCheckpointUnits, unitCount)
		batch := units[start:end]
		nodeIDs := make([]string, len(batch))
		for index, unit := range batch {
			nodeIDs[index] = unit.NodeID
		}
		existingEntries, err := store.ReadCatalogEntries(ctx, snapshot, storage.CatalogEntryReadRequest{NodeIDs: nodeIDs})
		if err != nil {
			return CatalogResult{}, fmt.Errorf("catalog workspace: read catalog checkpoint: %w", err)
		}
		existingEmbeddings, err := store.ReadCatalogEmbeddings(ctx, snapshot, storage.CatalogEmbeddingReadRequest{NodeIDs: nodeIDs})
		if err != nil {
			return CatalogResult{}, fmt.Errorf("catalog workspace: read embedding checkpoint: %w", err)
		}
		batchResult, err := writeCatalogUnits(ctx, store, snapshot, batch, existingEntries, existingEmbeddings, writeOptions)
		if err != nil {
			return CatalogResult{}, fmt.Errorf("catalog workspace: %w", err)
		}
		mergeCatalogWriteResult(&writeResult, batchResult)
		reportCatalogProgress(request.Progress, CatalogProgress{CompletedUnits: end, TotalUnits: unitCount, Stage: "Writing catalog entries"})
		if writeOptions.SynopsisGenerator != nil && end < unitCount {
			if releaseErr := releaseCatalogSynopsisModel(writeOptions.SynopsisGenerator); releaseErr != nil {
				synopsisModelReleased = true
				return CatalogResult{}, fmt.Errorf("catalog workspace: release synopsis checkpoint: %w", releaseErr)
			}
		}
	}
	recordCatalogEmbeddingRelease(&writeResult, releaseCatalogEmbeddingModel(writeOptions.EmbeddingGenerator))
	embeddingModelReleased = true
	recordCatalogSynopsisRelease(&writeResult, writeOptions.SynopsisProvider, releaseCatalogSynopsisModel(writeOptions.SynopsisGenerator))
	synopsisModelReleased = true
	return CatalogResult{Snapshot: snapshot, Units: unitCount, Write: writeResult}, nil
}

func catalogUnitsFromSnapshotSource(root string, source storage.SourceContribution) ([]extractor.CatalogUnit, error) {
	if !filepath.IsLocal(source.SourcePath) {
		return nil, fmt.Errorf("catalog workspace: source %q is invalid; re-index required", source.SourcePath)
	}
	var expectedHash string
	for _, node := range source.Facts.Nodes {
		if node.Kind == "file" && node.Evidence.Span.Path == source.SourcePath {
			if expectedHash != "" && expectedHash != node.Evidence.FileHash {
				return nil, fmt.Errorf("catalog workspace: source %q has inconsistent hashes; re-index required", source.SourcePath)
			}
			expectedHash = node.Evidence.FileHash
		}
	}
	if expectedHash == "" {
		return nil, fmt.Errorf("catalog workspace: source %q has no snapshot file hash; re-index required", source.SourcePath)
	}
	workspace, err := os.OpenRoot(root)
	if err != nil {
		return nil, fmt.Errorf("catalog workspace: open source root; re-index required: %w", err)
	}
	defer workspace.Close()
	contents, err := workspace.ReadFile(source.SourcePath)
	if err != nil {
		return nil, fmt.Errorf("catalog workspace: read source %q; re-index required: %w", source.SourcePath, err)
	}
	if fmt.Sprintf("sha256:%x", sha256.Sum256(contents)) != expectedHash {
		return nil, fmt.Errorf("catalog workspace: source %q changed after indexing; re-index required", source.SourcePath)
	}
	return extractor.CatalogUnitsForSource(extractor.Source{SourcePath: source.SourcePath, Contents: contents}, source.Facts), nil
}

func appendCatalogCleanupError(catalogErr error, action string, cleanupErr error) error {
	if catalogErr == nil {
		return fmt.Errorf("catalog workspace: %s: %w", action, cleanupErr)
	}
	return fmt.Errorf("%w; %s: %v", catalogErr, action, cleanupErr)
}

func mergeCatalogWriteResult(result *CatalogWriteResult, batch CatalogWriteResult) {
	if batch.CopilotUnavailableReason != "" {
		result.CopilotUnavailableReason = batch.CopilotUnavailableReason
	}
	if batch.OllamaUnavailableReason != "" {
		result.OllamaUnavailableReason = batch.OllamaUnavailableReason
	}
	if batch.ClaudeUnavailableReason != "" {
		result.ClaudeUnavailableReason = batch.ClaudeUnavailableReason
	}
	if batch.EmbeddingUnavailableReason != "" {
		result.EmbeddingUnavailableReason = batch.EmbeddingUnavailableReason
	}
}

func reportCatalogProgress(callback func(CatalogProgress), progress CatalogProgress) {
	if callback != nil {
		callback(progress)
	}
}
