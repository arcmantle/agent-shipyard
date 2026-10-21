import { randomBytes } from "node:crypto";

import { deleteCredential, getCredential, setCredential, type OsCredentialStoreOptions } from "@agent-issues/core";
import { resolveDaemonSlotKey } from "../daemon/daemon-state.js";

const SERVICE = "agent-issues-daemon";
const ACCOUNT = "local-daemon-token";

export type DaemonTokenStoreOptions = OsCredentialStoreOptions & { dbPath?: string };

function resolveAccount(options?: DaemonTokenStoreOptions): string {
	const slotKey = resolveDaemonSlotKey(options?.dbPath);
	return slotKey === "default" ? ACCOUNT : `${ACCOUNT}-${slotKey}`;
}

/** Mints a fresh, high-entropy per-instance daemon token (ISS184, ADR44). Not persisted by this call - see `saveDaemonToken`. */
export function mintDaemonToken(): string {
	return randomBytes(32).toString("hex");
}

/** Persists the current daemon instance's token via the native OS credential store (ADR46), overwriting any previous instance's token. */
export async function saveDaemonToken(token: string, options?: DaemonTokenStoreOptions): Promise<void> {
	await setCredential(SERVICE, resolveAccount(options), token, options);
}

/** Reads back the current daemon instance's token, or `undefined` if none has ever been saved (or a prior one was cleared). */
export async function readDaemonToken(options?: DaemonTokenStoreOptions): Promise<string | undefined> {
	return getCredential(SERVICE, resolveAccount(options), options);
}

/** Removes the daemon token, e.g. as part of the daemon's own idle-timeout/close shutdown. Safe to call even if no token was ever saved. */
export async function clearDaemonToken(options?: DaemonTokenStoreOptions): Promise<void> {
	await deleteCredential(SERVICE, resolveAccount(options), options);
}
