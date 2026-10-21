import type { DeleteTenantResult, RenameTenantResult, TenantSummary } from "../entity-store/tenant-types.js";
import type { AuthIdentity } from "../../auth/auth-provider.js";
import type { ContextStore } from "./context-store.js";
import type { EntityStore } from "./entity-store.js";
import type { HistoryDiagnostics } from "./history-diagnostics.js";
import type { IssueBreakdownStore } from "./issue-breakdown-store.js";
import type { IssueCommentStore } from "./issue-comment-store.js";
import type { PlanEntryStore } from "./plan-entry-store.js";
import type { ProjectSettingsStore } from "./project-settings-store.js";
import type { SearchStore } from "./search-store.js";
import type { SynchronizeStore } from "./synchronize-store.js";
import type { UserDirectoryStore } from "./user-directory-store.js";
import type { InstructionStore } from "./instruction-store.js";

/**
 * The engine-agnostic boundary the domain layer talks to (ADR11, ADR13):
 * SQLite (`SqliteStore`) implements it today, an HTTP-backed cloud client
 * implements it later, and callers never branch on which one they hold.
 * Every operation is async because the cloud path is inherently async.
 *
 * Composed from the three per-feature interfaces (ADR "Backends mirror one
 * another per feature, behind all-async feature interfaces") plus the
 * methods that don't belong to exactly one feature: `tenantId` and tenant
 * administration are cross-cutting, and `getHistoryDiagnostics` spans
 * `SynchronizeStore` and the fourth feature, history diagnostics (which has
 * no public seam of its own - see `HistoryDiagnosticsStore`'s doc comment).
 */
export interface StorageDriver extends EntityStore, ContextStore, IssueBreakdownStore, IssueCommentStore, PlanEntryStore, ProjectSettingsStore, SearchStore, SynchronizeStore, UserDirectoryStore, InstructionStore {
	readonly tenantId: string;
	withAuthenticatedIdentity(identity: AuthIdentity): StorageDriver;
	getHistoryDiagnostics(): Promise<HistoryDiagnostics>;

	// Tenant administration
	listTenants(): Promise<TenantSummary[]>;
	deleteTenant(tenantId: string): Promise<DeleteTenantResult>;
	renameTenant(previousTenantId: string, newTenantId: string): Promise<RenameTenantResult>;
	// Legacy per-folder tenant consolidation (ISS63) is no longer part of
	// this seam: it only ever ran as a one-time migration step, and the
	// automatic per-open sweep (ISS178/ISS181, database.ts's
	// buildConsolidateLegacyTenantsBackfillMigration) now folds in every
	// outstanding legacy tenant on its own - there is no longer a manual
	// path that needs a `StorageDriver` method to call through.

	close(): Promise<void>;
}
