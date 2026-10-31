import { InteractionRequiredAuthError, type Configuration, type IPublicClientApplication } from "@azure/msal-browser";
import { describe, expect, it, vi } from "vitest";

import { startHostedSession } from "./hosted-session.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "https://logbook.example";

type FakeClient = IPublicClientApplication & { configuration?: Configuration };

function fakeClient(options: { account?: string; token?: string; silentFails?: boolean } = {}) {
	const account = options.account ? { username: options.account, name: options.account, homeAccountId: options.account } : undefined;
	const client = {
		initialize: vi.fn(async () => {}),
		handleRedirectPromise: vi.fn(async () => null),
		getAllAccounts: vi.fn(() => (account ? [account] : [])),
		setActiveAccount: vi.fn(),
		loginRedirect: vi.fn(async () => {}),
		logoutRedirect: vi.fn(async () => {}),
		acquireTokenRedirect: vi.fn(async () => {}),
		acquireTokenSilent: vi.fn(async () => {
			if (options.silentFails) throw new Error("interaction_required");
			return { accessToken: options.token ?? "token" };
		})
	};
	return client as unknown as FakeClient & typeof client;
}

function fakeWindow(routes: Record<string, (init?: RequestInit) => Response>) {
	const calls: Array<{ url: string; authorization: string | null }> = [];
	const win = {
		location: new URL(`${ORIGIN}/#page=list&target=issue`) as unknown as Location,
		EventSource: undefined as unknown as typeof EventSource,
		fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), ORIGIN);
			calls.push({ url: url.href, authorization: new Headers(init?.headers).get("authorization") });
			const route = routes[url.origin === ORIGIN ? url.pathname : url.href];
			return route ? route(init) : new Response("missing", { status: 404 });
		}) as unknown as typeof fetch
	};
	return { win, calls };
}

const discovery = () => Response.json({ auth: { provider: "entra", tenantId: TENANT, clientId: CLIENT } });

describe("startHostedSession", () => {
	it("leaves the local CLI site unauthenticated when no discovery document exists", async () => {
		const { win } = fakeWindow({});
		const originalFetch = win.fetch;
		const createClient = vi.fn();

		await expect(startHostedSession({ win, createClient })).resolves.toBeUndefined();
		expect(createClient).not.toHaveBeenCalled();
		expect(win.fetch).toBe(originalFetch);
	});

	it("starts Entra sign-in with the API scope and returns to the requesting page", async () => {
		const { win } = fakeWindow({ "/.well-known/agent-issues": discovery });
		const client = fakeClient();

		void startHostedSession({ win, createClient: (configuration) => Object.assign(client, { configuration }) });
		await vi.waitFor(() => expect(client.loginRedirect).toHaveBeenCalledWith({ scopes: [`api://${CLIENT}/access_as_user`] }));
		expect(client.configuration?.auth).toMatchObject({ clientId: CLIENT, authority: `https://login.microsoftonline.com/${TENANT}`, redirectUri: `${ORIGIN}/` });
		expect(client.configuration?.cache?.cacheLocation).toBe("sessionStorage");
		expect(JSON.stringify(client.configuration)).not.toMatch(/secret/i);
	});

	it("authorizes same-origin data requests only, and renews sign-in when access is rejected or expired", async () => {
		const { win, calls } = fakeWindow({
			"/.well-known/agent-issues": discovery,
			"/api/project-summary": () => Response.json({ ok: true }),
			"/api/rejected": () => new Response("", { status: 401 }),
			"https://elsewhere.example/data": () => Response.json({})
		});
		const client = fakeClient({ account: "ada@example.com", token: "token-ada" });
		const session = await startHostedSession({ win, createClient: () => client });

		expect(session?.account.username).toBe("ada@example.com");
		await win.fetch("/api/project-summary?tenant=x");
		await win.fetch("https://elsewhere.example/data");
		expect(calls.slice(-2).map((call) => call.authorization)).toEqual(["Bearer token-ada", null]);

		void win.fetch("/api/rejected");
		await vi.waitFor(() => expect(client.acquireTokenRedirect).toHaveBeenCalledTimes(1));

		client.acquireTokenSilent.mockRejectedValueOnce(new InteractionRequiredAuthError("interaction_required", "Sign-in is required."));
		void win.fetch("/api/project-summary");
		await vi.waitFor(() => expect(client.acquireTokenRedirect).toHaveBeenCalledTimes(2));

		client.acquireTokenSilent.mockRejectedValueOnce(new Error("network"));
		await expect(win.fetch("/api/project-summary")).rejects.toThrow("network");
		expect(client.acquireTokenRedirect).toHaveBeenCalledTimes(2);

		await session!.signOut();
		expect(client.logoutRedirect).toHaveBeenCalledWith({ account: expect.objectContaining({ username: "ada@example.com" }) });
	});

	it("reports denied access after a fresh sign-in instead of redirecting again", async () => {
		const { win } = fakeWindow({ "/.well-known/agent-issues": discovery, "/api/project-summary": () => new Response("", { status: 401 }) });
		const client = fakeClient({ account: "eve@example.com" });
		client.handleRedirectPromise.mockResolvedValueOnce({ account: client.getAllAccounts()[0] } as never);
		await startHostedSession({ win, createClient: () => client });

		await expect(win.fetch("/api/project-summary")).resolves.toMatchObject({ status: 401 });
		expect(client.acquireTokenRedirect).not.toHaveBeenCalled();
	});

	it("keeps each signed-in user's token on that user's own requests and change events", async () => {
		const stream = () => new Response(new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('retry: 1000\r\ndata: {"type":"snapshot-changed","correlationId":"c1"}\r'));
				controller.enqueue(new TextEncoder().encode("\n\r\n"));
			}
		}), { headers: { "content-type": "text/event-stream" } });
		const ada = fakeWindow({ "/.well-known/agent-issues": discovery, "/events": stream, "/site-config.json": () => Response.json({}) });
		const bob = fakeWindow({ "/.well-known/agent-issues": discovery, "/site-config.json": () => Response.json({}) });
		await startHostedSession({ win: ada.win, createClient: () => fakeClient({ account: "ada@example.com", token: "token-ada" }) });
		await startHostedSession({ win: bob.win, createClient: () => fakeClient({ account: "bob@example.com", token: "token-bob" }) });

		await ada.win.fetch("/site-config.json");
		await bob.win.fetch("/site-config.json");
		const events = new ada.win.EventSource("/events");
		const message = await new Promise<string>((resolve) => { events.onmessage = (event) => resolve(event.data); });
		events.close();

		expect(JSON.parse(message)).toMatchObject({ correlationId: "c1" });
		expect(ada.calls.filter((call) => call.authorization).map((call) => call.authorization)).toEqual(["Bearer token-ada", "Bearer token-ada"]);
		expect(bob.calls.filter((call) => call.authorization).map((call) => call.authorization)).toEqual(["Bearer token-bob"]);
	});
});
