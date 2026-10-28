import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo, type Configuration, type IPublicClientApplication } from "@azure/msal-browser";

export type HostedSession = {
	account: { name?: string; username: string };
	signOut: () => Promise<void>;
};

type HostedWindow = Pick<Window, "fetch" | "location"> & { EventSource: typeof EventSource };

type HostedSessionOptions = {
	win?: HostedWindow;
	createClient?: (configuration: Configuration) => IPublicClientApplication;
};

const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const never = <T>() => new Promise<T>(() => {});

let current: HostedSession | undefined;

export function getHostedSession(): HostedSession | undefined {
	return current;
}

function isProtectedPath(pathname: string): boolean {
	return pathname === "/site-config.json" || pathname === "/events" || pathname.startsWith("/api/");
}

/**
 * Signs the browser in through Entra when the serving host advertises it; the local CLI site has no
 * discovery document, so it keeps its unauthenticated same-origin behavior.
 */
export async function startHostedSession(options: HostedSessionOptions = {}): Promise<HostedSession | undefined> {
	const win = options.win ?? window;
	const discovery = await win.fetch("/.well-known/agent-issues", { cache: "no-store" }).catch(() => undefined);
	if (!discovery?.ok) return undefined;
	const auth = ((await discovery.json().catch(() => undefined)) as { auth?: { provider?: string; tenantId?: string; clientId?: string } } | undefined)?.auth;
	if (auth?.provider !== "entra" || !GUID.test(auth.tenantId ?? "") || !GUID.test(auth.clientId ?? "")) return undefined;

	const origin = win.location.origin;
	const client = (options.createClient ?? ((configuration) => new PublicClientApplication(configuration)))({
		auth: {
			clientId: auth.clientId!,
			authority: `https://login.microsoftonline.com/${auth.tenantId}`,
			redirectUri: `${origin}/`,
			postLogoutRedirectUri: `${origin}/`
		},
		// Per-tab storage keeps one person's token out of another browser profile or tab session.
		cache: { cacheLocation: "sessionStorage" }
	});
	const scopes = [`api://${auth.clientId}/access_as_user`];
	await client.initialize();
	const redirect = await client.handleRedirectPromise();
	const account: AccountInfo | undefined = redirect?.account ?? client.getAllAccounts()[0];
	if (!account) {
		await client.loginRedirect({ scopes });
		return never();
	}
	client.setActiveAccount(account);

	const renewInteractively = async (): Promise<never> => {
		await client.acquireTokenRedirect({ scopes, account });
		return never();
	};
	const accessToken = async () => {
		try {
			return (await client.acquireTokenSilent({ scopes, account })).accessToken;
		} catch (error) {
			if (error instanceof InteractionRequiredAuthError) return renewInteractively();
			throw error;
		}
	};

	const baseFetch = win.fetch.bind(win);
	const authorizedFetch: typeof fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input), win.location.href);
		if (url.origin !== origin || !isProtectedPath(url.pathname)) return baseFetch(input, init);
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		headers.set("authorization", `Bearer ${await accessToken()}`);
		const response = await baseFetch(input, { ...init, headers });
		// A token rejected right after sign-in means access is denied; another redirect would loop.
		if (response.status === 401 && !redirect) return renewInteractively();
		return response;
	};
	win.fetch = authorizedFetch;
	win.EventSource = createAuthorizedEventSource(authorizedFetch);

	current = {
		account: { name: account.name, username: account.username },
		signOut: () => client.logoutRedirect({ account })
	};
	return current;
}

/** EventSource cannot send an Authorization header, so hosted change events use a streamed fetch. */
function createAuthorizedEventSource(fetchEvents: typeof fetch): typeof EventSource {
	class AuthorizedEventSource extends EventTarget {
		public static readonly CONNECTING = 0;
		public static readonly OPEN = 1;
		public static readonly CLOSED = 2;
		public readonly CONNECTING = 0;
		public readonly OPEN = 1;
		public readonly CLOSED = 2;
		public readonly withCredentials = false;
		public readyState = 0;
		public onopen: ((event: Event) => void) | null = null;
		public onmessage: ((event: MessageEvent<string>) => void) | null = null;
		public onerror: ((event: Event) => void) | null = null;
		private readonly controller = new AbortController();

		public constructor(public readonly url: string) {
			super();
			void this.read();
		}

		public close() {
			this.readyState = 2;
			this.controller.abort();
		}

		private emit(event: Event) {
			if (event.type === "open") this.onopen?.(event);
			if (event.type === "error") this.onerror?.(event);
			if (event instanceof MessageEvent) this.onmessage?.(event);
			this.dispatchEvent(event);
		}

		private async read() {
			try {
				const response = await fetchEvents(this.url, { cache: "no-store", headers: { accept: "text/event-stream" }, signal: this.controller.signal });
				if (!response.ok || !response.body) throw new Error("Change events are unavailable.");
				this.readyState = 1;
				this.emit(new Event("open"));
				const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
				let buffer = "";
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer = (buffer + value).replaceAll("\r\n", "\n");
					for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
						const data = buffer.slice(0, end).split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
						buffer = buffer.slice(end + 2);
						if (data) this.emit(new MessageEvent("message", { data }));
					}
				}
				throw new Error("Change events ended.");
			} catch {
				if (this.readyState === 2) return;
				this.readyState = 2;
				this.emit(new Event("error"));
			}
		}
	}
	return AuthorizedEventSource as unknown as typeof EventSource;
}
