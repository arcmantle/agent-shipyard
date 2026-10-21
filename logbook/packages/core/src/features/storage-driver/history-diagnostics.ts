import type { CanonicalChainBundle } from "../synchronize/canonical-chain.js";

export type HistoryRecordKind = "entity" | "context" | "context-term";

export type HistoryRecordDiagnostics = {
	recordId: string;
	deltaCount: number;
	historyBytes: number;
};

export type HistoryKindDiagnostics = {
	/** UTF-8 bytes of canonical serialized reverse-delta payloads, not physical database pages or indexes. */
	historyBytes: number;
	deltaCount: number;
	maxChainLength: number;
	/** Deepest successful reconstruction observed during this process lifetime. */
	maxMaterializationDepth: number;
	records: HistoryRecordDiagnostics[];
};

export type HistoryDiagnostics = Record<HistoryRecordKind, HistoryKindDiagnostics>;

export type HistoryMaterializationDepths = Record<HistoryRecordKind, number>;

export const EMPTY_HISTORY_MATERIALIZATION_DEPTHS: HistoryMaterializationDepths = {
	entity: 0,
	context: 0,
	"context-term": 0
};

export function measureHistory(bundle: CanonicalChainBundle, depths: HistoryMaterializationDepths): HistoryDiagnostics {
	return {
		entity: measureKind(bundle.entities.map((chain) => ({ recordId: chain.head.id, deltas: chain.deltas })), depths.entity),
		context: measureKind(bundle.contexts.map((chain) => ({ recordId: chain.head.key, deltas: chain.deltas })), depths.context),
		"context-term": measureKind(bundle.contextTerms.map((chain) => ({ recordId: `${chain.head.contextKey}:${chain.head.term}`, deltas: chain.deltas })), depths["context-term"])
	};
}

function measureKind(records: Array<{ recordId: string; deltas: Array<{ reversePatch: Uint8Array }> }>, maxMaterializationDepth: number): HistoryKindDiagnostics {
	const populatedRecords = records
		.filter((record) => record.deltas.length > 0)
		.map((record) => ({
			recordId: record.recordId,
			deltaCount: record.deltas.length,
			historyBytes: record.deltas.reduce<number>((total, delta) => total + delta.reversePatch.byteLength, 0)
		}))
		.sort((left, right) => left.recordId.localeCompare(right.recordId));

	return {
		historyBytes: populatedRecords.reduce((total, record) => total + record.historyBytes, 0),
		deltaCount: populatedRecords.reduce((total, record) => total + record.deltaCount, 0),
		maxChainLength: populatedRecords.reduce((maximum, record) => Math.max(maximum, record.deltaCount), 0),
		maxMaterializationDepth,
		records: populatedRecords
	};
}
