import type { InitiativeModel } from './components/initiative-route.js';
import type { IssueModel } from './components/issue-card.js';
import type { WorkContext } from './components/work-context.js';
import type { WorkerModel } from './components/terminal-panel.js';

export interface Initiative {
	title: string;
	summary: string;
	prd: string;
	story: string;
	issues: string[];
	adrs: string[];
}

export const initiatives: Record<string, Initiative> = {
	harness: {
		title: 'Helm execution workspace',
		summary: 'Coordinate agents, user decisions, and approved changes.',
		prd: 'Local execution workspace',
		story: 'Inspect and control agent work',
		issues: ['Session recovery', 'Usage limits', 'Approval checkpoint'],
		adrs: ['Native terminal workspace', 'Approved integration'],
	},
	navigation: {
		title: 'Tracker navigation',
		summary: 'Find tracked requirements and linked work.',
		prd: 'Connected work navigation',
		story: 'Browse initiative records',
		issues: ['Initiative selector', 'Linked record view', 'Work filters'],
		adrs: ['Shared tracker queries'],
	},
	studio: {
		title: 'Studio portfolio',
		summary: 'Present selected work and project details.',
		prd: 'Portfolio navigation',
		story: 'Inspect selected work',
		issues: ['Project index', 'Project detail', 'Contact form'],
		adrs: ['Static content'],
	},
	api: {
		title: 'Task service',
		summary: 'Manage tasks through a project-scoped API.',
		prd: 'Task API',
		story: 'Manage project tasks',
		issues: ['Task list', 'Task updates', 'Access control'],
		adrs: ['Project-scoped access'],
	},
};

export interface SimulationIssue {
	title: string;
	dependencies: number[];
	outcome: string;
	criteria: string[];
	evidence: string;
}

export interface SimulationWorker extends WorkerModel {
	title: string;
	lines: string[];
}

export interface ChangeRequest {
	id: number;
	target: number;
	brief: string;
	criteria: string;
	status: 'question' | 'proposal' | 'approved' | 'declined' | 'planning';
	choice?: string;
	issue?: number;
	pausedWorkers: string[];
	messages: { role: 'user' | 'agent'; text: string }[];
	draft: string;
}

const changeProposal = 'Proposed work: add a follow-up issue, revise a queued issue, or pause affected work and add a follow-up. Work remains unchanged until approval.';

const titles = [
	'Session recovery',
	'Usage limits',
	'Approval checkpoint',
	'Serial integration',
	'Restart confirmation',
	'Final merge approval',
];
const chainTitles = [
	'Persist runner identity',
	'Record issue attempts',
	'Bind worktree ownership',
	'Capture repository state',
	'Restore checkpoint index',
	'Validate checkpoint identity',
	'Record pending approvals',
	'Restore inbox ownership',
	'Reconcile worker sessions',
	'Check provider availability',
	'Validate session permissions',
	'Restore usage counters',
	'Apply provider limits',
	'Restore input ownership',
	'Check interrupted commands',
	'Record recovery decisions',
	'Validate worker worktrees',
	'Confirm restart eligibility',
	'Restore scheduling state',
	'Check dependency gates',
	'Restore review evidence',
	'Bind approval revisions',
	'Validate integration order',
	'Record integration results',
	'Reconcile branch checkpoints',
	'Check remaining work',
	'Prepare release evidence',
	'Review recovery evidence',
	'Validate release checkpoint',
	'Prepare final approval',
];

export const reference = (index: number) => `DEMO-${String(index + 1).padStart(2, '0')}`;

export class HarnessSimulation {
	constructor() {
		const details = [
			{
				outcome: 'Restore recorded sessions without restarting interrupted agents automatically.',
				criteria: [
					'Restore pending decisions and recorded checkpoints.',
					'Require confirmation before an interrupted agent restarts.',
				],
				evidence: '2 focused checks passed. Independent review is in progress.',
			},
			{
				outcome: 'Apply one usage limit across all sessions in a provider integration.',
				criteria: [
					'Count usage across workers and repositories.',
					'Pause new assignments when the limit is reached.',
				],
				evidence: 'Waiting for the user decision. Validation is not complete.',
			},
			{
				outcome: 'Bind integration approval to the exact recorded changes.',
				criteria: [
					'A changed revision requires new approval.',
					'Integrate only the approved revision.',
				],
				evidence: '6 checks passed. Independent review passed.',
			},
			{
				outcome: 'Integrate approved worker changes one issue at a time.',
				criteria: [
					'Keep worker changes in isolated worktrees.',
					'Send conflicts to the run inbox.',
				],
				evidence: 'Not assigned. No validation evidence.',
			},
			{
				outcome: 'Check restored state and usage before restarting an interrupted worker.',
				criteria: [
					'Read tracker, Git, and session state.',
					'Require user confirmation before restart.',
				],
				evidence: 'Not assigned. No validation evidence.',
			},
			{
				outcome:
					'Request separate approval before the initiative branch merges to the target branch.',
				criteria: ['All required issue changes must be integrated.', 'Do not push automatically.'],
				evidence: 'Not assigned. No validation evidence.',
			},
		];
		this.issues = titles.map((title, index) => ({
			title,
			dependencies: [[], [], [], [2], [3, 0, 1], []][index]!,
			...details[index]!,
		}));
		this.prds = [
			{
				title: 'Local execution workspace',
				story: 'Inspect and control agent work',
				issues: [0, 2],
			},
			{
				title: 'Safe delivery and recovery',
				story: 'Integrate and recover approved work',
				issues: [2, 3, 4, 5],
			},
		];
		let prerequisites = [4];
		const branches: Record<number, string[]> = {
			7: ['Validate Windows recovery', 'Validate macOS recovery'],
			17: ['Review provider recovery', 'Review worktree recovery'],
			25: ['Check CLI regression coverage', 'Check browser regression coverage'],
		};
		for (const [position, title] of chainTitles.entries()) {
			const index = this.addIssue(title, prerequisites);
			prerequisites = [index];
			if (branches[position])
				prerequisites = branches[position]!.map((branch) => this.addIssue(branch, [index]));
		}
		this.issues[5]!.dependencies = prerequisites;
		this.workers = [
			{
				id: '01',
				issue: 'DEMO-01',
				title: titles[0]!,
				status: 'running',
				label: 'Running',
				manual: false,
				visible: true,
				lines: [
					'GitHub Copilot / simulated session',
					'',
					'> /agent-issues tdd DEMO-01',
					'',
					'Read issue context and recovery contract.',
					'Run focused validation.',
					'',
					'$ pnpm test -- recovery',
					'PASS  interrupted session records',
					'PASS  restore pending inbox items',
					'',
					'Independent review is in progress.',
				],
			},
			{
				id: '02',
				issue: 'DEMO-02',
				title: titles[1]!,
				status: 'waiting',
				label: 'Needs a decision',
				manual: false,
				visible: true,
				lines: [
					'GitHub Copilot / simulated session',
					'',
					'> /agent-issues implement DEMO-02',
					'',
					'Read provider usage requirements.',
					'Question for the user:',
					'Should the limit apply across all workers?',
					'',
					'Waiting for your decision. Independent work can continue.',
				],
			},
			{
				id: '03',
				issue: 'DEMO-03',
				title: titles[2]!,
				status: 'review',
				label: 'Ready for review',
				manual: false,
				visible: true,
				lines: [
					'GitHub Copilot / simulated session',
					'',
					'> /agent-issues tdd DEMO-03',
					'',
					'PASS  approval binds to recorded changes',
					'PASS  changed revision requires approval',
					'',
					'Independent review: no material findings.',
					'Final focused validation: passed.',
					'',
					'Issue complete. Integration awaits approval.',
				],
			},
		];
	}

	issues: SimulationIssue[];
	prds: { title: string; story: string; issues: number[] }[];
	workers: SimulationWorker[];
	reviewReady = new Set<string>(['DEMO-03']);
	integrated = new Set<number>();
	mode: 'running' | 'paused' | 'stopped' = 'running';
	question = true;
	answerDraft = '';
	runAgentDraft = '';
	runAgentMessages: { role: 'agent' | 'user'; text: string }[] = [
		{
			role: 'agent',
			text: 'I assigned DEMO-01 and DEMO-02 to separate workers. DEMO-03 is ready for your review. Integration requires your approval.',
		},
	];
	requests: ChangeRequest[] = [];
	reviewFeedbacks: { reference: string; checkpoint: string; note: string }[] = [];
	activity = [
		'Worker 03 completed its skill review.',
		'Checkpoint saved: validation / attempt 03.1.',
		'Worker 02 requested a usage-limit decision.',
		'Workers 01 and 02 started in separate worktrees.',
	];
	resetVersion = 0;
	protected pausedStatuses = new Map<string, string>();
	protected affectedStatuses = new Map<string, string>();

	addIssue(title: string, dependencies: number[]) {
		const index = this.issues.length;
		this.issues.push({
			title,
			dependencies: [...dependencies],
			outcome: `${title} before dependent work starts.`,
			criteria: [
				'Record the result and focused validation.',
				'Require approval before integration.',
			],
			evidence: 'Not assigned. No validation evidence.',
		});
		this.prds[1]!.issues.push(index);
		return index;
	}

	issueModel(index: number): IssueModel {
		const issue = this.issues[index]!;
		const worker = this.workers.find((candidate) => candidate.issue === reference(index));
		const blocked = issue.dependencies.some((dependency) => !this.integrated.has(dependency));
		const tone = this.integrated.has(index)
			? 'integrated'
			: (worker?.status ?? (blocked || this.mode !== 'running' ? 'blocked' : 'ready'));
		const label = this.integrated.has(index)
			? 'Integrated'
			: (worker?.label ?? (blocked ? 'Blocked' : this.mode !== 'running' ? 'Paused' : 'Ready'));
		const detail = worker
			? `Worker ${worker.id} / ${worker.label}`
			: blocked
				? `Wait for ${issue.dependencies.map(reference).join(' + ')}`
				: this.mode !== 'running'
					? 'Run is paused.'
					: 'Ready for assignment';
		return {
			index,
			reference: reference(index),
			title: issue.title,
			status: { tone, label, detail },
			prds: this.prds.flatMap((prd, prdIndex) => (prd.issues.includes(index) ? [prdIndex] : [])),
			workerId: worker?.id,
			attention: worker?.id === '02' && this.question ? 'answer' : this.reviewReady.has(reference(index)) ? 'review' : undefined,
		};
	}

	workContext(issueReference: string): WorkContext {
		const index = this.issues.findIndex((_issue, position) => reference(position) === issueReference);
		return {
			issue: this.issueModel(index),
			parents: this.prds.flatMap((prd, prdIndex) =>
				prd.issues.includes(index) ? [{ index: prdIndex, title: prd.title, story: prd.story }] : []
			),
		};
	}

	get routeModel(): InitiativeModel {
		const pending = new Set(this.issues.map((_issue, index) => index));
		const visited = new Set<number>();
		const waves: number[][] = [];
		while (pending.size) {
			const wave = [...pending].filter((index) =>
				this.issues[index]!.dependencies.every((dependency) => visited.has(dependency))
			);
			if (!wave.length) throw new Error('The example contains a dependency cycle.');
			waves.push(wave);
			for (const index of wave) {
				pending.delete(index);
				visited.add(index);
			}
		}
		const segments: { depth: number; serial: boolean; issues: number[] }[] = [];
		for (const [depth, wave] of waves.entries()) {
			const previous = segments.at(-1);
			if (wave.length === 1 && previous?.serial && wave[0] !== 5) previous.issues.push(...wave);
			else segments.push({ depth, serial: wave.length === 1, issues: [...wave] });
		}
		const assigned = this.workers.flatMap((worker) =>
			worker.status !== 'integrated'
				? [this.issues.findIndex((_issue, index) => reference(index) === worker.issue)]
				: []
		);
		return {
			title: 'Helm execution workspace',
			summary: 'Coordinate agents, user decisions, and approved changes.',
			integrated: this.integrated.size,
			issueCount: this.issues.length,
			assignedCount: assigned.length,
			stageCount: waves.length,
			parallelCount: waves.filter((wave) => wave.length > 1).length,
			resetVersion: this.resetVersion,
			sections: segments.map((segment, position) => {
				const first = segment.issues[0]!;
				const unfinished =
					segment.issues.find((index) => !this.integrated.has(index)) ?? segment.issues.at(-1)!;
				return {
					key: String(first),
					kind:
						position === 0
							? 'current'
							: first === 5
								? 'final'
								: segment.serial
									? 'serial'
									: 'parallel',
					stage: segment.depth + 1,
					issues: segment.issues.map((index) => this.issueModel(index)),
					status: this.issueModel(unfinished).status,
					prerequisites: this.issues[first]!.dependencies.map(reference).join(' + '),
					nextReference: segments[position + 1]
						? reference(segments[position + 1]!.issues[0]!)
						: '',
				};
			}),
			prds: this.prds.map((prd, index) => ({
				index,
				title: prd.title,
				issueCount: prd.issues.length,
				assigned: prd.issues
					.filter((issue) => assigned.includes(issue))
					.map((issue) => this.issueModel(issue)),
			})),
			unlinked: assigned
				.filter((index) => !this.issueModel(index).prds.length)
				.map((index) => this.issueModel(index)),
		};
	}

	setWorkerStatus(worker: SimulationWorker, status: string) {
		if (status === 'review') this.reviewReady.add(worker.issue);
		else if (['running', 'waiting', 'merge', 'integrated'].includes(status)) this.reviewReady.delete(worker.issue);
		const labels: Record<string, string> = {
			running: 'Running',
			waiting: 'Needs a decision',
			review: 'Ready for review',
			merge: 'Waiting for merge',
			paused: 'Paused',
			stopped: 'Stopped',
			integrated: 'Integrated',
		};
		worker.status = status;
		worker.label = labels[status] ?? status;
	}

	pause() {
		if (this.mode === 'paused') {
			this.mode = 'running';
			for (const worker of this.workers)
				if (this.pausedStatuses.has(worker.id) && !this.affectedStatuses.has(worker.id))
					this.setWorkerStatus(worker, this.pausedStatuses.get(worker.id)!);
			this.pausedStatuses.clear();
		} else if (this.mode === 'running') {
			this.mode = 'paused';
			for (const worker of this.workers)
				if (worker.status !== 'integrated' && worker.status !== 'paused') {
					this.pausedStatuses.set(worker.id, worker.status);
					this.setWorkerStatus(worker, 'paused');
				}
		}
	}

	reviewCheckpoint(issueReference: string, initial: string) {
		const revision = this.reviewFeedbacks.filter((feedback) => feedback.reference === issueReference).length;
		return revision ? `${initial}-r${revision}` : initial;
	}

	requestReview(issueReference: string, checkpoint: string, note: string) {
		const worker = this.workers.find((candidate) => candidate.issue === issueReference);
		if (!note.trim() || !checkpoint || this.mode !== 'running' || !worker || worker.manual ||
			worker.status !== 'review' || !this.reviewReady.has(issueReference) ||
			this.reviewFeedbacks.some((feedback) => feedback.reference === issueReference && feedback.checkpoint === checkpoint)) return undefined;
		this.reviewFeedbacks.push({ reference: issueReference, checkpoint, note: note.trim() });
		this.setWorkerStatus(worker, 'running');
		const issue = this.issues.find((_issue, index) => reference(index) === issueReference)!;
		issue.evidence = 'Changes requested. New validation and independent review are pending.';
		worker.lines.push('', `Review feedback / ${checkpoint}`, note.trim(), 'Revising the same issue. New validation and review are required.');
		this.activity.unshift(`${issueReference} / Changes requested.`);
		return worker;
	}

	requestChange(brief: string, target = 2) {
		if (!brief.trim()) return undefined;
		const request: ChangeRequest = {
			id: this.requests.length + 1,
			target,
			brief: brief.trim(),
			criteria: '',
			status: 'question',
			pausedWorkers: [],
			draft: '',
			messages: [
				{ role: 'user', text: brief.trim() },
				{ role: 'agent', text: 'What result and acceptance criteria must this change satisfy?' },
			],
		};
		this.requests.push(request);
		return request;
	}

	answerChange(request: ChangeRequest, answer: string) {
		if (request.status !== 'question' || !answer.trim()) return false;
		request.criteria = answer.trim();
		request.status = 'proposal';
		request.messages.push(
			{ role: 'user', text: answer.trim() },
			{
				role: 'agent',
				text: changeProposal,
			}
		);
		return true;
	}

	approveChange(request: ChangeRequest, choice: 'followup' | 'revise' | 'pause', target = request.target) {
		if (request.status !== 'proposal' || !this.issues[target] || target === 5) return false;
		const worker = this.workers.find((candidate) => candidate.issue === reference(target));
		if (choice === 'revise' && (worker || this.integrated.has(target))) return false;
		request.target = target;
		if (choice === 'revise') {
			this.issues[target]!.outcome = request.brief;
			this.issues[target]!.criteria.push(request.criteria);
			request.issue = target;
		} else {
			request.issue = this.addIssue(request.brief, [target]);
			this.issues[request.issue]!.criteria.push(request.criteria);
			this.issues[5]!.dependencies.push(request.issue);
			if (choice === 'pause' && worker && worker.status !== 'integrated') {
				if (!this.affectedStatuses.has(worker.id)) {
					this.affectedStatuses.set(worker.id, this.pausedStatuses.get(worker.id) ?? worker.status);
				}
				request.pausedWorkers.push(worker.id);
				this.setWorkerStatus(worker, 'paused');
			}
		}
		request.choice = choice;
		request.status = 'approved';
		request.messages.push({
			role: 'agent',
			text: `${reference(request.issue)} recorded after explicit approval.`,
		});
		this.activity.unshift(`Change request ${request.id} approved.`);
		return true;
	}

	resumeAffected(request: ChangeRequest) {
		if (
			this.mode !== 'running' ||
			!this.requests.includes(request) ||
			request.status !== 'approved' ||
			!request.pausedWorkers.length
		)
			return false;
		const ids = request.pausedWorkers;
		request.pausedWorkers = [];
		for (const id of ids) {
			if (this.requests.some((other) => other.pausedWorkers.includes(id))) continue;
			const worker = this.workers.find((candidate) => candidate.id === id);
			if (worker?.status === 'paused')
				this.setWorkerStatus(worker, this.affectedStatuses.get(id) ?? worker.status);
			this.affectedStatuses.delete(id);
		}
		return true;
	}
}
