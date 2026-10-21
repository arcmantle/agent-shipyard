import { createHash } from "node:crypto";

const USER_ID_NAMESPACE = "agent-issues/user-stable-id/v1";
export const SYSTEM_AUTHENTICATION_SUBJECT = "agent-issues:system";

export type UserIdentity = {
	id: string;
	authenticationSubject: string;
};

export type UserDirectoryRecord = UserIdentity & {
	displayName: string | null;
	updatedAt: string;
};

export function deriveUserIdentity(authenticationSubject: string): UserIdentity {
	const bytes = createHash("sha256")
		.update(USER_ID_NAMESPACE)
		.update("\0")
		.update(`${Buffer.byteLength(authenticationSubject, "utf8")}:${authenticationSubject}`)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x80;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return {
		id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
		authenticationSubject
	};
}

export function mergeUserDirectories(left: UserDirectoryRecord[], right: UserDirectoryRecord[]): UserDirectoryRecord[] {
	const users = new Map<string, UserDirectoryRecord>();
	for (const candidate of [...left, ...right]) {
		const current = users.get(candidate.id);
		if (!current) {
			users.set(candidate.id, candidate);
			continue;
		}
		if (current.authenticationSubject !== candidate.authenticationSubject) {
			throw new Error(`User identity collision: ${candidate.id}.`);
		}
		users.set(candidate.id, selectUserDirectoryRecord(current, candidate));
	}
	return [...users.values()].sort((leftUser, rightUser) => leftUser.id.localeCompare(rightUser.id));
}

function selectUserDirectoryRecord(left: UserDirectoryRecord, right: UserDirectoryRecord): UserDirectoryRecord {
	if (left.displayName === null) return right;
	if (right.displayName === null) return left;
	if (left.updatedAt > right.updatedAt) return left;
	if (left.updatedAt < right.updatedAt) return right;
	return left.displayName > right.displayName ? left : right;
}