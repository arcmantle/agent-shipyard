import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewSetup, setupCallback } from './initial-setup.mjs';

test('initial setup reviews and callbacks bind each operation to its exact private request', async () => {
  const now = Date.now();
  const common = { infra_sha: 'a'.repeat(40), request_run_id: '1', request_run_attempt: '1' };
  const dated = { ...common, created_at: new Date(now).toISOString() };
  const requests = {
    bootstrap: { ...common, target_sha256: 'b'.repeat(64) },
    setup: { infra_sha: common.infra_sha, source_sha: 'c'.repeat(40), plan_run_id: '1', plan_run_attempt: '1',
      plan_sha256: 'b'.repeat(64), stage: 'automation', has_changes: true, counts: { create: 16, update: 0, delete: 0 }, created_at: dated.created_at },
    recovery: { ...dated, source_sha: 'c'.repeat(40), recovery_run_id: '2', recovery_run_attempt: '1', recovery_sha256: 'b'.repeat(64) },
    retirement: { ...dated, setup_run_id: '2', setup_run_attempt: '1', target_sha256: 'b'.repeat(64) },
  };
  for (const [purpose, request] of [...Object.entries(requests), ['setup', { ...requests.setup, stage: 'state' }]]) {
    const stage = purpose === 'setup' ? request.stage : purpose === 'retirement' ? 'automation' : 'state';
    const operation = { bootstrap: 'request-bootstrap', setup: 'plan', recovery: 'request-recovery', retirement: 'request-retirement' }[purpose];
    const run = { id: 1, run_attempt: 1, repository: { full_name: 'arcmantle/agent-shipyard-infra' }, head_branch: 'main',
      path: '.github/workflows/setup.yml', event: 'workflow_dispatch', display_title: `Setup Azure ${stage} (${operation})`,
      actor: { login: 'RoenLie' }, triggering_actor: { login: 'RoenLie' }, head_sha: common.infra_sha,
      created_at: dated.created_at, conclusion: 'success' };
    const github = override => ({ rest: { actions: { getWorkflowRun: async () => ({ data: { ...run, ...override } }) } } });
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
    const encoded = encode(request);
    const result = await reviewSetup(purpose, encoded, github(), now);
    const callback = setupCallback(purpose, encoded, result.digest);
    assert.equal(callback.operation, { bootstrap: 'bootstrap', setup: 'apply', recovery: 'recover', retirement: 'retire' }[purpose]);
    assert.equal(callback.stage, stage);
    assert.equal(callback.review ?? callback.bootstrap_request, encoded);
    for (const override of [{ path: 'other.yml' }, { display_title: 'Other setup operation' },
      { head_sha: 'd'.repeat(40) }, { actor: { login: 'other' } }, { triggering_actor: { login: 'other' } },
      { run_attempt: 2 }, { conclusion: 'failure' }]) {
      await assert.rejects(reviewSetup(purpose, encoded, github(override), now));
    }
    await assert.rejects(reviewSetup(purpose, encode({ ...request, private_value: 'not public' }), github(), now));
    await assert.rejects(reviewSetup(purpose, encoded, github(), now + 86400001));
    await assert.rejects(reviewSetup(purpose, encoded, github(), now - 1));
    assert.throws(() => setupCallback(purpose, encode({ ...request, infra_sha: 'd'.repeat(40) }), result.digest));
    if (purpose === 'setup') {
      for (const override of [{ stage: 'logbook' }, { has_changes: false }, { counts: { create: 0, update: 0, delete: 1 } }]) {
        await assert.rejects(reviewSetup(purpose, encode({ ...request, ...override }), github(), now));
      }
    }
  }
  await assert.rejects(reviewSetup('unknown', Buffer.from('{}').toString('base64'), {}, now));
});