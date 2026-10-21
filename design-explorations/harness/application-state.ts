import { LightElement } from './components/light-element.js';
import type { SidebarModel } from './components/repository-sidebar.js';
import type { RepositoryModel } from './components/repository-header.js';
import type { TrackedRecordModel } from './components/tracked-record.js';
import type { ReviewFeedbackBatch } from './components/review-checkpoint.js';
import { HarnessSimulation, initiatives, type ChangeRequest } from './simulation.js';
import { PlanningController } from './planning.js';
import { MergeController, mergeIssues, type MergeScenario } from './merge.js';
import { SettingsController } from './settings.js';
import { TerminalManager } from './terminals.js';

type Page = 'workspace' | 'planning' | 'repositories' | 'initiatives' | 'global-settings' | 'project-settings';

type WorkspaceView = 'initiative' | 'review' | 'merge';

interface Repository extends RepositoryModel {
	initiatives: string[];
}

export interface FolderBrowser {
	path: string;
	parent: string | null;
	entries: { name: string; path: string }[];
	loading: boolean;
	error: string;
}

export type DialogState =
	| { kind: 'record'; recordKind: string; index: number }
	| { kind: 'pioneer-ticket'; index: number }
	| { kind: 'agent'; worker: string }
	| { kind: 'request'; id: number | null }
	| { kind: 'folder' }
	| { kind: 'terminate' }
	| { kind: 'revision' }
	| { kind: 'merge-stop' };

const pages: Page[] = [
	'workspace',
	'planning',
	'repositories',
	'initiatives',
	'global-settings',
	'project-settings',
];

export abstract class HarnessApplicationState extends LightElement {
	static override properties = { version: { state: true } };

	constructor() {
		super();
		this.version = 0;
		const page = new URL(location.href).searchParams.get('page');
		this.page = pages.includes(page as Page) ? (page as Page) : 'workspace';
		this.projectOpen = new URL(location.href).searchParams.get('project') !== 'none';
		if (!this.projectOpen && !['repositories', 'global-settings'].includes(this.page))
			this.page = 'repositories';
		this.boundPopstate = this.handlePopstate.bind(this);
		this.seedPlanning();
		const scenario = new URL(location.href).searchParams.get('scenario');
		if (['conflict', 'clean', 'failed'].includes(scenario ?? ''))
			this.merge.current.scenario = scenario as MergeScenario;
	}

	declare protected version: number;

	protected page: Page;

	protected view: WorkspaceView = 'initiative';
	protected reviewSelection = 0;

	protected repository = 'agent-issues';
	protected projectOpen = true;

	protected initiative = 'harness';

	protected repositories: Record<string, Repository> = {
		'agent-issues': {
			name: 'shipyard',
			projectIdentity: 'shipyard',
			path: '/Users/roen/Developer/Personal/agent-issues',
			tenant: 'local-roen',
			initiatives: ['harness', 'navigation'],
		},
		'studio-site': {
			name: 'studio-site / example',
			projectIdentity: 'studio-site',
			path: '~/projects/studio-site',
			tenant: 'local-roen',
			initiatives: ['studio'],
		},
		'task-api': {
			name: 'task-api / example',
			projectIdentity: 'task-api',
			path: '~/projects/task-api',
			tenant: 'local-roen',
			initiatives: ['api'],
		},
	};

	protected repositoryViews = new Map<
		string,
		{ initiative: string; planning: string; launch: PlanningController['launch'] }
	>();

	protected simulation = new HarnessSimulation();

	protected planning = new PlanningController();

	protected merge = new MergeController();

	protected settings = new SettingsController();

	protected terminals = new TerminalManager();

	protected dialog: DialogState | undefined;

	protected dialogTrigger: HTMLElement | undefined;

	protected requestDraft = '';
	protected requestDraftKey = '';
	protected requestDrafts = new Map<string, string>();

	protected requestTarget = 2;

	protected repositoryQuery = '';

	protected inboxTab = 'inbox';

	protected get runAgentStatus() {
		if (this.simulation.mode === 'stopped') return 'Stopped';
		if (this.simulation.mode === 'paused') return 'Paused';
		if (this.simulation.question) return 'Needs your answer';
		if (this.pendingReviews.length) return 'Waiting for review';
		if (this.merge.pending.length) return 'Waiting for merge';
		return 'Coordinating';
	}

	protected panelLayout = window.matchMedia('(max-width: 1150px)');

	protected drawerOpen = !this.panelLayout.matches;

	protected inboxOpen = !this.panelLayout.matches;

	protected runPanelWidth = 300;

	protected runPanelDrag: { pointerId: number; startX: number; startWidth: number } | undefined;

	protected runPanelResizeFrame: number | undefined;

	protected get runPanelMaxWidth() {
		const available = window.innerWidth - 56 - (this.drawerOpen && !this.panelLayout.matches ? 240 : 0);
		return Math.max(280, Math.min(600, this.panelLayout.matches ? window.innerWidth - 72 : available - 420));
	}

	protected get runPanelSize() {
		return Math.min(this.runPanelWidth, this.runPanelMaxWidth);
	}

	protected boundViewportResize = this.handleViewportResize.bind(this);

	protected boundPanelLayout = this.handlePanelLayout.bind(this);

	protected toast = '';

	protected folder: FolderBrowser = {
		path: '',
		parent: null,
		entries: [],
		loading: false,
		error: '',
	};

	protected folderRequest = 0;

	protected boundPopstate: () => void;

	override connectedCallback() {
		super.connectedCallback();
		window.addEventListener('popstate', this.boundPopstate);
		this.panelLayout.addEventListener('change', this.boundPanelLayout);
		window.addEventListener('resize', this.boundViewportResize);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		window.removeEventListener('popstate', this.boundPopstate);
		this.panelLayout.removeEventListener('change', this.boundPanelLayout);
		window.removeEventListener('resize', this.boundViewportResize);
		if (this.runPanelResizeFrame !== undefined) cancelAnimationFrame(this.runPanelResizeFrame);
		this.runPanelResizeFrame = undefined;
		this.runPanelDrag = undefined;
		this.terminals.dispose();
	}

	protected handleViewportResize() {
		this.changed();
	}

	protected handleRunPanelPointerDown(event: PointerEvent) {
		if (event.button !== 0 || !event.isPrimary) return;
		event.preventDefault();
		const handle = event.currentTarget as HTMLElement;
		handle.focus();
		handle.setPointerCapture(event.pointerId);
		this.runPanelDrag = { pointerId: event.pointerId, startX: event.clientX, startWidth: this.runPanelSize };
		this.changed();
	}

	protected handleRunPanelPointerMove(event: PointerEvent) {
		const drag = this.runPanelDrag;
		if (!drag || drag.pointerId !== event.pointerId) return;
		this.runPanelWidth = Math.round(Math.max(280, Math.min(this.runPanelMaxWidth, drag.startWidth + drag.startX - event.clientX)));
		if (this.runPanelResizeFrame !== undefined) return;
		this.runPanelResizeFrame = requestAnimationFrame(() => {
			this.runPanelResizeFrame = undefined;
			this.paintRunPanelWidth();
		});
	}

	protected paintRunPanelWidth() {
		const width = String(this.runPanelSize);
		this.querySelector<HTMLElement>('.workspace-body')?.style.setProperty('--run-panel-width', `${width}px`);
		this.querySelector('.run-panel-resizer')?.setAttribute('aria-valuenow', width);
	}

	protected handleRunPanelPointerEnd(event: PointerEvent) {
		if (this.runPanelDrag?.pointerId !== event.pointerId) return;
		if (this.runPanelResizeFrame !== undefined) cancelAnimationFrame(this.runPanelResizeFrame);
		this.runPanelResizeFrame = undefined;
		this.runPanelDrag = undefined;
		const handle = event.currentTarget as HTMLElement;
		if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
		this.changed();
	}

	protected handleRunPanelKeydown(event: KeyboardEvent) {
		let width = this.runPanelSize;
		switch (event.key) {
			case 'ArrowLeft': width += 16; break;
			case 'ArrowRight': width -= 16; break;
			case 'Home': width = 280; break;
			case 'End': width = this.runPanelMaxWidth; break;
			default: return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.runPanelWidth = Math.max(280, Math.min(this.runPanelMaxWidth, width));
		this.changed();
	}

	protected handleRunPanelReset() {
		this.runPanelWidth = 300;
		this.changed();
	}

	protected handlePanelLayout(event: MediaQueryListEvent) {
		if (!event.matches) return;
		const active = document.activeElement;
		const action = active?.closest('.navigation-drawer')
			? 'drawer'
			: active?.closest('.run-inbox') ? 'inbox-toggle' : undefined;
		this.drawerOpen = false;
		this.inboxOpen = false;
		this.changed();
		if (action) {
			void this.updateComplete.then(() => this.querySelector<HTMLElement>(`.application-toolbar [data-action="${action}"][aria-controls]`)?.focus());
		}
	}

	protected seedPlanning() {
		this.planning.launch = {
			brief: 'Complete the Helm design.',
			initiative: 'harness',
			mode: 'pioneer',
		};
		const example = this.planning.start('agent-issues', initiatives.harness!.title)!;
		example.id = 'harness';
		example.model.title = 'Helm first release';
		const definitions = [
			['Provider control', 'research', 'How should Helm control native agent sessions?'],
			[
				'Workspace design',
				'prototype',
				'Which workspace layout makes agents and user decisions easy to inspect?',
			],
			['Approval gates', 'grilling', 'Which approvals are required before changes can integrate?'],
			[
				'Recovery model',
				'research',
				'How should interrupted work resume without repeating unsafe operations?',
			],
			[
				'Usage accounting',
				'task',
				'What is the shared usage boundary across workers and repositories?',
			],
			[
				'First-release scope',
				'grilling',
				'Which capabilities and limits belong in the first release?',
			],
		];
		example.model.tickets = example.model.tickets.map((ticket, index) => ({
			...ticket,
			title: definitions[index]![0]!,
			type: definitions[index]![1]!,
			question: definitions[index]![2]!,
		}));
		this.planning.selected = example.id;
		this.planning.saveDraft(0, 'Use native CLI terminals. A local runner owns execution.');
		this.planning.submit();
		this.planning.selected = '';
	}

	protected changed() {
		this.version++;
	}

	protected get browsing() {
		return this.repository !== 'agent-issues' || this.initiative !== 'harness';
	}

	protected get runLabel() {
		return this.simulation.mode === 'running'
			? 'Running'
			: this.simulation.mode === 'paused'
				? 'Paused'
				: 'Stopped';
	}

	protected get workerAnswerBlocked() {
		return (
			this.simulation.mode !== 'running' ||
			this.simulation.workers[1]!.manual ||
			this.simulation.workers[1]!.status === 'paused'
		);
	}

	protected get mergeAllowed() {
		return (
			this.simulation.mode === 'running' &&
			this.merge.current.reviewApproved &&
			!this.merge.current.manual &&
			(this.merge.selected === 0
				? this.simulation.workers[2]!.status !== 'paused'
				: this.simulation.integrated.has(this.merge.selected + 1))
		);
	}

	protected get pendingReviews() {
		return mergeIssues.flatMap((issue, index) =>
			this.simulation.reviewReady.has(issue.reference) &&
			!this.merge.sessions[index]!.reviewApproved &&
			!this.simulation.integrated.has(index + 2)
				? [index]
				: []
		);
	}

	protected get reviewAllowed() {
		const index = this.currentReview;
		if (index === undefined || this.simulation.mode !== 'running') return false;
		const worker = this.simulation.workers.find(
			(candidate) => candidate.issue === mergeIssues[index]!.reference
		);
		return Boolean(worker && !worker.manual && worker.status !== 'paused');
	}

	protected get currentReview() {
		return this.pendingReviews.includes(this.reviewSelection) ? this.reviewSelection : this.pendingReviews[0];
	}

	protected reviewCheckpoint(index: number) {
		const issue = mergeIssues[index]!;
		return this.simulation.reviewCheckpoint(issue.reference, issue.checkpoint);
	}

	protected get reviewWorker() {
		return this.simulation.workers.find((worker) =>
			worker.status !== 'integrated' && !this.simulation.reviewReady.has(worker.issue) &&
			this.simulation.reviewFeedbacks.some((feedback) => feedback.reference === worker.issue)
		);
	}

	protected sidebarModel(): SidebarModel {
		const initiative = initiatives[this.initiative];
		const record = (
			kind: TrackedRecordModel['kind'],
			index: number,
			title: string,
			status: string
		): TrackedRecordModel => ({ kind, index, title, status });
		const prds = !this.browsing
			? this.simulation.prds
			: initiative
				? [{ title: initiative.prd, story: initiative.story, issues: [0, 1, 2] }]
				: [];
		return {
			scope: `${this.repository}/${this.initiative}`,
			page: this.page,
			repository: this.repositories[this.repository]!,
			runLabel: this.runLabel,
			integrated: this.simulation.integrated.has(2),
			question: this.simulation.question,
			limits: {
				copilot: this.settings.global.copilotRequests,
				interpreter: this.settings.global.interpreterCalls,
			},
			planningSessions: this.planning.contexts
				.filter((context) => context.repository === this.repository)
				.map((context) => ({
					id: context.id,
					title: context.model.title,
					initiativeTitle: context.model.initiativeTitle,
					current: context.id === this.planning.selected,
				})),
			initiative: initiative
				? {
						id: this.initiative,
						title: initiative.title,
						run: this.browsing ? 'No active run' : `Run 004 / ${this.runLabel}`,
						prds: prds.map((prd, index) => ({
							record: record('prd', index, prd.title, 'Draft'),
							story: record('story', index, prd.story, 'In progress'),
							issues: prd.issues.map((issue) =>
								record(
									'issue',
									issue,
									this.browsing ? initiative.issues[issue]! : this.simulation.issues[issue]!.title,
									this.browsing ? 'Ready' : this.simulation.issueModel(issue).status.label
								)
							),
						})),
						adrs: initiative.adrs.map((title, index) => record('adr', index, title, 'Current')),
					}
				: undefined,
		};
	}

	protected navigate(page: Page, updateHistory = true) {
		if (!this.projectOpen && !['repositories', 'global-settings'].includes(page))
			page = 'repositories';
		this.page = page;
		if (window.matchMedia('(max-width: 1150px)').matches) {
			this.drawerOpen = false;
			this.inboxOpen = false;
		}
		if (updateHistory) {
			const url = new URL(location.href);
			url.searchParams.set('page', page);
			if (!this.projectOpen) url.searchParams.set('project', 'none');
			else if (url.searchParams.get('project') === 'none') url.searchParams.delete('project');
			history.pushState(null, '', url);
		}
		this.changed();
	}

	protected handlePopstate() {
		const url = new URL(location.href);
		const page = url.searchParams.get('page') as Page;
		this.projectOpen = url.searchParams.get('project') !== 'none';
		this.navigate(pages.includes(page) ? page : 'workspace', false);
	}

	protected switchRepository(id: string, page: 'workspace' | 'project-settings' = 'workspace') {
		if (!this.repositories[id]) return;
		this.repositoryViews.set(this.repository, {
			initiative: this.initiative,
			planning: this.planning.selected,
			launch: { ...this.planning.launch },
		});
		this.repository = id;
		this.projectOpen = true;
		const saved = this.repositoryViews.get(id);
		this.initiative = saved?.initiative ?? this.repositories[id]!.initiatives[0] ?? '';
		this.planning.selected = saved?.planning ?? '';
		this.planning.launch = saved?.launch ?? { brief: '', initiative: '', mode: 'plan' };
		this.navigate(page);
		void this.updateComplete.then(() => {
			const heading = this.querySelector<HTMLElement>(`[data-page-panel="${page}"] h1`);
			heading?.setAttribute('tabindex', '-1');
			heading?.focus({ preventScroll: true });
		});
	}

	protected openDialog(dialog: DialogState) {
		this.terminals.restoreWorker(this);
		if (dialog.kind === 'request') {
			if (dialog.id === null) {
				this.requestDrafts.set(this.requestDraftKey, this.requestDraft);
				this.requestDraftKey = JSON.stringify([this.repository]);
				this.requestDraft = this.requestDrafts.get(this.requestDraftKey) ?? '';
			} else {
				const request = this.simulation.requests.find((candidate) => candidate.id === dialog.id);
				if (request) this.requestTarget = request.target;
			}
		}
		if (!this.dialog)
			this.dialogTrigger =
				document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		this.dialog = dialog;
		this.changed();
	}

	protected closeDialog() {
		this.terminals.restoreWorker(this);
		this.dialog = undefined;
		this.changed();
		void this.updateComplete.then(() => {
			const trigger = this.dialogTrigger?.isConnected
				? this.dialogTrigger
				: this.dialogTrigger?.dataset.focusReturn === 'run-agent'
					? this.querySelector<HTMLElement>('#run-agent-message')
					: this.querySelector<HTMLElement>(`.route-issue[data-index="${this.dialogTrigger?.dataset.index}"]`);
			trigger?.focus({ preventScroll: true });
		});
	}

	protected handleDialogClose() {
		if (this.dialog) this.closeDialog();
	}

	protected handleClick(event: MouseEvent) {
		const control = (event.target as Element).closest<HTMLElement>('[data-action], [data-view]');
		if (!control || (control instanceof HTMLButtonElement && control.disabled)) return;
		const action = control.dataset.action ?? 'workspace-view';
		if (action === 'page' || action === 'close-settings') {
			event.preventDefault();
			const closeSettings = action === 'close-settings';
			this.navigate(closeSettings ? 'workspace' : control.dataset.page as Page);
			if (this.page === 'project-settings') {
				[...this.querySelectorAll('harness-settings-page')]
					.find((settings) => settings.scope === 'project')?.showProjectInformation();
				void this.updateComplete.then(() => {
					const heading = this.querySelector<HTMLElement>('[data-page-panel="project-settings"] h1');
					heading?.setAttribute('tabindex', '-1');
					heading?.focus({ preventScroll: true });
				});
			}
			if (control.dataset.page === 'repositories')
				void this.updateComplete.then(() => this.querySelector<HTMLElement>('#repository-search')?.focus());
			if (this.page === 'initiatives')
				void this.updateComplete.then(() => this.querySelector<HTMLElement>('[data-page-panel="initiatives"] h1')?.focus());
			if (closeSettings) {
				const selector = this.browsing
					? '.application-navigation [data-page="workspace"]'
					: '[data-page-panel="workspace"] [role="tab"][aria-selected="true"]';
				void this.updateComplete.then(() => this.querySelector<HTMLElement>(selector)?.focus());
			}
			return;
		}
		if (action === 'workspace-view') {
			this.view = control.dataset.view as WorkspaceView;
		} else if (action === 'pause') this.simulation.pause();
		else if (action === 'stop') {
			this.simulation.mode = 'stopped';
			for (const worker of this.simulation.workers)
				if (worker.status !== 'integrated') this.simulation.setWorkerStatus(worker, 'stopped');
		} else if (action === 'terminate') this.openDialog({ kind: 'terminate' });
		else if (action === 'active-run') {
			this.switchRepository('agent-issues');
			this.initiative = 'harness';
		} else if (action === 'project-close') {
			this.projectOpen = false;
			this.repositoryQuery = '';
			this.navigate('repositories');
			void this.updateComplete.then(() => this.querySelector<HTMLElement>('#repository-search')?.focus());
		} else if (action === 'repository-open') this.switchRepository(control.dataset.id!);
		else if (action === 'repository-settings') this.switchRepository(control.dataset.id!, 'project-settings');
		else if (action === 'initiative-open') {
			const id = control.dataset.id!;
			if (this.projectOpen && this.repositories[this.repository]!.initiatives.includes(id)) {
				this.initiative = id;
				this.navigate('workspace');
				void this.updateComplete.then(() => {
					const heading = this.querySelector<HTMLElement>('[data-page-panel="workspace"] h1');
					heading?.setAttribute('tabindex', '-1');
					heading?.focus({ preventScroll: true });
				});
			}
		}
		else if (action === 'new-planning-session') this.planning.selected = '';
		else if (action === 'planning-session')
			this.planning.select(control.dataset.id!, this.repository);
		else if (action === 'planning-pause') {
			if (this.planning.current)
				this.planning.current.model = {
					...this.planning.current.model,
					paused: !this.planning.current.model.paused,
				};
		} else if (action === 'pioneer-view') {
			if (this.planning.current)
				this.planning.current.model = {
					...this.planning.current.model,
					view: control.dataset.view as 'session' | 'map',
				};
		} else if (action === 'graph-in' || action === 'graph-out' || action === 'graph-fit') {
			const context = this.planning.current;
			if (context) {
				const viewport = this.querySelector<HTMLElement>('.pioneer-viewport');
				const zoom =
					action === 'graph-fit'
						? Math.min(
								1,
								Math.max(0.25, ((viewport?.clientWidth ?? 900) - 24) / 900),
								Math.max(0.25, ((viewport?.clientHeight ?? 640) - 24) / 640)
							)
						: Math.max(
								0.25,
								Math.min(1.5, context.model.zoom + (action === 'graph-in' ? 0.1 : -0.1))
							);
				context.model = { ...context.model, zoom };
			}
		} else if (action === 'pioneer-ticket')
			this.openDialog({ kind: 'pioneer-ticket', index: Number(control.dataset.index) });
		else if (action === 'record')
			this.openDialog({
				kind: 'record',
				recordKind: control.dataset.kind!,
				index: Number(control.dataset.index),
			});
		else if (action === 'agent' || action === 'answer-agent') {
			if (action === 'answer-agent' && (this.browsing || control.dataset.id !== '02' || !this.simulation.question)) return;
			this.openDialog({ kind: 'agent', worker: control.dataset.id! });
			if (action === 'answer-agent') {
				void this.updateComplete.then(async () => {
					await this.querySelector('harness-dialog')?.updateComplete;
					this.querySelector<HTMLTextAreaElement>('#agent-answer')?.focus();
				});
			}
		}
		else if (action === 'takeover') {
			const worker = this.simulation.workers.find(
				(candidate) => candidate.id === control.dataset.id
			);
			if (worker) worker.manual = !worker.manual;
		} else if (action === 'request-change') this.openDialog({ kind: 'request', id: null });
		else if (action === 'open-change')
			this.openDialog({ kind: 'request', id: Number(control.dataset.id) });
		else if (action === 'decline-change') {
			const request = this.currentRequest();
			if (request) {
				request.status = 'declined';
				request.messages.push({
					role: 'agent',
					text: 'Proposal declined. Existing work is unchanged.',
				});
			}
		} else if (action === 'separate-planning') {
			const request = this.currentRequest();
			if (request) {
				request.status = 'planning';
				this.planning.selected = '';
				this.planning.launch = {
					brief: `${request.brief}\n\n${request.criteria}`,
					initiative: '',
					mode: 'plan',
				};
				this.closeDialog();
				this.navigate('planning');
			}
		} else if (action === 'resume-affected') {
			const request = this.simulation.requests.find(
				(candidate) => candidate.id === Number(control.dataset.id)
			);
			if (request) this.simulation.resumeAffected(request);
		} else if (action === 'approve' || action === 'open-review') {
			if (action === 'open-review') {
				if (this.browsing) return;
				const index = this.pendingReviews.find((candidate) =>
					!control.dataset.reference || mergeIssues[candidate]!.reference === control.dataset.reference
				);
				if (index === undefined) return;
				this.reviewSelection = index;
				this.view = 'review';
				this.changed();
				void this.updateComplete.then(async () => {
					await this.querySelector('harness-review-checkpoint')?.updateComplete;
					this.querySelector<HTMLElement>('[data-review-note]')?.focus();
				});
			}
			else {
				const index = this.currentReview;
				if (index !== undefined && this.merge.approveReview(index, this.reviewAllowed, this.reviewCheckpoint(index))) {
					this.merge.selected = index;
					this.view = 'merge';
					const worker = this.simulation.workers.find(
						(candidate) => candidate.issue === mergeIssues[index]!.reference
					);
					if (worker) this.simulation.setWorkerStatus(worker, 'merge');
					this.simulation.activity.unshift(
						`${mergeIssues[index]!.reference} approved for the Merge queue.`
					);
				}
			}
		} else if (action === 'inbox-tab') this.inboxTab = control.dataset.tab!;
		else if (action === 'merge-advance') this.advanceMerge();
		else if (action === 'merge-pause') this.merge.current.paused = !this.merge.current.paused;
		else if (action === 'merge-stop') this.openDialog({ kind: 'merge-stop' });
		else if (action === 'merge-revision') this.openDialog({ kind: 'revision' });
		else if (action === 'merge-issue') {
			const index = Number(control.dataset.value);
			if (this.merge.pending.includes(index)) this.merge.selected = index;
		}
		else if (action === 'merge-view')
			this.merge.current.view = control.dataset.value as 'diffs' | 'agent';
		else if (action === 'comparison')
			this.merge.current.comparison = control.dataset.value as 'split' | 'unified';
		else if (action === 'file') this.merge.current.file = Number(control.dataset.value);
		else if (action === 'merge-control') this.merge.current.manual = !this.merge.current.manual;
		else if (action === 'merge-scenario') {
			const reviewed = this.merge.current.reviewApproved;
			const checkpoint = this.merge.issue.checkpoint;
			this.terminals.discardMerge(this.merge.current);
			this.merge.sessions[this.merge.selected] = this.merge.newSession();
			this.merge.current.reviewApproved = reviewed;
			this.merge.current.checkpoint = checkpoint;
			this.merge.current.scenario = control.dataset.value as MergeScenario;
			this.simulation.integrated.delete(this.merge.selected + 2);
			if (this.merge.selected === 0)
				this.simulation.setWorkerStatus(this.simulation.workers[2]!, 'review');
		} else if (action === 'close-dialog') this.closeDialog();
		else if (action === 'open-folder') {
			this.openDialog({ kind: 'folder' });
			void this.browseFolder('');
		} else if (action === 'folder-browse') void this.browseFolder(control.dataset.path ?? '');
		else if (action === 'folder-select') void this.selectFolder();
		else if (action === 'drawer') {
			this.drawerOpen = !this.drawerOpen;
			if (this.drawerOpen && this.panelLayout.matches) this.inboxOpen = false;
			this.changed();
			const selector = this.drawerOpen
				? '.navigation-drawer [data-action="drawer"][aria-controls]'
				: '.application-toolbar [data-action="drawer"][aria-controls]';
			void this.updateComplete.then(() => this.querySelector<HTMLElement>(selector)?.focus());
		}
		else if (action === 'inbox-toggle') {
			this.inboxOpen = !this.inboxOpen;
			if (this.inboxOpen && this.panelLayout.matches) this.drawerOpen = false;
			if (!this.inboxOpen) {
				this.changed();
				void this.updateComplete.then(() => this.querySelector<HTMLElement>('[data-action="inbox-toggle"][aria-controls="run-inbox"]')?.focus());
			}
		}
		else if (action === 'run-agent') {
			if (this.browsing) return;
			this.inboxTab = 'agent';
			this.inboxOpen = true;
			if (this.panelLayout.matches) this.drawerOpen = false;
			this.changed();
			void this.updateComplete.then(() => this.querySelector<HTMLTextAreaElement>('#run-agent-message')?.focus());
		}
		else if (action === 'theme') {
			this.terminals.dark = !this.terminals.dark;
			document.documentElement.dataset.harnessTheme = this.terminals.dark ? 'dark' : 'light';
		} else if (action === 'reset') {
			this.terminals.dispose();
			this.simulation = new HarnessSimulation();
			this.planning = new PlanningController();
			this.seedPlanning();
			this.merge = new MergeController();
			this.settings = new SettingsController();
			this.repositoryViews.clear();
			this.repository = 'agent-issues';
			this.initiative = 'harness';
			this.view = 'initiative';
			this.reviewSelection = 0;
			this.runPanelWidth = 300;
			this.runPanelDrag = undefined;
			this.dialog = undefined;
			this.toast = '';
			this.drawerOpen = window.matchMedia('(min-width: 1151px)').matches;
			this.inboxOpen = window.matchMedia('(min-width: 1151px)').matches;
		} else return;
		this.changed();
	}

	protected advanceMerge() {
		if (this.merge.runAgent(this.mergeAllowed) && this.merge.current.phase === 'integrated') {
			this.simulation.integrated.add(this.merge.selected + 2);
			const worker = this.simulation.workers.find(
				(candidate) => candidate.issue === this.merge.issue.reference
			);
			if (worker) this.simulation.setWorkerStatus(worker, 'integrated');
			this.simulation.activity.unshift(
				`${this.merge.issue.reference} integrated at ${this.merge.current.integrationHead}. Final merge awaits separate approval.`
			);
			this.merge.selected = this.merge.pending[0] ?? this.merge.selected;
		}
	}

	protected handleInput(event: Event) {
		const input = event.target as HTMLInputElement;
		if (input.closest('[data-form="planning-start"]')) {
			if (input.name === 'brief') this.planning.launch.brief = input.value;
			if (input.name === 'initiative') this.planning.launch.initiative = input.value;
			if (input.name === 'mode') this.planning.launch.mode = input.value as 'plan' | 'pioneer';
			input.setCustomValidity('');
		} else if (input.dataset.planningQuestion !== undefined) {
			this.planning.saveDraft(Number(input.dataset.planningQuestion), input.value);
			input.setCustomValidity('');
		} else if (input.id === 'repository-search') {
			this.repositoryQuery = input.value;
			this.changed();
		} else if (input.name === 'run-agent-message') {
			this.simulation.runAgentDraft = input.value;
			input.setCustomValidity('');
		} else if (input.name === 'answer') this.simulation.answerDraft = input.value;
		else if (input.name === 'change-brief') this.requestDraft = input.value;
		else if (input.name === 'change-answer') {
			const request = this.currentRequest();
			if (request) request.draft = input.value;
		} else if (input.name === 'target') {
			this.requestTarget = Number(input.value);
			const request = this.currentRequest();
			if (request) request.target = this.requestTarget;
			this.changed();
		} else if (input.id === 'merge-message') this.merge.current.draft = input.value;
	}

	protected handleChange(event: Event) {
		const input = event.target as HTMLInputElement;
		if (input.dataset.worker) {
			const worker = this.simulation.workers.find(
				(candidate) => candidate.id === input.dataset.worker
			);
			if (worker) {
				worker.visible = input.checked;
				this.changed();
			}
		}
	}

	protected handleReviewFeedback(event: CustomEvent<ReviewFeedbackBatch>) {
		if (this.browsing) return;
		const comments = event.detail.comments;
		const feedback = comments[0];
		if (!feedback || comments.some((comment) => !comment.note.trim() ||
			comment.reference !== feedback.reference || comment.checkpoint !== feedback.checkpoint)) return;
		const index = this.pendingReviews.find(
			(candidate) => mergeIssues[candidate]!.reference === feedback.reference
		);
		if (index === undefined || !this.reviewAllowed || this.reviewCheckpoint(index) !== feedback.checkpoint) return;
		const note = comments.map((comment) => {
			const location = comment.line ? ` / Diff line ${comment.line}${comment.endLine && comment.endLine !== comment.line ? `-${comment.endLine}` : ''}` : '';
			return `${comment.file ?? 'Review summary'}${location}\n${comment.snippet ? `${comment.snippet}\n` : ''}${comment.note.trim()}`;
		}).join('\n\n');
		const worker = this.simulation.requestReview(feedback.reference, feedback.checkpoint, note);
		if (!worker) return;
		this.querySelector<HTMLElement>('#review-tab')!.focus();
		this.openDialog({ kind: 'agent', worker: worker.id });
		event.preventDefault();
		this.changed();
	}

	protected handleSubmit(event: SubmitEvent) {
		const form = event.target as HTMLFormElement;
		const kind = form.dataset.form;
		if (!kind || kind === 'settings') return;
		event.preventDefault();
		if (!form.reportValidity()) return;
		const values = new FormData(form);
		if (kind === 'run-agent') {
			if (this.browsing || this.simulation.mode === 'stopped') return;
			const message = String(values.get('run-agent-message') ?? '').trim();
			if (!message) {
				const input = form.querySelector('textarea')!;
				input.setCustomValidity('Enter a message.');
				input.reportValidity();
				return;
			}
			this.simulation.runAgentMessages.push(
				{ role: 'user', text: message },
				{
					role: 'agent',
					text: `Message recorded. ${this.simulation.workers.map((worker) => `${worker.issue}: ${worker.label.toLowerCase()}.`).join(' ')} No assignments or approvals changed.`,
				}
			);
			this.simulation.runAgentDraft = '';
			this.changed();
			void this.updateComplete.then(() => {
				const messages = this.querySelector<HTMLElement>('.run-agent-messages');
				if (messages) messages.scrollTop = messages.scrollHeight;
				this.querySelector<HTMLTextAreaElement>('#run-agent-message')?.focus();
			});
		} else if (kind === 'planning-start') {
			this.planning.launch = {
				brief: String(values.get('brief') ?? ''),
				initiative: String(values.get('initiative') ?? ''),
				mode: values.get('mode') === 'pioneer' ? 'pioneer' : 'plan',
			};
			if (
				!this.planning.start(this.repository, initiatives[this.planning.launch.initiative]?.title)
			) {
				const brief = form.querySelector('textarea')!;
				brief.setCustomValidity('Enter a starting point.');
				brief.reportValidity();
			}
		} else if (kind === 'planning-answer') {
			for (const input of form.querySelectorAll<HTMLTextAreaElement>('[data-planning-question]')) {
				this.planning.saveDraft(Number(input.dataset.planningQuestion), input.value);
				input.setCustomValidity(input.value.trim() ? '' : 'Enter an answer.');
			}
			if (!form.reportValidity() || !this.planning.submit()) return;
		} else if (kind === 'answer') {
			const answer = String(values.get('answer') ?? '').trim();
			if (!answer || this.workerAnswerBlocked) return;
			this.simulation.question = false;
			this.simulation.answerDraft = '';
			this.simulation.setWorkerStatus(this.simulation.workers[1]!, 'running');
			this.simulation.workers[1]!.lines.push(
				`User decision: ${answer}`,
				'Continue implementation with the recorded decision.'
			);
			this.simulation.activity.unshift('Worker 02 received the usage-limit decision.');
		} else if (kind === 'change-start') {
			const request = this.simulation.requestChange(
				String(values.get('change-brief') ?? ''),
				this.requestTarget
			);
			if (!request) return;
			this.requestDraft = '';
			this.dialog = { kind: 'request', id: request.id };
		} else if (kind === 'change-answer') {
			const request = this.currentRequest();
			if (
				!request ||
				!this.simulation.answerChange(request, String(values.get('change-answer') ?? ''))
			)
				return;
		} else if (kind === 'change-approval') {
			const request = this.currentRequest();
			const choice = (event.submitter as HTMLButtonElement).value as
				| 'followup'
				| 'revise'
				| 'pause';
			if (!request || !this.simulation.approveChange(request, choice, Number(values.get('target'))))
				return;
		} else if (kind === 'folder-path') void this.browseFolder(String(values.get('path') ?? ''));
		else if (kind === 'revision') {
			if (this.merge.requestRevision(String(values.get('note') ?? ''))) {
				this.merge.runAgent(this.mergeAllowed);
				this.closeDialog();
			}
		} else if (kind === 'merge-stop') {
			this.merge.stop();
			this.closeDialog();
		} else if (kind === 'terminate') {
			this.simulation.mode = 'stopped';
			for (const worker of this.simulation.workers)
				if (worker.status !== 'integrated') this.simulation.setWorkerStatus(worker, 'stopped');
			this.closeDialog();
		} else if (kind === 'merge-message') {
			const message = String(values.get('message') ?? '').trim();
			if (!message || !this.mergeAllowed || this.merge.current.paused) return;
			this.merge.current.messages.push(
				{ role: 'user', text: message },
				{ role: 'agent', text: 'Message recorded in this simulated session. No provider call.' }
			);
			this.merge.current.draft = '';
		}
		this.changed();
	}

	protected handleKeydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement;
		if (event.key === 'Escape' && this.dialog) {
			event.preventDefault();
			this.closeDialog();
			return;
		}
		if (event.key === 'Escape' && (this.drawerOpen || this.inboxOpen)) {
			const panel = target.closest('.navigation-drawer, .run-inbox');
			if (panel) {
				event.preventDefault();
				const action = panel.classList.contains('navigation-drawer') ? 'drawer' : 'inbox-toggle';
				this.querySelector<HTMLElement>(`[data-action="${action}"][aria-controls]`)?.click();
				return;
			}
			if (window.matchMedia('(max-width: 1150px)').matches) {
				event.preventDefault();
				const action = this.drawerOpen ? 'drawer' : 'inbox-toggle';
				this.querySelector<HTMLElement>(`[data-action="${action}"][aria-controls]`)?.click();
				return;
			}
		}
		if (
			target.getAttribute('role') !== 'tab' ||
			!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
		)
			return;
		const tabs = [
			...target.closest('[role="tablist"]')!.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
		];
		const index = tabs.indexOf(target as HTMLButtonElement);
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? tabs.length - 1
					: (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
		event.preventDefault();
		tabs[next]!.click();
		void this.updateComplete.then(() => tabs[next]!.focus());
	}

	protected handleSettingsSaved() {
		for (const page of this.querySelectorAll('harness-settings-page')) page.refresh();
		this.toast = 'Simulated settings saved for this session.';
		this.changed();
	}

	protected currentRequest(): ChangeRequest | undefined {
		const dialog = this.dialog;
		return dialog?.kind === 'request'
			? this.simulation.requests.find((request) => request.id === dialog.id)
			: undefined;
	}

	protected async browseFolder(path: string) {
		const request = ++this.folderRequest;
		this.folder = { ...this.folder, loading: true, error: '' };
		this.changed();
		try {
			const response = await fetch(`/api/folders?path=${encodeURIComponent(path)}`);
			const body = (await response.json()) as FolderBrowser & { error?: string };
			if (request !== this.folderRequest || this.dialog?.kind !== 'folder') return;
			if (!response.ok) throw new Error(body.error ?? 'This folder is not available.');
			this.folder = {
				path: body.path,
				parent: body.parent,
				entries: body.entries,
				loading: false,
				error: '',
			};
		} catch (error) {
			if (request === this.folderRequest)
				this.folder = {
					...this.folder,
					loading: false,
					error: error instanceof Error ? error.message : 'This folder is not available.',
				};
		}
		this.changed();
	}

	protected async selectFolder() {
		if (this.folder.loading || this.folder.error) return;
		const path = this.folder.path;
		const request = ++this.folderRequest;
		this.folder.loading = true;
		this.changed();
		try {
			const response = await fetch(`/api/repository?path=${encodeURIComponent(path)}`);
			const body = (await response.json()) as { path: string; name: string; error?: string };
			if (request !== this.folderRequest || this.dialog?.kind !== 'folder') return;
			if (!response.ok) throw new Error(body.error ?? 'Git could not verify this repository.');
			let id = Object.keys(this.repositories).find(
				(key) => this.repositories[key]!.path === body.path
			);
			if (!id) {
				id = `repository-${Object.keys(this.repositories).length + 1}`;
				this.repositories[id] = {
					name: body.name,
					path: body.path,
					projectIdentity: '',
					tenant: 'Not connected',
					initiatives: [],
				};
			}
			this.closeDialog();
			this.switchRepository(id);
		} catch (error) {
			if (request === this.folderRequest)
				this.folder = {
					...this.folder,
					loading: false,
					error: error instanceof Error ? error.message : 'This repository is not available.',
				};
		}
		this.changed();
	}

	protected override updated() {
		this.paintRunPanelWidth();
		void this.syncTerminals();
	}

	protected async syncTerminals() {
		const version = this.version;
		await Promise.all(
			[
				...this.querySelectorAll<LightElement>(
					'harness-terminal-grid, harness-merge-workspace, harness-dialog'
				),
			].map((element) => element.updateComplete)
		);
		await Promise.all(
			[...this.querySelectorAll<LightElement>('harness-terminal-panel')].map(
				(element) => element.updateComplete
			)
		);
		if (version !== this.version || !this.isConnected) return;
		this.terminals.syncWorkers(this, this.simulation.workers);
		for (const [index, session] of this.merge.sessions.entries())
			this.terminals.syncMerge(
				session,
				this.querySelector<HTMLElement>(`[data-terminal="merge-${index}"]`)
			);
		if (this.dialog?.kind === 'agent') {
			const target = this.querySelector<HTMLElement>('.agent-session-mount');
			if (target) this.terminals.showWorker(this.dialog.worker, target);
		}
	}
}
