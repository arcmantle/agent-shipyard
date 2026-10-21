import type { UserDirectoryRecord } from "../user-directory/user-directory.js";

export interface UserDirectoryStore {
	upsertUser(input: { authenticationSubject: string; displayName?: string | null }): Promise<UserDirectoryRecord>;
	listUsers(): Promise<UserDirectoryRecord[]>;
}