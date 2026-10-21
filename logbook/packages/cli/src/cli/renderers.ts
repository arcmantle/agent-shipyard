import type { BackfillBodiesResult, BackfillableBodyKind } from "../backfill/body-backfill.js";
import type { SynchronizeSummary } from "@agent-issues/core";
import type { listTenants } from "@agent-issues/api-local";
import type { SavedLoginView } from "../auth/auth-session.js";
import type { startLiveSite } from "../site/index.js";

export function renderEntityList(
	kind: string,
	entities: Array<{ id: string; reference: string; status: string; title: string }>,
	openBlockers?: Record<string, string[]>,
	parentGroups?: Array<{
		parent: { reference: string; status: string; title: string };
		entities: Array<{ id: string; reference: string; status: string; title: string }>;
	}>
): string {
	if (parentGroups) {
		return parentGroups.map((group) => [
			`${group.parent.reference} ${group.parent.status} ${group.parent.title}`,
			renderEntityList(kind, group.entities, openBlockers)
		].join("\n")).join("\n\n");
	}
	if (entities.length === 0) {
		return `No ${kind} entities found.`;
	}

	return entities
		.map((entity) => {
			const blockers = openBlockers?.[entity.reference];
			const blockedSuffix = blockers?.length ? ` (blocked by ${blockers.join(", ")})` : "";
			return `${entity.reference} ${entity.status} ${entity.title}${blockedSuffix}`;
		})
		.join("\n");
}

export function renderOptionalEntityList(
	label: string,
	entities: Array<{ id: string; reference: string; kind: string; status: string; title: string }>
): string {
	if (entities.length === 0) {
		return `No ${label} entities found.`;
	}

	return entities.map((entity) => `${entity.reference} ${entity.kind} ${entity.status} ${entity.title}`).join("\n");
}

export function renderEntityDetails(details: {
	entity: { id: string; reference: string; kind: string; status: string; title: string; type?: string | null };
	incoming: Array<{ relationType: string; entity: { id: string; reference: string; kind: string; status: string } }>;
	outgoing: Array<{ relationType: string; entity: { id: string; reference: string; kind: string; status: string } }>;
	planEntries?: Array<{ reference: string; role: string; body?: string }>;
}): string {
	const incoming = details.incoming.length
		? details.incoming.map((link) => `${link.entity.reference} ${link.entity.kind} --${link.relationType}--> ${details.entity.reference}`).join("\n")
		: "none";
	const outgoing = details.outgoing.length
		? details.outgoing.map((link) => `${details.entity.reference} --${link.relationType}--> ${link.entity.reference} ${link.entity.kind}`).join("\n")
		: "none";
	const relatedPlanEntries = details.planEntries ?? [];
	const planEntryText = relatedPlanEntries.length
		? relatedPlanEntries.map((entry) => `${entry.reference} ${entry.role}${entry.body === undefined ? "" : ` ${entry.body}`}`).join("\n")
		: "none";

	return [
		`${details.entity.reference} ${details.entity.kind}${details.entity.type === null || details.entity.type === undefined ? "" : ` ${details.entity.type}`} ${details.entity.status} ${details.entity.title}`,
		"Incoming:",
		incoming,
		"Outgoing:",
		outgoing,
		"Related Plan entries:",
		planEntryText
	].join("\n");
}

export function renderPlanDetails(details: Parameters<typeof renderEntityDetails>[0] & {
	current: Array<{ title: string; entries: Array<{ id: string; reference: string; body?: string; referencedEntityIds: string[]; supersededEntryIds: string[] }> }>;
	history: Array<{ id: string; reference: string; body?: string; referencedEntityIds: string[]; supersededEntryIds: string[]; tombstone: boolean }>;
}): string {
	const referencesById = new Map(details.history.map((entry) => [entry.id, entry.reference]));
	const renderEntry = (entry: { body?: string; reference: string; referencedEntityIds: string[]; supersededEntryIds: string[] }) => {
		const references = entry.referencedEntityIds.length === 0 ? "" : ` references ${entry.referencedEntityIds.join(", ")}`;
		const supersession = entry.supersededEntryIds.length === 0 ? "" : ` supersedes ${entry.supersededEntryIds.map((id) => referencesById.get(id) ?? id).join(", ")}`;
		return `${entry.reference}${entry.body === undefined ? "" : ` ${entry.body}`}${references}${supersession}`;
	};
	const current = details.current
		.map((group) => `${group.title}: ${group.entries.length === 0 ? "none" : group.entries.map(renderEntry).join("; ")}`)
		.join("\n");
	const history = details.history.length === 0
		? "none"
		: details.history.map((entry) => `${renderEntry(entry)}${entry.tombstone ? " tombstoned" : ""}`).join("\n");

	return [renderEntityDetails(details), "Current Plan:", current, "History:", history].join("\n");
}

export function renderInitiativeBundle(bundle: {
	initiative: { id: string; reference: string; status: string; title: string };
	prds: Array<{ id: string; reference: string; status: string }>;
	userStories: Array<{ id: string; reference: string; status: string }>;
	adrs: Array<{ id: string; reference: string; status: string }>;
	issues: Array<{ id: string; reference: string; status: string }>;
	fixLinks: Array<{ issue: { id: string; reference: string }; userStory: { id: string; reference: string } }>;
	subIssueLinks: Array<{ parent: { id: string; reference: string }; issue: { id: string; reference: string } }>;
	blockerLinks: Array<{ source: { id: string; reference: string }; target: { id: string; reference: string } }>;
	constrainsLinks: Array<{ adr: { id: string; reference: string }; issue: { id: string; reference: string } }>;
}): string {
	return [
		`${bundle.initiative.reference} ${bundle.initiative.status} ${bundle.initiative.title}`,
		`PRDs: ${renderCompactList(bundle.prds)}`,
		`User Stories: ${renderCompactList(bundle.userStories)}`,
		`ADRs: ${renderCompactList(bundle.adrs)}`,
		`Issues: ${renderCompactList(bundle.issues)}`,
		`Fixes: ${bundle.fixLinks.length ? bundle.fixLinks.map((link) => `${link.issue.reference} -> ${link.userStory.reference}`).join(", ") : "none"}`,
		`Sub-issues: ${bundle.subIssueLinks.length ? bundle.subIssueLinks.map((link) => `${link.parent.reference} -> ${link.issue.reference}`).join(", ") : "none"}`,
		`Blockers: ${bundle.blockerLinks.length ? bundle.blockerLinks.map((link) => `${link.source.reference} -> ${link.target.reference}`).join(", ") : "none"}`,
		`Constrains: ${bundle.constrainsLinks.length ? bundle.constrainsLinks.map((link) => `${link.adr.reference} -> ${link.issue.reference}`).join(", ") : "none"}`
	].join("\n");
}

export function renderCurrentTenant(result: {
	command: "current-tenant";
	dbPath: string;
	tenantId: string;
	workspaceRoot: string;
}): string {
	return [
		`Current tenant: ${result.tenantId}`,
		`Workspace root: ${result.workspaceRoot}`,
		`Database: ${result.dbPath}`
	].join("\n");
}

export function renderProjectIdentity(result: {
	command: "project-identity";
	identity: string;
	source: string;
}): string {
	return [`Project identity: ${result.identity}`, `Source: ${result.source}`].join("\n");
}

export function renderTenantList(result: {
	command: "list-tenants";
	currentTenantId: string;
	dbPath: string;
	tenants: ReturnType<typeof listTenants>;
}): string {
	const lines = [`Tenants in ${result.dbPath}`];

	if (result.tenants.length === 0) {
		lines.push("none");
		return lines.join("\n");
	}

	for (const tenant of result.tenants) {
		const marker = tenant.id === result.currentTenantId ? "*" : "-";
		lines.push(
			`${marker} ${tenant.id} (${tenant.displayName}) entities=${tenant.counts.entities} relations=${tenant.counts.relations} contexts=${tenant.counts.contexts} terms=${tenant.counts.contextTerms} history=${tenant.counts.historyEntries}`
		);
	}

	return lines.join("\n");
}

export function renderDeleteTenant(result: {
	command: "delete-tenant";
	dbPath: string;
	tenantId: string;
	displayName: string;
	removed: boolean;
	counts: {
		entities: number;
		relations: number;
		contexts: number;
		contextTerms: number;
		historyEntries: number;
	};
	counters: number;
}): string {
	if (!result.removed) {
		return `Tenant not found: ${result.tenantId}`;
	}

	return [
		`Deleted tenant ${result.tenantId} (${result.displayName})`,
		`Database: ${result.dbPath}`,
		`Removed rows: entities=${result.counts.entities} relations=${result.counts.relations} contexts=${result.counts.contexts} terms=${result.counts.contextTerms} history=${result.counts.historyEntries} counters=${result.counters}`
	].join("\n");
}

export function renderRenameTenant(result: {
	command: "rename-tenant";
	dbPath: string;
	previousTenantId: string;
	previousDisplayName: string;
	newTenantId: string;
	newDisplayName: string;
	renamed: boolean;
	counts: {
		entities: number;
		relations: number;
		contexts: number;
		contextTerms: number;
		historyEntries: number;
	};
	counters: number;
}): string {
	if (!result.renamed) {
		return `Tenant not found: ${result.previousTenantId}`;
	}

	return [
		`Renamed tenant ${result.previousTenantId} (${result.previousDisplayName}) to ${result.newTenantId} (${result.newDisplayName})`,
		`Database: ${result.dbPath}`,
		`Moved rows: entities=${result.counts.entities} relations=${result.counts.relations} contexts=${result.counts.contexts} terms=${result.counts.contextTerms} history=${result.counts.historyEntries} counters=${result.counters}`
	].join("\n");
}

export function renderLiveSite(result: Awaited<ReturnType<typeof startLiveSite>>["info"]): string {
	return [
		`Serving live site at ${result.url}`,
		`Database: ${result.dbPath}`,
		`Port: ${result.port}`,
		"Keep this process running to continue listening for database changes."
	].join("\n");
}

export function renderStartedLiveSite(result: { port: number; started: boolean; url: string }): string {
	return `Started live site at ${result.url}`;
}

export function renderStopLiveSite(result: { host: string; port: number; url: string; reachable: boolean; stopped: boolean }): string {
	if (!result.stopped) {
		if (result.reachable) {
			return `A server is listening at ${result.url}, but it does not expose the agent-issues stop endpoint.`;
		}

		return `No live site was running at ${result.url}`;
	}

	return `Stopped live site at ${result.url}`;
}

export function renderBackfillBodies(result: {
	command: "backfill-bodies";
	dbPath: string;
	dryRun: boolean;
	force: boolean;
	kinds: BackfillableBodyKind[];
	scope: "current-tenant" | "all-tenants";
	tenants: BackfillBodiesResult[];
}): string {
	const lines = [
		`${result.dryRun ? "Previewed" : "Backfilled"} bodies in ${result.scope === "all-tenants" ? "all tenants" : "the current tenant"}`,
		`Database: ${result.dbPath}`,
		`Kinds: ${result.kinds.join(", ")}`,
		`Dry run: ${result.dryRun ? "yes" : "no"}`,
		`Force overwrite: ${result.force ? "yes" : "no"}`
	];

	if (result.tenants.length === 0) {
		lines.push("No tenants were present in the selected database.");
		return lines.join("\n");
	}

	for (const tenant of result.tenants) {
		lines.push(
			"",
			`Tenant ${tenant.tenantId}`,
			`  considered=${tenant.considered} updated=${tenant.updated} skipped=${tenant.skipped}`
		);

		for (const kind of tenant.byKind) {
			lines.push(`  ${kind.kind}: considered=${kind.considered} updated=${kind.updated} skipped=${kind.skipped}`);
		}
	}

	return lines.join("\n");
}

function renderCompactList(entities: Array<{ reference: string; status: string }>): string {
	if (entities.length === 0) {
		return "none";
	}

	return entities.map((entity) => `${entity.reference}:${entity.status}`).join(", ");
}

function renderEntityLine(entity: { id: string; kind: string; status: string; title: string }): string {
	return `${entity.id} ${entity.kind} ${entity.status} ${entity.title}`;
}

function indentBlock(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

export function renderAuthLogin(session: Extract<SavedLoginView, { kind: "remote" }>): string {
	return [
		`Logged in as ${session.displayName ?? session.userId} (tenant ${session.tenantId})`,
		`Session expires: ${session.expiresAt}`
	].join("\n");
}

export function renderAuthList(logins: Array<{ login: SavedLoginView; active: boolean }>): string {
	return logins
		.map(({ login, active }) => {
			const destination = login.kind === "local" ? "local" : `remote ${login.serviceUrl}`;
			return `${active ? "*" : "-"} ${login.name} (${destination})`;
		})
		.join("\n");
}

export function renderAuthLogout(name: string): string {
	return `Removed saved login ${name}.`;
}


export function renderAuthStatus(login: SavedLoginView): string {
	if (login.kind === "local") {
		return ["Active saved login: local", "Destination: local"].join("\n");
	}

	return [
		`Active saved login: ${login.name}`,
		"Destination: remote",
		`Remote URL: ${login.serviceUrl}`,
		`Identity: ${login.displayName ?? login.userId} (tenant ${login.tenantId})`,
		`Session expires: ${login.expiresAt}`
	].join("\n");
}

export function renderAuthSwitch(login: SavedLoginView): string {
	return `Switched to saved login ${login.name}.`;
}

export function renderAgentInit(result: { host: "claude" | "copilot" }): string {
	return `Installed the Agent Issues plugin for ${result.host}.`;
}

export function renderSynchronize(result: {
	command: "synchronize";
	cloudApiUrl: string;
	tenantId: string;
	summary: SynchronizeSummary;
}): string {
	const { summary } = result;
	const appliedTotal = summary.entriesAppliedToLocal + summary.entriesAppliedToCloud;
	const createdTotal = summary.entitiesCreatedLocal.length + summary.entitiesCreatedCloud.length;
	const updatedTotal = summary.entitiesUpdatedLocal.length + summary.entitiesUpdatedCloud.length;
	const relationsTotal = summary.relationsAppliedToLocal + summary.relationsAppliedToCloud;
	const contextsTotal =
		summary.contextsAppliedToLocal +
		summary.contextsAppliedToCloud +
		summary.contextTermsAppliedToLocal +
		summary.contextTermsAppliedToCloud;

	if (
		appliedTotal === 0 &&
		createdTotal === 0 &&
		updatedTotal === 0 &&
		relationsTotal === 0 &&
		contextsTotal === 0 &&
		summary.concurrentEditConflicts === 0
	) {
		return `Already in sync with ${result.cloudApiUrl} (tenant ${result.tenantId}).`;
	}

	const lines = [
		`Synchronized with ${result.cloudApiUrl} (tenant ${result.tenantId}).`,
		`History entries applied: ${summary.entriesAppliedToLocal} to local, ${summary.entriesAppliedToCloud} to cloud`,
		`Entities created: ${summary.entitiesCreatedLocal.length} local, ${summary.entitiesCreatedCloud.length} cloud`,
		`Entities updated: ${summary.entitiesUpdatedLocal.length} local, ${summary.entitiesUpdatedCloud.length} cloud`,
		`Relations applied: ${summary.relationsAppliedToLocal} to local, ${summary.relationsAppliedToCloud} to cloud`,
		`Contexts applied: ${summary.contextsAppliedToLocal} to local, ${summary.contextsAppliedToCloud} to cloud`,
		`Context terms applied: ${summary.contextTermsAppliedToLocal} to local, ${summary.contextTermsAppliedToCloud} to cloud`
	];

	if (summary.concurrentEditConflicts > 0) {
		lines.push(`Concurrent-edit conflicts resolved by last-writer-wins: ${summary.concurrentEditConflicts}`);
	}

	return lines.join("\n");
}
