/**
 * The tenant-management result contract (ADR13's dialect-agnostic
 * boundary): every `StorageDriver` implementation - SQLite
 * (`@agent-issues/api-local`) and Postgres (`@agent-issues/api-pg`) alike -
 * returns these same shapes, so they live in core rather than either
 * concrete store.
 */

export type TenantRecordCounts = {
	entities: number;
	relations: number;
	contexts: number;
	contextTerms: number;
	historyEntries: number;
};

export type TenantSummary = {
	id: string;
	displayName: string;
	counts: TenantRecordCounts;
};

export type DeleteTenantResult = {
	tenantId: string;
	displayName: string;
	removed: boolean;
	counts: TenantRecordCounts;
	counters: number;
};

export type RenameTenantResult = {
	previousTenantId: string;
	previousDisplayName: string;
	newTenantId: string;
	newDisplayName: string;
	renamed: boolean;
	counts: TenantRecordCounts;
	counters: number;
};
