import type { ProjectChangeEvent } from "@agent-issues/core";

export type CloudEventsConnection = {
	baseUrl: string;
	bearerToken: string;
};

export type CloudChangeEvent = ProjectChangeEvent;

const RECONNECT_DELAY_MS = 1000;

/**
 * Relays the cloud API's own `/events` SSE channel (ISS48) into a callback,
 * so the site server's `/events` route can re-broadcast `snapshot-changed`
 * events to its own browser clients using the identical event shape - the
 * cloud-mode counterpart to the local file-watch poll (ISS56). Only
 * `snapshot-changed` events reach the callback; the gate's own per-connection
 * `connected` event is swallowed here since the browser side already gets
 * its own `connected` event from the site server.
 */
export function subscribeToCloudEvents(
	connection: CloudEventsConnection,
	onEvent: (event: CloudChangeEvent) => void
): () => void {
	const controller = new AbortController();

	void relay(connection, controller.signal, onEvent);

	return () => controller.abort();
}

async function relay(connection: CloudEventsConnection, signal: AbortSignal, onEvent: (event: CloudChangeEvent) => void): Promise<void> {
	while (!signal.aborted) {
		try {
			const response = await fetch(`${connection.baseUrl}/events`, {
				headers: { authorization: `Bearer ${connection.bearerToken}` },
				signal
			});

			if (response.ok && response.body) {
				await readEventStream(response.body, onEvent);
			}
		} catch {
			// Connection dropped or was aborted; fall through to the reconnect delay
			// (or exit the loop if aborted).
		}

		if (!signal.aborted) {
			await delay(RECONNECT_DELAY_MS, signal);
		}
	}
}

async function readEventStream(body: ReadableStream<Uint8Array>, onEvent: (event: CloudChangeEvent) => void): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";

	for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });

		let boundary = buffer.indexOf("\n\n");
		while (boundary !== -1) {
			const rawEvent = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			emitParsedEvent(rawEvent, onEvent);
			boundary = buffer.indexOf("\n\n");
		}
	}
}

function emitParsedEvent(rawEvent: string, onEvent: (event: CloudChangeEvent) => void): void {
	const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
	if (!dataLine) {
		return;
	}

	try {
		const parsed = JSON.parse(dataLine.slice("data:".length).trim()) as Partial<CloudChangeEvent>;
		if (parsed.type === "snapshot-changed") {
			onEvent(parsed as CloudChangeEvent);
		}
	} catch {
		// Malformed event payload; ignore rather than crash the relay.
	}
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}

		const timeout = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true }
		);
	});
}
