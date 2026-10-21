import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { assembleInstruction, compareInstructionSource, describeInstructionReleaseChanges, inspectInstructionDependencies, inspectInstructionReset, inspectInstructionResetAll, normalizeInstructionBundle, prepareInstructionChanges, prepareInstructionFragmentCreate, prepareInstructionFragmentRemove, prepareInstructionReset, prepareInstructionResetAll, prepareInstructionSave, previewInstruction, readInstructionSource } from "@agent-issues/core";
import type { CommitInstructionChangesInput, CreateInstructionFragmentInput, RemoveInstructionFragmentInput, InstructionBundle, InstructionKind, InstructionSnapshotItem, InstructionSourceResult, InstructionStore, RetrieveInstructionInput, RetrievedInstruction, SaveInstructionSourceInput } from "@agent-issues/core";
import type { SqliteInternalConnection } from "../../db/sqlite-executor.js";

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export class LocalInstructionStore implements InstructionStore {
	constructor(executor: SqliteInternalConnection) {
		this.executor = executor;
	}

	protected readonly executor: SqliteInternalConnection;

	async importBundle(bundle: InstructionBundle): Promise<void> {
		const { items } = normalizeInstructionBundle(bundle);
		const contentHash = hash(JSON.stringify(items));
		this.executor.drizzle.transaction(() => {
			const existing = this.executor.drizzle.get<{ content_hash: string }>(sql`
				SELECT content_hash FROM instruction_bundles WHERE version = ${bundle.version}
			`);
			if (existing) {
				if (existing.content_hash !== contentHash) throw new Error(`Instruction bundle is immutable: ${bundle.version}`);
				return;
			}
			this.executor.drizzle.run(sql`INSERT INTO instruction_bundles (version, content_hash) VALUES (${bundle.version}, ${contentHash})`);
			for (const item of items) {
				this.executor.drizzle.run(sql`
					INSERT INTO instruction_defaults (version, item_key, kind, body, revision, content_hash)
					VALUES (${bundle.version}, ${item.key}, ${item.kind}, ${item.body}, 1, ${hash(item.body)})
				`);
			}
		});
	}

	async retrieveInstruction(input: RetrieveInstructionInput): Promise<RetrievedInstruction> {
		return this.executor.drizzle.transaction(() => assembleInstruction(input, this.readItems(input.version)));
	}

	async previewInstruction(input: Parameters<InstructionStore["previewInstruction"]>[0]) {
		return this.executor.drizzle.transaction(() => previewInstruction(input, this.readItems(input.version)));
	}

	async inspectInstructionDependencies(input: RetrieveInstructionInput) {
		return this.executor.drizzle.transaction(() => inspectInstructionDependencies(input, this.readItems(input.version)));
	}

	async listInstructionSources(input: { version: string }) {
		return this.executor.drizzle.transaction(() => ({ version: input.version, items: this.readManagedItems(input.version) }));
	}

	async readInstructionSource(input: RetrieveInstructionInput): Promise<InstructionSourceResult> {
		return this.executor.drizzle.transaction(() => readInstructionSource(input, this.readManagedItems(input.version)));
	}

	async compareInstructionSource(input: RetrieveInstructionInput) {
		return this.executor.drizzle.transaction(() => {
			const current = readInstructionSource(input, this.readManagedItems(input.version));
			const rows = this.executor.drizzle.all<{ version: string; kind: InstructionKind; body: string; revision: number; content_hash: string }>(sql`
				SELECT version, kind, body, revision, content_hash FROM instruction_defaults WHERE item_key = ${input.key}
			`);
			return compareInstructionSource(input, current, rows.map((row) => ({
				version: row.version, key: input.key, kind: row.kind, body: row.body,
				source: { type: "default", revision: row.revision, contentHash: row.content_hash }
			})));
		});
	}

	async saveInstructionSource(input: SaveInstructionSourceInput): Promise<InstructionSourceResult> {
		return this.executor.drizzle.transaction(() => {
			const saved = prepareInstructionSave(input, this.readItems(input.version), hash(typeof input.body === "string" ? input.body : ""));
			this.writeSource(saved);
			return saved;
		});
	}

	async listInstructionHistory(input: RetrieveInstructionInput) {
		return this.executor.drizzle.transaction(() => this.readHistory(input));
	}

	protected readHistory(input: RetrieveInstructionInput) {
		const current = readInstructionSource(input, this.readItems(input.version));
		const rows = this.executor.drizzle.all<{ body: string; revision: number; content_hash: string; default_version: string | null; is_default: number }>(current.source.type === "personal"
			? sql`SELECT body, revision, content_hash, NULL AS default_version, 0 AS is_default FROM instruction_personal_fragments WHERE item_key = ${input.key} AND removed = 0 ORDER BY revision DESC`
			: sql`SELECT body, revision, content_hash, default_version, is_default FROM instruction_history WHERE item_key = ${input.key} ORDER BY revision DESC`);
		return { ...input, revisions: rows.map((row): InstructionSourceResult => ({
			version: input.version, key: input.key, kind: current.kind, body: row.body,
			source: row.is_default ? { type: "default", revision: row.revision, contentHash: row.content_hash } : row.default_version === null
				? { type: "personal", revision: row.revision, contentHash: row.content_hash }
				: { type: "override", revision: row.revision, contentHash: row.content_hash, defaultVersion: row.default_version }
		})) };
	}

	async readInstructionRevision(input: Parameters<InstructionStore["readInstructionRevision"]>[0]): Promise<InstructionSourceResult> {
		return this.executor.drizzle.transaction(() => this.readRevision(input));
	}

	protected readRevision(input: Parameters<InstructionStore["readInstructionRevision"]>[0]): InstructionSourceResult {
		const history = this.readHistory({ version: input.version, key: input.key });
		const revision = history.revisions.find((item) => item.source.revision === input.revision);
		if (!revision) throw new Error(`Instruction revision not found: ${input.key}@${input.revision}`);
		return revision;
	}

	async restoreInstructionRevision(input: Parameters<InstructionStore["restoreInstructionRevision"]>[0]): Promise<InstructionSourceResult> {
		return this.executor.drizzle.transaction(() => {
			const revision = this.readRevision(input);
			const saved = prepareInstructionSave({ version: input.version, key: input.key, body: revision.body, expectedRevision: input.expectedRevision }, this.readItems(input.version), hash(revision.body));
			this.writeSource(saved);
			return saved;
		});
	}

	async resetInstructionSource(input: Parameters<InstructionStore["resetInstructionSource"]>[0]): Promise<InstructionSourceResult> {
		return this.executor.drizzle.transaction(() => {
			const items = this.readItems(input.version);
			const reset = prepareInstructionReset(input, items, this.readDefault(input));
			this.writeResetSource(reset);
			return reset;
		});
	}

	async inspectInstructionReset(input: RetrieveInstructionInput) {
		return this.executor.drizzle.transaction(() => inspectInstructionReset(input, this.readItems(input.version), this.readDefault(input)));
	}

	async inspectInstructionResetAll(input: { version: string }) {
		return this.executor.drizzle.transaction(() => {
			const { items, defaults } = this.readResetAllItems(input.version);
			return inspectInstructionResetAll(input, items, defaults, { type: "local" });
		});
	}

	async resetInstructionAll(input: Parameters<InstructionStore["resetInstructionAll"]>[0]) {
		return this.executor.drizzle.transaction(() => {
			const { items, defaults } = this.readResetAllItems(input.version);
			const inspection = prepareInstructionResetAll(input, items, defaults, { type: "local" });
			for (const { currentSource, proposedSource } of inspection.overrides) {
				if (currentSource.source.type !== "override") throw new Error("Expected instruction override.");
				const defaultItem = proposedSource ?? this.readDefault({ version: currentSource.source.defaultVersion, key: currentSource.key });
				this.writeResetSource({ ...defaultItem, version: input.version, source: { ...defaultItem.source, revision: currentSource.source.revision + 1 } });
			}
			for (const fragment of inspection.personalFragments) this.appendFragment({ ...fragment, source: { ...fragment.source, revision: fragment.source.revision + 1 } }, true);
			return inspection;
		});
	}

	protected writeResetSource(reset: InstructionSourceResult): void {
		this.executor.drizzle.run(sql`INSERT INTO instruction_history (item_key, kind, body, revision, content_hash, default_version, is_default)
			VALUES (${reset.key}, ${reset.kind}, ${reset.body}, ${reset.source.revision}, ${reset.source.contentHash}, ${reset.version}, 1)`);
		this.executor.drizzle.run(sql`DELETE FROM instruction_overrides WHERE item_key = ${reset.key}`);
	}

	protected readResetAllItems(version: string) {
		if (!this.executor.drizzle.get(sql`SELECT 1 FROM instruction_bundles WHERE version = ${version}`)) throw new Error(`Instruction defaults unavailable for release: ${version}`);
		const rows = this.executor.drizzle.all<{ item_key: string; kind: InstructionKind; body: string; revision: number; content_hash: string; default_version: string }>(sql`SELECT item_key, kind, body, revision, content_hash, default_version FROM instruction_overrides`);
		const changed = rows.map((row): InstructionSnapshotItem => ({ key: row.item_key, kind: row.kind, body: row.body, source: { type: "override", revision: row.revision, contentHash: row.content_hash, defaultVersion: row.default_version } }));
		const personal = this.executor.drizzle.all<{ item_key: string; body: string; revision: number; content_hash: string }>(sql`
			SELECT fragment.item_key, fragment.body, fragment.revision, fragment.content_hash FROM instruction_personal_fragments AS fragment
			WHERE fragment.revision = (SELECT MAX(history.revision) FROM instruction_personal_fragments AS history WHERE history.item_key = fragment.item_key) AND fragment.removed = 0
		`);
		for (const row of personal) changed.push({ key: row.item_key, kind: "fragment", body: row.body, source: { type: "personal", revision: row.revision, contentHash: row.content_hash } });
		const defaults = this.executor.drizzle.all<{ item_key: string; kind: InstructionKind; body: string; revision: number; content_hash: string }>(sql`SELECT item_key, kind, body, revision, content_hash FROM instruction_defaults WHERE version = ${version}`)
			.map((row): InstructionSnapshotItem => ({ key: row.item_key, kind: row.kind, body: row.body, source: { type: "default", revision: row.revision, contentHash: row.content_hash } }));
		return { items: [...defaults.filter((item) => !changed.some((current) => current.key === item.key)), ...changed], defaults };
	}

	protected readDefault(input: RetrieveInstructionInput): InstructionSnapshotItem {
		const row = this.executor.drizzle.get<{ kind: InstructionKind; body: string; content_hash: string }>(sql`SELECT kind, body, content_hash FROM instruction_defaults WHERE version = ${input.version} AND item_key = ${input.key}`);
		if (!row) throw new Error(`Instruction default not found: ${input.key}`);
		return { key: input.key, kind: row.kind, body: row.body, source: { type: "default", revision: 1, contentHash: row.content_hash } };
	}

	async commitInstructionChanges(input: CommitInstructionChangesInput) {
		return this.executor.drizzle.transaction(() => {
			const items = this.readItems(input.version);
			const overrides = this.executor.drizzle.all<{ key: string; body: string }>(sql`SELECT item_key AS key, body FROM instruction_overrides`);
			const result = prepareInstructionChanges(input, items, hash, overrides);
			for (const change of result.changes) {
				if (change.operation === "remove") this.appendFragment(change.source, true);
				else this.writeSource(change.source);
			}
			return result;
		});
	}

	async createInstructionFragment(input: CreateInstructionFragmentInput): Promise<InstructionSourceResult> {
		return this.executor.drizzle.transaction(() => {
			const items = this.readItems(input.version);
			const latest = this.executor.drizzle.get<{ revision: number }>(sql`SELECT MAX(revision) AS revision FROM instruction_personal_fragments WHERE item_key = ${input.key}`);
			const created = prepareInstructionFragmentCreate(input, items, (latest?.revision ?? 0) + 1, hash(typeof input.body === "string" ? input.body : ""));
			this.appendFragment(created, false);
			return created;
		});
	}

	async removeInstructionFragment(input: RemoveInstructionFragmentInput): Promise<InstructionSourceResult> {
		return this.executor.drizzle.transaction(() => {
			const items = this.readItems(input.version);
			const overrides = this.executor.drizzle.all<{ key: string; body: string }>(sql`SELECT item_key AS key, body FROM instruction_overrides`);
			const removed = prepareInstructionFragmentRemove(input, items, [...items, ...overrides]);
			this.appendFragment(removed, true);
			return removed;
		});
	}

	protected writeSource(saved: InstructionSourceResult): void {
		if (saved.source.type === "personal") {
			this.appendFragment(saved, false);
			return;
		}
		if (saved.source.type !== "override") throw new Error("Expected instruction override.");
		this.executor.drizzle.run(sql`INSERT INTO instruction_history (item_key, kind, body, revision, content_hash, default_version)
			VALUES (${saved.key}, ${saved.kind}, ${saved.body}, ${saved.source.revision}, ${saved.source.contentHash}, ${saved.source.defaultVersion})`);
		this.executor.drizzle.run(sql`INSERT INTO instruction_overrides (item_key, kind, body, revision, content_hash, default_version)
			VALUES (${saved.key}, ${saved.kind}, ${saved.body}, ${saved.source.revision}, ${saved.source.contentHash}, ${saved.source.defaultVersion})
			ON CONFLICT (item_key) DO UPDATE SET body = excluded.body, revision = excluded.revision, content_hash = excluded.content_hash`);
	}

	protected appendFragment(item: InstructionSourceResult, removed: boolean): void {
		this.executor.drizzle.run(sql`INSERT INTO instruction_personal_fragments (item_key, revision, body, content_hash, removed)
			VALUES (${item.key}, ${item.source.revision}, ${item.body}, ${item.source.contentHash}, ${removed ? 1 : 0})`);
	}

	protected readManagedItems(version: string) {
		const items = this.readItems(version);
		const rows = this.executor.drizzle.all<{ version: string; item_key: string; kind: InstructionKind; body: string; revision: number; content_hash: string }>(sql`
			SELECT version, item_key, kind, body, revision, content_hash FROM instruction_defaults
			WHERE version = ${version} OR version IN (SELECT default_version FROM instruction_overrides)
		`);
		return describeInstructionReleaseChanges(version, items, rows.map((item) => ({
			version: item.version, key: item.item_key, kind: item.kind, body: item.body,
			source: { type: "default", revision: item.revision, contentHash: item.content_hash }
		})));
	}

	protected readItems(version: string): InstructionSnapshotItem[] {
		const bundle = this.executor.drizzle.get(sql`SELECT 1 FROM instruction_bundles WHERE version = ${version}`);
		if (!bundle) throw new Error(`Instruction defaults unavailable for release: ${version}`);
		const items = this.executor.drizzle.all<{ item_key: string; kind: InstructionKind; body: string; revision: number; content_hash: string; default_version: string | null }>(sql`
			SELECT defaults.item_key, defaults.kind, COALESCE(overrides.body, defaults.body) AS body,
				COALESCE(overrides.revision, (SELECT MAX(history.revision) FROM instruction_history AS history WHERE history.item_key = defaults.item_key), defaults.revision) AS revision, COALESCE(overrides.content_hash, defaults.content_hash) AS content_hash,
				overrides.default_version
			FROM instruction_defaults AS defaults LEFT JOIN instruction_overrides AS overrides ON overrides.item_key = defaults.item_key
			WHERE defaults.version = ${version} ORDER BY defaults.item_key
		`);
		const defaults: InstructionSnapshotItem[] = items.map((item) => ({ key: item.item_key, kind: item.kind, body: item.body,
			source: item.default_version === null
				? { type: "default", revision: item.revision, contentHash: item.content_hash }
				: { type: "override", revision: item.revision, contentHash: item.content_hash, defaultVersion: item.default_version }
		}));
		const personal = this.executor.drizzle.all<{ item_key: string; body: string; revision: number; content_hash: string }>(sql`
			SELECT fragment.item_key, fragment.body, fragment.revision, fragment.content_hash FROM instruction_personal_fragments AS fragment
			WHERE fragment.revision = (SELECT MAX(history.revision) FROM instruction_personal_fragments AS history WHERE history.item_key = fragment.item_key)
				AND fragment.removed = 0
		`);
		for (const item of personal) {
			if (defaults.some((current) => current.key === item.item_key)) throw new Error(`Personal fragment conflicts with release default: ${item.item_key}`);
			defaults.push({ key: item.item_key, kind: "fragment", body: item.body, source: { type: "personal", revision: item.revision, contentHash: item.content_hash } });
		}
		return defaults.sort((first, second) => first.key.localeCompare(second.key));
	}
}