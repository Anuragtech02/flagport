// End-to-end check of webhooks and Slack notifications.
// Needs a running Flagport with SIGNUPS=open (start it with `npm run dev`).
// Against a local server it starts a receiver on this machine and checks what arrives.
// Against a deployed server nothing can post back here, so it checks the rest with an address that cannot be reached.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

const BASE = process.env.BASE ?? 'http://localhost:48788';
const local = /\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE + '/');
const visitor = local ? { 'cf-connecting-ip': `10.${Date.now() % 250}.${Math.floor(Math.random() * 250)}.4` } : {};

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
async function until(check, what, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const found = await check();
    if (found) return found;
  }
  assert.fail('Timed out waiting for ' + what);
}

// ---- The receiver: remembers every request, and can be told to fail the next few.
const received = [];
const failNext = {};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (failNext[req.url] > 0) {
      failNext[req.url]--;
      res.writeHead(500).end();
      return;
    }
    received.push({ path: req.url, headers: req.headers, body, json: JSON.parse(body) });
    res.writeHead(200).end('ok');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const target = (path) => (local ? `http://127.0.0.1:${server.address().port}${path}` : `https://flagport.invalid${path}`);
const arrived = (path, event) => until(() => received.find((r) => r.path === path && (r.json.event === event || r.headers['x-flagport-event'] === event)), `${event} at ${path}`);
const verified = (request, secret) => {
  const expected = crypto.createHmac('sha256', secret).update(`${request.headers['x-flagport-timestamp']}.${request.body}`).digest('hex');
  return request.headers['x-flagport-signature'] === `sha256=${expected}`;
};

const owner = (await call('POST', '/workspaces')).body.key;
const member = async (name, role) => (await call('POST', '/members', owner, { name, role })).body.key;
const [asha, ravi, viewer] = [await member('Asha', 'writer'), await member('Ravi', 'writer'), await member('Viewer', 'reader')];
const prod = (await call('POST', '/envs', owner, { name: 'Production' })).body;
const staging = (await call('POST', '/envs', owner, { name: 'Staging' })).body;
const flag = { name: 'Checkout', on: false, variations: [true, false], fallthrough: { variation: 0 }, offVariation: 1, tags: [] };

// ---- Who may manage webhooks, and where they may point
assert.equal((await call('GET', '/webhooks', viewer)).status, 403);
assert.equal((await call('POST', '/webhooks', asha, { name: 'Mine', url: target('/x') })).status, 403);
for (const url of ['http://example.com/hook', 'https://192.168.1.5/hook', 'https://10.0.0.8/hook', 'ftp://example.com/hook', 'https://printer.local/hook', 'https://[::1]/hook', 'not a url']) {
  assert.equal((await call('POST', '/webhooks', owner, { name: 'Bad', url })).status, 400, url);
}
assert.equal((await call('POST', '/webhooks', owner, { name: 'Bad', url: target('/x'), kinds: ['everything'] })).status, 400);
assert.equal((await call('POST', '/webhooks', owner, { name: 'Bad', url: target('/x'), envs: ['not-mine'] })).status, 400);
step('only admins manage webhooks, and only public https addresses are accepted');

const created = (await call('POST', '/webhooks', owner, { name: 'Everything', url: target('/all?token=keep-this-private') })).body;
const all = created.webhook;
assert.match(created.secret, /^whsec_[0-9a-f]{48}$/);
assert.equal(all.format, 'json');
let listed = (await call('GET', '/webhooks', owner)).body;
assert.equal(listed.length, 1);
assert.ok(!JSON.stringify(listed).includes('keep-this-private') && !JSON.stringify(listed).includes(created.secret));
step('a webhook gets a signing secret once; the list shows neither it nor the full address');

if (local) {
  // ---- What is sent
  await call('PUT', `/envs/${prod.id}/flags/checkout`, asha, flag);
  let hit = await arrived('/all?token=keep-this-private', 'flag.created');
  assert.equal(hit.json.version, 1);
  assert.equal(hit.json.actor.name, 'Asha');
  assert.deepEqual(hit.json.environment, { id: prod.id, name: 'Production' });
  assert.equal(hit.json.key, 'checkout');
  assert.equal(hit.json.after.on, false);
  assert.match(hit.json.url, new RegExp(`/app/#/e/${prod.id}/flags/checkout$`));
  assert.ok(verified(hit, created.secret));
  assert.ok(!verified(hit, 'whsec_wrong'));
  step('a change arrives as JSON with who, where and what, signed with the secret');

  // ---- Limiting by kind and by environment, and the Slack format
  const slack = (await call('POST', '/webhooks', owner, { name: 'Approvals', url: target('/slack'), format: 'slack', kinds: ['change'] })).body.webhook;
  const stagingOnly = (await call('POST', '/webhooks', owner, { name: 'Staging', url: target('/staging'), envs: [staging.id] })).body.webhook;
  await call('PUT', `/envs/${prod.id}/flags/checkout?comment=Rule+tidy-up`, asha, { ...flag, tags: ['checkout'] });
  await call('PUT', `/envs/${staging.id}/flags/search`, asha, flag);
  const change = (await call('POST', `/envs/${prod.id}/changes`, asha, { flag: 'checkout', title: 'Turn on <checkout>', review: true, proposed: { ...flag, tags: ['checkout'], on: true } })).body;
  hit = await arrived('/slack', 'change.requested');
  assert.equal(hit.json.text, 'Flag `checkout` in Production: Requested approval for change #1: Turn on <checkout>, by Asha');
  assert.match(hit.json.blocks[0].text.text, /Turn on &lt;checkout&gt;\*\nFlag `checkout` in Production$/);
  assert.match(hit.json.blocks[1].elements[0].text, new RegExp(`^By Asha .*<.*/app/#/e/${prod.id}/changes\\|Open in Flagport>$`));
  await call('POST', `/envs/${prod.id}/changes/${change.id}/review`, ravi, { decision: 'approve', comment: 'Go ahead' });
  hit = await arrived('/slack', 'change.approved');
  assert.match(hit.json.blocks[0].text.text, /> Go ahead/);
  await arrived('/staging', 'flag.created');
  await arrived('/all?token=keep-this-private', 'change.approved');
  await sleep(300);
  assert.deepEqual([...new Set(received.filter((r) => r.path === '/slack').map((r) => r.headers['x-flagport-event']))], ['change.requested', 'change.approved']);
  assert.ok(received.filter((r) => r.path === '/staging').every((r) => r.json.environment?.id === staging.id));
  const order = received.filter((r) => r.path === '/all?token=keep-this-private').map((r) => r.json.id);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  step('a webhook can be limited to kinds and environments; Slack gets a readable message; order is kept');

  // ---- Retrying, and the record of deliveries
  failNext['/staging'] = 1;
  await call('PUT', `/envs/${staging.id}/flags/search`, asha, { ...flag, on: true });
  await until(async () => (await call('GET', `/webhooks/${stagingOnly.id}/deliveries`, owner)).body.find((d) => d.event === 'flag.updated' && d.status === 'pending' && d.attempts === 1 && d.code === 500 && d.nextAt), 'a retry to be scheduled');
  hit = await arrived('/staging', 'flag.updated');
  const record = await until(async () => (await call('GET', `/webhooks/${stagingOnly.id}/deliveries`, owner)).body.find((d) => d.event === 'flag.updated' && d.status === 'delivered'), 'the retried delivery to be recorded');
  assert.equal(record.attempts, 2);
  assert.equal(record.code, 200);
  step('a delivery that fails is tried again, and the record shows both attempts');

  // ---- Test messages, a new secret, turning off
  let ping = (await call('POST', `/webhooks/${all.id}/test`, owner)).body;
  assert.equal(ping.status, 'delivered');
  assert.equal((await arrived('/all?token=keep-this-private', 'ping')).json.event, 'ping');
  failNext['/all?token=keep-this-private'] = 1;
  ping = (await call('POST', `/webhooks/${all.id}/test`, owner)).body;
  assert.equal(ping.status, 'failed');
  assert.equal(ping.error, 'The endpoint answered 500');
  assert.equal(ping.attempts, 1);
  const rotated = (await call('POST', `/webhooks/${all.id}/secret`, owner)).body.secret;
  assert.notEqual(rotated, created.secret);
  await call('PUT', `/envs/${prod.id}/segments/beta`, asha, { included: ['u1'], excluded: [], rules: [] });
  hit = await arrived('/all?token=keep-this-private', 'segment.created');
  assert.ok(verified(hit, rotated) && !verified(hit, created.secret));
  step('a test message reports how it went, and a replaced secret signs what follows');

  assert.equal((await call('PATCH', `/webhooks/${slack.id}`, owner, { enabled: false })).body.enabled, false);
  const before = received.filter((r) => r.path === '/slack').length;
  await call('POST', `/envs/${prod.id}/changes`, asha, { flag: 'checkout', title: 'Later', review: true, proposed: { ...flag, tags: ['later'], on: true } });
  await arrived('/all?token=keep-this-private', 'change.requested');
  await sleep(500);
  assert.equal(received.filter((r) => r.path === '/slack').length, before);
  step('a webhook that is turned off receives nothing');
} else {
  // ---- Deployed: an address that cannot be reached still exercises sending, retrying and the record.
  const ping = (await call('POST', `/webhooks/${all.id}/test`, owner)).body;
  assert.equal(ping.status, 'failed');
  assert.equal(ping.event, 'ping');
  assert.ok(ping.error);
  await call('PUT', `/envs/${prod.id}/flags/checkout`, asha, flag);
  const waiting = await until(async () => (await call('GET', `/webhooks/${all.id}/deliveries`, owner)).body.find((d) => d.event === 'flag.created' && d.attempts >= 1 && d.nextAt), 'a retry to be scheduled', 20_000);
  assert.equal(waiting.status, 'pending');
  step('sending to an unreachable address fails, is recorded, and is scheduled for another try');
  assert.equal((await call('PATCH', `/webhooks/${all.id}`, owner, { enabled: false })).body.enabled, false);
  const stopped = (await call('GET', `/webhooks/${all.id}/deliveries`, owner)).body.find((d) => d.event === 'flag.created');
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.nextAt, null);
  step('turning a webhook off stops what was waiting to be retried');
}

// ---- The audit log, other workspaces, removal
const audit = (await call('GET', '/audit?kind=webhook', owner)).body;
assert.ok(audit.some((e) => e.action === 'created' && e.summary === 'Added the webhook Everything' && e.after.url === all.urlHint));
assert.ok(!JSON.stringify(audit).includes('keep-this-private'));
const stranger = (await call('POST', '/workspaces')).body.key;
assert.deepEqual((await call('GET', '/webhooks', stranger)).body, []);
for (const [method, path] of [['PATCH', ''], ['DELETE', ''], ['GET', '/deliveries'], ['POST', '/test'], ['POST', '/secret']]) {
  assert.equal((await call(method, `/webhooks/${all.id}${path}`, stranger, method === 'PATCH' ? { name: 'Taken' } : undefined)).status, 404, `${method} ${path}`);
}
step('webhook changes are in the audit log without the address, and another workspace cannot reach them');

assert.equal((await call('DELETE', `/webhooks/${all.id}`, owner)).status, 204);
listed = (await call('GET', '/webhooks', owner)).body;
assert.ok(!listed.some((w) => w.id === all.id));
if (local) {
  const count = received.filter((r) => r.path === '/all?token=keep-this-private').length;
  await call('PUT', `/envs/${prod.id}/flags/after-removal`, asha, flag);
  await sleep(700);
  assert.equal(received.filter((r) => r.path === '/all?token=keep-this-private').length, count);
}
step('a removed webhook is gone and receives nothing more');

for (const w of (await call('GET', '/webhooks', owner)).body) await call('DELETE', `/webhooks/${w.id}`, owner);
for (const e of (await call('GET', '/envs', owner)).body) await call('DELETE', `/envs/${e.id}`, owner);
server.close();
console.log('\nAll webhook checks passed.');
