import { SignalWatcher } from "@lit-labs/signals";
import { LitElement, css, html, type PropertyValues } from "lit";
import { ArrowLeft, ArrowUpRight, Ellipsis, Plus, RefreshCw, RotateCcw, Save, Trash2, createElement } from "lucide";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { when } from "lit/directives/when.js";
import { choose } from "lit/directives/choose.js";
import { map } from "lit/directives/map.js";
import { diffLines } from "diff";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { InstructionComparison, InstructionDependencyInspection, InstructionHistory, InstructionKind, InstructionPreview, InstructionResetInspection, InstructionSource, InstructionSourceResult } from "@agent-issues/core";
import { InstructionFragmentError, splitInstructionMarkdown } from "@agent-issues/core/instruction-store";
import { InstructionResetRefreshError, type AgentIssuesStore, type SiteInstructionResetAllInspection } from "../services/agent-issues-store.js";
import { issueBrowserControlStyles, issueBrowserTypographyStyles } from "../styles/issue-browser-shared-styles.js";
import "./instruction-editor.js";

export class InstructionsView extends SignalWatcher(LitElement) {
	static properties = {
		store: { attribute: false }, dirty: { state: true }, saving: { state: true }, pendingNavigation: { state: true },
		editTogether: { state: true }, stagedItems: { state: true }, switchingItem: { state: true },
		activeView: { state: true }, preview: { state: true }, previewLoading: { state: true }, previewError: { state: true },
		comparison: { state: true }, comparisonLoading: { state: true }, comparisonError: { state: true },
		dependencies: { state: true }, dependenciesLoading: { state: true }, dependenciesError: { state: true },
		history: { state: true }, historyLoading: { state: true }, historyError: { state: true }, historyRevision: { state: true },
		restoreOpen: { state: true }, restoreImpact: { state: true }, restoreError: { state: true },
		resetOpen: { state: true }, resetInspection: { state: true }, resetAllInspection: { state: true }, resettingAll: { state: true }, resetError: { state: true }, resetCompleted: { state: true },
		creatingFragment: { state: true }, removingFragment: { state: true }, fragmentKey: { state: true }, fragmentError: { state: true }, fragmentConflict: { state: true }, fragmentReferences: { state: true }
	};
	public store!: AgentIssuesStore;
	protected editTogether = false;
	protected stagedItems = new Map<string, { source: InstructionSourceResult; body: string }>();
	protected editorSource: InstructionSourceResult | null = null;
	protected switchingItem = false;
	protected internalNavigation = false;
	protected resetOpen = false;
	protected resetInspection: InstructionResetInspection | null = null;
	protected resetAllInspection: SiteInstructionResetAllInspection | null = null;
	protected resettingAll = false;
	protected resetError = "";
	protected resetCompleted = false;
	protected resetGeneration = 0;
	protected actionsIcon = createElement(Ellipsis, { width: 16, height: 16, "aria-hidden": "true" });
	protected creatingFragment = false;
	protected removingFragment: InstructionSourceResult | null = null;
	protected fragmentKey = "fragment/";
	protected fragmentError = "";
	protected fragmentConflict: InstructionSourceResult | null = null;
	protected fragmentReferences: string[] = [];
	protected fragmentGeneration = 0;
	protected dirty = false;
	protected saving = false;
	protected pendingNavigation: (() => void) | null = null;
	protected activeView: "edit" | "preview" | "compare" | "dependencies" | "history" = "edit";
	protected history: InstructionHistory | null = null;
	protected historyLoading = false;
	protected historyError = "";
	protected historyRevision: InstructionSourceResult | null = null;
	protected historyGeneration = 0;
	protected restoreOpen = false;
	protected restoreImpact: InstructionDependencyInspection | null = null;
	protected restoreError = "";
	protected restoreIcon = createElement(RotateCcw, { width: 16, height: 16, "aria-hidden": "true" });
	protected dependencies: InstructionDependencyInspection | null = null;
	protected dependenciesLoading = false;
	protected dependenciesError = "";
	protected dependenciesGeneration = 0;
	protected comparison: InstructionComparison | null = null;
	protected comparisonLoading = false;
	protected comparisonError = "";
	protected comparisonGeneration = 0;
	protected preview: InstructionPreview | null = null;
	protected previewLoading = false;
	protected previewError = "";
	protected previewGeneration = 0;
	protected previewSource: InstructionSourceResult | null = null;
	protected previewTenant: string | null = null;
	protected backIcon = createElement(ArrowLeft, { width: 18, height: 18, "aria-hidden": "true" });
	protected saveIcon = createElement(Save, { width: 16, height: 16, "aria-hidden": "true" });
	protected refreshIcon = createElement(RefreshCw, { width: 16, height: 16, "aria-hidden": "true" });
	protected openIcon = createElement(ArrowUpRight, { width: 16, height: 16, "aria-hidden": "true" });
	protected createIcon = createElement(Plus, { width: 16, height: 16, "aria-hidden": "true" });
	protected removeIcon = createElement(Trash2, { width: 16, height: 16, "aria-hidden": "true" });

	override connectedCallback() {
		super.connectedCallback();
		this.store.instructionNavigationGuard = this.allowNavigation;
		window.addEventListener("beforeunload", this.onBeforeUnload);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this.editTogether = false;
		this.stagedItems = new Map();
		if (this.store.instructionItemNavigator === this.navigateStagedRoute) this.store.instructionItemNavigator = null;
		this.clearReset();
		this.resetFragmentDialog();
		this.invalidatePreview();
		this.invalidateComparison();
		this.invalidateDependencies();
		this.invalidateHistory();
		this.activeView = "edit";
		if (this.store.instructionNavigationGuard === this.allowNavigation) this.store.instructionNavigationGuard = null;
		window.removeEventListener("beforeunload", this.onBeforeUnload);
	}

	protected override willUpdate() {
		const source = this.store.instructionSource.get();
		const tenant = this.store.selectedTenant.get();
		if (tenant !== this.previewTenant) {
			this.resetFragmentDialog();
			this.editTogether = false;
			this.stagedItems = new Map();
			if (this.store.instructionItemNavigator === this.navigateStagedRoute) this.store.instructionItemNavigator = null;
		}
		if (source !== this.previewSource || tenant !== this.previewTenant) {
			const staged = source && this.stagedItems.get(source.key);
			this.editorSource = staged ? { ...staged.source, body: staged.body } : source;
			this.dirty = !!staged && staged.body !== staged.source.body;
			this.clearReset();
			this.previewSource = source;
			this.previewTenant = tenant;
			this.invalidatePreview();
			this.invalidateComparison();
			this.invalidateDependencies();
			this.invalidateHistory();
			this.activeView = "edit";
		}
	}

	protected override updated(changed: PropertyValues) {
		if (changed.has("resetOpen") && this.resetOpen) {
			this.shadowRoot?.querySelector<HTMLDialogElement>(".reset-dialog")?.showModal();
		}
		if (changed.has("restoreOpen") && this.restoreOpen) {
			this.shadowRoot?.querySelector<HTMLDialogElement>(".restore-dialog")?.showModal();
		}
		if (changed.has("pendingNavigation") && this.pendingNavigation) {
			this.shadowRoot?.querySelector<HTMLDialogElement>(".navigation-dialog")?.showModal();
		}
		if ((changed.has("creatingFragment") || changed.has("removingFragment")) && (this.creatingFragment || this.removingFragment)) {
			this.shadowRoot?.querySelector<HTMLDialogElement>(".fragment-dialog")?.showModal();
		}
	}

	protected onBeforeUnload = (event: BeforeUnloadEvent) => {
		if (!this.hasPendingChanges() && !this.saving && !this.store.instructionSaving.get()) return;
		event.preventDefault();
		event.returnValue = "";
	};

	protected allowNavigation = (navigate: () => void) => {
		if (this.internalNavigation) return true;
		if (this.switchingItem) return false;
		if (this.saving || this.store.instructionSaving.get() || this.pendingNavigation || this.creatingFragment || this.removingFragment || this.restoreOpen || this.resetOpen) return false;
		if (!this.dirty && !this.editTogether) return true;
		this.pendingNavigation = navigate;
		return false;
	};

	public requestNavigation(navigate: () => void) {
		if (this.allowNavigation(navigate)) navigate();
	}

	protected onCancelNavigation() {
		if (this.saving || this.store.instructionSaving.get()) return;
		this.shadowRoot?.querySelector("dialog")?.close();
		this.pendingNavigation = null;
	}

	protected onDialogCancel(event: Event) {
		event.preventDefault();
		this.onCancelNavigation();
	}

	protected onDialogKeyDown(event: KeyboardEvent) {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		this.onCancelNavigation();
	}

	protected onDiscardNavigation() {
		if (this.saving || this.store.instructionSaving.get()) return;
		const navigate = this.pendingNavigation;
		this.shadowRoot?.querySelector("dialog")?.close();
		this.pendingNavigation = null;
		this.dirty = false;
		if (this.editTogether) this.clearTogether();
		navigate?.();
	}

	protected async onSaveNavigation() {
		await this.saveAndNavigate();
	}

	protected async saveAndNavigate(expectedRevision?: number) {
		if (!await (this.editTogether ? this.onSaveAll() : this.saveInstruction(expectedRevision))) return;
		const navigate = this.pendingNavigation;
		this.shadowRoot?.querySelector("dialog")?.close();
		this.pendingNavigation = null;
		this.dirty = false;
		if (this.editTogether) this.clearTogether();
		navigate?.();
	}

	protected onEditorChange(event: CustomEvent<{ dirty: boolean }>) {
		const staged = this.stagedItems.get(this.store.selectedInstructionKey.get() ?? "");
		this.dirty = event.detail.dirty || !!staged && staged.body !== staged.source.body;
		this.invalidatePreview();
	}

	protected onEditTogether() {
		this.editTogether = true;
		this.store.instructionItemNavigator = this.navigateStagedRoute;
	}

	protected navigateStagedRoute = async (key: string | null, category: InstructionKind) => {
		await this.selectStagedItem(key, category, false);
	};

	protected clearTogether() {
		this.editTogether = false;
		this.stagedItems = new Map();
		if (this.store.instructionItemNavigator === this.navigateStagedRoute) this.store.instructionItemNavigator = null;
		this.dirty = false;
		const source = this.store.instructionSource.get();
		this.editorSource = source ? { ...source } : null;
		this.invalidatePreview();
	}

	protected onExitTogether() {
		this.requestNavigation(() => this.clearTogether());
	}

	protected async onInspectPending() {
		if (this.saving || this.switchingItem || this.store.instructionSaving.get()) return;
		try {
			await this.captureStagedItem();
		} catch (error) {
			this.store.instructionError.set(error instanceof Error ? error.message : String(error));
		}
	}

	protected hasPendingChanges() {
		return this.dirty || [...this.stagedItems.values()].some((item) => item.body !== item.source.body);
	}

	protected async onSaveAll() {
		if (this.saving || this.switchingItem || this.store.instructionSaving.get()) return false;
		const tenant = this.store.selectedTenant.get();
		this.saving = true;
		try {
			await this.captureStagedItem();
			const changes = [...this.stagedItems].filter(([, item]) => item.body !== item.source.body).map(([key, item]) => ({
				operation: "save" as const, key, body: item.body, expectedRevision: item.source.source.revision
			}));
			if (changes.length) await this.store.commitInstructionChanges(changes);
			if (tenant !== this.store.selectedTenant.get()) return false;
			this.stagedItems = new Map();
			this.dirty = false;
			return true;
		} catch (error) {
			if (tenant === this.store.selectedTenant.get()) this.store.instructionError.set(error instanceof Error ? error.message : String(error));
			return false;
		} finally {
			this.saving = false;
		}
	}

	protected async captureStagedItem() {
		const source = this.store.instructionSource.get();
		const tenant = this.store.selectedTenant.get();
		const editor = this.shadowRoot?.querySelector("agent-issues-instruction-editor");
		if (!source || !editor) return;
		const body = this.dirty ? await editor.readMarkdown() : this.stagedItems.get(source.key)?.body ?? source.body;
		if (!this.isConnected || this.store.instructionSource.get() !== source || this.store.selectedTenant.get() !== tenant) throw new Error("The instruction owner or source changed.");
		const original = this.stagedItems.get(source.key)?.source ?? source;
		this.stagedItems = new Map(this.stagedItems).set(source.key, { source: original, body });
	}

	protected async selectStagedItem(key: string | null, category?: InstructionKind, writeRoute = true) {
		if (this.switchingItem || this.saving || this.pendingNavigation || this.store.instructionSaving.get()) return;
		this.switchingItem = true;
		try {
			await this.captureStagedItem();
			this.internalNavigation = true;
			if (category && category !== this.store.instructionCategory.get()) this.store.selectInstructionCategory(category, { writeRoute });
			const selection = this.store.selectInstruction(key, { writeRoute });
			this.internalNavigation = false;
			await selection;
		} catch (error) {
			this.store.instructionError.set(error instanceof Error ? error.message : String(error));
		} finally {
			this.internalNavigation = false;
			this.switchingItem = false;
		}
	}

	protected onPendingItem(event: Event) {
		const key = (event.currentTarget as HTMLElement).dataset.pendingItem!;
		void this.selectStagedItem(key, key.slice(0, key.indexOf("/")) as InstructionKind);
	}

	protected invalidatePreview() {
		this.previewGeneration += 1;
		this.preview = null;
		this.previewError = "";
		this.previewLoading = false;
	}

	protected onView(event: Event) {
		if (this.restoreOpen || this.resetOpen || this.store.instructionSaving.get()) return;
		this.invalidatePreview();
		this.invalidateComparison();
		this.invalidateDependencies();
		this.invalidateHistory();
		this.activeView = (event.currentTarget as HTMLElement).dataset.instructionView as typeof this.activeView;
		if (this.activeView === "preview") void this.loadPreview();
		if (this.activeView === "compare") void this.loadComparison();
		if (this.activeView === "dependencies") void this.loadDependencies();
		if (this.activeView === "history") void this.loadHistory();
	}

	protected invalidateHistory() {
		this.historyGeneration += 1;
		this.history = null;
		this.historyRevision = null;
		this.historyLoading = false;
		this.historyError = "";
		this.restoreOpen = false;
		this.restoreImpact = null;
		this.restoreError = "";
	}

	protected async readHistory(read: () => Promise<InstructionHistory | InstructionSourceResult>, revision = false) {
		const source = this.store.instructionSource.get();
		const tenant = this.store.selectedTenant.get();
		const generation = ++this.historyGeneration;
		const isCurrent = () => this.isConnected && generation === this.historyGeneration
			&& this.store.instructionSource.get() === source && this.store.selectedTenant.get() === tenant;
		this.historyRevision = null;
		if (!revision) this.history = null;
		this.historyError = "";
		this.historyLoading = true;
		try {
			const result = await read();
			if (!isCurrent()) return;
			if (revision) this.historyRevision = result as InstructionSourceResult;
			else this.history = result as InstructionHistory;
		} catch (error) {
			if (isCurrent()) this.historyError = error instanceof Error ? error.message : String(error);
		} finally {
			if (isCurrent()) this.historyLoading = false;
		}
	}

	protected async loadHistory() {
		const source = this.store.instructionSource.get();
		if (source) await this.readHistory(() => this.store.listInstructionHistory(source.key));
	}

	protected async onHistoryRevision(event: Event) {
		const source = this.store.instructionSource.get();
		const revision = Number((event.currentTarget as HTMLElement).dataset.historyRevision);
		if (source) await this.readHistory(() => this.store.readInstructionRevision(source.key, revision), true);
	}

	protected onRestoreRevision() {
		const dirty = this.dirty;
		const revision = this.historyRevision;
		const source = this.store.instructionSource.get();
		const tenant = this.store.selectedTenant.get();
		if (!revision || !source) return;
		this.requestNavigation(() => {
			this.dirty = this.store.instructionSource.get() === source && dirty;
			void this.updateComplete.then(() => {
				if (!this.isConnected || this.store.instructionSource.get()?.key !== source.key || this.store.selectedTenant.get() !== tenant) return;
				this.historyRevision = revision;
				void this.prepareRestore();
			});
		});
	}

	protected async prepareRestore() {
		const source = this.store.instructionSource.get();
		const tenant = this.store.selectedTenant.get();
		const generation = this.historyGeneration;
		if (!source || !this.historyRevision) return;
		this.restoreOpen = true;
		this.restoreImpact = null;
		this.restoreError = "";
		try {
			const impact = await this.store.inspectInstructionDependencies(source.key);
			if (this.isConnected && this.restoreOpen && generation === this.historyGeneration
				&& this.store.instructionSource.get() === source && this.store.selectedTenant.get() === tenant) this.restoreImpact = impact;
		} catch (error) {
			if (this.isConnected && this.restoreOpen && generation === this.historyGeneration
				&& this.store.selectedTenant.get() === tenant) this.restoreError = error instanceof Error ? error.message : String(error);
		}
	}

	protected onCancelRestore(event?: Event) {
		event?.preventDefault();
		if (this.store.instructionSaving.get()) return;
		this.historyGeneration += 1;
		this.restoreOpen = false;
		this.restoreImpact = null;
		this.restoreError = "";
	}

	protected async onConfirmRestore() {
		if (!this.historyRevision || !this.restoreImpact || this.store.instructionSaving.get()) return;
		const generation = this.historyGeneration;
		this.restoreError = "";
		try {
			await this.store.restoreInstructionRevision(this.historyRevision.source.revision);
			this.dirty = false;
			this.restoreOpen = false;
		} catch (error) {
			if (this.isConnected && generation === this.historyGeneration) this.restoreError = error instanceof Error ? error.message : String(error);
		}
	}

	protected clearReset() {
		this.resetGeneration += 1;
		this.resetOpen = false;
		this.resetInspection = null;
		this.resetAllInspection = null;
		this.resetError = "";
		this.resetCompleted = false;
	}

	protected onResetInstruction() {
		this.requestReset(false);
	}

	protected onResetAll() {
		this.requestReset(true);
	}

	protected requestReset(all: boolean) {
		const source = this.store.instructionSource.get();
		const tenant = this.store.selectedTenant.get();
		const dirty = this.dirty;
		if (!all && (!source || source.source.type === "personal")) return;
		this.shadowRoot?.querySelector<HTMLDetailsElement>(all ? ".set-actions" : ".item-actions")?.removeAttribute("open");
		this.requestNavigation(() => {
			this.dirty = this.store.instructionSource.get() === source && dirty;
			void this.updateComplete.then(() => {
				if (this.isConnected && this.store.instructionSource.get()?.key === source?.key && this.store.selectedTenant.get() === tenant) void this.prepareReset(all);
			});
		});
	}

	protected async prepareReset(all: boolean) {
		const source = this.store.instructionSource.get();
		const tenant = this.store.selectedTenant.get();
		const generation = ++this.resetGeneration;
		if (!all && !source) return;
		this.resettingAll = all;
		this.resetOpen = true;
		this.resetInspection = null;
		this.resetAllInspection = null;
		this.resetError = "";
		try {
			if (all) {
				const inspection = await this.store.inspectInstructionResetAll();
				if (this.isConnected && generation === this.resetGeneration && this.store.selectedTenant.get() === tenant) this.resetAllInspection = inspection;
			} else {
				const inspection = await this.store.inspectInstructionReset(source!.key);
				if (this.isConnected && generation === this.resetGeneration && this.store.selectedTenant.get() === tenant) this.resetInspection = inspection;
			}
		} catch (error) {
			if (this.isConnected && generation === this.resetGeneration) this.resetError = error instanceof Error ? error.message : String(error);
		}
	}

	protected onCancelReset(event?: Event) {
		event?.preventDefault();
		if (!this.store.instructionSaving.get()) this.clearReset();
	}

	protected async onRefreshReset() {
		if (this.store.instructionSaving.get()) return;
		if (!this.resetCompleted) {
			await this.prepareReset(this.resettingAll);
			return;
		}
		const generation = this.resetGeneration;
		const tenant = this.store.selectedTenant.get();
		try {
			await this.store.reloadResetInstructions();
			if (!this.isConnected || this.store.selectedTenant.get() !== tenant) return;
			this.dirty = false;
			this.clearReset();
		} catch (error) {
			if (this.isConnected && generation === this.resetGeneration) this.resetError = `Reset All completed. ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	protected async onConfirmReset() {
		if ((!this.resetInspection && !this.resetAllInspection) || this.resetError || this.store.instructionSaving.get()) return;
		const generation = this.resetGeneration;
		const tenant = this.store.selectedTenant.get();
		this.resetError = "";
		try {
			if (this.resetAllInspection) await this.store.resetInstructionAll(this.resetAllInspection);
			else await this.store.resetInstructionSource(this.resetInspection!);
			if (!this.isConnected || this.store.selectedTenant.get() !== tenant) return;
			this.dirty = false;
			this.clearReset();
		} catch (error) {
			if (this.isConnected && generation === this.resetGeneration) {
				this.resetCompleted = error instanceof InstructionResetRefreshError;
				this.resetError = error instanceof Error ? error.message : String(error);
			}
		}
	}

	protected invalidateDependencies() {
		this.dependenciesGeneration += 1;
		this.dependencies = null;
		this.dependenciesError = "";
		this.dependenciesLoading = false;
	}

	protected async loadDependencies() {
		const source = this.store.instructionSource.get();
		if (!source) return;
		const tenant = this.store.selectedTenant.get();
		const generation = ++this.dependenciesGeneration;
		const isCurrent = () => generation === this.dependenciesGeneration && this.isConnected
			&& this.store.instructionSource.get() === source && this.store.selectedTenant.get() === tenant;
		this.dependencies = null;
		this.dependenciesError = "";
		this.dependenciesLoading = true;
		try {
			const dependencies = await this.store.inspectInstructionDependencies(source.key);
			if (isCurrent()) this.dependencies = dependencies;
		} catch (error) {
			if (isCurrent()) this.dependenciesError = error instanceof Error ? error.message : String(error);
		} finally {
			if (isCurrent()) this.dependenciesLoading = false;
		}
	}

	protected invalidateComparison() {
		this.comparisonGeneration += 1;
		this.comparison = null;
		this.comparisonError = "";
		this.comparisonLoading = false;
	}

	protected async loadComparison() {
		const source = this.store.instructionSource.get();
		if (!source) return;
		const tenant = this.store.selectedTenant.get();
		const generation = ++this.comparisonGeneration;
		const isCurrent = () => generation === this.comparisonGeneration && this.isConnected
			&& this.store.instructionSource.get() === source && this.store.selectedTenant.get() === tenant;
		this.comparison = null;
		this.comparisonError = "";
		this.comparisonLoading = true;
		try {
			const comparison = await this.store.compareInstructionSource(source.key);
			if (isCurrent()) this.comparison = comparison;
		} catch (error) {
			if (isCurrent()) this.comparisonError = error instanceof Error ? error.message : String(error);
		} finally {
			if (isCurrent()) this.comparisonLoading = false;
		}
	}

	protected async loadPreview() {
		const editor = this.shadowRoot?.querySelector("agent-issues-instruction-editor");
		const source = this.store.instructionSource.get();
		if (!editor || !source) return;
		const tenant = this.store.selectedTenant.get();
		const generation = ++this.previewGeneration;
		const isCurrent = () => generation === this.previewGeneration && this.isConnected
			&& this.store.instructionSource.get() === source && this.store.selectedTenant.get() === tenant;
		this.preview = null;
		this.previewError = "";
		this.previewLoading = true;
		try {
			const body = await editor.readMarkdown();
			if (!isCurrent()) return;
			if (this.editTogether) await this.captureStagedItem();
			if (!isCurrent()) return;
			const changes = this.editTogether ? [...this.stagedItems].map(([key, item]) => ({ key, body: item.body })) : undefined;
			const preview = await this.store.previewInstructionSource(source.key, body, changes);
			if (isCurrent()) this.preview = preview;
		} catch (error) {
			if (isCurrent()) this.previewError = error instanceof Error ? error.message : String(error);
		} finally {
			if (isCurrent()) this.previewLoading = false;
		}
	}

	protected onOpenFragment(event: CustomEvent<{ key: string }>) {
		this.openInstruction(event.detail.key);
	}

	protected onOpenDependency(event: Event) {
		const key = (event.currentTarget as HTMLElement).dataset.openInstruction;
		if (key) this.openInstruction(key);
	}

	protected openInstruction(key: string) {
		if (this.editTogether) {
			void this.selectStagedItem(key, key.slice(0, key.indexOf("/")) as InstructionKind);
			return;
		}
		this.requestNavigation(() => {
			const category = key.slice(0, key.indexOf("/")) as InstructionKind;
			if (category !== this.store.instructionCategory.get()) this.store.selectInstructionCategory(category);
			void this.store.selectInstruction(key);
		});
	}

	protected async onSave() {
		if (this.editTogether) return this.onSaveAll();
		return this.saveInstruction();
	}

	protected async onRetrySave() {
		const revision = this.store.instructionConflict.get()?.source.revision;
		if (revision === undefined) return;
		if (this.pendingNavigation) await this.saveAndNavigate(revision);
		else await this.saveInstruction(revision);
	}

	protected async saveInstruction(expectedRevision?: number) {
		const editor = this.shadowRoot?.querySelector("agent-issues-instruction-editor");
		const source = this.store.instructionSource.get();
		const tenant = this.store.selectedTenant.get();
		if (!editor || !source || this.saving || this.store.instructionSaving.get()) return false;
		this.saving = true;
		try {
			const body = await editor.readMarkdown();
			if (this.store.instructionSource.get() !== source || this.store.selectedTenant.get() !== tenant) {
				throw new Error("The instruction owner or source changed. The changes were not saved.");
			}
			const saved = await this.store.saveInstructionSource(body, expectedRevision);
			if (saved) this.dirty = false;
			return saved;
		} catch (error) {
			this.store.instructionError.set(error instanceof Error ? error.message : String(error));
			return false;
		} finally {
			this.saving = false;
		}
	}

	protected onCategory(event: Event) {
		const category = (event.currentTarget as HTMLElement).dataset.category as InstructionKind;
		if (category === this.store.instructionCategory.get()) return;
		if (this.editTogether) {
			void this.selectStagedItem(null, category);
			return;
		}
		this.store.selectInstructionCategory(category);
	}

	protected onSearch(event: Event) {
		this.store.instructionSearch.set((event.target as HTMLInputElement).value);
	}

	protected onSelect(event: Event) {
		const key = (event.currentTarget as HTMLElement).dataset.instructionKey ?? null;
		if (key === this.store.selectedInstructionKey.get()) return;
		if (this.editTogether) {
			void this.selectStagedItem(key);
			return;
		}
		void this.store.selectInstruction(key);
	}

	protected onBack() {
		if (this.editTogether) {
			void this.selectStagedItem(null);
			return;
		}
		void this.store.selectInstruction(null);
	}

	protected onCreateFragment() {
		this.resetFragmentDialog();
		this.fragmentKey = "fragment/";
		this.creatingFragment = true;
	}

	protected onRemoveFragment(event: Event) {
		const key = (event.currentTarget as HTMLElement).dataset.removeFragment!;
		const source = this.store.instructionSource.get();
		const dirty = !this.editTogether && this.dirty;
		const confirm = () => {
			const catalog = this.store.instructionCatalog.get();
			const item = catalog?.items.find((candidate) => candidate.key === key);
			if (!item || item.source.type !== "personal") return;
			if (this.store.instructionSource.get() === source) this.dirty = dirty;
			this.resetFragmentDialog();
			this.removingFragment = { ...item, version: catalog!.version };
		};
		if (this.editTogether || key === this.store.selectedInstructionKey.get()) this.requestNavigation(confirm);
		else confirm();
	}

	protected async onConfirmRemoveFragment() {
		const fragment = this.removingFragment;
		if (!fragment || this.store.instructionSaving.get()) return;
		const generation = this.fragmentGeneration;
		const selected = fragment.key === this.store.selectedInstructionKey.get();
		this.fragmentError = "";
		try {
			await this.store.removeInstructionFragment(fragment);
			if (!this.isConnected || generation !== this.fragmentGeneration) return;
			this.resetFragmentDialog();
			if (selected) this.dirty = false;
		} catch (error) {
			if (!this.isConnected || generation !== this.fragmentGeneration) return;
			this.fragmentError = error instanceof Error ? error.message : String(error);
			this.fragmentConflict = error instanceof InstructionFragmentError ? error.currentSource ?? null : null;
			this.fragmentReferences = error instanceof InstructionFragmentError ? error.affectedReferences : [];
		}
	}

	protected onFragmentKey(event: Event) {
		this.fragmentKey = (event.target as HTMLInputElement).value;
	}

	protected onCancelFragment(event?: Event) {
		event?.preventDefault();
		if (this.store.instructionSaving.get()) return;
		this.resetFragmentDialog();
	}

	protected resetFragmentDialog() {
		this.fragmentGeneration += 1;
		this.shadowRoot?.querySelector<HTMLDialogElement>(".fragment-dialog")?.close();
		this.creatingFragment = false;
		this.removingFragment = null;
		this.fragmentError = "";
		this.fragmentConflict = null;
		this.fragmentReferences = [];
	}

	protected async onConfirmCreateFragment(event: Event) {
		event.preventDefault();
		if (this.store.instructionSaving.get()) return;
		const generation = this.fragmentGeneration;
		this.fragmentError = "";
		try {
			const created = await this.store.createInstructionFragment(this.fragmentKey.trim());
			if (!this.isConnected || generation !== this.fragmentGeneration) return;
			this.resetFragmentDialog();
			if (this.editTogether) {
				this.store.instructionSearch.set("");
				await this.selectStagedItem(created.key, "fragment");
				return;
			}
			this.requestNavigation(() => {
				this.store.instructionSearch.set("");
				void this.store.selectInstruction(created.key);
			});
		} catch (error) {
			if (this.isConnected && generation === this.fragmentGeneration) this.fragmentError = error instanceof Error ? error.message : String(error);
		}
	}

	protected onRetry() {
		if (this.dirty) {
			if (this.pendingNavigation) void this.saveAndNavigate();
			else void this.onSave();
		} else void this.store.loadInstructionCatalog();
	}

	protected itemName(key: string) {
		return key.slice(key.indexOf("/") + 1);
	}

	protected sourceLabel(source: InstructionSource) {
		return source.type === "default" ? "Default" : "Personal edits";
	}

	protected renderSaveError() {
		const store = this.store;
		const conflict = store.instructionConflict.get();
		return html`
		${when(store.instructionError.get(), () => html`
		<div class="error" role="alert">
			<span>${store.instructionError.get()}</span>
			<button
				?disabled=${this.saving || store.instructionSaving.get()}
				@click=${this.onRetry}
			>
				Retry
			</button>
		</div>
		`)}
		${when(conflict, () => html`
		<section class="conflict" aria-label="Revision comparison">
			<p>Editing revision ${store.instructionSource.get()?.source.revision}</p>
			<p>Saved revision ${conflict?.source.revision}</p>
			<pre data-current-instruction>${conflict?.body}</pre>
			<button
				data-retry-instruction-save
				?disabled=${this.saving || store.instructionSaving.get()}
				@click=${this.onRetrySave}
			>
				${this.saveIcon.cloneNode(true)} Save Against Revision ${conflict?.source.revision}
			</button>
		</section>
		`)}
		`;
	}

	protected renderPreview() {
		return html`
		<div class="preview-toolbar">
			<span role="status">Pending</span>
			<button
				aria-label="Refresh preview"
				title="Refresh preview"
				?disabled=${this.previewLoading}
				@click=${this.loadPreview}
			>
				${this.refreshIcon}
			</button>
		</div>
		${when(this.previewLoading, () => html`<p role="status">Loading preview...</p>`)}
		${when(this.previewError, () => html`<p role="alert">${this.previewError}</p>`)}
		${when(this.preview, () => html`
		<article data-instruction-preview>
			${unsafeHTML(DOMPurify.sanitize(marked.parse(splitInstructionMarkdown(this.preview!.body).body, { async: false })))}
		</article>
		<details>
			<summary>Assembled Text</summary>
			<pre data-assembled-text>${this.preview!.body}</pre>
		</details>
		`)}
		`;
	}

	protected renderComparison() {
		const comparison = this.comparison;
		const originalVersion = comparison?.currentSource.source.type === "override"
			? comparison.currentSource.source.defaultVersion : null;
		const changes = comparison?.defaultSource
			? diffLines(comparison.defaultSource.body, comparison.currentSource.body) : [];
		return html`
		<div class="preview-toolbar">
			<span>Saved source</span>
			<button
				aria-label="Refresh comparison"
				title="Refresh comparison"
				?disabled=${this.comparisonLoading}
				@click=${this.loadComparison}
			>
				${this.refreshIcon.cloneNode(true)}
			</button>
		</div>
		${when(this.comparisonLoading, () => html`<p role="status">Loading comparison...</p>`)}
		${when(this.comparisonError, () => html`<p role="alert">${this.comparisonError}</p>`)}
		${when(comparison, () => html`
		<section data-instruction-comparison aria-label="Default comparison">
			<p>Applicable default version ${comparison!.version}</p>
			${when(originalVersion, () => html`<p>Original default version ${originalVersion}</p>`)}
			${when(comparison!.newerDefaultVersions.length, () => html`<p class="update">Newer defaults: ${comparison!.newerDefaultVersions.join(", ")}</p>`)}
			${when(comparison!.defaultSource, () => html`
				${when(!comparison!.different, () => html`<p>No personal differences.</p>`)}
				<p class="diff-legend">Removed from default (-) / Added in saved source (+)</p>
				<pre class="inline-diff" aria-label="Source differences">${map(changes, (change) => choose(change.added ? "added" : change.removed ? "removed" : "unchanged", [
					["added", () => html`<ins aria-label="Added in saved source">${change.value}</ins>`],
					["removed", () => html`<del aria-label="Removed from default">${change.value}</del>`]
				], () => html`<span>${change.value}</span>`))}</pre>
			`, () => html`
				<p>Personal fragment. No official default.</p>
				<pre>${comparison!.currentSource.body}</pre>
			`)}
		</section>
		`)}
		`;
	}

	protected renderDependencies() {
		const inspection = this.dependencies;
		const releaseChanges = this.store.instructionSource.get()?.releaseChanges?.dependencies;
		return html`
		<div class="preview-toolbar">
			<span>Saved source</span>
			<button
				aria-label="Refresh dependencies"
				title="Refresh dependencies"
				?disabled=${this.dependenciesLoading}
				@click=${this.loadDependencies}
			>
				${this.refreshIcon.cloneNode(true)}
			</button>
		</div>
		${when(this.dependenciesLoading, () => html`
			<p role="status">Loading dependencies...</p>
		`)}
		${when(this.dependenciesError, () => html`
			<p role="alert">${this.dependenciesError}</p>
		`)}
		${when(inspection, () => html`
		<section data-instruction-dependencies>
			<p>Default version ${inspection!.version}</p>
			${when(releaseChanges && Object.values(releaseChanges).some((keys) => keys.length), () => html`
			<section aria-label="Release dependency changes">
				<h3>Release dependency changes</h3>
				${map(["added", "removed", "changed"] as const, (change) => when(releaseChanges![change].length, () => html`
					<p>${change[0].toUpperCase() + change.slice(1)}: ${releaseChanges![change].join(", ")}</p>
				`))}
			</section>
			`)}
			<h3>Included fragments</h3>
			${when(inspection!.dependencies.some((dependency) => !dependency.source), () => html`
				<p role="alert">Unresolved references</p>
			`)}
			<ul>
				${map(inspection!.dependencies, (dependency) => html`
				<li>
					<button
						data-open-instruction=${dependency.key}
						title=${`Open ${dependency.key}`}
						?disabled=${!dependency.source}
						@click=${this.onOpenDependency}
					>
						${dependency.key} ${this.openIcon.cloneNode(true)}
					</button>
					<span>${when(dependency.direct, () => html`Direct`, () => html`Nested`)}</span>
					${when(!dependency.source, () => html`
						<span>${when(dependency.reason === "not-fragment", () => html`Not a fragment`, () => html`Missing fragment`)}</span>
					`)}
					${when(dependency.source, () => html`
						<span>${this.sourceLabel(dependency.source!)} / Revision ${dependency.source!.revision}</span>
					`)}
					${when(inspection!.modifiedFragments.includes(dependency.key), () => html`
						<span data-modified-fragment>Modified fragment</span>
					`)}
				</li>
				`)}
			</ul>
			${when(!inspection!.dependencies.length, () => html`
				<p>No included fragments.</p>
			`)}
			<h3>Affected instructions</h3>
			<ul>
				${map(inspection!.affectedInstructions, (key) => html`
				<li data-affected-instruction=${key}>
					<button
						data-open-instruction=${key}
						title=${`Open ${key}`}
						@click=${this.onOpenDependency}
					>
						${key} ${this.openIcon.cloneNode(true)}
					</button>
				</li>
				`)}
			</ul>
			${when(!inspection!.affectedInstructions.length, () => html`
				<p>No affected instructions.</p>
			`)}
		</section>
		`)}
		`;
	}

	protected renderHistory() {
		return html`
		<div class="preview-toolbar">
			<span>Saved revisions</span>
			<button
				aria-label="Refresh history"
				title="Refresh history"
				?disabled=${this.historyLoading}
				@click=${this.loadHistory}
			>
				${this.refreshIcon.cloneNode(true)}
			</button>
		</div>
		${when(this.historyLoading, () => html`
			<p role="status">Loading history...</p>
		`)}
		${when(this.historyError, () => html`
			<p role="alert">${this.historyError}</p>
		`)}
		${when(this.history, () => html`
			<ul>
				${repeat(this.history!.revisions, (revision) => revision.source.revision, (revision) => html`
				<li>
					<button
						data-history-revision=${revision.source.revision}
						aria-pressed=${String(this.historyRevision?.source.revision === revision.source.revision)}
						?disabled=${this.historyLoading}
						@click=${this.onHistoryRevision}
					>
						Revision ${revision.source.revision}
					</button>
				</li>
				`)}
			</ul>
			${when(!this.history!.revisions.length, () => html`
				<p>No saved revisions.</p>
			`)}
		`)}
		${when(this.historyRevision, () => html`
			<section aria-label="Selected revision">
				<p>Revision ${this.historyRevision!.source.revision} / Default version ${this.historyRevision!.version}</p>
				<pre data-history-source>${this.historyRevision!.body}</pre>
				<button
					data-restore-revision
					?disabled=${this.saving || this.store.instructionSaving.get()}
					@click=${this.onRestoreRevision}
				>
					${this.restoreIcon.cloneNode(true)} Restore
				</button>
			</section>
		`)}
		`;
	}

	protected renderRestoreDialog() {
		const source = this.store.instructionSource.get();
		const revision = this.historyRevision;
		const changes = source && revision ? diffLines(source.body, revision.body) : [];
		return html`
		<dialog
			class="restore-dialog"
			aria-labelledby="restore-dialog-title"
			@cancel=${this.onCancelRestore}
		>
			<h2 id="restore-dialog-title">Restore revision ${revision?.source.revision}</h2>
			<p>${source?.key} / Expected revision ${source?.source.revision}</p>
			${when(this.dirty, () => html`
				<p>Unsaved changes will be discarded only if restore succeeds.</p>
			`)}
			<h3>Proposed source changes</h3>
			<p>Removed from saved source (-) / Added by restore (+)</p>
			<pre class="inline-diff" aria-label="Proposed source changes">${map(changes, (change) => choose(change.added ? "added" : change.removed ? "removed" : "unchanged", [
				["added", () => html`<ins>${change.value}</ins>`],
				["removed", () => html`<del>${change.value}</del>`]
			], () => html`<span>${change.value}</span>`))}</pre>
			<h3>Affected instructions</h3>
			${when(this.restoreImpact, () => html`
				<ul>${map([...new Set([source!.key, ...this.restoreImpact!.affectedInstructions])], (key) => html`
					<li>${key}</li>
				`)}</ul>
			`, () => when(!this.restoreError, () => html`
				<p role="status">Loading impact...</p>
			`))}
			${when(this.restoreError, () => html`
				<p role="alert">${this.restoreError}</p>
			`)}
			<div class="navigation-actions">
				<button
					data-cancel-restore
					?disabled=${this.store.instructionSaving.get()}
					@click=${this.onCancelRestore}
				>
					Cancel
				</button>
				<button
					data-confirm-restore
					?disabled=${!this.restoreImpact || this.store.instructionSaving.get()}
					@click=${this.onConfirmRestore}
				>
					${this.restoreIcon.cloneNode(true)} Restore
				</button>
			</div>
		</dialog>
		`;
	}

	protected renderResetDialog() {
		const inspection = this.resetInspection;
		const allInspection = this.resetAllInspection;
		const ready = !!inspection || !!allInspection;
		const changes = inspection ? diffLines(inspection.currentSource.body, inspection.proposedSource.body) : [];
		return html`
		<dialog
			class="reset-dialog"
			aria-labelledby="reset-dialog-title"
			@cancel=${this.onCancelReset}
		>
			<h2 id="reset-dialog-title">${when(this.resettingAll, () => html`Reset All`, () => html`Reset to Default`)}</h2>
			${when(!this.resettingAll, () => html`<p>Fragment overrides remain unchanged.</p>`)}
			${when(this.dirty, () => html`
				<p>Unsaved changes will be discarded only if reset succeeds.</p>
			`)}
			${when(inspection, () => html`
				<p>${inspection!.key} / Default version ${inspection!.version} / Expected revision ${inspection!.currentSource.source.revision}</p>
				<h3>Proposed source changes</h3>
				<pre class="inline-diff">${map(changes, (change) => choose(change.added ? "added" : change.removed ? "removed" : "unchanged", [
					["added", () => html`<ins>${change.value}</ins>`],
					["removed", () => html`<del>${change.value}</del>`]
				], () => html`<span>${change.value}</span>`))}</pre>
				<h3>Retained modified fragments</h3>
				<ul>${map(inspection!.modifiedFragments, (key) => html`<li>${key}</li>`)}</ul>
				<h3>Affected instructions</h3>
				<ul>${map(inspection!.affectedInstructions, (key) => html`<li>${key}</li>`)}</ul>
			`)}
			${when(allInspection, () => html`
				<p>Default version ${allInspection!.version}. Official defaults and other owners remain unchanged.</p>
				<h3>Overrides to reset</h3>
				${map(allInspection!.overrides, (item) => html`
					<h4>${item.currentSource.key}</h4>
					<p>Expected revision ${item.currentSource.source.revision}</p>
					<pre>${item.currentSource.body}</pre>
					<p>Replacement</p>
					${when(item.proposedSource, () => html`<pre>${item.proposedSource!.body}</pre>`, () => html`<p>Remove override; no default in this release.</p>`)}
				`)}
				<h3>Personal fragments to remove</h3>
				<ul>${map(allInspection!.personalFragments, (item) => html`<li>${item.key} / Expected revision ${item.source.revision}</li>`)}</ul>
				<h3>Affected instructions</h3>
				<ul>${map(allInspection!.affectedInstructions, (key) => html`<li>${key}</li>`)}</ul>
			`)}
			${when(!ready && !this.resetError, () => html`<p role="status">Loading impact...</p>`)}
			${when(this.resetError, () => html`<p role="alert">${this.resetError}</p>`)}
			<div class="navigation-actions">
				${when(this.resetError, () => html`
				<button
					data-refresh-reset
					?disabled=${this.store.instructionSaving.get()}
					@click=${this.onRefreshReset}
				>
					${this.refreshIcon.cloneNode(true)} ${when(this.resetCompleted, () => html`Refresh instructions`, () => html`Refresh impact`)}
				</button>
				`)}
				<button
					data-cancel-reset
					?disabled=${this.store.instructionSaving.get()}
					@click=${this.onCancelReset}
				>
					Cancel
				</button>
				<button
					data-confirm-reset
					?disabled=${!ready || !!this.resetError || this.store.instructionSaving.get()}
					@click=${this.onConfirmReset}
				>
					${this.restoreIcon.cloneNode(true)} ${when(this.resettingAll, () => html`Reset All`, () => html`Reset to Default`)}
				</button>
			</div>
		</dialog>
		`;
	}

	override render() {
		const store = this.store;
		const catalog = store.instructionCatalog.get();
		const source = store.instructionSource.get();
		const owner = catalog?.owner;
		const ownerLabel = owner?.type === "cloud" ? `${owner.tenantId} / ${owner.userId}` : "Local profile";
		const sourceLabel = source ? this.sourceLabel(source.source) : "";
		const saveDisabled = (this.editTogether ? !this.hasPendingChanges() : !this.dirty)
			|| this.saving || this.switchingItem || store.instructionSaving.get() || store.instructionSourceLoading.get();
		const categories: Array<{ kind: InstructionKind; label: string }> = [
			{ kind: "agent", label: "Agent" }, { kind: "skill", label: "Skills" }, { kind: "fragment", label: "Fragments" }
		];
		return html`
		<header class="page-header">
			<h1>Instructions</h1>
			${when(!this.editTogether, () => html`
			<button
				data-edit-together
				?disabled=${!catalog || this.saving || store.instructionSaving.get()}
				@click=${this.onEditTogether}
			>
				${this.createIcon.cloneNode(true)} Edit Together
			</button>
			`)}
			${when(owner, () => html`
			<p>${ownerLabel}</p>
			<p>Default version ${catalog?.version}</p>
			`)}
			${when(catalog, () => html`
			<details class="set-actions">
				<summary
					title="Instruction-set actions"
					aria-label="Instruction-set actions"
				>
					${this.actionsIcon.cloneNode(true)}
				</summary>
				<button
					data-reset-all
					?disabled=${this.saving || store.instructionSaving.get() || store.instructionCatalogLoading.get()}
					@click=${this.onResetAll}
				>
					${this.restoreIcon.cloneNode(true)} Reset All
				</button>
			</details>
			`)}
		</header>
		${when(this.editTogether, () => html`
		<section class="pending-changes" data-pending-changes aria-label="Pending changes">
			<div class="pending-toolbar">
			<h2>Edit Together</h2>
			<button
				aria-label="Inspect pending changes"
				title="Inspect pending changes"
				?disabled=${this.saving || this.switchingItem || store.instructionSaving.get()}
				@click=${this.onInspectPending}
			>
				${this.refreshIcon.cloneNode(true)}
			</button>
			<button
				data-exit-together
				?disabled=${this.saving || this.switchingItem || store.instructionSaving.get()}
				@click=${this.onExitTogether}
			>
				${this.backIcon.cloneNode(true)} Exit Edit Together
			</button>
			<button
				data-save-all
				?disabled=${!this.hasPendingChanges() || this.saving || this.switchingItem || store.instructionSaving.get()}
				@click=${this.onSaveAll}
			>
				${this.saveIcon.cloneNode(true)} Save All
			</button>
			</div>
			${map([...this.stagedItems], ([key, item]) => html`
			<details>
				<summary>${key} ${when(item.body !== item.source.body, () => html`Pending`)}</summary>
				<pre>${item.body}</pre>
				<button
					data-pending-item=${key}
					@click=${this.onPendingItem}
				>
					${this.openIcon.cloneNode(true)} Open
				</button>
			</details>
			`)}
		</section>
		`)}
		${when(!this.pendingNavigation, () => this.renderSaveError())}
		<div
			class="workspace"
			data-selected=${String(!!store.selectedInstructionKey.get())}
		>
			<section class="catalog" aria-label="Instruction catalog">
				<div class="categories" role="tablist" aria-label="Instruction categories">
					${repeat(categories, (category) => category.kind, (category) => html`
					<button
						aria-selected=${String(store.instructionCategory.get() === category.kind)}
						data-category=${category.kind}
						role="tab"
						@click=${this.onCategory}
					>
						${category.label}
					</button>
					`)}
				</div>
				<input
					aria-label="Search instructions"
					placeholder="Search instructions"
					type="search"
					.value=${store.instructionSearch.get()}
					@input=${this.onSearch}
				>
				${when(store.instructionCategory.get() === "fragment", () => html`
				<button
					aria-label="Create fragment"
					title="Create fragment"
					?disabled=${store.instructionSaving.get() || store.instructionCatalogLoading.get() || !catalog}
					@click=${this.onCreateFragment}
				>
					${this.createIcon} Create fragment
				</button>
				`)}
				<div class="items">
					${when(store.instructionCatalogLoading.get(), () => html`<p role="status">Loading instructions...</p>`)}
					${repeat(store.filteredInstructions.get(), (item) => item.key, (item) => html`
					<div class="item-row">
					<button
						aria-pressed=${String(store.selectedInstructionKey.get() === item.key)}
						class="item"
						data-instruction-key=${item.key}
						@click=${this.onSelect}
					>
						<span class="item-name">${this.itemName(item.key)}</span>
						<span class="metadata">${this.sourceLabel(item.source)}</span>
						${when(item.releaseChanges?.newerDefaultAvailable, () => html`<span class="update">Newer default</span>`)}
					</button>
					${when(item.kind === "fragment" && item.source.type === "personal", () => html`
					<button
						aria-label=${`Remove ${item.key}`}
						title=${`Remove ${item.key}`}
						data-remove-fragment=${item.key}
						?disabled=${this.saving || store.instructionSaving.get()}
						@click=${this.onRemoveFragment}
					>
						${this.removeIcon.cloneNode(true)}
					</button>
					`)}
					</div>
					`)}
					${when(!store.instructionCatalogLoading.get() && !!catalog && !store.filteredInstructions.get().length, () => html`<p>No instructions found.</p>`)}
				</div>
			</section>
			<section class="detail" aria-label="Instruction source">
				${when(store.selectedInstructionKey.get(), () => html`
				<header class="item-header">
					<button
						aria-label="Back to instructions"
						class="back"
						title="Back to instructions"
						@click=${this.onBack}
					>
						${this.backIcon}
					</button>
					<h2>${this.itemName(store.selectedInstructionKey.get()!)}</h2>
					${when(source, () => html`
					<div class="item-metadata">
						<span class="metadata">${sourceLabel}</span>
						<span class="metadata">Default version ${source?.version}</span>
						<span class="metadata">${when(this.dirty, () => html`Unsaved changes`)}</span>
					</div>
					<button
						data-save-instruction
						?disabled=${saveDisabled}
						@click=${this.onSave}
					>
						${this.saveIcon} ${when(this.editTogether, () => html`Save All`, () => html`Save`)}
					</button>
					${when(source?.source.type !== "personal", () => html`
					<details class="item-actions">
						<summary
							title="Instruction actions"
							aria-label="Instruction actions"
						>
							${this.actionsIcon.cloneNode(true)}
						</summary>
						<button
							data-reset-instruction
							?disabled=${this.saving || store.instructionSaving.get()}
							@click=${this.onResetInstruction}
						>
							${this.restoreIcon.cloneNode(true)} Reset to Default
						</button>
					</details>
					`)}
					`)}
				</header>
				`, () => html`<p class="empty">Select an instruction</p>`)}
				${when(store.instructionSourceLoading.get(), () => html`<p role="status">Loading source...</p>`)}
				${when(source, () => html`
				<div class="item-views" role="tablist" aria-label="Instruction views">
					${repeat([{ id: "edit", label: "Edit" }, { id: "preview", label: "Preview" }, { id: "compare", label: "Compare" }, { id: "dependencies", label: "Dependencies" }, { id: "history", label: "History" }], (view) => view.id, (view) => html`
					<button
						id=${`${view.id}-tab`}
						role="tab"
						aria-controls=${`${view.id}-panel`}
						aria-selected=${String(this.activeView === view.id)}
						data-instruction-view=${view.id}
						@click=${this.onView}
					>
						${view.label}
					</button>
					`)}
				</div>
				<div
					id="edit-panel"
					role="tabpanel"
					aria-labelledby="edit-tab"
					?hidden=${this.activeView !== "edit"}
				>
				<agent-issues-instruction-editor
					.source=${this.editorSource}
					.fragments=${catalog?.items ?? []}
					.busy=${this.saving || this.switchingItem || store.instructionSaving.get()}
					@instruction-editor-change=${this.onEditorChange}
					@instruction-fragment-open=${this.onOpenFragment}
				></agent-issues-instruction-editor>
				</div>
				${when(this.activeView === "preview", () => html`
				<section
					id="preview-panel"
					role="tabpanel"
					aria-labelledby="preview-tab"
				>
					${this.renderPreview()}
				</section>
				`)}
				${when(this.activeView === "compare", () => html`
				<section
					id="compare-panel"
					role="tabpanel"
					aria-labelledby="compare-tab"
				>
					${this.renderComparison()}
				</section>
				`)}
				${when(this.activeView === "dependencies", () => html`
				<section
					id="dependencies-panel"
					role="tabpanel"
					aria-labelledby="dependencies-tab"
				>
					${this.renderDependencies()}
				</section>
				`)}
				${when(this.activeView === "history", () => html`
				<section
					id="history-panel"
					role="tabpanel"
					aria-labelledby="history-tab"
				>
					${this.renderHistory()}
				</section>
				`)}
				`)}
			</section>
		</div>
		${when(this.restoreOpen, () => this.renderRestoreDialog())}
		${when(this.resetOpen, () => this.renderResetDialog())}
		${when(this.creatingFragment || this.removingFragment, () => html`
			<dialog
				class="fragment-dialog"
				aria-labelledby="fragment-dialog-title"
				@cancel=${this.onCancelFragment}
			>
				<form @submit=${this.onConfirmCreateFragment}>
					<h2 id="fragment-dialog-title">${when(this.creatingFragment, () => html`Create fragment`, () => html`Remove fragment`)}</h2>
					${when(this.creatingFragment, () => html`
					<label>
						Fragment key
						<input
							aria-label="Fragment key"
							required
							pattern="fragment/.+"
							.value=${this.fragmentKey}
							?disabled=${store.instructionSaving.get()}
							@input=${this.onFragmentKey}
						>
					</label>
					`, () => html`
					<p>Remove ${this.removingFragment?.key}?</p>
					${when(this.dirty && this.removingFragment?.key === store.selectedInstructionKey.get(), () => html`
						<p>Unsaved changes will be discarded only if removal succeeds.</p>
					`)}
					`)}
					${when(this.fragmentError, () => html`<p role="alert">${this.fragmentError}</p>`)}
					${when(this.fragmentReferences.length, () => html`
						<h3>Affected instructions</h3>
						<ul>${map(this.fragmentReferences, (key) => html`<li>${key}</li>`)}</ul>
					`)}
					${when(this.fragmentConflict, () => html`
						<p>Requested revision ${this.removingFragment?.source.revision}. Saved revision ${this.fragmentConflict?.source.revision}.</p>
						<pre>${this.fragmentConflict?.body}</pre>
					`)}
					<div class="navigation-actions">
						<button
							type="button"
							data-cancel-fragment
							?disabled=${store.instructionSaving.get()}
							@click=${this.onCancelFragment}
						>
							Cancel
						</button>
						${when(this.creatingFragment, () => html`
						<button
							type="submit"
							data-confirm-create-fragment
							?disabled=${store.instructionSaving.get()}
						>
							Create
						</button>
						`, () => html`
						<button
							type="button"
							data-confirm-remove-fragment
							?disabled=${store.instructionSaving.get()}
							@click=${this.onConfirmRemoveFragment}
						>
							${this.removeIcon.cloneNode(true)} Remove
						</button>
						`)}
					</div>
				</form>
			</dialog>
		`)}
		${when(this.pendingNavigation, () => html`
			<dialog
				class="navigation-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="unsaved-title"
				@cancel=${this.onDialogCancel}
				@keydown=${this.onDialogKeyDown}
			>
				<h2 id="unsaved-title">Unsaved changes</h2>
				${this.renderSaveError()}
				<div class="navigation-actions">
					<button
						autofocus
						data-cancel-navigation
						?disabled=${this.saving || store.instructionSaving.get()}
						@click=${this.onCancelNavigation}
					>
						Cancel
					</button>
					<button
						data-discard-navigation
						?disabled=${this.saving || store.instructionSaving.get()}
						@click=${this.onDiscardNavigation}
					>
						${when(this.editTogether, () => html`Discard All`, () => html`Discard`)}
					</button>
					<button
						data-save-navigation
						?disabled=${this.saving || store.instructionSaving.get()}
						@click=${this.onSaveNavigation}
					>
						${this.saveIcon.cloneNode(true)} ${when(this.editTogether, () => html`Save All`, () => html`Save`)}
					</button>
				</div>
			</dialog>
		`)}
		`;
	}

	static styles = [issueBrowserTypographyStyles, issueBrowserControlStyles, css`
	:host {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		height: 100%;
		background: var(--surface);
		color: var(--text);
	}
	.page-header {
		padding: 20px 24px;
		border-bottom: 1px solid var(--border);
	}
	h1 {
		margin: 0 0 8px;
		font-size: 22px;
	}
	h2 {
		margin: 0;
		font-size: 18px;
		overflow-wrap: anywhere;
	}
	.pending-changes {
		flex-shrink: 0;
		max-height: 180px;
		overflow: auto;
		padding: 12px 24px;
		border-bottom: 1px solid var(--border);
		background: var(--surface-muted);
	}
	.pending-toolbar {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}
	.pending-toolbar h2 {
		font-size: 15px;
	}
	.pending-toolbar button {
		display: inline-flex;
	}
	.pending-changes details {
		margin-top: 8px;
		overflow-wrap: anywhere;
	}
	.pending-changes pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	p {
		margin: 6px 0;
		overflow-wrap: anywhere;
	}
	.workspace {
		display: grid;
		grid-template-columns: 300px minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr);
		flex: 1;
		min-height: 0;
	}
	.catalog {
		display: flex;
		flex-direction: column;
		gap: 16px;
		min-width: 0;
		min-height: 0;
		padding: 16px;
		border-right: 1px solid var(--border);
	}
	.categories {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 4px;
	}
	.categories button {
		padding: 4px;
		font-size: 13px;
	}
	button, input {
		min-height: 40px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
	}
	button {
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		cursor: pointer;
	}
	button[data-save-instruction] {
		display: inline-flex;
		margin-left: auto;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button:hover, button[aria-selected="true"], button[aria-pressed="true"] {
		border-color: var(--accent);
		background: var(--surface-muted);
	}
	button:focus-visible, input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.page-header {
		position: relative;
		padding-right: 76px;
	}
	.set-actions {
		position: absolute;
		top: 20px;
		right: 24px;
	}
	.item-actions {
		position: relative;
		flex-shrink: 0;
	}
	.set-actions summary, .item-actions summary {
		display: flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		width: 40px;
		height: 40px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		cursor: pointer;
		list-style: none;
	}
	.set-actions summary::-webkit-details-marker, .item-actions summary::-webkit-details-marker {
		display: none;
	}
	.set-actions summary:focus-visible, .item-actions summary:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.set-actions button, .item-actions button {
		position: absolute;
		z-index: 2;
		top: 44px;
		right: 0;
		display: flex;
		width: max-content;
		max-width: calc(100vw - 48px);
	}
	input {
		box-sizing: border-box;
		width: 100%;
		padding: 8px;
	}
	.items {
		overflow: auto;
	}
	.item-row {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 8px;
	}
	.item-row .item {
		flex: 1;
		min-width: 0;
		margin-bottom: 0;
	}
	[data-remove-fragment] {
		display: inline-flex;
		justify-content: center;
		width: 40px;
		flex-shrink: 0;
		padding: 8px;
	}
	.item {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		width: 100%;
		margin-bottom: 8px;
		padding: 12px;
		text-align: left;
	}
	.item-name {
		width: 100%;
		overflow-wrap: anywhere;
	}
	.metadata {
		color: var(--muted);
		font-size: 12px;
	}
	.update {
		color: var(--accent);
		font-size: 12px;
	}
	.detail {
		min-width: 0;
		padding: 24px;
		overflow: auto;
	}
	.item-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		padding-bottom: 16px;
		border-bottom: 1px solid var(--border);
	}
	.item-metadata {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.item-views, .preview-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin: 16px 0;
	}
	.preview-toolbar button {
		display: inline-flex;
	}
	[data-instruction-dependencies] ul {
		padding: 0;
		list-style: none;
	}
	[data-instruction-dependencies] li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
		overflow-wrap: anywhere;
	}
	[data-open-instruction] {
		display: inline-flex;
		max-width: 100%;
		text-align: left;
		overflow-wrap: anywhere;
	}
	[data-open-instruction] svg {
		flex-shrink: 0;
	}
	article {
		line-height: 1.6;
		overflow-wrap: anywhere;
	}
	article pre {
		padding: 12px;
		background: var(--surface-muted);
	}
	article img {
		max-width: 100%;
	}
	article table {
		display: block;
		max-width: 100%;
		overflow: auto;
	}
	article a {
		color: var(--accent);
	}
	.inline-diff {
		margin: 12px 0;
		line-height: 1.6;
	}
	.inline-diff ins, .inline-diff del, .inline-diff span {
		display: block;
		padding: 6px 12px;
		border-left: 3px solid transparent;
	}
	.inline-diff ins {
		border-left-color: var(--success, #228545);
		background: color-mix(in srgb, var(--success, #228545) 12%, var(--surface));
		text-decoration: none;
	}
	.inline-diff del {
		border-left-color: var(--danger, #c23838);
		background: color-mix(in srgb, var(--danger, #c23838) 12%, var(--surface));
	}
	.diff-legend {
		color: var(--muted);
		font-size: 12px;
	}
	summary {
		padding: 12px 0;
		cursor: pointer;
	}
	.back {
		display: none;
		width: 40px;
		flex-shrink: 0;
	}
	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 14px;
		line-height: 1.6;
	}
	.empty {
		color: var(--muted);
	}
	.error {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 24px;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	.navigation-dialog::backdrop, .fragment-dialog::backdrop, .restore-dialog::backdrop, .reset-dialog::backdrop {
		background: var(--overlay-backdrop, rgb(0 0 0 / 40%));
	}
	.navigation-dialog, .fragment-dialog, .restore-dialog, .reset-dialog {
		box-sizing: border-box;
		width: min(calc(100% - 32px), 520px);
		max-height: calc(100dvh - 32px);
		padding: 24px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text);
		overflow: auto;
	}
	.reset-dialog li, .reset-dialog h4 {
		overflow-wrap: anywhere;
	}
	.conflict {
		padding: 12px 0;
	}
	.conflict pre {
		max-height: 200px;
		overflow: auto;
	}
	.navigation-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 24px;
	}
	@media (max-width: 900px) {
		.page-header {
			padding: 12px 64px 12px 16px;
		}
		.page-header p {
			display: inline-block;
			margin: 4px 8px 0 0;
			font-size: 12px;
		}
		.set-actions {
			top: 12px;
			right: 16px;
		}
		.pending-changes {
			box-sizing: border-box;
			max-height: min(180px, 25dvh);
			padding: 8px 16px;
		}
		.workspace {
			grid-template-columns: minmax(0, 1fr);
		}
		.workspace[data-selected="true"] .catalog, .workspace[data-selected="false"] .detail {
			display: none;
		}
		.back {
			display: block;
		}
		.item-header {
			position: sticky;
			z-index: 3;
			top: 0;
			gap: 8px;
			padding: 12px 0;
			background: var(--surface);
		}
		.item-header h2 {
			flex: 1;
			min-width: 0;
		}
		.item-metadata {
			order: 1;
			flex-basis: 100%;
		}
	}
	`];
}

customElements.define("agent-issues-instructions-view", InstructionsView);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-instructions-view": InstructionsView;
	}
}