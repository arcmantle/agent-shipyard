import { css } from "lit";

export const issueBrowserTypographyStyles = css`
button,
input,
select,
pre,
code {
	font: inherit;
}

button {
	color: inherit;
}

.repo-label,
.section-label,
.meta-label,
.issue-number,
.small-copy {
	color: var(--muted);
	font-size: 0.75rem;
	font-weight: 600;
}

.repo-title,
h1,
h2,
h3 {
	margin: 0;
	letter-spacing: -0.01em;
}

.repo-title {
	font-size: 1rem;
	font-weight: 600;
}

.repo-subtitle,
.meta-copy,
.section-copy,
.empty-copy,
.thread-copy,
.relation-copy,
.definition-value,
.graph-copy,
.list-meta,
.issue-meta-text {
	color: var(--muted);
	font-size: 0.875rem;
	line-height: 1.5;
}

.initiative-title,
.backlink-title,
.relation-title {
	font-size: 0.9375rem;
	font-weight: 600;
	line-height: 1.35;
}
`;

export const issueBrowserControlStyles = css`
input,
select {
	width: 100%;
	box-sizing: border-box;
	padding: 9px 12px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--surface);
	color: var(--text);
}

input:focus,
select:focus,
.issue-row-button:focus,
.entity-row-button:focus,
.link-button:focus,
.tab-button:focus,
.back-button:focus,
.graph-action:focus,
.initiative-button:focus,
.bundle-title-button:focus,
.bundle-toggle:focus {
	outline: 2px solid var(--focus-ring);
	outline-offset: 2px;
}

.badge,
.counter,
.graph-action,
.tab-button,
.back-button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-height: 28px;
	padding: 0 10px;
	border: 1px solid var(--border);
	border-radius: 999px;
	background: var(--surface);
	font-size: 0.75rem;
	font-weight: 600;
	line-height: 1;
}

.counter {
	background: var(--surface-muted);
}

.badge.success {
	border-color: rgba(26, 127, 55, 0.18);
	background: var(--success-bg);
	color: var(--success);
}

.badge.warn {
	border-color: rgba(154, 103, 0, 0.18);
	background: var(--warn-bg);
	color: var(--warn);
}

.badge.danger {
	border-color: rgba(207, 34, 46, 0.18);
	background: var(--danger-bg);
	color: var(--danger);
}

.badge.info,
.graph-action {
	border-color: rgba(9, 105, 218, 0.18);
	background: var(--accent-soft);
	color: var(--accent);
}

.badge.done {
	border-color: rgba(130, 80, 223, 0.18);
	background: var(--done-bg);
	color: var(--done);
}

.badge.neutral,
.tab-button,
.back-button {
	background: var(--surface-muted);
}

.count-row,
.issue-row-meta,
.issue-row-top,
.badge-row,
.inline-row,
.bundle-counts,
.relation-meta,
.backlink-meta,
.graph-badges,
.initiative-counts {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	align-items: center;
}

.issue-row-button,
.entity-row-button,
.link-button,
.graph-action,
.tab-button,
.back-button,
.initiative-button,
.bundle-title-button,
.bundle-toggle {
	border: 0;
	cursor: pointer;
	text-align: left;
}

.link-button {
	background: transparent;
	padding: 0;
	color: var(--accent);
	font-weight: 600;
}

.link-button:hover {
	text-decoration: underline;
}

.empty-panel {
	padding: 24px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--surface);
}

.error-panel {
	padding: 12px;
	border: 1px solid rgba(207, 34, 46, 0.18);
	border-radius: 6px;
	background: var(--danger-bg);
	color: var(--danger);
}
`;