import { EMPTY_HISTORY_MATERIALIZATION_DEPTHS, type HistoryDiagnosticsStore, type HistoryMaterializationDepths, type HistoryRecordKind } from "@agent-issues/core";
import type { Pool } from "pg";

const depthsByPool = new WeakMap<Pool, Map<string, HistoryMaterializationDepths>>();

export function getHistoryMaterializationDepths(pool: Pool, tenantId: string): HistoryMaterializationDepths {
	let depthsByTenant = depthsByPool.get(pool);
	if (!depthsByTenant) {
		depthsByTenant = new Map();
		depthsByPool.set(pool, depthsByTenant);
	}

	const existing = depthsByTenant.get(tenantId);
	if (existing) {
		return existing;
	}

	const depths = { ...EMPTY_HISTORY_MATERIALIZATION_DEPTHS };
	depthsByTenant.set(tenantId, depths);
	return depths;
}

export function recordHistoryMaterialization(pool: Pool, tenantId: string, kind: HistoryRecordKind, headRevision: number, targetRevision: number): void {
	const depths = getHistoryMaterializationDepths(pool, tenantId);
	depths[kind] = Math.max(depths[kind], headRevision - targetRevision);
}

/**
 * The history-diagnostics feature class (ADR "Backends mirror one another
 * per feature, behind all-async feature interfaces"): a thin, promise-
 * returning wrapper over the pool-holding free functions above, which
 * `PgStore` composes alongside the other three feature classes. Unlike the
 * other three, this one never opens a `withTenantTransaction`: the
 * materialization depths are a process-lifetime in-memory cache, not a
 * database write.
 */
export class PgHistoryDiagnosticsStore implements HistoryDiagnosticsStore {
	public constructor(
		private readonly pool: Pool,
		private readonly tenantId: string
	) {}

	public async getMaterializationDepths(): Promise<HistoryMaterializationDepths> {
		return getHistoryMaterializationDepths(this.pool, this.tenantId);
	}

	public async recordMaterialization(kind: HistoryRecordKind, headRevision: number, targetRevision: number): Promise<void> {
		recordHistoryMaterialization(this.pool, this.tenantId, kind, headRevision, targetRevision);
	}
}
