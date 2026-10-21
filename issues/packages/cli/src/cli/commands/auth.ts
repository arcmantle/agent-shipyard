import { createInterface } from "node:readline/promises";

import { Option } from "clipanion";

import {
	getActiveSavedLogin,
	listSavedLogins,
	removeSavedLogin,
	saveSavedLogin,
	setActiveSavedLogin,
	toSavedLoginView,
	type SavedLoginStoreOptions,
	type RemoteSavedLogin
} from "../../auth/auth-session.js";
import { discoverServiceAuth } from "../../auth/service-discovery.js";

import { renderAuthList, renderAuthLogin, renderAuthLogout, renderAuthStatus, renderAuthSwitch } from "../renderers.js";
import { BaseCommand } from "../shared.js";

export type DeviceCodeLoginResult = {
	tenantId: string;
	userId: string;
	displayName?: string;
	accessToken: string;
	expiresAt: string;
};

/** Reports the human-readable device-code instructions Entra returns (e.g. "go to microsoft.com/devicelogin and enter code ABCD-EFGH"). */
export type DeviceCodePrompt = (message: string) => void;

/**
 * Runs the interactive Entra ID device-code exchange and resolves the
 * identity + token it produced. The real implementation
 * (`../../entra-device-login.js`) is the genuine HITL gap this repo cannot
 * exercise: it requires a human to complete a device-code login in a
 * browser against a real Azure tenant (ISS32's acceptance criteria).
 */
export type DeviceCodeLoginFn = (options: {
	tenantId: string;
	clientId: string;
	onDeviceCode: DeviceCodePrompt;
}) => Promise<DeviceCodeLoginResult>;

export type RemoteLoginDependencies = {
	deviceCodeLogin: DeviceCodeLoginFn;
	fetch?: typeof globalThis.fetch;
	onDeviceCode: DeviceCodePrompt;
	storeOptions?: SavedLoginStoreOptions;
};

export async function performRemoteLogin(
	input: { name: string; serviceUrl: string },
	dependencies: RemoteLoginDependencies
): Promise<RemoteSavedLogin> {
	if (input.name === "local") {
		throw new Error('Saved-login name "local" is reserved.');
	}

	const discovered = await discoverServiceAuth(input.serviceUrl, dependencies.fetch);
	const result = await dependencies.deviceCodeLogin({
		tenantId: discovered.auth.tenantId,
		clientId: discovered.auth.clientId,
		onDeviceCode: dependencies.onDeviceCode
	});
	const login: RemoteSavedLogin = {
		name: input.name,
		kind: "remote",
		serviceUrl: discovered.serviceUrl,
		tenantId: result.tenantId,
		userId: result.userId,
		displayName: result.displayName,
		accessToken: result.accessToken,
		expiresAt: result.expiresAt
	};

	await saveSavedLogin(login, dependencies.storeOptions);
	return login;
}

export class AuthLoginCommand extends BaseCommand {
	public static paths = [["auth", "login"]];

	public name = Option.String("--name");
	public serviceUrl = Option.String("--url");

	public async execute(): Promise<number> {
		const login = await this.loginRemote();
		const view = toSavedLoginView(login);
		this.print({ command: "auth-login" as const, login: view }, renderAuthLogin(view));
		return 0;
	}

	private async loginRemote(): Promise<RemoteSavedLogin> {
		const { name, serviceUrl } = await this.resolveRemoteInput();
		const dependencies = this.context.authLoginDependencies;
		const deviceCodeLogin = dependencies?.deviceCodeLogin
			?? (await import("../../auth/entra-device-login.js")).acquireEntraDeviceCodeSession;

		return performRemoteLogin(
			{ name, serviceUrl },
			{
				deviceCodeLogin,
				fetch: dependencies?.fetch,
				onDeviceCode: (message) => this.context.stdout.write(`${message}\n`),
				storeOptions: this.context.credentialStoreOptions
			}
		);
	}

	private async resolveRemoteInput(): Promise<{ name: string; serviceUrl: string }> {
		let name = this.name?.trim();
		let serviceUrl = this.serviceUrl?.trim();
		if (this.asJson) {
			if (!name) throw new Error("`auth login --json` requires --name <name>.");
			if (!serviceUrl) throw new Error("`auth login --json` requires --url <url>.");
			return { name, serviceUrl };
		}

		const dependencies = this.context.authLoginDependencies;
		const interactive = dependencies?.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
		if ((!name || !serviceUrl) && !interactive) {
			throw new Error("`auth login` requires --name <name> and --url <url> outside an interactive terminal.");
		}
		const prompt = dependencies?.prompt ?? ((question: string) => this.prompt(question));
		name ||= (await prompt("Saved login name: ")).trim();
		serviceUrl ||= (await prompt("Service URL: ")).trim();
		if (!name) throw new Error("Saved-login name cannot be empty.");
		if (!serviceUrl) throw new Error("Service URL cannot be empty.");
		return { name, serviceUrl };
	}

	private async prompt(question: string): Promise<string> {
		const readline = createInterface({ input: process.stdin, output: this.context.stdout, terminal: true });
		try {
			return await readline.question(question);
		} finally {
			readline.close();
		}
	}

}

export class AuthListCommand extends BaseCommand {
	public static paths = [["auth", "list"]];

	public async execute(): Promise<number> {
		const logins = await listSavedLogins(this.context.credentialStoreOptions);
		const active = await getActiveSavedLogin(this.context.credentialStoreOptions);
		const views = logins.map((login) => ({ login: toSavedLoginView(login), active: login.name === active.name }));
		this.print({ command: "auth-list" as const, logins: views }, renderAuthList(views));
		return 0;
	}
}

export class AuthLogoutCommand extends BaseCommand {
	public static paths = [["auth", "logout"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		const active = await getActiveSavedLogin(this.context.credentialStoreOptions);
		const name = this.positionals[0] ?? active.name;
		await removeSavedLogin(name, this.context.credentialStoreOptions);
		this.print({ command: "auth-logout" as const, name }, renderAuthLogout(name));
		return 0;
	}
}

export class AuthStatusCommand extends BaseCommand {
	public static paths = [["auth", "status"]];

	public async execute(): Promise<number> {
		const login = await getActiveSavedLogin(this.context.credentialStoreOptions);
		const view = toSavedLoginView(login);
		this.print({ command: "auth-status" as const, login: view }, renderAuthStatus(view));
		return 0;
	}
}

export class AuthSwitchCommand extends BaseCommand {
	public static paths = [["auth", "switch"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		const name = this.positionals[0] ?? (await this.getNextSavedLoginName());
		await setActiveSavedLogin(name, this.context.credentialStoreOptions);
		const login = await getActiveSavedLogin(this.context.credentialStoreOptions);
		const view = toSavedLoginView(login);
		this.print({ command: "auth-switch" as const, login: view }, renderAuthSwitch(view));
		return 0;
	}

	private async getNextSavedLoginName(): Promise<string> {
		const logins = await listSavedLogins(this.context.credentialStoreOptions);
		const active = await getActiveSavedLogin(this.context.credentialStoreOptions);
		const activeIndex = logins.findIndex(({ name }) => name === active.name);
		return logins[(activeIndex + 1) % logins.length].name;
	}
}
