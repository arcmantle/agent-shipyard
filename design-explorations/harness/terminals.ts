import { html, nothing, render } from 'lit';
import type { SimulationWorker } from './simulation.js';
import type { MergeSession } from './merge.js';

interface TerminalTheme {
	background: string;
	foreground: string;
	cursor: string;
	selectionBackground: string;
	green: string;
	brightBlack: string;
}
interface TerminalHandle {
	options: { theme: TerminalTheme; cursorBlink: boolean };
	loadAddon(addon: FitHandle): void;
	open(host: HTMLElement): void;
	write(text: string): void;
	writeln(text: string): void;
	focus(): void;
	dispose(): void;
	onData(handler: (data: string) => void): { dispose(): void };
}
interface FitHandle {
	fit(): void;
}
interface TerminalEntry {
	host: HTMLElement;
	terminal: TerminalHandle;
	fit: FitHandle;
	observer: ResizeObserver;
	written: number;
	draft: string;
}

export class TerminalManager {
	workers = new Map<string, TerminalEntry>();
	merges = new Map<MergeSession, TerminalEntry>();
	overlayWorker = '';
	dark = false;

	protected get theme(): TerminalTheme {
		const styles = getComputedStyle(document.documentElement);
		return {
			background: styles.getPropertyValue('--terminal').trim(),
			foreground: styles.getPropertyValue('--theme-terminal-ink').trim(),
			cursor: styles.getPropertyValue('--accent').trim(),
			selectionBackground: styles.getPropertyValue('--theme-terminal-selection').trim(),
			green: styles.getPropertyValue('--green').trim(),
			brightBlack: styles.getPropertyValue('--muted').trim(),
		};
	}

	protected create(host: HTMLElement, manual: () => boolean) {
		if (!window.Terminal || !window.FitAddon) return undefined;
		render(nothing, host);
		const terminal = new window.Terminal({
			fontFamily: getComputedStyle(host).getPropertyValue('--terminal-font').trim() || '"FiraCode Nerd Font", "Cascadia Code", "Roboto Mono", monospace',
			fontSize: 13,
			lineHeight: 1.5,
			cursorBlink: manual(),
			theme: this.theme,
			scrollback: 300,
			convertEol: true,
		});
		const fit = new window.FitAddon.FitAddon();
		terminal.loadAddon(fit);
		terminal.open(host);
		const observer = new ResizeObserver(() => {
			if (host.offsetWidth && host.offsetHeight) fit.fit();
		});
		observer.observe(host);
		const entry: TerminalEntry = { host, terminal, fit, observer, written: 0, draft: '' };
		terminal.onData((data) => {
			if (!manual()) return;
			if (data === '\r') {
				terminal.write('\r\n');
				entry.draft = '';
			} else if (data === '\u007f') {
				if (entry.draft.length) {
					entry.draft = entry.draft.slice(0, -1);
					terminal.write('\b \b');
				}
			} else if (!data.includes('\u001b')) {
				entry.draft += data;
				terminal.write(data);
			}
		});
		return entry;
	}

	protected writeLine(entry: TerminalEntry, line: string) {
		const color =
			line.startsWith('PASS') || line.includes('passed')
				? '\u001b[32m'
				: line.includes('Copilot') || line.startsWith('>')
					? '\u001b[90m'
					: '';
		entry.terminal.writeln(`${color}${line}\u001b[0m`);
	}

	syncWorkers(root: HTMLElement, workers: SimulationWorker[]) {
		for (const placeholder of root.querySelectorAll<HTMLElement>(
			'.terminal-grid [data-terminal]'
		)) {
			const worker = workers.find((candidate) => candidate.id === placeholder.dataset.terminal);
			if (!worker) continue;
			let entry = this.workers.get(worker.id);
			if (entry && worker.id !== this.overlayWorker && placeholder !== entry.host)
				placeholder.replaceWith(entry.host);
			if (!entry) {
				entry = this.create(placeholder, () => worker.manual);
				if (!entry) {
					render(html`<pre>${worker.lines.join('\n')}</pre>`, placeholder);
					continue;
				}
				this.workers.set(worker.id, entry);
			}
			entry.terminal.options.cursorBlink = worker.manual;
			entry.terminal.options.theme = this.theme;
			for (const line of worker.lines.slice(entry.written)) this.writeLine(entry, line);
			entry.written = worker.lines.length;
		}
	}

	syncMerge(session: MergeSession, placeholder: HTMLElement | null) {
		if (!placeholder) return;
		let entry = this.merges.get(session);
		if (entry && placeholder !== entry.host) placeholder.replaceWith(entry.host);
		if (!entry) {
			entry = this.create(placeholder, () => session.manual);
			if (!entry) {
				render(
					html`<pre>${session.messages.map((message) => message.text).join('\n\n')}</pre>`,
					placeholder
				);
				return;
			}
			this.merges.set(session, entry);
			this.writeLine(entry, 'Merge agent / Copilot / simulated session\r\n');
		}
		entry.terminal.options.cursorBlink = session.manual;
		entry.terminal.options.theme = this.theme;
		for (const message of session.messages.slice(entry.written))
			entry.terminal.writeln(`${message.role === 'agent' ? 'Agent' : 'You'}: ${message.text}\r\n`);
		entry.written = session.messages.length;
	}

	discardMerge(session: MergeSession) {
		const entry = this.merges.get(session);
		if (!entry) return;
		entry.observer.disconnect();
		entry.terminal.dispose();
		this.merges.delete(session);
	}

	showWorker(id: string, target: HTMLElement) {
		const entry = this.workers.get(id);
		if (!entry) return;
		if (entry.host.parentElement !== target) {
			const placeholder = document.createElement('div');
			placeholder.className = 'terminal-host';
			placeholder.dataset.terminal = id;
			entry.host.replaceWith(placeholder);
			target.append(entry.host);
		}
		this.overlayWorker = id;
		if (entry.host.offsetWidth && entry.host.offsetHeight) entry.fit.fit();
	}

	restoreWorker(root: HTMLElement) {
		const id = this.overlayWorker;
		this.overlayWorker = '';
		const entry = this.workers.get(id);
		const placeholder = root.querySelector<HTMLElement>(`.terminal-grid [data-terminal="${id}"]`);
		if (entry && placeholder && placeholder !== entry.host) placeholder.replaceWith(entry.host);
	}

	dispose() {
		for (const entry of [...this.workers.values(), ...this.merges.values()]) {
			entry.observer.disconnect();
			entry.terminal.dispose();
		}
		this.workers.clear();
		this.merges.clear();
		this.overlayWorker = '';
	}
}

declare global {
	interface Window {
		Terminal?: new (options: {
			fontFamily: string;
			fontSize: number;
			lineHeight: number;
			cursorBlink: boolean;
			theme: TerminalTheme;
			scrollback: number;
			convertEol: boolean;
		}) => TerminalHandle;
		FitAddon?: { FitAddon: new () => FitHandle };
	}
}
