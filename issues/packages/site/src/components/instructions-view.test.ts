// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentIssuesStore } from "../services/agent-issues-store.js";
import "./instructions-view.js";

beforeEach(() => {
	Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: false, media: query, onchange: null,
		addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }
	}));
	Object.defineProperties(HTMLDialogElement.prototype, {
		showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
		close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } }
	});
});

afterEach(() => {
	document.body.replaceChildren();
	Reflect.deleteProperty(document, "execCommand");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function mountPendingInstructions(
	save?: (request: { key: string; body: string; expectedRevision: number }, url: URL) => Promise<Response>,
	read?: (url: URL) => Promise<Response> | undefined,
	selectedKey = "skill/prepare"
) {
	const items = [
		{ key: "skill/prepare", kind: "skill", body: "Prepare", source: { type: "default", revision: 1, contentHash: "prepare" } },
		{ key: "skill/plan", kind: "skill", body: "Plan", source: { type: "default", revision: 1, contentHash: "plan" } },
		{ key: "fragment/rules", kind: "fragment", body: "Rules", source: { type: "default", revision: 1, contentHash: "rules" } },
		{ key: "fragment/personal", kind: "fragment", body: "Personal", source: { type: "personal", revision: 1, contentHash: "personal" } }
	];
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
		const url = new URL(String(input), window.location.origin);
		if (options?.method === "POST" && save) return save(JSON.parse(String(options.body)), url);
		const response = read?.(url);
		if (response) return response;
		return Response.json(url.pathname.endsWith("catalog")
			? { version: "0.2.0", items, owner: { type: "local" } }
			: { ...items.find((item) => item.key === url.searchParams.get("key")), version: "0.2.0" });
	});
	const store = new AgentIssuesStore();
	await store.openInstructions();
	store.selectInstructionCategory(selectedKey.startsWith("fragment/") ? "fragment" : "skill");
	await store.selectInstruction(selectedKey);
	const view = document.createElement("agent-issues-instructions-view");
	view.store = store;
	document.body.append(view);
	await view.updateComplete;
	const editor = view.shadowRoot!.querySelector("agent-issues-instruction-editor")!;
	await vi.waitFor(() => expect(editor.shadowRoot?.querySelector('[contenteditable="true"]')).toBeTruthy());
	editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-insert-fragment]")!.click();
	await editor.updateComplete;
	editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-fragment-key]")!.click();
	await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-instruction]")!.disabled).toBe(false));
	const pending = await editor.readMarkdown();
	fetch.mockClear();
	return { store, view, editor, pending, fetch, items };
}

describe("instruction editor", () => {
	it.each(["close", "escape"])("returns focus after fragment picker dismissal with %s", async (method) => {
		const { editor, pending } = await mountPendingInstructions();
		const trigger = editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-insert-fragment]")!;
		trigger.click();
		await editor.updateComplete;
		const search = editor.shadowRoot!.querySelector<HTMLInputElement>('[aria-label="Search fragments"]')!;
		await vi.waitFor(() => expect(editor.shadowRoot!.activeElement).toBe(search));
		if (method === "escape") {
			search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		} else {
			const close = editor.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Close fragment picker"]');
			expect(close).toBeTruthy();
			close!.click();
		}
		await editor.updateComplete;
		expect(editor.shadowRoot!.querySelector('[role="dialog"]')).toBeNull();
		expect(editor.shadowRoot!.activeElement).toBe(trigger);
		expect(await editor.readMarkdown()).toBe(pending);
	});

	it("retains staged work through browser instruction navigation", async () => {
		const { store, view, pending } = await mountPendingInstructions();
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-edit-together]")!.click();
		window.history.replaceState({}, "", "#page=instructions&category=skill&instruction=skill%2Fplan");
		await store.onPopState();
		await vi.waitFor(() => expect(store.instructionSource.get()?.key).toBe("skill/plan"));
		expect(view.shadowRoot!.querySelector(".navigation-dialog")).toBeNull();
		window.history.replaceState({}, "", "#page=instructions&category=skill&instruction=skill%2Fprepare");
		await store.onBrowserNavigation();
		await vi.waitFor(() => expect(store.instructionSource.get()?.key).toBe("skill/prepare"));
		await vi.waitFor(async () => expect(await view.shadowRoot!.querySelector("agent-issues-instruction-editor")!.readMarkdown()).toBe(pending));
		expect(view.shadowRoot!.querySelector("[data-pending-changes]")).toBeTruthy();
	});

	it("opens a created fragment without leaving Edit Together", async () => {
		const created = { key: "fragment/new", kind: "fragment", body: "", version: "0.2.0", source: { type: "personal", revision: 1, contentHash: "new" } };
		const { store, view, pending } = await mountPendingInstructions(async () => Response.json(created), (url) => url.searchParams.get("key") === created.key ? Promise.resolve(Response.json(created)) : undefined, "fragment/personal");
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-edit-together]")!.click();
		view.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Create fragment"]')!.click();
		await view.updateComplete;
		const key = view.shadowRoot!.querySelector<HTMLInputElement>('[aria-label="Fragment key"]')!;
		key.value = created.key;
		key.dispatchEvent(new Event("input"));
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-create-fragment]")!.click();
		await vi.waitFor(() => expect(store.selectedInstructionKey.get()).toBe(created.key));
		expect(view.shadowRoot!.querySelector(".navigation-dialog")).toBeNull();
		expect(view.shadowRoot!.querySelector("[data-pending-changes]")?.textContent).toContain(pending);
	});

	it("requires mode exit before removing a non-selected fragment", async () => {
		const { store, view, fetch } = await mountPendingInstructions(undefined, undefined, "fragment/personal");
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-edit-together]")!.click();
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-key="fragment/rules"]')!.click();
		await vi.waitFor(() => expect(store.selectedInstructionKey.get()).toBe("fragment/rules"));
		fetch.mockClear();
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-remove-fragment="fragment/personal"]')!.click();
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector(".fragment-dialog")).toBeNull();
		expect(view.shadowRoot!.querySelector(".navigation-dialog")?.textContent).toContain("Discard All");
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-cancel-navigation]")!.click();
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector("[data-pending-changes]")?.textContent).toContain("fragment/personal");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not publish a late Save All response into another owner", async () => {
		const { store, view, fetch, items } = await mountPendingInstructions();
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-edit-together]")!.click();
		await view.updateComplete;
		const catalog = store.instructionCatalog.get();
		const source = store.instructionSource.get();
		let finish!: (response: Response) => void;
		fetch.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-all]")!.click();
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		store.selectedTenant.set("another-owner");
		await view.updateComplete;
		finish(Response.json({ version: "0.2.0", changes: [{ operation: "save", source: { ...items[0], version: "0.2.0", body: "Old owner text", source: { type: "override", revision: 2 } } }] }));
		await vi.waitFor(() => expect(store.instructionSaving.get()).toBe(false));
		expect(store.instructionCatalog.get()).toBe(catalog);
		expect(store.instructionSource.get()).toBe(source);
		expect(view.shadowRoot!.querySelector("[data-pending-changes]")).toBeNull();
		expect(view.shadowRoot!.textContent).not.toContain("Old owner text");
	});

	it.each(["cancel", "discard", "save", "failed-save"])("handles %s when leaving Edit Together with staged work", async (choice) => {
		const { store, view, pending, fetch, items } = await mountPendingInstructions();
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-edit-together]")!.click();
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-key="skill/plan"]')!.click();
		await vi.waitFor(() => expect(store.instructionSource.get()?.key).toBe("skill/plan"));
		const beforeUnload = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(beforeUnload);
		expect(beforeUnload.defaultPrevented).toBe(true);
		const navigate = vi.fn();
		view.requestNavigation(navigate);
		await view.updateComplete;
		const dialog = view.shadowRoot!.querySelector(".navigation-dialog")!;
		expect(dialog.textContent).toContain("Save All");
		expect(dialog.textContent).toContain("Discard All");
		expect(dialog.textContent).toContain("Cancel");
		fetch.mockClear();
		fetch.mockResolvedValue(choice === "failed-save" ? new Response("Invalid instruction graph", { status: 400 }) : Response.json({ version: "0.2.0", changes: [
			{ operation: "save", source: { ...items[0], version: "0.2.0", body: pending, source: { type: "override", revision: 2, contentHash: "saved", defaultVersion: "0.2.0" } } }
		] }));
		view.shadowRoot!.querySelector<HTMLButtonElement>(`[data-${choice === "failed-save" ? "save" : choice}-navigation]`)!.click();
		if (choice === "save" || choice === "discard") {
			await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
			expect(view.shadowRoot!.querySelector("[data-edit-together]")).toBeTruthy();
			expect(view.shadowRoot!.querySelector("[data-pending-changes]")).toBeNull();
		} else {
			if (choice === "failed-save") await vi.waitFor(() => expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Invalid instruction graph"));
			expect(navigate).not.toHaveBeenCalled();
			expect(view.shadowRoot!.querySelector("[data-pending-changes]")?.textContent).toContain(pending);
		}
		if (choice === "cancel" || choice === "discard") expect(fetch).not.toHaveBeenCalled();
		else {
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ changes: [
				{ operation: "save", key: "skill/prepare", body: pending, expectedRevision: 1 }
			] });
		}
	});

	it.each([true, false])("saves the staged set atomically and retains it on failure: success %s", async (succeed) => {
		const { store, view, pending, fetch, items } = await mountPendingInstructions();
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-edit-together]")!.click();
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-key="skill/plan"]')!.click();
		await vi.waitFor(() => expect(store.instructionSource.get()?.key).toBe("skill/plan"));
		const editor = view.shadowRoot!.querySelector("agent-issues-instruction-editor")!;
		await vi.waitFor(() => expect(editor.shadowRoot?.querySelector('[contenteditable="true"]')).toBeTruthy());
		editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-insert-fragment]")!.click();
		await editor.updateComplete;
		editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-fragment-key]")!.click();
		const planBody = await editor.readMarkdown();
		const current = store.instructionSource.get();
		fetch.mockClear();
		fetch.mockResolvedValue(succeed ? Response.json({ version: "0.2.0", changes: [
			{ operation: "save", source: { ...items[0], version: "0.2.0", body: pending, source: { type: "override", revision: 2, contentHash: "saved-prepare", defaultVersion: "0.2.0" } } },
			{ operation: "save", source: { ...items[1], version: "0.2.0", body: planBody, source: { type: "override", revision: 2, contentHash: "saved-plan", defaultVersion: "0.2.0" } } }
		] }) : new Response("Instruction revision conflict", { status: 400 }));
		const saveAll = view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-all]");
		expect(saveAll).toBeTruthy();
		saveAll!.click();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-all]")?.disabled).toBe(succeed));
		const [input, options] = fetch.mock.calls[0]!;
		expect(new URL(String(input), window.location.origin).pathname).toBe("/api/instructions/changes");
		expect(JSON.parse(String(options?.body))).toEqual({ changes: [
			{ operation: "save", key: "skill/prepare", body: pending, expectedRevision: 1 },
			{ operation: "save", key: "skill/plan", body: planBody, expectedRevision: 1 }
		] });
		if (succeed) {
			expect(store.instructionSource.get()?.source.revision).toBe(2);
			expect(store.instructionCatalog.get()?.items[0]?.body).toBe(pending);
		} else {
			expect(store.instructionSource.get()).toBe(current);
			expect(view.shadowRoot!.querySelector('[role="alert"]')?.textContent).toContain("Instruction revision conflict");
			expect(await editor.readMarkdown()).toBe(planBody);
			expect(view.shadowRoot!.querySelector("[data-pending-changes]")?.textContent).toContain(pending);
		}
	});

	it("previews all staged changes without saving", async () => {
		const { store, view, pending, fetch } = await mountPendingInstructions();
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-edit-together]")!.click();
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-category="fragment"]')!.click();
		await vi.waitFor(() => expect(store.instructionCategory.get()).toBe("fragment"));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-key="fragment/rules"]')!.click();
		await vi.waitFor(() => expect(store.instructionSource.get()?.key).toBe("fragment/rules"));
		const editor = view.shadowRoot!.querySelector("agent-issues-instruction-editor")!;
		await vi.waitFor(() => expect(editor.shadowRoot?.querySelector('[contenteditable="true"]')).toBeTruthy());
		editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-insert-fragment]")!.click();
		await editor.updateComplete;
		editor.shadowRoot!.querySelector<HTMLButtonElement>('[data-fragment-key="fragment/personal"]')!.click();
		const fragmentBody = await editor.readMarkdown();
		fetch.mockClear();
		fetch.mockResolvedValue(Response.json({ key: "fragment/rules", version: "0.2.0", body: "Pending assembly", source: { type: "default", revision: 1 }, fragments: [] }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="preview"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-preview]")?.textContent).toContain("Pending assembly"));
		expect(fetch).toHaveBeenCalledTimes(1);
		const [input, options] = fetch.mock.calls[0]!;
		expect(new URL(String(input), window.location.origin).pathname).toBe("/api/instructions/preview");
		expect(JSON.parse(String(options?.body))).toEqual({ key: "fragment/rules", changes: [{ key: "skill/prepare", body: pending }, { key: "fragment/rules", body: fragmentBody }] });
	});

	it("retains staged text when switching items in Edit Together", async () => {
		const { store, view, pending } = await mountPendingInstructions();
		const together = view.shadowRoot!.querySelector<HTMLButtonElement>("[data-edit-together]");
		expect(together).toBeTruthy();
		together!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-category="fragment"]')!.click();
		await vi.waitFor(() => expect(store.instructionCategory.get()).toBe("fragment"));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-key="fragment/rules"]')!.click();
		await vi.waitFor(() => expect(store.instructionSource.get()?.key).toBe("fragment/rules"));
		expect(view.shadowRoot!.querySelector(".navigation-dialog")).toBeNull();
		expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-instruction]")?.disabled).toBe(false);
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-category="skill"]')!.click();
		await vi.waitFor(() => expect(store.instructionCategory.get()).toBe("skill"));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-key="skill/prepare"]')!.click();
		await vi.waitFor(() => expect(store.instructionSource.get()?.key).toBe("skill/prepare"));
		await vi.waitFor(async () => expect(await view.shadowRoot!.querySelector("agent-issues-instruction-editor")!.readMarkdown()).toBe(pending));
		expect(view.shadowRoot!.querySelector("[data-pending-changes]")?.textContent).toContain("skill/prepare");
	});

	it("reports committed Reset All when refresh fails and retries reads without a second reset", async () => {
		const { store, view, editor, pending, fetch, items } = await mountPendingInstructions();
		const source = store.instructionSource.get()!;
		const inspection = { version: source.version, owner: { type: "local" }, overrides: [], personalFragments: [], affectedInstructions: [], expectedRevisions: [], confirmationToken: "confirmation" };
		fetch.mockResolvedValueOnce(Response.json(inspection));
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-reset-all]")!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-reset]")?.disabled).toBe(false));
		fetch.mockResolvedValueOnce(Response.json(inspection)).mockResolvedValueOnce(new Response("Catalog unavailable", { status: 500 }));
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-reset]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector(".reset-dialog [role='alert']")?.textContent).toContain("Reset All completed"));
		expect(await editor.readMarkdown()).toBe(pending);
		fetch.mockImplementation(async (input) => {
			const url = new URL(String(input), window.location.origin);
			if (url.pathname.endsWith("catalog")) return Response.json({ version: source.version, owner: { type: "local" }, items });
			if (url.pathname.endsWith("source")) return Response.json(source);
			throw new Error(`Unexpected request ${url}`);
		});
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-refresh-reset]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector(".reset-dialog")).toBeNull());
		expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
		expect(store.instructionSource.get()).toEqual(source);
		expect(store.instructionError.get()).toBeNull();
	});

	it.each([["instruction", "inspect"], ["all", "inspect"], ["instruction", "write"], ["all", "write"]])("ignores late %s reset %s responses after an owner change", async (scope, operation) => {
		const { store, view, fetch, items } = await mountPendingInstructions();
		const source = store.instructionSource.get()!;
		const catalog = store.instructionCatalog.get();
		const proposedSource = { ...source, body: "Old owner reset" };
		const inspection = scope === "all"
			? { version: source.version, owner: { type: "local" }, overrides: [{ currentSource: source, proposedSource }], personalFragments: [], affectedInstructions: [], expectedRevisions: [], confirmationToken: "confirmation" }
			: { key: source.key, version: source.version, currentSource: source, proposedSource, affectedInstructions: [], modifiedFragments: [] };
		let finish!: (response: Response) => void;
		fetch.mockImplementation(async (input, options) => {
			const url = new URL(String(input), window.location.origin);
			if ((operation === "inspect" && url.pathname.endsWith("inspect")) || (operation === "write" && options?.method === "POST")) return new Promise<Response>((resolve) => { finish = resolve; });
			if (url.pathname.endsWith("catalog")) return Response.json({ ...catalog, items });
			if (url.pathname.endsWith("source")) return Response.json(proposedSource);
			return Response.json(inspection);
		});
		view.shadowRoot!.querySelector<HTMLButtonElement>(`[data-reset-${scope}]`)!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
		if (operation === "write") {
			await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-reset]")?.disabled).toBe(false));
			view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-reset]")!.click();
		}
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		store.selectedTenant.set("new-owner");
		await view.updateComplete;
		finish(Response.json(operation === "inspect" || scope === "all" ? inspection : proposedSource));
		await vi.waitFor(() => expect(store.instructionSaving.get()).toBe(false));
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector(".reset-dialog")).toBeNull();
		expect(view.shadowRoot!.textContent).not.toContain("Old owner reset");
		expect(store.instructionSource.get()).toBe(source);
		expect(store.instructionCatalog.get()).toBe(catalog);
	});

	it.each([
		["instruction", "Instruction revision conflict"], ["all", "Invalid instruction graph"]
	])("retains saved state and pending work after %s reset fails: %s", async (scope, message) => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions();
		const currentSource = store.instructionSource.get()!;
		const catalog = store.instructionCatalog.get();
		const inspection = scope === "all"
			? { version: currentSource.version, owner: { type: "local" }, overrides: [], personalFragments: [], affectedInstructions: [], expectedRevisions: [], confirmationToken: "confirmation" }
			: { key: currentSource.key, version: currentSource.version, currentSource, proposedSource: currentSource, affectedInstructions: [], modifiedFragments: [] };
		fetch.mockResolvedValueOnce(Response.json(inspection));
		view.shadowRoot!.querySelector<HTMLButtonElement>(`[data-reset-${scope}]`)!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-reset]")?.disabled).toBe(false));
		fetch.mockResolvedValueOnce(new Response(message, { status: 400 }));
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-reset]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector(".reset-dialog [role='alert']")?.textContent).toContain(message));
		expect(store.instructionSource.get()).toBe(currentSource);
		expect(store.instructionCatalog.get()).toBe(catalog);
		expect(await editor.readMarkdown()).toBe(pending);
		expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-reset]")!.disabled).toBe(true);
		fetch.mockResolvedValueOnce(Response.json(inspection));
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-refresh-reset]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-reset]")!.disabled).toBe(false));
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-cancel-reset]")!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-category="fragment"]')!.click();
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector(".navigation-dialog")).toBeTruthy();
	});

	it.each(["fragment/personal", "skill/prepare"])("confirms every Reset All removal and refreshes selection %s", async (selectedKey) => {
		const { store, view, editor, pending, fetch, items } = await mountPendingInstructions(undefined, undefined, selectedKey);
		const override = { ...items[0], version: "0.2.0", body: "Personal preparation", source: { type: "override", revision: 3, contentHash: "override", defaultVersion: "0.1.0" } };
		const proposedSource = { ...items[0], version: "0.2.0" };
		const personal = { ...items[3], version: "0.2.0" };
		const expectedRevisions = [
			{ key: override.key, sourceType: "override", expectedRevision: 3 },
			{ key: personal.key, sourceType: "personal", expectedRevision: 1 }
		];
		const inspection = { version: "0.2.0", owner: { type: "local" }, overrides: [{ currentSource: override, proposedSource }], personalFragments: [personal], affectedInstructions: ["agent/issues"], expectedRevisions, confirmationToken: "reset-confirmation" };
		fetch.mockImplementation(async (input, options) => {
			const url = new URL(String(input), window.location.origin);
			if (url.pathname.endsWith("reset-all/inspect")) return Response.json(inspection);
			if (url.pathname.endsWith("reset-all") && options?.method === "POST") return Response.json(inspection);
			if (url.pathname.endsWith("catalog")) return Response.json({ version: "0.2.0", owner: { type: "local" }, items: items.slice(0, 3) });
			if (url.pathname.endsWith("source")) return Response.json(proposedSource);
			throw new Error(`Unexpected request ${url}`);
		});
		const action = view.shadowRoot!.querySelector<HTMLButtonElement>("[data-reset-all]");
		expect(action).toBeTruthy();
		action!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector(".reset-dialog")?.textContent).toContain(override.body));
		const confirmation = view.shadowRoot!.querySelector(".reset-dialog")!;
		expect(confirmation.textContent).toContain(override.key);
		expect(confirmation.textContent).toContain(personal.key);
		expect(confirmation.textContent).toContain("agent/issues");
		expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-cancel-reset]")!.click();
		await view.updateComplete;
		expect(await editor.readMarkdown()).toBe(pending);
		expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
		action!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-reset]")?.disabled).toBe(false));
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-reset]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector(".reset-dialog")).toBeNull());
		expect(store.selectedInstructionKey.get()).toBe(selectedKey === personal.key ? null : selectedKey);
		expect(store.instructionSource.get()).toEqual(selectedKey === personal.key ? null : proposedSource);
		expect(store.instructionCatalog.get()?.items.map((item) => item.key)).not.toContain(personal.key);
		const write = fetch.mock.calls.find(([, options]) => options?.method === "POST")!;
		expect(JSON.parse(String(write[1]?.body))).toEqual({ expectedRevisions, confirmationToken: inspection.confirmationToken });
		expect(view.shadowRoot!.querySelector(".reset-dialog")).toBeNull();
	});

	it.each(["save", "discard"])("confirms selected-item reset scope and impact after choosing %s for pending work", async (choice) => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions();
		let currentSource = store.instructionSource.get()!;
		let proposedSource = { ...currentSource, body: "Official default", source: { ...currentSource.source, revision: 2 } };
		fetch.mockImplementation(async (input, options) => {
			const url = new URL(String(input), window.location.origin);
			if (url.pathname.endsWith("source") && options?.method === "POST") {
				currentSource = { ...currentSource, body: pending, source: { ...currentSource.source, revision: 2 } };
				proposedSource = { ...proposedSource, source: { ...proposedSource.source, revision: 3 } };
				return Response.json(currentSource);
			}
			if (url.pathname.endsWith("reset/inspect")) return Response.json({ currentSource, proposedSource, affectedInstructions: ["agent/issues"], modifiedFragments: ["fragment/rules"], version: currentSource.version, key: currentSource.key });
			if (url.pathname.endsWith("reset") && options?.method === "POST") return Response.json(proposedSource);
			throw new Error(`Unexpected request ${url}`);
		});
		const action = view.shadowRoot!.querySelector<HTMLButtonElement>("[data-reset-instruction]");
		expect(action).toBeTruthy();
		action!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>(`[data-${choice}-navigation]`)!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector(".reset-dialog")?.textContent).toContain("Official default"));
		const confirmation = view.shadowRoot!.querySelector(".reset-dialog")!;
		expect(confirmation.textContent).toContain("Fragment overrides remain unchanged");
		expect(confirmation.textContent).toContain("fragment/rules");
		expect(confirmation.textContent).toContain("agent/issues");
		expect(fetch.mock.calls.some(([input, options]) => new URL(String(input), window.location.origin).pathname.endsWith("/reset") && options?.method === "POST")).toBe(false);
		expect(await editor.readMarkdown()).toBe(pending);
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-reset]")!.click();
		await vi.waitFor(() => expect(store.instructionSource.get()?.body).toBe(proposedSource.body));
		const write = fetch.mock.calls.find(([input, options]) => new URL(String(input), window.location.origin).pathname.endsWith("/reset") && options?.method === "POST")!;
		expect(JSON.parse(String(write[1]?.body))).toEqual({ key: currentSource.key, expectedRevision: currentSource.source.revision });
		expect(view.shadowRoot!.querySelector(".reset-dialog")).toBeNull();
	});

	it.each(["discard", "save"])("inspects and confirms a revision before restore after choosing %s for pending edits", async (choice) => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get()!;
		const revision = { ...source, body: "Earlier instruction", source: { ...source.source, revision: 1 } };
		fetch.mockImplementation(async (input, options) => {
			const url = new URL(String(input), window.location.origin);
			if (url.pathname.endsWith("history")) return Response.json({ key: source.key, version: source.version, revisions: [revision] });
			if (url.pathname.endsWith("revision")) return Response.json(revision);
			if (url.pathname.endsWith("dependencies")) return Response.json({ affectedInstructions: ["agent/issues"], dependencies: [], modifiedFragments: [], key: source.key, version: source.version, source: source.source });
			if (url.pathname.endsWith("source") && options?.method === "POST") return Response.json({ ...source, body: pending, source: { ...source.source, revision: 2 } });
			if (url.pathname.endsWith("restore") && options?.method === "POST") return Response.json({ ...revision, source: { ...source.source, type: "override", revision: 2, defaultVersion: source.version } });
			throw new Error(`Unexpected request ${url}`);
		});
		const tab = view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="history"]');
		expect(tab).toBeTruthy();
		tab!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector('[data-history-revision="1"]')).toBeTruthy());
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-history-revision="1"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector('[data-history-source]')?.textContent).toBe(revision.body));
		expect(await editor.readMarkdown()).toBe(pending);
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-restore-revision]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector('[data-discard-navigation]')).toBeTruthy());
		view.shadowRoot!.querySelector<HTMLButtonElement>(`[data-${choice}-navigation]`)!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector('.restore-dialog')?.textContent).toContain("agent/issues"));
		expect(view.shadowRoot!.querySelector('.restore-dialog')?.textContent).toContain(revision.body);
		expect(fetch.mock.calls.some(([input]) => String(input).includes("/restore"))).toBe(false);
		expect(await editor.readMarkdown()).toBe(pending);
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-confirm-restore]')!.click();
		await vi.waitFor(() => expect(store.instructionSource.get()?.body).toBe(revision.body));
		const restore = fetch.mock.calls.find(([input]) => String(input).includes("/restore"))!;
		expect(JSON.parse(String(restore[1]?.body))).toEqual({ key: source.key, revision: 1, expectedRevision: choice === "save" ? 2 : 1 });
		expect(view.shadowRoot!.querySelector('.restore-dialog')).toBeNull();
	});

	it.each(["Instruction revision conflict", "Instruction fragment not found"])("retains pending edits and saved state after restore fails: %s", async (message) => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get()!;
		const catalog = store.instructionCatalog.get();
		const revision = { ...source, body: "Earlier source" };
		fetch.mockResolvedValueOnce(Response.json({ key: source.key, version: source.version, revisions: [revision] }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="history"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector('[data-history-revision="1"]')).toBeTruthy());
		fetch.mockResolvedValueOnce(Response.json(revision));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-history-revision="1"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector('[data-history-source]')).toBeTruthy());
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-restore-revision]')!.click();
		await view.updateComplete;
		fetch.mockResolvedValueOnce(Response.json({ affectedInstructions: [], dependencies: [], modifiedFragments: [] }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-discard-navigation]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>('[data-confirm-restore]')?.disabled).toBe(false));
		fetch.mockResolvedValueOnce(new Response(message, { status: 400 }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-confirm-restore]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector('.restore-dialog [role="alert"]')?.textContent).toContain(message));
		expect(store.instructionSource.get()).toBe(source);
		expect(store.instructionCatalog.get()).toBe(catalog);
		expect(await editor.readMarkdown()).toBe(pending);
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-cancel-restore]')!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-category="fragment"]')!.click();
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector('.navigation-dialog')).toBeTruthy();
	});

	it.each(["history", "revision", "impact", "restore"])("discards late %s responses after an owner change", async (operation) => {
		const { store, view, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get()!;
		let finish!: (response: Response) => void;
		const delay = () => new Promise<Response>((resolve) => { finish = resolve; });
		const revision = { ...source, body: "Old owner history" };
		fetch.mockImplementation(async (input) => {
			const url = new URL(String(input), window.location.origin);
			if (url.pathname.endsWith(operation === "impact" ? "dependencies" : operation)) return delay();
			if (url.pathname.endsWith("history")) return Response.json({ key: source.key, version: source.version, revisions: [revision] });
			if (url.pathname.endsWith("revision")) return Response.json(revision);
			return Response.json({ affectedInstructions: ["skill/old-owner"], dependencies: [], modifiedFragments: [] });
		});
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="history"]')!.click();
		if (operation !== "history") {
			await vi.waitFor(() => expect(view.shadowRoot!.querySelector('[data-history-revision="1"]')).toBeTruthy());
			view.shadowRoot!.querySelector<HTMLButtonElement>('[data-history-revision="1"]')!.click();
		}
		if (operation === "impact" || operation === "restore") {
			await vi.waitFor(() => expect(view.shadowRoot!.querySelector('[data-restore-revision]')).toBeTruthy());
			view.shadowRoot!.querySelector<HTMLButtonElement>('[data-restore-revision]')!.click();
			await view.updateComplete;
			view.shadowRoot!.querySelector<HTMLButtonElement>('[data-discard-navigation]')!.click();
			if (operation === "restore") {
				await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>('[data-confirm-restore]')?.disabled).toBe(false));
				view.shadowRoot!.querySelector<HTMLButtonElement>('[data-confirm-restore]')!.click();
			}
		}
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		store.selectedTenant.set("new-owner");
		await view.updateComplete;
		finish(Response.json(operation === "history" ? { key: source.key, version: source.version, revisions: [revision] }
			: operation === "impact" ? { affectedInstructions: ["skill/old-owner"] } : revision));
		await vi.waitFor(() => expect(store.instructionSaving.get()).toBe(false));
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector('#history-panel')).toBeNull();
		expect(view.shadowRoot!.querySelector('.restore-dialog')).toBeNull();
		expect(view.shadowRoot!.textContent).not.toContain("Old owner history");
		expect(view.shadowRoot!.textContent).not.toContain("skill/old-owner");
		expect(store.instructionSource.get()).toBe(source);
	});

	it.each([
		["create", "success"], ["create", "failure"], ["remove", "success"], ["remove", "failure"]
	])("discards late %s %s responses after an owner change", async (operation, outcome) => {
		const { store, view, fetch } = await mountPendingInstructions(undefined, undefined, "fragment/personal");
		const source = store.instructionSource.get();
		const catalog = store.instructionCatalog.get();
		if (operation === "create") {
			view.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Create fragment"]')!.click();
			await view.updateComplete;
			const key = view.shadowRoot!.querySelector<HTMLInputElement>('[aria-label="Fragment key"]')!;
			key.value = "fragment/old-owner";
			key.dispatchEvent(new Event("input"));
		} else {
			view.shadowRoot!.querySelector<HTMLButtonElement>('[data-remove-fragment="fragment/personal"]')!.click();
			await view.updateComplete;
			view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
		}
		await view.updateComplete;
		let finish!: (response: Response) => void;
		fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
		view.shadowRoot!.querySelector<HTMLButtonElement>(`[data-confirm-${operation}-fragment]`)!.click();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		store.selectedTenant.set("new-owner");
		await view.updateComplete;
		finish(outcome === "failure" ? new Response("Old owner error", { status: 500 }) : Response.json({ ...source, key: "fragment/old-owner" }));
		await vi.waitFor(() => expect(store.instructionSaving.get()).toBe(false));
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector(".fragment-dialog")).toBeNull();
		expect(view.shadowRoot!.textContent).not.toContain("Old owner error");
		expect(store.instructionSource.get()).toBe(source);
		expect(store.instructionCatalog.get()).toBe(catalog);
	});

	it("retains pending edits and the entered key after failed creation and guards opening a successfully created fragment", async () => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions(undefined, undefined, "fragment/personal");
		const source = store.instructionSource.get();
		const catalog = store.instructionCatalog.get();
		view.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Create fragment"]')!.click();
		await view.updateComplete;
		const key = view.shadowRoot!.querySelector<HTMLInputElement>('[aria-label="Fragment key"]')!;
		key.value = "fragment/new-personal";
		key.dispatchEvent(new Event("input"));
		await view.updateComplete;
		fetch.mockResolvedValueOnce(new Response("Instruction storage unavailable", { status: 500 }));
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-create-fragment]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector(".fragment-dialog [role='alert']")?.textContent).toContain("storage unavailable"));
		expect(key.value).toBe("fragment/new-personal");
		expect(await editor.readMarkdown()).toBe(pending);
		expect(store.instructionSource.get()).toBe(source);
		expect(store.instructionCatalog.get()).toBe(catalog);
		const created = { key: key.value, kind: "fragment", body: "", version: "0.2.0", source: { type: "personal", revision: 1, contentHash: "new" } };
		fetch.mockResolvedValueOnce(Response.json(created));
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-create-fragment]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-cancel-navigation]")).toBeTruthy());
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-cancel-navigation]")!.click();
		await view.updateComplete;
		expect(store.selectedInstructionKey.get()).toBe(source!.key);
		expect(store.instructionCatalog.get()?.items.some((item) => item.key === created.key)).toBe(true);
		expect(await editor.readMarkdown()).toBe(pending);
	});

	it("cancels removal confirmation without discarding pending editor text", async () => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions(undefined, undefined, "fragment/personal");
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-remove-fragment="fragment/personal"]')!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
		await view.updateComplete;
		const cancel = view.shadowRoot!.querySelector<HTMLButtonElement>(".fragment-dialog [data-cancel-fragment]");
		expect(cancel).toBeTruthy();
		cancel!.click();
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector(".fragment-dialog")).toBeNull();
		expect(store.selectedInstructionKey.get()).toBe("fragment/personal");
		expect(await editor.readMarkdown()).toBe(pending);
		expect(fetch).not.toHaveBeenCalled();
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-category="skill"]')!.click();
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector("[data-cancel-navigation]")).toBeTruthy();
	});

	it.each(["referenced", "revision-conflict", "storage unavailable"])("retains pending editor work and saved state after %s removal failure", async (reason) => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions(undefined, undefined, "fragment/personal");
		const source = store.instructionSource.get();
		const catalog = store.instructionCatalog.get();
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-remove-fragment="fragment/personal"]')!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
		await view.updateComplete;
		const currentSource = { ...source!, body: "Newer saved content", source: { ...source!.source, revision: 2 } };
		fetch.mockResolvedValueOnce(reason === "storage unavailable"
			? new Response("Storage unavailable", { status: 500 })
			: Response.json({ message: "Fragment removal is blocked.", reason, currentSource,
				affectedReferences: reason === "referenced" ? ["skill/prepare", "agent/issues"] : [] }, { status: 400 }));
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-remove-fragment]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector(".fragment-dialog [role='alert']")).toBeTruthy());
		const dialog = view.shadowRoot!.querySelector(".fragment-dialog")!;
		if (reason === "referenced") {
			expect(dialog.textContent).toContain("skill/prepare");
			expect(dialog.textContent).toContain("agent/issues");
		} else if (reason === "revision-conflict") {
			expect(dialog.textContent).toContain("Requested revision 1");
			expect(dialog.textContent).toContain("Saved revision 2");
			expect(dialog.textContent).toContain("Newer saved content");
		}
		expect(await editor.readMarkdown()).toBe(pending);
		expect(store.instructionSource.get()).toBe(source);
		expect(store.instructionCatalog.get()).toBe(catalog);
		expect(fetch).toHaveBeenCalledTimes(1);
		const reload = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(reload);
		expect(reload.defaultPrevented).toBe(true);
	});

	it("guards personal fragment removal and clears selection only after successful revision-bound removal", async () => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions(undefined, undefined, "fragment/personal");
		const remove = view.shadowRoot!.querySelector<HTMLButtonElement>('[data-remove-fragment="fragment/personal"]');
		expect(remove).toBeTruthy();
		expect(view.shadowRoot!.querySelector('[data-remove-fragment="fragment/rules"]')).toBeNull();
		remove!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-cancel-navigation]")!.click();
		await view.updateComplete;
		expect(await editor.readMarkdown()).toBe(pending);
		expect(fetch).not.toHaveBeenCalled();
		remove!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector(".fragment-dialog")?.textContent).toContain("fragment/personal");
		let finishRemoval!: (response: Response) => void;
		fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRemoval = resolve; }));
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-remove-fragment]")!.click();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		expect(store.selectedInstructionKey.get()).toBe("fragment/personal");
		await store.selectTenant("another-owner");
		expect(store.selectedTenant.get()).not.toBe("another-owner");
		const [input, options] = fetch.mock.calls[0];
		expect(new URL(String(input), window.location.origin).pathname).toBe("/api/instructions/fragments/remove");
		expect(JSON.parse(String(options?.body))).toEqual({ key: "fragment/personal", expectedRevision: 1 });
		finishRemoval(Response.json({ key: "fragment/personal" }));
		await vi.waitFor(() => expect(store.selectedInstructionKey.get()).toBeNull());
		expect(store.instructionSource.get()).toBeNull();
		expect(store.instructionCatalog.get()?.items.some((item) => item.key === "fragment/personal")).toBe(false);
		expect(view.shadowRoot!.querySelector(".fragment-dialog")).toBeNull();
	});

	it("creates a personal fragment from the Fragments category and makes it editable and selectable", async () => {
		const { store, view, fetch } = await mountPendingInstructions();
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-category="fragment"]')!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
		await view.updateComplete;
		store.selectedTenant.set("owner-a");
		await view.updateComplete;
		const created = { key: "fragment/new-personal", kind: "fragment", body: "", version: "0.2.0", source: { type: "personal", revision: 1, contentHash: "personal" } };
		fetch.mockResolvedValueOnce(Response.json(created)).mockResolvedValueOnce(Response.json(created));
		const create = view.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Create fragment"]');
		expect(create).toBeTruthy();
		create!.click();
		await view.updateComplete;
		const key = view.shadowRoot!.querySelector<HTMLInputElement>('[aria-label="Fragment key"]')!;
		key.value = created.key;
		key.dispatchEvent(new Event("input"));
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-confirm-create-fragment]")!.click();
		await vi.waitFor(() => expect(store.selectedInstructionKey.get()).toBe(created.key));
		expect(store.instructionSource.get()).toEqual(created);
		expect(store.instructionCatalog.get()?.items.find((item) => item.key === created.key)).toEqual(created);
		expect(store.instructionCatalog.get()?.items.filter((item) => item.kind === "skill")).toHaveLength(2);
		const [input, options] = fetch.mock.calls[0];
		const url = new URL(String(input), window.location.origin);
		expect(url.pathname).toBe("/api/instructions/fragments/create");
		expect(url.searchParams.get("tenant")).toBe("owner-a");
		expect(url.searchParams.has("project")).toBe(false);
		expect(JSON.parse(String(options?.body))).toEqual({ key: created.key, body: "" });
		const editor = view.shadowRoot!.querySelector("agent-issues-instruction-editor")!;
		await vi.waitFor(() => expect(editor.shadowRoot?.querySelector('[contenteditable="true"]')).toBeTruthy());
		editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-insert-fragment]")!.click();
		await editor.updateComplete;
		expect(editor.shadowRoot!.querySelector('[data-fragment-key="fragment/new-personal"]')).toBeTruthy();
	});

	it("clears dependency output during loading and failure and retries without losing edits", async () => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get()!;
		const inspection = { key: source.key, version: source.version, source: source.source, dependencies: [], modifiedFragments: [], affectedInstructions: [] };
		fetch.mockResolvedValueOnce(Response.json(inspection));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="dependencies"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-dependencies]")).toBeTruthy());
		expect(view.shadowRoot!.textContent).toContain("No included fragments.");
		let finishRead!: (response: Response) => void;
		fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRead = resolve; }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Refresh dependencies"]')!.click();
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector("[data-instruction-dependencies]")).toBeNull();
		expect(view.shadowRoot!.querySelector('#dependencies-panel [role="status"]')?.textContent).toContain("Loading dependencies");
		finishRead(new Response("Instruction storage unavailable", { status: 500 }));
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector('#dependencies-panel [role="alert"]')?.textContent).toContain("Instruction storage unavailable"));
		expect(view.shadowRoot!.querySelector("[data-instruction-dependencies]")).toBeNull();
		fetch.mockResolvedValueOnce(Response.json(inspection));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Refresh dependencies"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-dependencies]")).toBeTruthy());
		expect(view.shadowRoot!.querySelector('#dependencies-panel [role="alert"]')).toBeNull();
		expect(await editor.readMarkdown()).toBe(pending);
	});

	it.each(["owner", "item", "disconnect", "new inspection"])("discards stale dependency responses after %s changes", async (change) => {
		const { store, view, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get()!;
		const inspection = { key: source.key, version: source.version, source: source.source, dependencies: [], modifiedFragments: [], affectedInstructions: [] };
		fetch.mockResolvedValueOnce(Response.json(inspection));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="dependencies"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-dependencies]")).toBeTruthy());
		let finishRead!: (response: Response) => void;
		fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRead = resolve; }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Refresh dependencies"]')!.click();
		await view.updateComplete;
		if (change === "owner") store.selectedTenant.set("owner-b");
		else if (change === "item") {
			view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-key="skill/plan"]')!.click();
			await view.updateComplete;
			view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
			await vi.waitFor(() => expect(store.instructionSource.get()?.key).toBe("skill/plan"));
		} else if (change === "disconnect") view.remove();
		else {
			view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="edit"]')!.click();
			await view.updateComplete;
			fetch.mockResolvedValueOnce(Response.json({ ...inspection, affectedInstructions: ["skill/latest"] }));
			view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="dependencies"]')!.click();
			await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-dependencies]")?.textContent).toContain("skill/latest"));
		}
		await view.updateComplete;
		const delayed = Response.json({ ...inspection, affectedInstructions: ["skill/old-owner"] });
		finishRead(delayed);
		await vi.waitFor(() => expect(delayed.bodyUsed).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (change === "disconnect") document.body.append(view);
		await view.updateComplete;
		expect(view.shadowRoot!.textContent).not.toContain("skill/old-owner");
		if (change === "new inspection") expect(view.shadowRoot!.querySelector("[data-instruction-dependencies]")?.textContent).toContain("skill/latest");
		else expect(view.shadowRoot!.querySelector("[data-instruction-dependencies]")).toBeNull();
	});

	it("shows unresolved references and release dependency changes without hiding valid dependencies", async () => {
		const { store, view, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get()!;
		store.instructionSource.set({ ...source, releaseChanges: {
			defaultVersion: "0.2.0", newerDefaultAvailable: true, defaultChanged: true,
			dependencies: { added: ["fragment/added"], removed: ["fragment/removed"], changed: ["fragment/changed"] }
		} });
		await view.updateComplete;
		fetch.mockResolvedValueOnce(Response.json({
			key: source.key, version: source.version, source: source.source,
			dependencies: [
				{ key: "fragment/rules", direct: true, source: source.source },
				{ key: "fragment/missing", direct: false, source: null, reason: "missing" },
				{ key: "skill/plan", direct: true, source: null, reason: "not-fragment" }
			], modifiedFragments: [], affectedInstructions: []
		}));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="dependencies"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-dependencies]")).toBeTruthy());
		const panel = view.shadowRoot!.querySelector("[data-instruction-dependencies]")!;
		expect(panel.textContent).toContain("fragment/rules");
		expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Unresolved references");
		expect(panel.textContent).toContain("Missing fragment");
		expect(panel.textContent).toContain("Not a fragment");
		expect(panel.querySelector<HTMLButtonElement>('[data-open-instruction="fragment/missing"]')?.disabled).toBe(true);
		expect(panel.querySelector<HTMLButtonElement>('[data-open-instruction="skill/plan"]')?.disabled).toBe(true);
		expect(panel.textContent).toContain("Added: fragment/added");
		expect(panel.textContent).toContain("Removed: fragment/removed");
		expect(panel.textContent).toContain("Changed: fragment/changed");
		expect(panel.textContent).toContain("No affected instructions.");
	});

	it.each(["fragment/rules", "skill/plan"])("guards opening %s from dependencies while preserving pending edits on Cancel", async (key) => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get()!;
		fetch.mockResolvedValueOnce(Response.json({
			key: source.key, version: source.version, source: source.source,
			dependencies: [{ key: "fragment/rules", direct: true, source: source.source }],
			modifiedFragments: [], affectedInstructions: ["skill/plan"]
		}));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="dependencies"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-dependencies]")).toBeTruthy());
		view.shadowRoot!.querySelector<HTMLButtonElement>(`[data-open-instruction="${key}"]`)!.click();
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
		expect(store.selectedInstructionKey.get()).toBe(source.key);
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-cancel-navigation]")!.click();
		await view.updateComplete;
		expect(await editor.readMarkdown()).toBe(pending);
		view.shadowRoot!.querySelector<HTMLButtonElement>(`[data-open-instruction="${key}"]`)!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
		await vi.waitFor(() => expect(store.instructionSource.get()?.key).toBe(key));
		expect(store.instructionCategory.get()).toBe(key.split("/")[0]);
	});

	it("inspects saved nested dependencies and impact without replacing pending edits", async () => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get()!;
		store.selectedTenant.set("owner-a");
		await view.updateComplete;
		fetch.mockResolvedValueOnce(Response.json({
			key: source.key, version: source.version, source: source.source,
			dependencies: [
				{ key: "fragment/rules", direct: true, source: { type: "override", revision: 2, contentHash: "rules", defaultVersion: "0.1.0" } },
				{ key: "fragment/nested", direct: false, source: { type: "personal", revision: 3, contentHash: "nested" } }
			],
			modifiedFragments: ["fragment/rules", "fragment/nested"], affectedInstructions: ["skill/plan", "agent/issues"]
		}));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="dependencies"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-dependencies]")).toBeTruthy());
		const panel = view.shadowRoot!.querySelector("[data-instruction-dependencies]")!;
		expect(panel.textContent).toContain("Default version 0.2.0");
		expect(panel.textContent).toContain("Direct");
		expect(panel.textContent).toContain("Nested");
		expect(panel.textContent).toContain("Personal edits");
		expect(panel.textContent).toContain("Revision 3");
		expect(panel.querySelectorAll("[data-modified-fragment]")).toHaveLength(2);
		expect(panel.querySelector('[data-affected-instruction="agent/issues"]')).toBeTruthy();
		const [input, options] = fetch.mock.calls[0];
		const url = new URL(String(input), window.location.origin);
		expect(url.pathname).toBe("/api/instructions/dependencies");
		expect(url.searchParams.get("key")).toBe(source.key);
		expect(url.searchParams.get("tenant")).toBe("owner-a");
		expect(url.searchParams.has("project")).toBe(false);
		expect(options?.method ?? "GET").toBe("GET");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(store.instructionSource.get()).toBe(source);
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="edit"]')!.click();
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector("agent-issues-instruction-editor")).toBe(editor);
		expect(await editor.readMarkdown()).toBe(pending);
	});

	it("compares saved source with release defaults without replacing pending edits", async () => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get()!;
		store.selectedTenant.set("owner-a");
		await view.updateComplete;
		const comparison = {
			key: source.key, version: "0.2.0",
			currentSource: { ...source, body: "Shared\n<script>personal</script>\n", source: { type: "override", revision: 3, contentHash: "edited", defaultVersion: "0.1.0" } },
			defaultSource: { ...source, body: "Shared\nOfficial rules\n" },
			different: true, newerDefaultVersions: ["0.3.0"]
		};
		fetch.mockResolvedValueOnce(Response.json(comparison));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="compare"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-comparison]")).toBeTruthy());
		const panel = view.shadowRoot!.querySelector("[data-instruction-comparison]")!;
		expect(panel.textContent).toContain("Applicable default version 0.2.0");
		expect(panel.textContent).toContain("Original default version 0.1.0");
		expect(panel.textContent).toContain("Newer defaults: 0.3.0");
		expect(panel.querySelector("del")?.textContent).toContain("Official rules");
		expect(panel.querySelector("ins")?.textContent).toContain("<script>personal</script>");
		expect(panel.querySelector("script")).toBeNull();
		const [input, options] = fetch.mock.calls[0];
		const url = new URL(String(input), window.location.origin);
		expect(url.pathname).toBe("/api/instructions/compare");
		expect(url.searchParams.get("key")).toBe(source.key);
		expect(url.searchParams.get("tenant")).toBe("owner-a");
		expect(url.searchParams.has("project")).toBe(false);
		expect(options?.method ?? "GET").toBe("GET");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(store.instructionSource.get()).toBe(source);
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="edit"]')!.click();
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector("agent-issues-instruction-editor")).toBe(editor);
		expect(await editor.readMarkdown()).toBe(pending);
	});

	it.each(["default", "personal fragment"])("compares an item with %s source", async (kind) => {
		const { store, view, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get()!;
		const personal = kind === "personal fragment";
		const currentSource = personal
			? { ...source, key: "fragment/personal", kind: "fragment", body: "Personal rules", source: { type: "personal", revision: 1, contentHash: "personal" } }
			: source;
		fetch.mockResolvedValueOnce(Response.json({
			key: currentSource.key, version: source.version, currentSource,
			defaultSource: personal ? null : source, different: personal ? null : false, newerDefaultVersions: []
		}));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="compare"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-comparison]")).toBeTruthy());
		const panel = view.shadowRoot!.querySelector("[data-instruction-comparison]")!;
		expect(panel.textContent).toContain(personal ? "Personal fragment. No official default." : "No personal differences.");
		expect(panel.querySelector("pre")?.textContent).toContain(currentSource.body);
		expect(panel.textContent).not.toContain("Original default version");
		expect(panel.textContent).not.toContain("Newer defaults:");
		expect(panel.querySelector("ins, del")).toBeNull();
	});

	it("clears comparison output while loading and on failure, and retries without losing edits", async () => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get()!;
		const comparison = { key: source.key, version: source.version, currentSource: source, defaultSource: source, different: false, newerDefaultVersions: [] };
		fetch.mockResolvedValueOnce(Response.json(comparison));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="compare"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-comparison]")).toBeTruthy());
		let finishComparison!: (response: Response) => void;
		fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishComparison = resolve; }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Refresh comparison"]')!.click();
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector("[data-instruction-comparison]")).toBeNull();
		expect(view.shadowRoot!.querySelector('#compare-panel [role="status"]')?.textContent).toContain("Loading comparison");
		finishComparison(new Response("Instruction defaults unavailable", { status: 500 }));
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector('#compare-panel [role="alert"]')?.textContent).toContain("Instruction defaults unavailable"));
		expect(view.shadowRoot!.querySelector("[data-instruction-comparison]")).toBeNull();
		fetch.mockResolvedValueOnce(Response.json(comparison));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Refresh comparison"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-comparison]")).toBeTruthy());
		expect(view.shadowRoot!.querySelector('#compare-panel [role="alert"]')).toBeNull();
		expect(await editor.readMarkdown()).toBe(pending);
	});

	it.each(["owner", "item", "disconnect", "new comparison"])("discards stale comparison responses after %s changes", async (change) => {
		const { store, view, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get()!;
		const comparison = { key: source.key, version: source.version, currentSource: source, defaultSource: source, different: false, newerDefaultVersions: [] };
		fetch.mockResolvedValueOnce(Response.json(comparison));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="compare"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-comparison]")).toBeTruthy());
		let finishComparison!: (response: Response) => void;
		fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishComparison = resolve; }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Refresh comparison"]')!.click();
		await view.updateComplete;
		if (change === "owner") store.selectedTenant.set("owner-b");
		else if (change === "item") {
			view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-key="skill/plan"]')!.click();
			await view.updateComplete;
			view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
			await vi.waitFor(() => expect(store.instructionSource.get()?.key).toBe("skill/plan"));
		} else if (change === "disconnect") view.remove();
		else {
			view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="edit"]')!.click();
			await view.updateComplete;
			fetch.mockResolvedValueOnce(Response.json({ ...comparison, currentSource: { ...source, body: "Latest comparison" }, different: true }));
			view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="compare"]')!.click();
			await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-comparison]")?.textContent).toContain("Latest comparison"));
		}
		await view.updateComplete;
		if (change !== "new comparison") expect(view.shadowRoot!.querySelector("[data-instruction-comparison]")).toBeNull();
		const delayed = Response.json({ ...comparison, currentSource: { ...source, body: "Old owner source" }, different: true });
		finishComparison(delayed);
		await vi.waitFor(() => expect(delayed.bodyUsed).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (change === "disconnect") document.body.append(view);
		await view.updateComplete;
		expect(view.shadowRoot!.textContent).not.toContain("Old owner source");
		if (change === "new comparison") expect(view.shadowRoot!.querySelector("[data-instruction-comparison]")?.textContent).toContain("Latest comparison");
		else expect(view.shadowRoot!.querySelector("[data-instruction-comparison]")).toBeNull();
	});

	it("previews unsaved source as safe assembled Markdown and text without saving it", async () => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get();
		store.selectedTenant.set("owner-a");
		await view.updateComplete;
		const assembled = "# Pending instructions\n\n**Rules content**\n\n<script>window.previewUnsafe = true</script>\n\n[Unsafe](javascript:alert(1))";
		fetch.mockResolvedValueOnce(Response.json({ ...source, body: assembled, pending: true, pendingKeys: [source!.key], fragments: [] }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="preview"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-preview] h1")?.textContent).toBe("Pending instructions"));
		const [input, options] = fetch.mock.calls[0];
		const url = new URL(String(input), window.location.origin);
		expect(url.pathname).toBe("/api/instructions/preview");
		expect(url.searchParams.get("tenant")).toBe("owner-a");
		expect(url.searchParams.has("project")).toBe(false);
		expect(options?.method).toBe("POST");
		expect(JSON.parse(String(options?.body))).toEqual({ key: "skill/prepare", changes: [{ key: "skill/prepare", body: pending }] });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(view.shadowRoot!.textContent).toContain("Pending");
		expect(view.shadowRoot!.querySelector("[data-instruction-preview] strong")?.textContent).toBe("Rules content");
		expect(view.shadowRoot!.querySelector("[data-instruction-preview] script")).toBeNull();
		expect(view.shadowRoot!.querySelector("[data-instruction-preview] a")?.hasAttribute("href")).toBe(false);
		expect(view.shadowRoot!.querySelector("[data-assembled-text]")?.textContent).toBe(assembled);
		expect(store.instructionSource.get()).toBe(source);
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="edit"]')!.click();
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector("agent-issues-instruction-editor")).toBe(editor);
		expect(await editor.readMarkdown()).toBe(pending);
	});

	it("clears previous assembled output on an assembly error and allows a retry without losing edits", async () => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get();
		fetch.mockResolvedValueOnce(Response.json({ ...source, body: "# Previous preview", pending: true, pendingKeys: [source!.key], fragments: [] }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="preview"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-preview]")?.textContent).toContain("Previous preview"));
		fetch.mockResolvedValueOnce(new Response("Instruction fragment cycle", { status: 400 }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Refresh preview"]')!.click();
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector("[data-instruction-preview]")).toBeNull();
		expect(view.shadowRoot!.querySelector("[data-assembled-text]")).toBeNull();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector('[role="alert"]')?.textContent).toContain("Instruction fragment cycle"));
		expect(store.instructionSource.get()).toBe(source);
		expect(await editor.readMarkdown()).toBe(pending);
		fetch.mockResolvedValueOnce(Response.json({ ...source, body: "# Retried preview", pending: true, pendingKeys: [source!.key], fragments: [] }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Refresh preview"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-preview]")?.textContent).toContain("Retried preview"));
		expect(view.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
	});

	it.each(["success", "error"])("does not replace a newer preview with a delayed %s response", async (result) => {
		const { store, view, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get();
		let finishPreview!: (response: Response) => void;
		fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishPreview = resolve; }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="preview"]')!.click();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="edit"]')!.click();
		await view.updateComplete;
		fetch.mockResolvedValueOnce(Response.json({ ...source, body: "# New preview", pending: true, pendingKeys: [source!.key], fragments: [] }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="preview"]')!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-instruction-preview]")?.textContent).toContain("New preview"));
		const delayed = result === "success"
			? Response.json({ ...source, body: "# Old preview", pending: true, pendingKeys: [source!.key], fragments: [] })
			: new Response("Old assembly error", { status: 400 });
		finishPreview(delayed);
		await vi.waitFor(() => expect(delayed.bodyUsed).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector("[data-instruction-preview]")?.textContent).toContain("New preview");
		expect(view.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
	});

	it.each(["item", "owner", "disconnect"])("discards pending preview output after %s changes", async (change) => {
		const { store, view, fetch } = await mountPendingInstructions();
		const source = store.instructionSource.get();
		let finishPreview!: (response: Response) => void;
		fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishPreview = resolve; }));
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-view="preview"]')!.click();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		if (change === "item") {
			view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-key="skill/plan"]')!.click();
			await view.updateComplete;
			view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
			await vi.waitFor(() => expect(store.instructionSource.get()?.key).toBe("skill/plan"));
		} else if (change === "owner") store.selectedTenant.set("owner-b");
		else view.remove();
		await view.updateComplete;
		const delayed = Response.json({ ...source, body: "# Old owner preview", pending: true, pendingKeys: [source!.key], fragments: [] });
		finishPreview(delayed);
		await vi.waitFor(() => expect(delayed.bodyUsed).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (change === "disconnect") {
			document.body.append(view);
			await view.updateComplete;
		}
		expect(view.shadowRoot!.querySelector("[data-instruction-preview]")).toBeNull();
		expect(view.shadowRoot!.querySelector("[data-assembled-text]")).toBeNull();
		expect(view.shadowRoot!.querySelector('[data-instruction-view="edit"]')?.getAttribute("aria-selected")).toBe("true");
	});

	it.each([
		["item", '[data-instruction-key="skill/plan"]'],
		["category", '[data-category="fragment"]'],
		["fragment Open", null],
		["Back", '[aria-label="Back to instructions"]']
	])("keeps selection and pending text when %s navigation is cancelled", async (_navigation, selector) => {
		const { store, view, editor, pending, fetch } = await mountPendingInstructions();
		if (selector) view.shadowRoot!.querySelector<HTMLButtonElement>(selector)!.click();
		else {
			await vi.waitFor(() => expect(editor.shadowRoot!.querySelector('[data-instruction-fragment="fragment/rules"] button')).toBeTruthy());
			editor.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-fragment="fragment/rules"] button')!.click();
		}
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector('[role="dialog"]')).toBeTruthy();
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-cancel-navigation]")!.click();
		await view.updateComplete;
		expect(store.selectedInstructionKey.get()).toBe("skill/prepare");
		expect(store.instructionCategory.get()).toBe("skill");
		expect(await editor.readMarkdown()).toBe(pending);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("keeps the save bound to its owner and blocks navigation from serialization through completion", async () => {
		let finishSave!: () => void;
		const writing = new Promise<void>((resolve) => { finishSave = resolve; });
		let savedBody = "";
		const { store, view, pending } = await mountPendingInstructions(async (request, url) => {
			expect(url.searchParams.get("tenant")).toBe("owner-a");
			expect(request.expectedRevision).toBe(1);
			savedBody = request.body;
			await writing;
			return Response.json({ key: request.key, kind: "skill", body: request.body, version: "0.2.0", source: { type: "override", revision: 2, contentHash: "saved", defaultVersion: "0.2.0" } });
		});
		store.selectedTenant.set("owner-a");
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-instruction]")!.click();
		await store.selectTenant("owner-b");
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector('[role="dialog"]')).toBeNull();
		expect(store.selectedTenant.get()).toBe("owner-a");
		await vi.waitFor(() => expect(savedBody).toBe(pending));
		await store.selectTenant("owner-b");
		expect(store.selectedTenant.get()).toBe("owner-a");
		finishSave();
		await vi.waitFor(() => expect(store.instructionSource.get()?.body).toBe(pending));
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-instruction]")!.disabled).toBe(true));
	});

	it("warns on reload only while pending work exists and removes the warning after Discard or disconnect", async () => {
		const { store, view, fetch } = await mountPendingInstructions();
		const reload = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(reload);
		expect(reload.defaultPrevented).toBe(true);
		view.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Back to instructions"]')!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
		await view.updateComplete;
		expect(store.selectedInstructionKey.get()).toBeNull();
		expect(store.instructionSource.get()).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
		const cleanReload = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(cleanReload);
		expect(cleanReload.defaultPrevented).toBe(false);
		view.remove();
		const afterDisconnect = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(afterDisconnect);
		expect(afterDisconnect.defaultPrevented).toBe(false);
	});

	it("saves pending text before continuing the requested navigation", async () => {
		let finishSave!: () => void;
		const writing = new Promise<void>((resolve) => { finishSave = resolve; });
		let savedBody = "";
		const { store, view, pending } = await mountPendingInstructions(async (request) => {
			expect(request.key).toBe("skill/prepare");
			expect(request.expectedRevision).toBe(1);
			savedBody = request.body;
			await writing;
			return Response.json({ key: request.key, kind: "skill", body: request.body, version: "0.2.0", source: { type: "override", revision: 2, contentHash: "saved", defaultVersion: "0.2.0" } });
		});
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-key="skill/plan"]')!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-navigation]")!.click();
		await vi.waitFor(() => expect(savedBody).toBe(pending));
		expect(store.selectedInstructionKey.get()).toBe("skill/prepare");
		finishSave();
		await vi.waitFor(() => expect(store.selectedInstructionKey.get()).toBe("skill/plan"));
		await vi.waitFor(() => expect(store.instructionSource.get()?.body).toBe("Plan"));
		expect(view.shadowRoot!.querySelector('[role="dialog"]')).toBeNull();
		expect(view.shadowRoot!.textContent).not.toContain("Unsaved changes");
	});

	it("asks again before a delayed browser transition can remove newly edited text", async () => {
		let finishRead!: (response: Response) => void;
		const reading = new Promise<Response>((resolve) => { finishRead = resolve; });
		let projectRead = false;
		const { store, view, editor } = await mountPendingInstructions(undefined, (url) => {
			if (url.pathname !== "/api/project-summary") return undefined;
			projectRead = true;
			return reading;
		});
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		window.history.replaceState({}, "", "#tenant=demo&project=PROJ1&page=project");
		await store.onBrowserNavigation();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-discard-navigation]")!.click();
		await vi.waitFor(() => expect(projectRead).toBe(true));
		editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-insert-fragment]")!.click();
		await editor.updateComplete;
		editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-fragment-key]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-instruction]")!.disabled).toBe(false));
		const pending = await editor.readMarkdown();
		finishRead(Response.json({ kind: "available", project: { id: "PROJ1", kind: "project", title: "Project" }, epics: [], counts: { epics: 0, initiatives: 0, completedInitiatives: 0 } }));
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector('[role="dialog"]')).toBeTruthy());
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-cancel-navigation]")!.click();
		await view.updateComplete;
		expect(store.activePage.get()).toBe("instructions");
		expect(store.selectedInstructionKey.get()).toBe("skill/prepare");
		expect(await editor.readMarkdown()).toBe(pending);
	});

	it("compares a newer saved revision without replacing pending text and retries only after an explicit choice", async () => {
		let attempts = 0;
		const { store, view, editor, pending, items } = await mountPendingInstructions(async (request) => {
			attempts += 1;
			if (attempts === 1) {
				expect(request.expectedRevision).toBe(1);
				return new Response("Instruction revision conflict: expected 1, found 2", { status: 400 });
			}
			expect(request.expectedRevision).toBe(2);
			expect(request.body).toBe(pending);
			return Response.json({ key: request.key, kind: "skill", body: request.body, version: "0.2.0", source: { type: "override", revision: 3, contentHash: "retried", defaultVersion: "0.2.0" } });
		});
		items[0].body = "Another saved change";
		items[0].source = { type: "default", revision: 2, contentHash: "newer" };
		view.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-key="skill/plan"]')!.click();
		await view.updateComplete;
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-navigation]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector('[role="alert"]')?.textContent).toContain("revision conflict"));
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector("[data-current-instruction]")?.textContent).toBe("Another saved change"));
		expect(view.shadowRoot!.textContent).toContain("Editing revision 1");
		expect(view.shadowRoot!.textContent).toContain("Saved revision 2");
		expect(store.selectedInstructionKey.get()).toBe("skill/prepare");
		expect(store.instructionSource.get()?.source.revision).toBe(1);
		expect(await editor.readMarkdown()).toBe(pending);
		expect(attempts).toBe(1);
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-retry-instruction-save]")!.click();
		await vi.waitFor(() => expect(store.selectedInstructionKey.get()).toBe("skill/plan"));
		expect(attempts).toBe(2);
	});

	it("retains pending edits after a rejected save", async () => {
		const message = "Instruction fragment cycle";
		const items = [
			{ key: "fragment/rules", kind: "fragment", body: "Rules", source: { type: "personal", revision: 1, contentHash: "rules" } }
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
			const url = new URL(String(input), window.location.origin);
			if (options?.method === "POST") return new Response(message, { status: 400 });
			return Response.json(url.pathname.endsWith("catalog")
				? { version: "0.2.0", items, owner: { type: "local" } }
				: { ...items[0], version: "0.2.0" });
		});
		const store = new AgentIssuesStore();
		await store.openInstructions();
		await store.selectInstruction("fragment/rules");
		const view = document.createElement("agent-issues-instructions-view");
		view.store = store;
		document.body.append(view);
		await view.updateComplete;
		const editor = view.shadowRoot!.querySelector("agent-issues-instruction-editor")!;
		await vi.waitFor(() => expect(editor.shadowRoot?.querySelector('[contenteditable="true"]')).toBeTruthy());
		editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-insert-fragment]")!.click();
		await editor.updateComplete;
		editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-fragment-key]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-instruction]")!.disabled).toBe(false));
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-instruction]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector('[role="alert"]')?.textContent).toContain(message));
		expect(await editor.readMarkdown()).toContain("<!-- include:fragment/rules -->");
		expect(store.instructionSource.get()?.body).toBe("Rules");
		expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-instruction]")!.disabled).toBe(false);
	});

	it("shows read-only frontmatter and saves inserted fragment references without changing it", async () => {
		const frontmatter = "---\nname: prepare\ndescription: Plugin metadata\n---\n";
		let body = `${frontmatter}# Prepare\n\n<!-- include:fragment/rules -->`;
		let revision = 1;
		const items = [
			{ key: "skill/prepare", kind: "skill", body, source: { type: "default", revision, contentHash: "original" } },
			{ key: "fragment/rules", kind: "fragment", body: "Rules content", source: { type: "default", revision: 1, contentHash: "rules" } },
			{ key: "fragment/notes", kind: "fragment", body: "Notes content", source: { type: "personal", revision: 1, contentHash: "notes" } }
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
			const url = new URL(String(input), window.location.origin);
			expect(url.searchParams.has("project")).toBe(false);
			if (url.pathname.endsWith("catalog")) return Response.json({ version: "0.2.0", items, owner: { type: "local" } });
			if (options?.method === "POST") {
				const saved = JSON.parse(String(options.body));
				expect(saved.expectedRevision).toBe(revision);
				body = saved.body;
				revision += 1;
			}
			const key = url.searchParams.get("key") ?? "skill/prepare";
			const item = items.find((candidate) => candidate.key === key)!;
			return Response.json({ ...item, body: key === "skill/prepare" ? body : item.body, version: "0.2.0", source: { ...item.source, revision } });
		});
		const store = new AgentIssuesStore();
		await store.openInstructions();
		await store.selectInstruction("skill/prepare");
		const view = document.createElement("agent-issues-instructions-view");
		view.store = store;
		document.body.append(view);
		await view.updateComplete;
		let editor = view.shadowRoot!.querySelector("agent-issues-instruction-editor")!;
		await vi.waitFor(() => expect(editor?.shadowRoot?.querySelector('[contenteditable="true"]')).toBeTruthy());
		const panel = editor.shadowRoot!.querySelector("[data-instruction-frontmatter]")!;
		expect(panel.textContent).toBe(frontmatter);
		expect(panel.closest('[contenteditable="true"]')).toBeNull();
		expect(editor.shadowRoot!.querySelector('[contenteditable="true"]')!.textContent).not.toContain("Plugin metadata");
		expect(editor.shadowRoot!.querySelector("[data-instruction-fragment]")!.textContent).toContain("rules");
		expect(editor.shadowRoot!.textContent).not.toContain("Rules content");
		editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-insert-fragment]")!.click();
		await editor.updateComplete;
		const search = editor.shadowRoot!.querySelector<HTMLInputElement>('[aria-label="Search fragments"]')!;
		search.value = "notes";
		search.dispatchEvent(new Event("input"));
		await editor.updateComplete;
		expect(editor.shadowRoot!.querySelectorAll("[data-fragment-key]")).toHaveLength(1);
		editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-fragment-key]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-instruction]")!.disabled).toBe(false));
		expect(body).not.toContain("include:fragment/notes");
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-instruction]")!.click();
		await vi.waitFor(() => expect(revision).toBe(2));
		expect(body.startsWith(frontmatter)).toBe(true);
		expect(body).toContain("<!-- include:fragment/notes -->");
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-instruction]")!.disabled).toBe(true));
		expect(view.shadowRoot!.textContent).not.toContain("Unsaved changes");
		await store.selectInstruction("skill/prepare");
		await vi.waitFor(() => {
			editor = view.shadowRoot!.querySelector("agent-issues-instruction-editor")!;
			expect(editor?.shadowRoot?.querySelector('[data-instruction-fragment="fragment/notes"]')).toBeTruthy();
		});
		expect(editor.shadowRoot!.querySelector("[data-instruction-frontmatter]")!.textContent).toBe(frontmatter);
		editor.shadowRoot!.querySelector<HTMLButtonElement>('[data-instruction-fragment="fragment/rules"] button')!.click();
		await vi.waitFor(() => expect(store.selectedInstructionKey.get()).toBe("fragment/rules"));
	});
});