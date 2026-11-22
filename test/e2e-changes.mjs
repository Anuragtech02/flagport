// End-to-end check of change requests, approvals and scheduled changes.
// Needs a running Flagport with SIGNUPS=open (start it with `npm run dev`).
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://localhost:48788';
const local = /\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE + '/');
const visitor = local ? { 'cf-connecting-ip': `10.${Date.now() % 250}.${Math.floor(Math.random() * 250)}.3` } : {};

async function call(method, path, key, body) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), 'content-type': 'application/json', ...visitor },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
}
const step = (name) => console.log('ok  ' + name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const owner = (await call('POST', '/workspaces')).body.key;
const member = async (name, role) => (await call('POST', '/members', owner, { name, role })).body.key;
const [asha, ravi, dev, viewer] = [await member('Asha', 'writer'), await member('Ravi', 'writer'), await member('Dev', 'admin'), await member('Viewer', 'reader')];
const env = (await call('POST', '/envs', owner, { name: 'Production' })).body;
const flags = `/envs/${env.id}/flags`;
const changes = `/envs/${env.id}/changes`;
const flag = { name: 'Checkout', on: false, variations: [true, false], fallthrough: { variation: 0 }, offVariation: 1, tags: [] };
await call('PUT', `${flags}/a`, owner, flag);
const current = async () => (await call('GET', `/envs/${env.id}`, owner)).body.flags.a;
const propose = (key, change, extra = {}) => call('POST', changes, key, { flag: 'a', title: 'Change checkout', ...extra, proposed: change });

// ---- Asking for a review when it is not required
assert.equal((await propose(asha, { ...flag, on: true })).status, 400);
assert.equal((await propose(asha, flag, { review: true })).status, 400);
assert.equal((await propose(viewer, { ...flag, on: true }, { review: true })).status, 403);
let change = (await propose(asha, { ...flag, on: true }, { review: true, title: 'Turn on checkout' })).body;
assert.equal(change.status, 'pending');
assert.equal((await current()).on, false);
step('a member can ask for a review; nothing changes until it is approved');

assert.equal((await call('POST', `${changes}/${change.id}/review`, asha, { decision: 'approve' })).status, 403);
assert.equal((await call('POST', `${changes}/${change.id}/review`, viewer, { decision: 'approve' })).status, 403);
change = (await call('POST', `${changes}/${change.id}/review`, ravi, { decision: 'approve', comment: 'Looks right' })).body;
assert.equal(change.status, 'applied');
assert.equal((await current()).on, true);
assert.equal((await call('POST', `${changes}/${change.id}/review`, ravi, { decision: 'approve' })).status, 409);
step('the author cannot approve their own change; another member can, and it takes effect');

let audit = (await call('GET', `/audit?env=${env.id}`, owner)).body;
const applied = audit.find((e) => e.kind === 'flags' && e.summary.includes(`change #${change.id}`));
assert.equal(applied.summary, `Turned on (change #${change.id}, approved by Ravi)`);
assert.equal(applied.actor.name, 'Ravi');
assert.ok(audit.some((e) => e.kind === 'change' && e.action === 'requested' && e.actor.name === 'Asha'));
assert.ok(audit.some((e) => e.kind === 'change' && e.action === 'approved' && e.comment === 'Looks right'));
step('the audit log shows who asked, who approved, and the change itself');

change = (await propose(asha, { ...(await current()), on: false }, { review: true })).body;
change = (await call('POST', `${changes}/${change.id}/review`, ravi, { decision: 'reject', comment: 'Not during the sale' })).body;
assert.equal(change.status, 'rejected');
assert.equal(change.reviews[0].comment, 'Not during the sale');
assert.equal((await current()).on, true);
change = (await propose(asha, { ...(await current()), on: false }, { review: true })).body;
assert.equal((await call('POST', `${changes}/${change.id}/cancel`, ravi)).status, 403);
assert.equal((await call('POST', `${changes}/${change.id}/cancel`, asha)).body.status, 'cancelled');
step('a change can be rejected, or cancelled by its author');

// ---- Requiring approval
assert.equal((await call('PATCH', `/envs/${env.id}/settings`, asha, { approvals: true })).status, 403);
assert.equal((await call('PATCH', `/envs/${env.id}/settings`, dev, { approvals: true })).body.approvals, true);
assert.equal((await call('GET', `/envs/${env.id}`, viewer)).body.settings.approvals, true);
const direct = await call('PUT', `${flags}/a`, asha, { ...(await current()), on: false });
assert.equal(direct.status, 409);
assert.equal(direct.body.approvalRequired, true);
assert.equal((await call('DELETE', `${flags}/a`, asha)).status, 409);
assert.equal((await call('PUT', `${flags}/a?bypass=true`, asha, { ...(await current()), on: false })).status, 409);
assert.equal((await call('PUT', `${flags}/a`, dev, { ...(await current()), on: false })).status, 409);
assert.equal((await current()).on, true);
assert.equal((await call('PUT', `${flags}/brand-new`, asha, flag)).status, 200);
step('where approval is required, direct saves and deletes are refused; new flags are not');

assert.equal((await call('PUT', `${flags}/a?bypass=true`, dev, { ...(await current()), tags: ['checkout'] })).status, 200);
audit = (await call('GET', `/audit?env=${env.id}&key=a`, owner)).body;
assert.match(audit[0].summary, /without approval/);
step('an admin can skip approval, and the audit log says so');

// ---- A change still applies after an unrelated edit, and fails on a conflicting one
change = (await propose(asha, { ...(await current()), on: false }, { title: 'Turn off' })).body;
assert.equal(change.status, 'pending');
await call('PUT', `${flags}/a?bypass=true`, dev, { ...(await current()), tags: ['checkout', 'q4'] });
change = (await call('POST', `${changes}/${change.id}/review`, ravi, { decision: 'approve' })).body;
assert.equal(change.status, 'applied');
assert.equal((await current()).on, false);
assert.deepEqual((await current()).tags, ['checkout', 'q4']);
step('an approved change keeps an unrelated edit made in the meantime');

change = (await propose(asha, { ...(await current()), fallthrough: { variation: 1 } }, { title: 'Default to false' })).body;
await call('PUT', `${flags}/a?bypass=true`, dev, { ...(await current()), fallthrough: { rollout: { variations: [{ variation: 0, weight: 50000 }, { variation: 1, weight: 50000 }] } } });
change = (await call('POST', `${changes}/${change.id}/review`, ravi, { decision: 'approve' })).body;
assert.equal(change.status, 'failed');
assert.match(change.failure, /fallthrough/);
assert.ok((await current()).fallthrough.rollout);
step('a change that conflicts with a newer edit fails instead of overwriting it');

// ---- Scheduling
assert.equal((await propose(asha, { ...(await current()), on: true }, { applyAt: new Date(Date.now() - 3_600_000).toISOString() })).status, 400);
const soon = new Date(Date.now() + 3000).toISOString();
change = (await propose(asha, { ...(await current()), on: true }, { title: 'Launch', applyAt: soon })).body;
change = (await call('POST', `${changes}/${change.id}/review`, ravi, { decision: 'approve' })).body;
assert.equal(change.status, 'approved');
assert.equal((await current()).on, false);
assert.equal((await call('GET', `/envs/${env.id}`, owner)).body.openChanges, 1);
for (let i = 0; i < 20 && !(await current()).on; i++) await sleep(500);
assert.equal((await current()).on, true);
const list = (await call('GET', changes, viewer)).body;
assert.equal(list.find((c) => c.id === change.id).status, 'applied');
assert.equal(list.find((c) => c.id === change.id).closedBy, 'schedule');
audit = (await call('GET', `/audit?env=${env.id}&key=a&kind=flags`, owner)).body;
assert.match(audit[0].summary, /on schedule, approved by Ravi/);
assert.equal(audit[0].actor.name, 'Asha');
step('an approved scheduled change waits for its time, then applies itself');

assert.equal((await call('PATCH', `/envs/${env.id}/settings`, dev, { approvals: false })).body.approvals, false);
change = (await propose(asha, { ...(await current()), on: false }, { title: 'Wind down', applyAt: new Date(Date.now() + 86_400_000).toISOString() })).body;
assert.equal(change.status, 'approved');
assert.equal(change.needsApproval, false);
assert.equal((await call('POST', `${changes}/${change.id}/apply`, viewer)).status, 403);
change = (await call('POST', `${changes}/${change.id}/apply`, ravi)).body;
assert.equal(change.status, 'applied');
assert.equal((await current()).on, false);
step('without required approval a change can be scheduled directly, and applied early');

for (const e of (await call('GET', '/envs', owner)).body) await call('DELETE', `/envs/${e.id}`, owner);
console.log('\nAll change checks passed.');
