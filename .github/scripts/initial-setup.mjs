import { createHash } from 'node:crypto';

const fields = {
  bootstrap: 'infra_sha,request_run_attempt,request_run_id,target_sha256',
  setup: 'counts,created_at,has_changes,infra_sha,plan_run_attempt,plan_run_id,plan_sha256,source_sha,stage',
  recovery: 'created_at,infra_sha,recovery_run_attempt,recovery_run_id,recovery_sha256,request_run_attempt,request_run_id,source_sha',
  retirement: 'created_at,infra_sha,request_run_attempt,request_run_id,setup_run_attempt,setup_run_id,target_sha256',
};

const operations = { bootstrap: 'request-bootstrap', setup: 'plan', recovery: 'request-recovery', retirement: 'request-retirement' };
const details = {
  bootstrap: 'Approval permits administrator sign-in in private Actions and creation of the temporary setup identity, its exact setup-workflow trust, and subscription Owner grant. Existing installations are rejected before writes. The request is consumed once. Complete sign-in directly in the private run; do not send codes through chat.',
  setup: 'Approval permits the exact saved plan, required provider registration, and runner-only state access. State setup retains recovery state and verifies migration. Automation setup creates the Plan and Apply identities, exact workflow trust, subscription Reader for Plan, subscription Owner for Apply, and state access. Owner can manage resources, roles, providers, and identity trust, including its own access. Azure does not enforce GitHub approval. Review every role scope privately. Temporary setup access must then be retired. No application resources are created.',
  recovery: 'Approval permits runner-only state access and conditional creation of missing bootstrap state. Existing state is not overwritten. Recovery verifies state and a no-change plan without Terraform Apply. The retained recovery artifact is preserved.',
  retirement: 'Approval removes only the exact temporary setup federation and subscription Owner assignment. Federation removal is verified before Owner removal. Routine identities, resources, and state are preserved. A partial failure requires separately approved recovery, not replay.',
};

export async function reviewSetup(purpose, encoded, github, now = Date.now()) {
  if (!Object.hasOwn(fields, purpose) || !encoded || encoded.length > 8192) throw new Error('Invalid initial setup request.');
  const bytes = Buffer.from(encoded, 'base64');
  const review = JSON.parse(bytes);
  if (Object.keys(review).sort().join(',') !== fields[purpose]) throw new Error('Invalid initial setup fields.');
  for (const [key, value] of Object.entries(review)) {
    if ((key.endsWith('_id') || key.endsWith('_attempt')) && !/^[1-9][0-9]*$/.test(value)) throw new Error('Invalid setup identifier.');
    if (key.endsWith('_sha256') && !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid setup digest.');
    if (['infra_sha', 'source_sha'].includes(key) && !/^[a-f0-9]{40}$/.test(value)) throw new Error('Invalid setup source.');
  }
  if (purpose !== 'bootstrap') {
    const age = now - Date.parse(review.created_at);
    if (!Number.isFinite(age) || age < 0 || age > 86400000) throw new Error('The setup request has expired.');
  }
  if (purpose === 'setup' && (!['state', 'automation'].includes(review.stage) || review.has_changes !== true
    || Object.keys(review.counts ?? {}).sort().join(',') !== 'create,delete,update'
    || !Object.values(review.counts).every(value => Number.isSafeInteger(value) && value >= 0)
    || review.counts.delete !== 0)) throw new Error('Invalid or destructive setup plan.');
  const runId = purpose === 'setup' ? review.plan_run_id : review.request_run_id;
  const attempt = purpose === 'setup' ? review.plan_run_attempt : review.request_run_attempt;
  const stage = purpose === 'retirement' ? 'automation' : purpose === 'setup' ? review.stage : 'state';
  const { data: run } = await github.rest.actions.getWorkflowRun({ owner: 'arcmantle', repo: 'agent-shipyard-infra', run_id: runId });
  const age = now - Date.parse(run.created_at);
  if (run.repository?.full_name !== 'arcmantle/agent-shipyard-infra' || run.head_branch !== 'main'
    || run.path !== '.github/workflows/setup.yml' || run.event !== 'workflow_dispatch'
    || run.display_title !== `Setup Azure ${stage} (${operations[purpose]})`
    || run.actor?.login?.toLowerCase() !== 'roenlie' || run.triggering_actor?.login?.toLowerCase() !== 'roenlie'
    || run.head_sha !== review.infra_sha || String(run.id) !== runId || String(run.run_attempt) !== attempt
    || ['failure', 'cancelled', 'timed_out'].includes(run.conclusion)
    || (purpose === 'setup' && run.conclusion !== 'success')
    || (purpose === 'bootstrap' && (!Number.isFinite(age) || age < 0 || age > 3600000))) {
    throw new Error('The private initial setup run does not match.');
  }
  return { digest: createHash('sha256').update(bytes).digest('hex'), runId,
    heading: `Initial Setup: ${purpose}${purpose === 'setup' ? ` (${review.stage})` : ''}`, details: details[purpose]
      + (purpose === 'setup' ? ` Create: ${review.counts.create}. Update: ${review.counts.update}. Delete: 0.` : '') };
}

export function setupCallback(purpose, encoded, digest) {
  if (!Object.hasOwn(fields, purpose)
    || createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex') !== digest) {
    throw new Error('The approved initial setup request changed.');
  }
  const review = JSON.parse(Buffer.from(encoded, 'base64'));
  const operation = { bootstrap: 'bootstrap', setup: 'apply', recovery: 'recover', retirement: 'retire' }[purpose];
  return { operation, stage: purpose === 'retirement' ? 'automation' : purpose === 'setup' ? review.stage : 'state',
    ...(purpose === 'bootstrap' ? { bootstrap_request: encoded } : { review: encoded }) };
}