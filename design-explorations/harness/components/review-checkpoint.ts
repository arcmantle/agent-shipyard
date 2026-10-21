import { html, type PropertyValues } from 'lit';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';
import {
	Check,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	FileCode2,
	FoldVertical,
	Folder,
	MessageSquare,
	Pencil,
	Search,
	Send,
	Trash2,
	UnfoldVertical,
	X,
} from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';
import type { WorkContext } from './work-context.js';
import './work-context.js';

interface CheckpointFile {
	index: number;
	folder: string;
	name: string;
	path: string;
	added: number;
	removed: number;
	kind: string;
}

export interface ReviewFeedback {
	reference: string;
	checkpoint: string;
	file?: string;
	line?: number;
	endLine?: number;
	snippet: string;
	note: string;
}

export interface ReviewFeedbackBatch {
	comments: ReviewFeedback[];
}

const files: CheckpointFile[] = Array.from({ length: 50 }, (_unused, index) => {
	const folders = ['src/runner', 'src/providers', 'src/checkpoints', 'src/workspace', 'tests'];
	const modules = [
		'approval',
		'checkpoint',
		'recovery',
		'session',
		'usage',
		'worker',
		'integration',
		'inbox',
		'limits',
		'scheduler',
	];
	const folder = folders[Math.floor(index / 10)]!;
	const name = `${modules[index % 10]}${folder === 'tests' ? '.test' : ''}.ts`;
	const kind = index % 11 === 10 ? 'D' : index % 7 === 0 ? 'A' : 'M';
	return {
		index,
		folder,
		name,
		path: `${folder}/${name}`,
		added: kind === 'D' ? 0 : (index % 9) + 3,
		removed: kind === 'D' ? 9 : kind === 'A' ? 0 : index % 4,
		kind,
	};
});

const diffs = [
	[
		'@@ approval checkpoint @@',
		'  export function integrate(change) {',
		'-   return merge(change);',
		'+   const approval = readApproval(change.id);',
		'+   verifyRevision(approval, change.revision);',
		'+   return mergeApproved(change, approval);',
		'  }',
	],
	[
		'@@ public-interface checks @@',
		'+ test("changed revision requires approval", () => {',
		'+   const change = updateRecordedChanges();',
		'+   expect(() => integrate(change)).toThrow();',
		'+ });',
		'+ test("approved changes can integrate", () => {',
		'+   expect(integrate(approvedChange)).toBeDefined();',
		'+ });',
	],
	[
		'@@ recorded checkpoint @@',
		'+ export const checkpoint = {',
		'+   issue: "DEMO-03",',
		'+   attempt: "03.1",',
		'+   stage: "review",',
		'+   revision: "c7b90a2",',
		'+ };',
	],
];

export class HarnessReviewCheckpoint extends LightElement {
	static override properties = {
		allowed: { attribute: false },
		reference: { attribute: false },
		checkpoint: { attribute: false },
		context: { attribute: false },
		branch: { attribute: false },
		query: { state: true },
		selected: { state: true },
		feedbackOpen: { state: true },
		feedbackGeneral: { state: true },
		feedbackLine: { state: true },
		feedbackEndLine: { state: true },
		pendingFeedback: { state: true },
	};

	constructor() {
		super();
		this.allowed = true;
		this.reference = 'DEMO-03';
		this.checkpoint = 'c7b90a2';
		this.context = undefined;
		this.branch = '';
		this.query = '';
		this.selected = 0;
		this.feedbackOpen = false;
		this.feedbackGeneral = false;
		this.feedbackLine = undefined;
		this.feedbackEndLine = undefined;
		this.pendingFeedback = [];
	}

	declare allowed: boolean;
	declare reference: string;
	declare checkpoint: string;
	declare context: WorkContext | undefined;
	declare branch: string;
	declare protected query: string;
	declare protected selected: number;
	declare protected feedbackOpen: boolean;
	declare protected feedbackGeneral: boolean;
	declare protected feedbackLine: number | undefined;
	declare protected feedbackEndLine: number | undefined;
	declare protected pendingFeedback: (ReviewFeedback & { id: number })[];
	protected nextFeedbackId = 1;
	protected editingFeedback: number | undefined;
	protected feedbackSnippet = '';
	protected feedbackDrafts = new Map<string, string>();
	protected feedbackTrigger: HTMLElement | undefined;
	protected feedbackAnchor: HTMLElement | undefined;
	protected feedbackPopover: HTMLElement | undefined;
	protected collapsed = new Set<string>();
	protected selectingLines = false;
	protected selectingFromSpace = false;
	protected selectionDragged = false;
	protected selectionStartY = 0;
	protected handleSelectionChange = () => {
		if (!this.selectingLines || this.selectingFromSpace) return;
		const diff = this.querySelector<HTMLElement>('.checkpoint-diff');
		if (diff) this.highlightSelection(diff);
	};
	protected handleSelectionMove = (event: MouseEvent) => {
		if (!this.selectingLines || !this.selectingFromSpace || event.buttons !== 1) return;
		const diff = this.querySelector<HTMLElement>('.checkpoint-diff');
		if (!diff) return;
		const bounds = diff.getBoundingClientRect();
		if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
		const rows = [...diff.querySelectorAll<HTMLElement>('[data-diff-line]')];
		const first = rows.find((row) => this.selectionStartY < row.getBoundingClientRect().bottom) ?? rows.at(-1);
		const last = rows.find((row) => {
			const bounds = row.getBoundingClientRect();
			return event.clientY >= bounds.top && event.clientY < bounds.bottom && event.clientX >= bounds.left && event.clientX < bounds.right;
		});
		if (!first || !last) return;
		this.selectionDragged = true;
		this.highlightRows(diff, first, last);
	};
	protected handleSelectionEnd = () => {
		const diff = this.querySelector<HTMLElement>('.checkpoint-diff');
		if (this.selectingLines && !this.selectingFromSpace && diff) this.highlightSelection(diff);
		this.selectingLines = false;
	};
	protected handleSelectionDismiss = (event: MouseEvent) => {
		if (event.button !== 0) return;
		const target = event.target as Element;
		if (this.contains(target) && target.closest('.review-line-comment, .review-inline-feedback')) return;
		this.selectingLines = !target.closest('button, a, input, textarea, select, [contenteditable]');
		this.selectingFromSpace = !target.closest('.checkpoint-diff code');
		this.selectionDragged = false;
		this.selectionStartY = event.clientY;
		if (this.contains(target) && target.closest('.review-diff-row')) return;
		this.feedbackOpen = false;
		this.feedbackLine = undefined;
		this.feedbackEndLine = undefined;
		this.feedbackSnippet = '';
	};

	override connectedCallback() {
		super.connectedCallback();
		document.addEventListener('selectionchange', this.handleSelectionChange);
		document.addEventListener('mousedown', this.handleSelectionDismiss);
		document.addEventListener('mousemove', this.handleSelectionMove);
		document.addEventListener('mouseup', this.handleSelectionEnd);
	}
	override disconnectedCallback() {
		document.removeEventListener('selectionchange', this.handleSelectionChange);
		document.removeEventListener('mousedown', this.handleSelectionDismiss);
		document.removeEventListener('mousemove', this.handleSelectionMove);
		document.removeEventListener('mouseup', this.handleSelectionEnd);
		this.selectingLines = false;
		super.disconnectedCallback();
	}

	protected override willUpdate(changed: PropertyValues) {
		if (changed.has('selected') || changed.has('reference') || changed.has('checkpoint')) {
			this.feedbackOpen = false;
			this.feedbackLine = undefined;
			this.feedbackEndLine = undefined;
			this.feedbackSnippet = '';
		}
		for (const details of this.querySelectorAll<HTMLDetailsElement>('[data-folder]')) {
			if (details.open) this.collapsed.delete(details.dataset.folder!);
			else this.collapsed.add(details.dataset.folder!);
		}
	}

	protected handleSearch(event: Event) {
		this.query = (event.currentTarget as HTMLInputElement).value;
	}
	protected override updated() {
		const popover = this.querySelector<HTMLElement>('.review-inline-feedback');
		if (!popover) {
			this.feedbackAnchor?.style.removeProperty('anchor-name');
			this.feedbackPopover = undefined;
			return;
		}
		if (this.feedbackAnchor !== this.feedbackTrigger) {
			this.feedbackAnchor?.style.removeProperty('anchor-name');
			this.feedbackAnchor = this.feedbackTrigger;
		}
		this.feedbackAnchor?.style.setProperty('anchor-name', '--review-comment');
		if (this.feedbackPopover !== popover) {
			this.feedbackPopover = popover;
			popover.showPopover();
		}
	}
	protected handleFeedbackToggle(event: ToggleEvent) {
		if (event.newState === 'closed' && this.feedbackOpen && (event.currentTarget as HTMLElement).isConnected)
			this.feedbackOpen = false;
	}
	protected handleFeedbackKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		this.handleFeedbackCancel();
	}
	protected async openFeedback() {
		this.feedbackOpen = false;
		await this.updateComplete;
		this.feedbackOpen = true;
		await this.updateComplete;
		this.querySelector<HTMLTextAreaElement>('#review-inline-note')?.focus();
	}
	protected feedbackKey() {
		return JSON.stringify([this.reference, this.checkpoint, this.feedbackGeneral ? null : files[this.selected]!.path, this.feedbackLine, this.feedbackEndLine, this.editingFeedback]);
	}
	protected currentFeedback() {
		return this.pendingFeedback.filter((comment) =>
			comment.reference === this.reference && comment.checkpoint === this.checkpoint
		).sort((first, second) => Number(Boolean(first.file)) - Number(Boolean(second.file)));
	}
	protected hasFeedbackDrafts() {
		return [...this.feedbackDrafts].some(([key, note]) => {
			const [reference, checkpoint, , , , id] = JSON.parse(key) as [string, string, string | null, number | null, number | null, number | null];
			const saved = this.pendingFeedback.find((comment) => comment.id === id);
			return reference === this.reference && checkpoint === this.checkpoint && Boolean(note.trim()) && note.trim() !== saved?.note;
		});
	}
	protected handleComment(event: Event) {
		const button = event.currentTarget as HTMLElement;
		this.feedbackTrigger = button;
		this.feedbackGeneral = button.hasAttribute('data-review-note');
		this.feedbackLine = undefined;
		this.feedbackEndLine = undefined;
		this.feedbackSnippet = '';
		const generalNote = this.feedbackGeneral ? this.currentFeedback().find((comment) => !comment.file) : undefined;
		this.editingFeedback = generalNote?.id;
		if (generalNote && !this.feedbackDrafts.has(this.feedbackKey()))
			this.feedbackDrafts.set(this.feedbackKey(), generalNote.note);
		void this.openFeedback();
	}
	protected selectionRow(node: Node | null) {
		const element = node instanceof Element ? node : node?.parentElement;
		return element?.closest<HTMLElement>('[data-diff-line]');
	}
	protected handleHighlight(event: Event) {
		if (event instanceof MouseEvent && event.button !== 0) return;
		const target = event.target as Element;
		if (target.closest('button')) return;
		if (event.type === 'mouseup' && this.selectingLines && this.selectingFromSpace && this.selectionDragged) return;
		const diff = event.currentTarget as HTMLElement;
		const clicked = this.selectionRow(target);
		this.highlightSelection(diff, clicked, event.type === 'mouseup' && !this.selectingFromSpace);
	}
	protected handleSelectionStart(event: MouseEvent) {
		if (event.button !== 0 || (event.target as Element).closest('button')) return;
		this.selectingLines = true;
	}
	protected highlightSelection(diff: HTMLElement, clicked?: HTMLElement | null, useSelection = true) {
		const selection = window.getSelection();
		const rows = [...diff.querySelectorAll<HTMLElement>('[data-diff-line]')];
		const selectedRows = useSelection && selection && !selection.isCollapsed && selection.rangeCount
			? rows.filter((row) => selection.getRangeAt(0).intersectsNode(row.querySelector('code')!))
			: [];
		const first = selectedRows[0] ?? clicked;
		const last = selectedRows.at(-1) ?? clicked;
		if (!first || !last) return;
		this.highlightRows(diff, first, last);
	}
	protected highlightRows(diff: HTMLElement, first: HTMLElement, last: HTMLElement) {
		this.feedbackOpen = false;
		this.feedbackGeneral = false;
		this.feedbackLine = Math.min(Number(first.dataset.diffLine), Number(last.dataset.diffLine));
		this.feedbackEndLine = Math.max(Number(first.dataset.diffLine), Number(last.dataset.diffLine));
		this.feedbackSnippet = [...diff.querySelectorAll<HTMLElement>('[data-diff-line]')]
			.filter((row) => Number(row.dataset.diffLine) >= this.feedbackLine! && Number(row.dataset.diffLine) <= this.feedbackEndLine!)
			.map((row) => row.querySelector('code')!.textContent)
			.join('\n');
		this.feedbackTrigger = first.querySelector('code') ?? undefined;
		this.editingFeedback = undefined;
	}
	protected handleHighlightKey(event: KeyboardEvent) {
		if (event.key !== 'Enter' || (event.target as Element).closest('button')) return;
		event.preventDefault();
		this.handleHighlight(event);
	}
	protected handleLineComment(event: Event) {
		this.feedbackTrigger = event.currentTarget as HTMLElement;
		void this.openFeedback();
	}
	protected handleFeedbackInput(event: Event) {
		this.feedbackDrafts.set(this.feedbackKey(), (event.currentTarget as HTMLTextAreaElement).value);
	}
	protected handleFeedbackCancel() {
		this.feedbackOpen = false;
		void this.updateComplete.then(() => this.feedbackTrigger?.focus());
	}
	protected handleFeedbackSubmit(event: SubmitEvent) {
		event.preventDefault();
		const note = this.querySelector<HTMLTextAreaElement>('#review-inline-note')!.value.trim();
		if (!note) return;
		const comment = {
			id: this.editingFeedback ?? this.nextFeedbackId++,
			reference: this.reference,
			checkpoint: this.checkpoint,
			file: this.feedbackGeneral ? undefined : files[this.selected]!.path,
			line: this.feedbackLine,
			endLine: this.feedbackEndLine,
			snippet: this.feedbackSnippet,
			note,
		};
		this.pendingFeedback = [...this.pendingFeedback.filter((item) => item.id !== comment.id), comment];
		this.feedbackDrafts.delete(this.feedbackKey());
		this.handleFeedbackCancel();
	}
	protected handleRemoveFeedback(event: Event) {
		const id = Number((event.currentTarget as HTMLElement).dataset.comment);
		const comment = this.currentFeedback().find((item) => item.id === id);
		if (comment)
			this.feedbackDrafts.delete(JSON.stringify([comment.reference, comment.checkpoint, comment.file ?? null, comment.line, comment.endLine, comment.id]));
		this.pendingFeedback = this.pendingFeedback.filter((comment) => comment.id !== id);
		if (this.editingFeedback === id) this.feedbackOpen = false;
	}
	protected async handleEditFeedback(event: Event) {
		const id = Number((event.currentTarget as HTMLElement).dataset.comment);
		const comment = this.currentFeedback().find((item) => item.id === id);
		if (!comment) return;
		if (comment.file) this.selected = files.findIndex((file) => file.path === comment.file);
		await this.updateComplete;
		this.feedbackGeneral = !comment.file;
		this.feedbackLine = comment.line;
		this.feedbackEndLine = comment.endLine;
		this.feedbackSnippet = comment.snippet;
		this.editingFeedback = id;
		if (!this.feedbackDrafts.has(this.feedbackKey())) this.feedbackDrafts.set(this.feedbackKey(), comment.note);
		this.feedbackTrigger = this.querySelector(this.feedbackGeneral ? '[data-review-note]' : '[aria-label="Comment on this file"]') ?? undefined;
		await this.openFeedback();
	}
	protected handleSendReview() {
		const comments = this.currentFeedback();
		if (!this.allowed || !comments.length || this.feedbackOpen || this.hasFeedbackDrafts()) return;
		this.querySelector<HTMLButtonElement>('[aria-label="Comment on this file"]')!.focus();
		const accepted = !this.dispatchEvent(new CustomEvent<ReviewFeedbackBatch>('harness-review-feedback', {
			bubbles: true,
			cancelable: true,
			detail: { comments },
		}));
		if (accepted) {
			for (const comment of comments)
				this.feedbackDrafts.delete(JSON.stringify([comment.reference, comment.checkpoint, comment.file ?? null, comment.line, comment.endLine, comment.id]));
			this.pendingFeedback = this.pendingFeedback.filter((comment) => !comments.includes(comment));
		}
	}
	protected handleClear() {
		this.query = '';
		this.querySelector<HTMLInputElement>('#checkpoint-search')!.focus();
	}
	protected handleSelect(event: Event) {
		this.selected = Number((event.currentTarget as HTMLElement).dataset.index);
	}
	protected handleFolders(event: Event) {
		const expanded = (event.currentTarget as HTMLElement).dataset.expanded === 'true';
		this.collapsed.clear();
		if (!expanded) {
			for (const file of files) {
				const segments = file.folder.split('/');
				for (let depth = 1; depth <= segments.length; depth++) {
					this.collapsed.add(segments.slice(0, depth).join('/'));
				}
			}
		}
		for (const details of this.querySelectorAll<HTMLDetailsElement>('[data-folder]')) {
			details.open = expanded;
		}
		this.requestUpdate();
	}
	protected handleNavigate(event: Event) {
		const matches = this.matchingFiles();
		const position = matches.findIndex((file) => file.index === this.selected);
		const direction = (event.currentTarget as HTMLElement).dataset.direction === 'next' ? 1 : -1;
		if (matches[position + direction]) this.selected = matches[position + direction]!.index;
	}
	protected matchingFiles() {
		return files.filter((file) =>
			file.path.toLowerCase().includes(this.query.trim().toLowerCase())
		);
	}

	protected renderTree(matches: CheckpointFile[], parent = ''): ReturnType<typeof html> {
		const names = [
			...new Set(
				matches.map((file) => file.folder.slice(parent ? parent.length + 1 : 0).split('/')[0]!)
			),
		];
		return html`
		${repeat(
				names,
				(name) => name,
				(name) => {
					const path = parent ? `${parent}/${name}` : name;
					const children = matches.filter(
						(file) => file.folder === path || file.folder.startsWith(`${path}/`)
					);
					const nested = children.filter((file) => file.folder !== path);
					return html`
					<details
						class="checkpoint-folder"
						data-folder=${path}
						.open=${live(!this.collapsed.has(path))}
					>
						<summary title=${path}>
							${renderIcon(ChevronRight)}${renderIcon(Folder)}<span class="tree-name"
								>${name}</span
							><span class="tree-count">${children.length}</span>
						</summary>
						<div class="checkpoint-folder-children">
							${when(nested.length, () => this.renderTree(nested, path))}
							${repeat(
									children.filter((file) => file.folder === path),
									(file) => file.index,
									(file) => html`
									<button
										class=${`checkpoint-file ${file.index === this.selected ? 'active' : ''}`}
										data-action="review-file"
										data-index=${file.index}
										aria-current=${String(file.index === this.selected)}
										aria-label=${file.path}
										title=${`${file.path} / +${file.added} -${file.removed}`}
										@click=${this.handleSelect}
									>
										${renderIcon(FileCode2)}<span class="tree-name">${file.name}</span
										><span class=${`file-change file-change-${file.kind.toLowerCase()}`}
											>${file.kind}</span
										>
									</button>
									`
								)}
						</div>
					</details>
					`;
				}
			)}
		`;
	}

	protected override render() {
		const matches = this.matchingFiles();
		const selected = files[this.selected]!;
		const reviewNoteLabel = this.currentFeedback().some((comment) => !comment.file) ? 'Edit review note' : 'Add review note';
		const position = matches.findIndex((file) => file.index === selected.index);
		const diff = [
			`@@ ${selected.path} / simulated checkpoint @@`,
			...diffs[this.selected % diffs.length]!.map((line) =>
				line.replace('"DEMO-03"', JSON.stringify(this.reference))
			),
		];
		return html`
		<section class="review-main">
			<div class="checkpoint-heading">
				<div class="work-heading">
					<harness-work-context
						.context=${this.context}
						.branch=${this.branch}
						.checkpoint=${this.checkpoint}
					></harness-work-context>
				</div>
				<div class="checkpoint-actions">
					<button
						data-review-note
						@click=${this.handleComment}
					>
						${renderIcon(MessageSquare)}${reviewNoteLabel}
					</button>
					<button
						class="primary"
						data-action="approve"
						?disabled=${!this.allowed || this.feedbackOpen || this.hasFeedbackDrafts() || this.currentFeedback().length > 0}
					>
						${renderIcon(Check)}Approve review
					</button>
				</div>
			</div>
			<div class="checkpoint-search">
				<label for="checkpoint-search">${renderIcon(Search)}</label>
				<input
					id="checkpoint-search"
					type="search"
					aria-label="Search changed files"
					placeholder="Find a file..."
					.value=${live(this.query)}
					@input=${this.handleSearch}
				/>
				<button
					class="icon-button"
					title="Clear file search"
					aria-label="Clear file search"
					@click=${this.handleClear}
				>
					${renderIcon(X)}
				</button>
			</div>
			<div class="checkpoint-browser">
				<div
					class="checkpoint-files"
					aria-label="Changed files"
				>
					<div class="file-result-count">
						<span>
							${matches.length} of 50 files
							<span class="checkpoint-change-count">
								<span class="additions">+${files.reduce((sum, file) => sum + file.added, 0)}</span>
								-${files.reduce((sum, file) => sum + file.removed, 0)}
							</span>
						</span>
						<div
							class="checkpoint-tree-actions"
							role="group"
							aria-label="Folder controls"
						>
							<button
								class="icon-button"
								aria-label="Expand all folders"
								title="Expand all folders"
								data-expanded="true"
								?disabled=${!matches.length}
								@click=${this.handleFolders}
							>
								${renderIcon(UnfoldVertical)}
							</button>
							<button
								class="icon-button"
								aria-label="Collapse all folders"
								title="Collapse all folders"
								data-expanded="false"
								?disabled=${!matches.length}
								@click=${this.handleFolders}
							>
								${renderIcon(FoldVertical)}
							</button>
						</div>
					</div>
					<div class="checkpoint-tree-scroll">
						${this.renderTree(matches)}
						${when(!matches.length, () => html`<p class="no-files">No matching files</p>`)}
					</div>
				</div>
				<section class="checkpoint-selected">
					<div class="selected-file-header">
						<span class="mono">${selected.path}</span>
						<div>
							<button
								class="icon-button"
								aria-label="Comment on this file"
								title="Comment on this file"
								@click=${this.handleComment}
							>
								${renderIcon(MessageSquare)}
							</button>
							<span
								>${position < 0 ? 'Outside filter' : `${position + 1} / ${matches.length}`}</span
							>
							<button
								class="icon-button"
								data-direction="previous"
								aria-label="Previous changed file"
								title="Previous changed file"
								?disabled=${position <= 0}
								@click=${this.handleNavigate}
							>
								${renderIcon(ChevronUp)}
							</button>
							<button
								class="icon-button"
								data-direction="next"
								aria-label="Next changed file"
								title="Next changed file"
								?disabled=${position < 0 || position >= matches.length - 1}
								@click=${this.handleNavigate}
							>
								${renderIcon(ChevronDown)}
							</button>
						</div>
					</div>
					<div
						class="diff checkpoint-diff"
						aria-label="Selected checkpoint diff"
						@mousedown=${this.handleSelectionStart}
						@mouseup=${this.handleHighlight}
						@keydown=${this.handleHighlightKey}
					>
						${repeat(
								diff,
								(_line, index) => index,
								(line, index) => html`
								<div
									class=${`review-diff-row ${line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''} ${index + 1 >= (this.feedbackLine ?? Infinity) && index + 1 <= (this.feedbackEndLine ?? 0) ? 'review-highlight' : ''} ${this.currentFeedback().some((comment) => comment.file === selected.path && index + 1 >= (comment.line ?? Infinity) && index + 1 <= (comment.endLine ?? comment.line ?? 0)) ? 'review-commented' : ''}`}
									data-diff-line=${index + 1}
								>
									<code tabindex="0">${line}</code>
									${when(!this.feedbackGeneral && index + 1 === this.feedbackEndLine, () => html`
									<button
										class="icon-button review-line-comment"
										aria-label="Comment on selected lines"
										title="Comment on selected lines"
										aria-expanded=${String(this.feedbackOpen)}
										@click=${this.handleLineComment}
									>
										${renderIcon(MessageSquare)}
									</button>
									`)}
								</div>
								`
							)}
					</div>
					${when(this.feedbackOpen, () => html`
					<form
						class="review-inline-feedback"
						popover="auto"
						aria-label="Review comment"
						@toggle=${this.handleFeedbackToggle}
						@keydown=${this.handleFeedbackKeydown}
						@submit=${this.handleFeedbackSubmit}
					>
						<label for="review-inline-note">
							${when(this.feedbackGeneral, () => html`Review summary`, () => html`Feedback / ${selected.path}`)}
							${when(this.feedbackLine, () => html` / Diff line ${this.feedbackLine} `)}
							${when(this.feedbackEndLine && this.feedbackEndLine !== this.feedbackLine, () => html` through ${this.feedbackEndLine} `)}
						</label>
						${when(this.feedbackSnippet, () => html`<pre class="review-feedback-snippet">${this.feedbackSnippet}</pre>`)}
						<textarea
							id="review-inline-note"
							rows="3"
							.value=${live(this.feedbackDrafts.get(this.feedbackKey()) ?? '')}
							@input=${this.handleFeedbackInput}
							required
						></textarea>
						<div class="review-feedback-actions">
							<button
								type="button"
								@click=${this.handleFeedbackCancel}
							>
								Cancel
							</button>
							<button class="primary">${renderIcon(Check)}${this.editingFeedback ? 'Save comment' : 'Add comment'}</button>
						</div>
					</form>
					`)}
					${when(this.currentFeedback().length, () => html`
					<div class="review-feedback-batch">
						<details>
							<summary>Draft comments (${this.currentFeedback().length})</summary>
							${repeat(this.currentFeedback(), (comment) => comment.id, (comment) => html`
							<div class="review-draft-comment">
								<div>
									<strong>${comment.file ?? 'Review summary'}${when(comment.line, () => html` / ${comment.line}${when(comment.endLine !== comment.line, () => html`-${comment.endLine}`)}`)}</strong>
									<p>${comment.note}</p>
								</div>
								<button
									class="icon-button"
									data-comment=${comment.id}
									aria-label="Edit comment"
									title="Edit comment"
									@click=${this.handleEditFeedback}
								>${renderIcon(Pencil)}</button>
								<button
									class="icon-button"
									data-comment=${comment.id}
									aria-label="Remove comment"
									title="Remove comment"
									@click=${this.handleRemoveFeedback}
								>${renderIcon(Trash2)}</button>
							</div>
							`)}
						</details>
						<button
							class="primary"
							data-send-review
							?disabled=${!this.allowed || this.feedbackOpen || this.hasFeedbackDrafts()}
							@click=${this.handleSendReview}
						>${renderIcon(Send)}Send review (${this.currentFeedback().length})</button>
					</div>
					`)}
				</section>
			</div>
		</section>
		`;
	}
}

customElements.define('harness-review-checkpoint', HarnessReviewCheckpoint);

declare global {
	interface HTMLElementEventMap {
		'harness-review-feedback': CustomEvent<ReviewFeedbackBatch>;
	}
	interface HTMLElementTagNameMap {
		'harness-review-checkpoint': HarnessReviewCheckpoint;
	}
}
