import { EMPTY_HISTORY_MATERIALIZATION_DEPTHS, type HistoryDiagnosticsStore, type HistoryMaterializationDepths, type HistoryRecordKind } from "@agent-issues/core";

import type { SqliteExecutor } from "../db/sqlite-executor.js";

const depthsByDatabase = new WeakMap<object, HistoryMaterializationDepths>();

export function getHistoryMaterializationDepths(executor: SqliteExecutor): HistoryMaterializationDepths {
	const existing = depthsByDatabase.get(executor.drizzle);
	if (existing) {
		return existing;
	}

	const depths = { ...EMPTY_HISTORY_MATERIALIZATION_DEPTHS };
	depthsByDatabase.set(executor.drizzle, depths);
	return depths;
}

export function recordHistoryMaterialization(executor: SqliteExecutor, kind: HistoryRecordKind, headRevision: number, targetRevision: number): void {
	const depths = getHistoryMaterializationDepths(executor);
	depths[kind] = Math.max(depths[kind], headRevision - targetRevision);
}

/**
 * The history-diagnostics feature class (ADR "Backends mirror one another
 * per feature, behind all-async feature interfaces"): a thin, promise-
 * returning wrapper over the executor-holding free functions above, which
 * `SqliteStore` composes alongside the other three feature classes.
 */
export class LocalHistoryDiagnosticsStore implements HistoryDiagnosticsStore {
	public constructor(private readonly executor: SqliteExecutor) {}

	public async getMaterializationDepths(): Promise<HistoryMaterializationDepths> {
		return getHistoryMaterializationDepths(this.executor);
	}

	public async recordMaterialization(kind: HistoryRecordKind, headRevision: number, targetRevision: number): Promise<void> {
		recordHistoryMaterialization(this.executor, kind, headRevision, targetRevision);
	}
}
