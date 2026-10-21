import { describe, expect, it } from "vitest";

import { deriveUserIdentity, mergeUserDirectories, SYSTEM_AUTHENTICATION_SUBJECT } from "./user-directory.js";

describe("user directory identity", () => {
	it("derives one stable UUID from an authentication subject", () => {
		const first = deriveUserIdentity("entra:alice");

		expect(deriveUserIdentity("entra:alice")).toEqual(first);
		expect(deriveUserIdentity("entra:bob").id).not.toBe(first.id);
	});

	it("derives the reserved system user from its authentication subject", () => {
		expect(deriveUserIdentity(SYSTEM_AUTHENTICATION_SUBJECT)).toEqual({
			id: deriveUserIdentity(SYSTEM_AUTHENTICATION_SUBJECT).id,
			authenticationSubject: SYSTEM_AUTHENTICATION_SUBJECT
		});
	});

	it("keeps the newest non-empty display name with a deterministic tie-break", () => {
		const user = deriveUserIdentity("entra:alice");

		expect(mergeUserDirectories([
			{ ...user, displayName: "Alice", updatedAt: "2026-08-07T10:00:00.000Z" }
		], [
			{ ...user, displayName: "Alicia", updatedAt: "2026-08-07T10:00:00.000Z" },
			{ ...deriveUserIdentity("entra:bob"), displayName: null, updatedAt: "2026-08-07T10:00:00.000Z" }
		])).toEqual([
			{ ...deriveUserIdentity("entra:bob"), displayName: null, updatedAt: "2026-08-07T10:00:00.000Z" },
			{ ...user, displayName: "Alicia", updatedAt: "2026-08-07T10:00:00.000Z" }
		]);
	});
});