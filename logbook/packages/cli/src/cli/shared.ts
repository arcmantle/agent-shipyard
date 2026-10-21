import { readFile } from "node:fs/promises";
import type { Writable } from "node:stream";

import { Command, Option, type BaseContext } from "clipanion";

import type { StorageDriver } from "@agent-issues/core";
import { readBuildContentHash, type ContextDirectoryView, type DatabaseLocationOptions } from "@agent-issues/api-local";
import type { SavedLoginStoreOptions } from "../auth/auth-session.js";
import { openStorageDriver } from "../runtime/open-storage-driver.js";

export type AgentIssuesContext = BaseContext & {
	agentInitProgressActive?: boolean;
	cwd: string;
	agentInitDependencies?: {
		run: AgentInitRunner;
	};
	authLoginDependencies?: {
		deviceCodeLogin?: (options: {
			tenantId: string;
			clientId: string;
			onDeviceCode: (message: string) => void;
		}) => Promise<{
			tenantId: string;
			userId: string;
			displayName?: string;
			accessToken: string;
			expiresAt: string;
		}>;
		fetch?: typeof globalThis.fetch;
		interactive?: boolean;
		prompt?: (question: string) => Promise<string>;
	};
	/**
	 * Overrides how `auth-session.ts` reaches the native OS credential store
	 * (ISS185, ADR46). Production never sets this - the real OS tool is used.
	 * Tests inject an in-memory fake here (via `runCli`'s context argument)
	 * so `auth login`/`logout`/`status`/`switch` never shell out to the
	 * developer's or CI machine's real credential store.
	 */
	credentialStoreOptions?: SavedLoginStoreOptions;
};

export type AgentInitRunner = (
	command: string,
	args: string[],
	options: { quiet: boolean }
) => Promise<string>;

export type EntityView = "compact" | "full";

export const CONTEXT_SUBCOMMANDS = new Set(["list", "show", "search", "conflicts", "set", "define", "forget"]);
const BODY_FILE_READ_ATTEMPTS = 3;

export abstract class BaseCommand extends Command<AgentIssuesContext> {
	public asJson = Option.Boolean("--json", false);
	public prettyJson = Option.Boolean("--pretty", false);
	public projectIdentity = Option.String("--project-identity");

	protected print(payload: object, text: string) {
		printOutput(this.context.stdout, this.asJson, this.prettyJson, payload, text);
	}

	/**
	 * The `withStore`/`openStorageDriver` options every command needs: the
	 * invoking cwd (for database-path resolution) and this invocation's
	 * `credentialStoreOptions` override (ISS185) so auth-session lookups in
	 * cloud mode go through whatever the test injected via `runCli`'s
	 * context instead of always defaulting to the real OS credential store.
	 */
	protected withStoreOptions(
		extra?: DatabaseLocationOptions
	): DatabaseLocationOptions & { credentialStoreOptions?: SavedLoginStoreOptions } {
		return {
			credentialStoreOptions: this.context.credentialStoreOptions,
			currentWorkingDirectory: this.context.cwd,
			projectIdentity: this.projectIdentity,
			...extra
		};
	}
}

export abstract class TenantCommand extends BaseCommand {
	public dbPath = Option.String("--db");
}

export abstract class MutableTenantCommand extends TenantCommand {
	public force = Option.Boolean("--force", false);
}

export abstract class BodyTenantCommand extends TenantCommand {
	public bodyFile = Option.String("--body-file");

	protected async resolveBody(): Promise<string | undefined> {
		return resolveMarkdownFileOption(this.bodyFile, "--body-file");
	}
}

export abstract class TargetCommand extends BaseCommand {
	public force = Option.Boolean("--force", false);
	public target = Option.String("--target");
}

/**
 * Opens the storage-driver seam for one command invocation and closes it
 * afterwards, replacing the repeated `ensureDatabase` + try/finally pattern
 * every command used before the seam existed (ADR11, ADR13). Delegates to
 * `openStorageDriver` (ADR18) to pick `SqliteStore` or `HttpStore` per the
 * resolved backend, so commands never branch on backend themselves. Hands
 * the resolved `dbPath` back too, since a few commands echo it in their
 * output (the cloud API URL in cloud mode, per `OpenStorageDriverResult`).
 *
 * Passes this install's build-content-hash so local mode's daemon routing
 * (ISS190, ADR44/45) can detect a stale already-running daemon.
 */
export async function withStore<T>(
	dbPath: string | undefined,
	options: (DatabaseLocationOptions & { credentialStoreOptions?: SavedLoginStoreOptions }) | undefined,
	fn: (store: StorageDriver, dbPath: string) => Promise<T>
): Promise<T> {
	const { store, dbPath: resolvedDbPath } = await openStorageDriver({
		dbPath,
		databaseOptions: options,
		authSessionOptions: options?.credentialStoreOptions,
		localDaemon: { buildHash: readBuildContentHash() }
	});

	try {
		return await fn(store, resolvedDbPath);
	} finally {
		await store.close();
	}
}

export function parseContextView(value: string | undefined): ContextDirectoryView {
	if (!value) {
		return "all";
	}

	if (value === "all" || value === "global" || value === "initiatives") {
		return value;
	}

	throw new Error(`Unknown context view: ${value}`);
}

export function parseEntityView(value: string | undefined): EntityView {
	if (value === undefined || value === "compact") {
		return "compact";
	}

	if (value === "full") {
		return value;
	}

	throw new Error(`Unknown entity view: ${value}`);
}

export function parseCsvOption(value: string | undefined): string[] {
	if (!value) {
		return [];
	}

	return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

export function parsePositiveIntegerOption(value: string | undefined, optionName: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${optionName} must be a positive integer: ${value}`);
	}

	return parsed;
}

export function parsePortOption(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	const parsedPort = Number(value);
	if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
		throw new Error(`Invalid port: ${value}`);
	}

	return parsedPort;
}

export function stringifyJson(value: unknown, pretty: boolean): string {
	return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

export function printOutput(output: Writable, asJson: boolean, prettyJson: boolean, payload: object, text: string) {
	if (asJson) {
		output.write(`${stringifyJson(payload, prettyJson)}\n`);
		return;
	}

	output.write(`${text}\n`);
}

export function requirePositional(positionals: string[], index: number, usage: string): string {
	const value = positionals[index];

	if (!value) {
		throw new Error(`Missing argument. Usage: ${usage}`);
	}

	return value;
}

export function requireOption(value: string | undefined, message: string): string {
	if (!value) {
		throw new Error(message);
	}

	return value;
}

/**
 * Reads a large-markdown option's value from a file (or from stdin when the
 * value is `-`). Every command that accepts a large authored-markdown field
 * (entity, context summary, term definition) uses the same `--body-file`
 * flag - never an inline flag value - since inline multiline markdown breaks
 * shell quoting and lands in shell history and process listings.
 */
export async function resolveMarkdownFileOption(
	filePath: string | undefined,
	flagName: string,
	stdin: AsyncIterable<string | Uint8Array> = process.stdin
): Promise<string | undefined> {
	if (filePath === undefined) {
		return undefined;
	}

	if (filePath === "-") {
		try {
			return await readMarkdownStdin(stdin);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not read ${flagName} from stdin: ${message}`);
		}
	}

	try {
		return await readMarkdownFile(filePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read ${flagName} ${filePath}: ${message}`);
	}
}

async function readMarkdownFile(filePath: string): Promise<string> {
	return retryBodyRead(async () => await readFile(filePath, "utf8"));
}

async function readMarkdownStdin(stdin: AsyncIterable<string | Uint8Array>): Promise<string> {
	const chunks: string[] = [];
	for await (const chunk of stdin) {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
	}
	return chunks.join("");
}

async function retryBodyRead(read: () => string | Promise<string>): Promise<string> {
	for (let attempt = 1; attempt <= BODY_FILE_READ_ATTEMPTS; attempt += 1) {
		try {
			return await read();
		} catch (error) {
			if (!isEagainError(error) || attempt === BODY_FILE_READ_ATTEMPTS) {
				throw error;
			}
		}
	}

	throw new Error("Could not read body input.");
}

function isEagainError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EAGAIN";
}
