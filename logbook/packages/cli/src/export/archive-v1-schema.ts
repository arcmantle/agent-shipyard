import { z } from "zod";
import { BODY_SOURCES, ENTITY_CATEGORIES, ENTITY_KINDS, ENTITY_PRIORITIES, type MigrationWireBundle } from "@agent-issues/core";

const text = z.string();
const id = text.uuid();
const hash = text.regex(/^[a-f0-9]{64}$/);
const time = text.datetime();
const revision = z.number().int().positive();
const identity = { id, reference: text.min(1), shortReference: text.optional(), createdBy: text.min(1), updatedBy: text.min(1), revision, contentHash: hash, createdAt: time, updatedAt: time };
const delta = z.object({
	id, revision, author: text.min(1), createdAt: time, patchFormat: z.literal(1),
	reversePatch: text.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
	sourceHash: hash, targetHash: hash, restoredFromRevision: revision.optional()
}).strict();
const chain = <T extends z.ZodRawShape>(head: T) => z.object({ head: z.object(head).strict(), deltas: z.array(delta) }).strict();

export const migrationWireV1Schema: z.ZodType<MigrationWireBundle> = z.object({
	chains: z.object({
		entities: z.array(chain({
			...identity, kind: z.enum(ENTITY_KINDS), title: text, body: text, bodySource: z.enum(BODY_SOURCES),
			category: z.enum(ENTITY_CATEGORIES).nullable(), priority: z.enum(ENTITY_PRIORITIES).nullable(),
			type: z.enum(["pioneer-map", "pioneer-ticket"]).nullable(), status: text,
			parentId: id.nullable(), projectId: id.nullable().optional(), tombstone: z.boolean()
		})),
		contexts: z.array(chain({ ...identity, key: text, scopeEntityId: id.nullable(), title: text, summary: text })),
		contextTerms: z.array(chain({ ...identity, contextKey: text, term: text, definition: text, avoid: z.array(text), tombstone: z.boolean() })),
		issueComments: z.array(chain({ ...identity, issueId: id, body: text, referencedIssueIds: z.array(id), tombstone: z.boolean() })),
		planEntries: z.array(chain({
			...identity, planId: id, body: text, role: z.enum(["question", "decision", "scope", "constraint", "preference", "consideration"]),
			scopeDirection: z.enum(["included", "excluded"]).nullable(), referencedEntityIds: z.array(id), supersededEntryIds: z.array(id), tombstone: z.boolean()
		})),
		completionObservations: z.array(z.object({
			id, issueId: id, completionOrdinal: revision, repositoryIdentity: text.nullable(), commitSha: text.nullable(),
			branch: text.nullable(), dirty: z.boolean().nullable(), capturedAt: time,
			calculatedVersionState: z.enum(["available", "unknown"]), calculatedVersion: text.nullable(),
			diagnostics: z.array(z.object({ code: text, message: text }).strict())
		}).strict()).optional(),
		users: z.array(z.object({ id, authenticationSubject: text, displayName: text.nullable(), updatedAt: time }).strict())
	}).strict(),
	relations: z.array(z.object({
		fromId: id, toId: id, type: z.enum(["contains", "owns", "records", "tracks", "creates", "decomposes", "taggedWith", "supersedes", "relatesTo", "informs", "fixes", "constrains", "resolves", "blocks", "handsOff"]),
		createdBy: text, createdAt: time
	}).strict()),
	issueBreakdownDrafts: z.array(z.object({
		id, targetId: id, status: text, snapshotJson: text, snapshotDigest: text, approvedAt: time.nullable(),
		createdIssueReferences: text, createdAt: time, updatedAt: time
	}).strict()),
	projectSettings: z.array(z.object({ projectId: id, prospectorSettings: text }).strict()),
	instructions: z.object({
		overrides: z.array(z.object({ itemKey: text, kind: text, body: text, revision, contentHash: hash, defaultVersion: text }).strict()),
		personalFragments: z.array(z.object({ itemKey: text, body: text, revision, contentHash: hash, removed: z.boolean() }).strict()),
		history: z.array(z.object({ itemKey: text, kind: text, body: text, revision, contentHash: hash, defaultVersion: text, isDefault: z.boolean() }).strict())
	}).strict()
}).strict();

export const archiveManifestV1Schema = z.object({
	format: z.literal("agent-logbook-project"),
	version: z.literal(1),
	projectId: id,
	generatedAt: time,
	instructionsIncluded: z.boolean(),
	documents: z.array(z.object({
		section: z.enum(["entities", "contexts", "contextTerms", "issueComments", "planEntries"]),
		id, file: text.min(1), originalFile: text.min(1)
	}).strict())
}).strict();

export type ArchiveManifestV1 = z.infer<typeof archiveManifestV1Schema>;
