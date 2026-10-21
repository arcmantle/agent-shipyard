import { BlockNoteView } from "@blocknote/mantine";
import type { InstructionManagedItem, InstructionSourceResult } from "@agent-issues/core";
import { LitElement, css, html, unsafeCSS, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { when } from "lit/directives/when.js";
import { createElement as reactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement, Puzzle, X } from "lucide";
import blockNoteStyles from "@blocknote/core/style.css?inline";
import mantineStyles from "@blocknote/mantine/style.css?inline";
import { InstructionDocument } from "./instruction-document.js";

export class InstructionEditor extends LitElement {
	static properties = {
		source: { attribute: false }, fragments: { attribute: false }, busy: { type: Boolean },
		loading: { state: true }, error: { state: true }, frontmatter: { state: true },
		pickerOpen: { state: true }, search: { state: true }
	};
	public source: InstructionSourceResult | null = null;
	public fragments: InstructionManagedItem[] = [];
	public busy = false;
	protected loading = false;
	protected error = "";
	protected frontmatter = "";
	protected pickerOpen = false;
	protected search = "";
	protected generation = 0;
	protected documentModel: InstructionDocument | null = null;
	protected reactRoot: Root | null = null;
	protected themeObserver = new MutationObserver(() => this.renderEditor());
	protected insertIcon = createElement(Puzzle, { width: 16, height: 16, "aria-hidden": "true" });
	protected closeIcon = createElement(X, { width: 16, height: 16, "aria-hidden": "true" });

	override connectedCallback() {
		super.connectedCallback();
		this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this.generation += 1;
		this.themeObserver.disconnect();
		this.reactRoot?.unmount();
		this.reactRoot = null;
	}

	protected override updated(changed: PropertyValues) {
		if (changed.has("source")) void this.loadSource();
		else if (changed.has("busy")) this.renderEditor();
	}

	protected async loadSource() {
		const generation = ++this.generation;
		this.reactRoot?.unmount();
		this.reactRoot = null;
		this.documentModel = null;
		this.frontmatter = "";
		this.error = "";
		this.pickerOpen = false;
		this.loading = true;
		try {
			if (!this.source) return;
			const model = await InstructionDocument.load(this.source.body);
			if (generation !== this.generation || !this.isConnected) return;
			this.documentModel = model;
			this.frontmatter = model.frontmatter;
			await this.updateComplete;
			this.renderEditor();
			this.dispatchEvent(new CustomEvent("instruction-editor-change", { detail: { dirty: false }, bubbles: true, composed: true }));
		} catch (error) {
			if (generation === this.generation) this.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (generation === this.generation) this.loading = false;
		}
	}

	protected renderEditor() {
		const host = this.shadowRoot?.querySelector<HTMLElement>(".editor-host");
		const portal = this.shadowRoot?.querySelector<HTMLElement>(".editor-portals");
		if (!host || !portal || !this.documentModel || !this.isConnected) return;
		this.reactRoot ??= createRoot(host);
		this.reactRoot.render(reactElement(BlockNoteView<
			typeof this.documentModel.editor.schema.blockSchema,
			typeof this.documentModel.editor.schema.inlineContentSchema,
			typeof this.documentModel.editor.schema.styleSchema
		>, {
			editor: this.documentModel.editor,
			editable: !this.busy,
			theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
			portalElements: { default: portal },
			onChange: this.onChange
		}));
	}

	protected onChange = () => {
		this.dispatchEvent(new CustomEvent("instruction-editor-change", { detail: { dirty: true }, bubbles: true, composed: true }));
	};

	public async readMarkdown() {
		if (!this.documentModel || this.loading || this.error) throw new Error("Instruction editor is not ready.");
		return this.documentModel.toMarkdown();
	}

	protected onTogglePicker() {
		if (this.pickerOpen) {
			this.onClosePicker();
			return;
		}
		this.pickerOpen = true;
		this.search = "";
		void this.updateComplete.then(() => this.shadowRoot?.querySelector<HTMLInputElement>("input[type=search]")?.focus());
	}

	protected onClosePicker() {
		this.pickerOpen = false;
		void this.updateComplete.then(() => this.shadowRoot?.querySelector<HTMLButtonElement>("[data-insert-fragment]")?.focus());
	}

	protected onPickerKeyDown(event: KeyboardEvent) {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		this.onClosePicker();
	}

	protected onSearch(event: Event) {
		this.search = (event.target as HTMLInputElement).value;
	}

	protected onInsert(event: Event) {
		const target = (event.currentTarget as HTMLElement).dataset.fragmentKey;
		const editor = this.documentModel?.editor;
		if (!editor || !target || this.busy) return;
		editor.insertBlocks([{ type: "fragmentReference", props: { target } }], editor.getTextCursorPosition().block, "after");
		this.pickerOpen = false;
		this.onChange();
		editor.focus();
	}

	override render() {
		const matches = this.fragments.filter((item) => item.kind === "fragment" && item.key.toLowerCase().includes(this.search.toLowerCase()));
		return html`
		${when(this.frontmatter, () => html`
		<section class="frontmatter" aria-label="Plugin frontmatter (read-only)">
			<h3>Plugin Frontmatter <span>Read-only</span></h3>
			<pre data-instruction-frontmatter>${this.frontmatter}</pre>
		</section>
		`)}
		<div class="tools">
			<button
				aria-expanded=${String(this.pickerOpen)}
				data-insert-fragment
				?disabled=${this.loading || this.busy || !!this.error}
				@click=${this.onTogglePicker}
			>
				${this.insertIcon} Insert Fragment
			</button>
			${when(this.pickerOpen, () => html`
			<div
				class="picker"
				role="dialog"
				aria-label="Insert fragment"
				@keydown=${this.onPickerKeyDown}
			>
				<div class="picker-search">
					<input
						aria-label="Search fragments"
						type="search"
						.value=${this.search}
						@input=${this.onSearch}
					>
					<button
						aria-label="Close fragment picker"
						title="Close fragment picker"
						@click=${this.onClosePicker}
					>
						${this.closeIcon}
					</button>
				</div>
				<div class="fragment-list">
					${repeat(matches, (item) => item.key, (item) => html`
					<button
						data-fragment-key=${item.key}
						@click=${this.onInsert}
					>
						${item.key.slice("fragment/".length)}
					</button>
					`)}
					${when(!matches.length, () => html`<p>No fragments found.</p>`)}
				</div>
			</div>
			`)}
		</div>
		${when(this.loading, () => html`<p role="status">Loading editor...</p>`)}
		${when(this.error, () => html`<p role="alert">${this.error}</p>`)}
		<div class="editor-host" data-instruction-source></div>
		<div class="editor-portals"></div>
		`;
	}

	static styles = [unsafeCSS(blockNoteStyles), unsafeCSS(mantineStyles), css`
	:host {
		display: block;
		min-width: 0;
		font-family: inherit;
	}
	.frontmatter {
		margin: 16px 0;
		padding: 12px;
		border-left: 3px solid var(--border);
		background: var(--surface-muted);
	}
	h3 {
		margin: 0 0 8px;
		font-size: 14px;
	}
	h3 span {
		margin-left: 8px;
		color: var(--muted);
		font-size: 12px;
		font-weight: normal;
	}
	pre {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 12px;
	}
	.tools {
		position: relative;
		margin: 16px 0;
	}
	button, input {
		box-sizing: border-box;
		min-height: 40px;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
	}
	button {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button:focus-visible, input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.picker {
		position: absolute;
		z-index: 20;
		top: 48px;
		left: 0;
		box-sizing: border-box;
		width: min(360px, 100%);
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		box-shadow: 0 4px 16px #0002;
	}
	.picker input {
		width: 100%;
		min-width: 0;
	}
	.picker-search {
		display: flex;
		gap: 8px;
	}
	.picker-search button {
		flex-shrink: 0;
		justify-content: center;
		width: 40px;
		padding: 8px;
	}
	.fragment-list {
		max-height: 240px;
		margin-top: 8px;
		overflow: auto;
	}
	.fragment-list button {
		width: 100%;
		margin-bottom: 4px;
		text-align: left;
		overflow-wrap: anywhere;
	}
	.bn-container {
		--bn-font-family: inherit;
		--bn-colors-editor-background: var(--surface);
		--bn-colors-editor-text: var(--text);
		--bn-colors-menu-background: var(--surface);
		--bn-colors-menu-text: var(--text);
		font-family: inherit;
	}
	.bn-editor {
		min-height: 220px;
		padding: 16px 32px;
		background: var(--surface);
		color: var(--text);
		white-space: pre-wrap;
	}
	.bn-container .bn-default-styles, .editor-portals .bn-root {
		font-family: inherit;
	}
	.bn-editor h1 {
		font-size: 26px;
	}
	.bn-editor h2 {
		font-size: 22px;
	}
	.instruction-reference {
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 8px 12px;
		border-left: 3px solid var(--accent);
		background: var(--surface-muted);
	}
	.instruction-reference span {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	@media (max-width: 900px) {
		.bn-editor {
			padding: 12px 24px;
		}
	}
	`];
}

customElements.define("agent-issues-instruction-editor", InstructionEditor);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-instruction-editor": InstructionEditor;
	}
	interface HTMLElementEventMap {
		"instruction-editor-change": CustomEvent<{ dirty: boolean }>;
		"instruction-fragment-open": CustomEvent<{ key: string }>;
	}
}