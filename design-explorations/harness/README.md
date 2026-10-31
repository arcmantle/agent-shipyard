# Helm Design Exploration

This folder contains one current Helm prototype for Shipyard. It includes the workspace, Planning,
Settings, agent overlays, and simulated Merge sessions. Activity is simulated;
there are no live agent processes, provider calls, or Git writes.

Logbook is the knowledge and issue system. Wayfinder is the code navigation
system. Product names in this prototype do not rename CLI binaries or commands.
The shared light and dark palettes and theme rules are in `theme.css`.

Install the workspace dependencies with `pnpm install` first. From the repository
root, run:

```console
pnpm --dir logbook --filter @agent-issues/site exec vite --config ../../../design-explorations/harness/vite.config.ts
```

Open the URL printed by Vite. It starts on port 5328 or the next available port.
Use the server rather than opening the HTML file directly.

The Vite development server uses the site's installed Vite, Lit, and Lucide
dependencies. It serves the TypeScript entry directly on the same origin and
caches optimized dependencies in the site's node_modules folder. Component
changes reload the page automatically. A reload resets the simulated state.

Check the components without starting the server:

```console
pnpm exec tsc -p design-explorations/harness/tsconfig.json
pnpm --dir logbook --filter @agent-issues/site exec vitest run --config ../../../design-explorations/harness/vite.config.ts
```

`LightElement` returns `this` from `createRenderRoot()`. All application views use
real Lit templates in light DOM:

- Application navigation, workspace tabs, repository sidebar and header.
- Initiative selector, tracked records, usage meter, run header and controls.
- Initiative route, route sections, issue lists and cards, status badges.
- PRD context and PRD links.
- Terminal selection, terminal grid and terminal panels.
- Merge file list, requirements, checks and activity timeline.
- Planning launch, conversation, Plan entries, and Pioneer graph.
- Settings, Review checkpoint, Merge workspace, library-backed diffs, and dialogs.

Keyed lists retain issue and terminal nodes during partial updates. Components
receive typed view models. TypeScript controllers own the simulated state.
Native events connect the views to those controllers. xterm owns its unmanaged
terminal mounts and retains each terminal and input draft across navigation.
jsdiff computes the line differences. There are no iframes, injected scripts,
global-function replacements, mutation-based mounts, or HTML-string renderers.

## Files

- [index.html](index.html) is the only application entry page.
- [app.ts](app.ts) loads the [application.ts](application.ts) Lit application.
- [application-state.ts](application-state.ts) owns page state, events, and controller coordination.
- [app.css](app.css) contains the current C styles.
- [planning.ts](planning.ts), [simulation.ts](simulation.ts), [merge.ts](merge.ts),
  and [settings.ts](settings.ts) own the simulated workflows.
- [terminals.ts](terminals.ts) retains and updates xterm sessions.
- [components/](components/) contains the light-DOM Lit components.
- [vite.config.ts](vite.config.ts) configures Vite and Vitest.
- [prototype-api.ts](prototype-api.ts) provides guarded, read-only folder and
  Git-root inspection. It does not write files or run agents.

The old application-wide A/B layouts and design switcher are removed. The saved C reference remains
unchanged in the separate agent-issues-harness-prototype source worktree. This
folder contains the current prototype only.

## Project Controls

The Projects view is the project chooser. Open it from the labelled Projects button at the
top of the application rail or from the labelled Projects button at the top
of the sidebar. The current project name is below that button. Project rows
show the local directory, Agent Issues identity, tenant, and
work status. Search narrows the list. Selecting a row opens that project's
workspace and restores its initiative. Add project opens the existing folder
selection flow. Initiatives has its own application menu and list view at
`?page=initiatives`. The list contains only the current project's initiatives.
Selecting an initiative opens its workspace. The sidebar shows the current
initiative and its records. The Initiatives menu is the entry to the list.

Open `?page=repositories&project=none` to preview the state with no project
selected. Close project in the current-project summary opens the same state.
Projects and Global Settings remain available. Selecting a project restores
its workspace and initiative.

Each project row has a Settings button. Opening it selects that project and
opens `?page=project-settings`. The active project's button is highlighted,
and its summary has a labelled Project settings button. Settings is not in
the sidebar.

The root navigation has a separate Project entry for the open project's
information page. It opens the Project information tab directly. Projects
opens the project list; Project opens the current project's information.
One tab bar separates Project, Context, Wayfinder, Usage and limits,
Workers and approvals, and Providers and models. Global Settings uses the three
execution tabs. There are no layout variants or layout switcher. Project details
and context are held separately for each repository. Save project stores an in-memory
snapshot; a reload clears it. These values do not change repository files or the
Agent Issues database.

Agent Wayfinder controls simulate connection, graph refresh, and query operations.
They do not execute CLI commands or query a real graph. The graph database is
relative to the project directory. Changing that directory or database clears the
simulated graph state. Execution settings have their own tabs. Drafts remain
available when tabs change. Arrow keys, Home, and End move between settings tabs.

The initiative example contains 42 issues, a 30-issue main chain, and three later
parallel fork/join stages. Serial sections expand to show their issues. Final
approval stays separate from the chain.

Initiative, Review, and Merge remain visible as separate tabs. Review and Merge
show pending counts and empty states when no work is available. The initial
example has one completed worker checkpoint ready for Review and no Merge work.
Review approval adds that checkpoint to the Merge queue without running the
Merge agent. Merge approval, resolution approval, and passing checks remain
separate requirements. Paused work stays visible, but its actions are blocked.

The layout supports desktop and tablet screens, with a 768px minimum width.
Fonts and the pinned CDN libraries require internet access. State is held in
memory and resets on reload. The server is disabled in production mode.
