import { rmSync } from "node:fs";
import path from "node:path";

import { getCredential, resolveAgentIssuesHomeDirectory, setCredential, type OsCredentialStoreOptions } from "@agent-issues/core";

export type LocalSavedLogin = {
	name: "local";
	kind: "local";
};

export type RemoteSavedLogin = {
	name: string;
	kind: "remote";
	serviceUrl: string;
	tenantId: string;
	userId: string;
	displayName?: string;
	accessToken: string;
	expiresAt: string;
};

export type SavedLogin = LocalSavedLogin | RemoteSavedLogin;

export type SavedLoginView = LocalSavedLogin | Omit<RemoteSavedLogin, "accessToken">;

const LOCAL_SAVED_LOGIN: LocalSavedLogin = { name: "local", kind: "local" };

/** Strips remote credentials so callers can safely display or log a saved login. */
export function toSavedLoginView(login: LocalSavedLogin): LocalSavedLogin;
export function toSavedLoginView(login: RemoteSavedLogin): Omit<RemoteSavedLogin, "accessToken">;
export function toSavedLoginView(login: SavedLogin): SavedLoginView;
export function toSavedLoginView(login: SavedLogin): SavedLoginView {
	if (login.kind === "local") return login;
	const { accessToken: _accessToken, ...view } = login;
	return view;
}

export type SavedLoginStoreOptions = OsCredentialStoreOptions & {
	/**
	 * Overrides the directory checked for legacy plaintext routing files to
	 * remove during upgrade. Production defaults to
	 * `resolveAgentIssuesHomeDirectory()` (`~/.agent-issues`); tests inject a
	 * temp directory so no real user state is touched.
	 */
	homeDirectory?: string;
};

const SERVICE = "agent-issues-auth";
const ACCOUNT = "sessions";
const LEGACY_AUTH_SESSION_FILENAME = "auth.json";
const LEGACY_CLOUD_BINDINGS_FILENAME = "cloud-bindings.json";
const SAVED_LOGIN_CREDENTIAL_VERSION = 1;

type SavedLoginCredential = {
	version: typeof SAVED_LOGIN_CREDENTIAL_VERSION;
	activeName: string;
	remoteLogins: RemoteSavedLogin[];
};

function resolveLegacyFilePath(filename: string, options?: SavedLoginStoreOptions): string {
	const homeDirectory = options?.homeDirectory ?? resolveAgentIssuesHomeDirectory();
	return path.join(homeDirectory, filename);
}

function createLocalSavedLoginCredential(): SavedLoginCredential {
	return { version: SAVED_LOGIN_CREDENTIAL_VERSION, activeName: LOCAL_SAVED_LOGIN.name, remoteLogins: [] };
}

function parseSavedLoginCredential(raw: string): SavedLoginCredential | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;

		const { version, activeName, remoteLogins } = parsed as Partial<SavedLoginCredential>;
		if (version !== SAVED_LOGIN_CREDENTIAL_VERSION || typeof activeName !== "string" || !Array.isArray(remoteLogins)) {
			return undefined;
		}
		return {
			version,
			activeName,
			remoteLogins
		};
	} catch {
		return undefined;
	}
}

async function readSavedLoginCredential(options?: SavedLoginStoreOptions): Promise<SavedLoginCredential> {
	rmSync(resolveLegacyFilePath(LEGACY_AUTH_SESSION_FILENAME, options), { force: true });
	rmSync(resolveLegacyFilePath(LEGACY_CLOUD_BINDINGS_FILENAME, options), { force: true });

	const stored = await getCredential(SERVICE, ACCOUNT, options);
	if (stored !== undefined) {
		const current = parseSavedLoginCredential(stored);
		if (current) return current;
	}

	const migrated = createLocalSavedLoginCredential();
	await setCredential(SERVICE, ACCOUNT, JSON.stringify(migrated), options);
	return migrated;
}

async function writeSavedLoginCredential(file: SavedLoginCredential, options?: SavedLoginStoreOptions): Promise<void> {
	await setCredential(SERVICE, ACCOUNT, JSON.stringify(file), options);
}

/** Returns every saved login in switching order, beginning with local. */
export async function listSavedLogins(_options?: SavedLoginStoreOptions): Promise<SavedLogin[]> {
	return [LOCAL_SAVED_LOGIN, ...(await readSavedLoginCredential(_options)).remoteLogins];
}

/** Returns the one globally active saved login. */
export async function getActiveSavedLogin(options?: SavedLoginStoreOptions): Promise<SavedLogin> {
	const file = await readSavedLoginCredential(options);
	return file.remoteLogins.find(({ name }) => name === file.activeName) ?? LOCAL_SAVED_LOGIN;
}

/** Creates or refreshes a named remote login and makes it active. */
export async function saveSavedLogin(login: RemoteSavedLogin, options?: SavedLoginStoreOptions): Promise<void> {
	if (login.name === LOCAL_SAVED_LOGIN.name) {
		throw new Error('Saved-login name "local" is reserved.');
	}

	const file = await readSavedLoginCredential(options);
	const existingIndex = file.remoteLogins.findIndex(({ name }) => name === login.name);
	if (existingIndex === -1) {
		file.remoteLogins.push(login);
	} else {
		file.remoteLogins[existingIndex] = login;
	}
	file.activeName = login.name;
	await writeSavedLoginCredential(file, options);
}

/** Persists the globally active name when it identifies an existing saved login. */
export async function setActiveSavedLogin(name: string, options?: SavedLoginStoreOptions): Promise<void> {
	const file = await readSavedLoginCredential(options);
	if (name !== LOCAL_SAVED_LOGIN.name && !file.remoteLogins.some((login) => login.name === name)) {
		throw new Error(`No saved login named "${name}".`);
	}

	file.activeName = name;
	await writeSavedLoginCredential(file, options);
}

/** Removes a remote saved login, falling back to local when it was active. */
export async function removeSavedLogin(name: string, options?: SavedLoginStoreOptions): Promise<void> {
	if (name === LOCAL_SAVED_LOGIN.name) {
		throw new Error('The local saved login cannot be removed.');
	}

	const file = await readSavedLoginCredential(options);
	if (!file.remoteLogins.some((login) => login.name === name)) {
		throw new Error(`No saved login named "${name}".`);
	}

	file.remoteLogins = file.remoteLogins.filter((login) => login.name !== name);
	if (file.activeName === name) {
		file.activeName = LOCAL_SAVED_LOGIN.name;
	}
	await writeSavedLoginCredential(file, options);
}
