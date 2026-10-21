import { execFileSync } from 'node:child_process';

const packages = [
  '@agent-issues/core',
  '@agent-issues/api-local',
  '@agent-issues/api-pg',
  '@agent-issues/site',
  '@agent-issues/kanban',
  'agent-issues',
  'agent-issues-mcp',
  'agent-issues-mcp-provider',
];

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

for (const packageName of packages) {
  const buildScript = packageName === 'agent-issues' && process.argv.includes('--development') ? 'build:dev' : 'build';
  execFileSync(pnpm, ['--filter', packageName, buildScript], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: process.platform === 'win32',
  });
}