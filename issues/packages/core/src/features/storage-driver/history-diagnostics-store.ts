import type { HistoryMaterializationDepths, HistoryRecordKind } from "./history-diagnostics.js";

/**
 * The history-diagnostics half of the storage-driver seam (ADR "Backends
 * mirror one another per feature, behind all-async feature interfaces"),
 * split out of `StorageDriver` so a reader who knows one backend's
 * `LocalHistoryDiagnosticsStore`/`PgHistoryDiagnosticsStore` can read the
 * other.
 *
 * Not part of `StorageDriver`'s own composition: `StorageDriver.getHistoryDiagnostics`
 * spans this feature and `SynchronizeStore` (it measures history depth over
 * the exported canonical chains), so it stays an orchestration method on the
 * facade rather than a method either per-feature interface could expose on
 * its own. `EntityStore`/`ContextStore`'s revision-materialization methods
 * similarly span this feature; each backend records the materialization
 * depth its own way (mirrors are a review property, not a compiler-enforced
 * one - see the ADR).
 */
export interface HistoryDiagnosticsStore {
	getMaterializationDepths(): Promise<HistoryMaterializationDepths>;
	recordMaterialization(kind: HistoryRecordKind, headRevision: number, targetRevision: number): Promise<void>;
}
