import { describe, expect, it } from "vitest";

import { EntityRevisionError, type BodySource, type EntityRevisionPatch } from "./domain.js";
import { applyReversePatch, materializeFromPatches } from "./materialize-revision.js";
import { createReverseFieldPatch, ENTITY_REVERSE_PATCH_REGISTRY } from "../reverse-field-patch/reverse-field-patch.js";

type EntityRevisionState = {
	title: string;
	body: string;
	bodySource: BodySource;
	category: "technical" | "security" | null;
	priority: "low" | "critical" | null;
	type: "pioneer-map" | "pioneer-ticket" | null;
	status: string;
	parentId: string | null;
	tombstone: boolean;
};

describe("materializeFromPatches", () => {
	it("restores category and priority from a prior revision", () => {
		const predecessor: EntityRevisionState = {
			title: "Initial",
			body: "Body",
			bodySource: "authored" as const,
			category: "technical" as const,
			priority: "low" as const,
			type: null,
			status: "open",
			parentId: "INIT1",
			tombstone: false
		};
		const successor: EntityRevisionState = {
			...predecessor,
			category: "security" as const,
			priority: "critical" as const
		};
		const materialized = materializeFromPatches(
			"DEBT1",
			{
				id: "DEBT1",
				...successor,
				revision: 2,
				createdAt: "2026-01-01T00:00:00.000Z"
			},
			[
				{
					revision: 2,
					author: "alice",
					createdAt: "2026-01-02T00:00:00.000Z",
					...createReverseFieldPatch(successor, predecessor, ENTITY_REVERSE_PATCH_REGISTRY)
				}
			],
			1
		);

		expect(materialized).toMatchObject({
			category: "technical",
			priority: "low"
		});
	});

	it("materializes a generic reverse-field transition", () => {
		const predecessor: EntityRevisionState = { title: "Initial", body: "Body", bodySource: "authored", category: null, priority: null, type: null, status: "todo", parentId: null, tombstone: false };
		const successor: EntityRevisionState = { title: "Current", body: "Body!", bodySource: "generated", category: null, priority: null, type: null, status: "done", parentId: "INIT2", tombstone: true };
		const patch = {
			revision: 2,
			author: "alice",
			createdAt: "2026-01-02T00:00:00.000Z",
			...createReverseFieldPatch(successor, predecessor, ENTITY_REVERSE_PATCH_REGISTRY)
		};

		expect(applyReversePatch(successor, patch)).toEqual(predecessor);
	});

	it("applies content and lifecycle patches newest-first with target revision metadata", () => {
		const first: EntityRevisionState = { title: "First", body: "First body", bodySource: "authored", category: null, priority: null, type: null, status: "todo", parentId: null, tombstone: false };
		const second: EntityRevisionState = { title: "Second", body: "Second body", bodySource: "generated", category: null, priority: null, type: null, status: "in-progress", parentId: "INIT1", tombstone: false };
		const third: EntityRevisionState = { title: "Third", body: "Third body", bodySource: "authored", category: null, priority: null, type: null, status: "done", parentId: "INIT2", tombstone: false };
		const patches: EntityRevisionPatch[] = [
			{
				revision: 3,
				author: "third-author",
				createdAt: "2026-01-03T00:00:00.000Z",
				...createReverseFieldPatch(third, second, ENTITY_REVERSE_PATCH_REGISTRY)
			},
			{
				revision: 2,
				author: "second-author",
				createdAt: "2026-01-02T00:00:00.000Z",
				...createReverseFieldPatch(second, first, ENTITY_REVERSE_PATCH_REGISTRY)
			}
		];

		const materialized = materializeFromPatches(
			"ISS1",
			{
				id: "ISS1",
				...third,
				revision: 3,
				createdAt: "2026-01-01T00:00:00.000Z"
			},
			patches,
			2
		);

		expect(materialized).toEqual({
			entityId: "ISS1",
			targetRevision: 2,
			headRevision: 3,
			title: "Second",
			body: "Second body",
			bodySource: "generated",
			category: null,
			priority: null,
			type: null,
			status: "in-progress",
			parentId: "INIT1",
			tombstone: false,
			author: "second-author",
			createdAt: "2026-01-02T00:00:00.000Z",
			restoredFromRevision: null
		});
	});

	it("reports a stable broken-chain error when a required delta is absent", () => {
		expect(() =>
			materializeFromPatches(
				"ISS1",
				{
					id: "ISS1",
					title: "Third",
					body: "Third body",
					bodySource: "authored",
					category: null,
					priority: null,
					type: null,
					status: "done",
					parentId: null,
					tombstone: false,
					revision: 3,
					createdAt: "2026-01-01T00:00:00.000Z"
				},
				[],
				1
			)
		).toThrow(EntityRevisionError);

		try {
			materializeFromPatches(
				"ISS1",
				{
					id: "ISS1",
					title: "Third",
					body: "Third body",
					bodySource: "authored",
					category: null,
					priority: null,
					type: null,
					status: "done",
					parentId: null,
					revision: 3,
					createdAt: "2026-01-01T00:00:00.000Z"
				},
				[],
				1
			);
		} catch (error) {
			expect(error).toBeInstanceOf(EntityRevisionError);
			expect((error as EntityRevisionError).reason).toBe("broken-chain");
			expect((error as EntityRevisionError).headRevision).toBe(3);
		}
	});

	it("reports a broken chain when target revision metadata is absent", () => {
		try {
			materializeFromPatches(
				"ISS1",
				{
					id: "ISS1",
					title: "Third",
					body: "Third body",
					bodySource: "authored",
					category: null,
					priority: null,
					type: null,
					status: "done",
					parentId: null,
					tombstone: false,
					revision: 3,
					createdAt: "2026-01-01T00:00:00.000Z"
				},
				[
					{
						revision: 3,
						author: "third-author",
						createdAt: "2026-01-03T00:00:00.000Z",
						...createReverseFieldPatch(
							{ title: "Third", body: "Third body", bodySource: "authored", category: null, priority: null, type: null, status: "done", parentId: null, tombstone: false },
							{ title: "Second", body: "Second body", bodySource: "authored", category: null, priority: null, type: null, status: "done", parentId: null, tombstone: false },
							ENTITY_REVERSE_PATCH_REGISTRY
						)
					}
				],
				2
			);
			expect.unreachable("Expected materialization to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(EntityRevisionError);
			expect(error).toMatchObject({ reason: "broken-chain", headRevision: 3 });
		}
	});
});