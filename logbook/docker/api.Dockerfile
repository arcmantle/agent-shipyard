FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS build

WORKDIR /workspace
RUN npm install --global pnpm@11.10.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/api-pg/package.json ./packages/api-pg/package.json
RUN pnpm --filter @agent-issues/api-pg... install --frozen-lockfile --ignore-scripts
COPY packages/core/src ./packages/core/src
COPY packages/core/tsconfig*.json ./packages/core/
COPY packages/api-pg/src ./packages/api-pg/src
COPY packages/api-pg/tsconfig*.json ./packages/api-pg/
RUN pnpm --filter @agent-issues/core build \
	&& pnpm --filter @agent-issues/api-pg build \
	&& pnpm --filter @agent-issues/api-pg deploy --prod --legacy /release

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS site

WORKDIR /workspace
RUN npm install --global pnpm@11.10.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/site/package.json ./packages/site/package.json
RUN pnpm --filter @agent-issues/site... install --frozen-lockfile --ignore-scripts
COPY packages/core/src ./packages/core/src
COPY packages/site/index.html packages/site/tsconfig.json packages/site/vite.production.config.ts ./packages/site/
COPY packages/site/src ./packages/site/src
RUN pnpm --filter @agent-issues/site exec vite build --config vite.production.config.ts
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/cli/scripts/build-plugin.mjs ./packages/site/build-plugin.mjs
COPY packages/cli/skills ./packages/cli/skills
COPY packages/cli/.github/agents ./packages/cli/.github/agents
COPY packages/cli/plugin/README.md ./packages/cli/plugin/README.md
# The script runs from the site package so it resolves the site's installed markdown parser.
RUN node packages/site/build-plugin.mjs --source-dir packages/cli --target-dir /plugin

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /release/ ./
COPY --from=site --chown=node:node /workspace/packages/site/dist/ ./public/
COPY --from=site --chown=node:node /plugin/instruction-defaults.json ./instruction-defaults.json
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
	CMD node --input-type=module -e "try { const response = await fetch('http://127.0.0.1:' + process.env.PORT + '/health/live'); process.exit(response.ok ? 0 : 1); } catch { process.exit(1); }"
CMD ["node", "dist/main.js"]