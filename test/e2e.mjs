// End-to-end check: the unmodified official LaunchDarkly Node SDK against a
// running Flagport (start it first with `npm run dev`).
import assert from 'node:assert/strict';
import { init } from '@launchdarkly/node-server-sdk';

const BASE = process.env.BASE ?? 'http://localhost:48788';
const ADMIN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';

async function admin(method, path, body, token = ADMIN) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
}

const step = (name) => console.log('ok  ' + name);

// Admin auth
assert.equal((await admin('GET', '/envs', null, 'wrong-token')).status, 401);
step('admin API rejects a wrong token');

// Environment + flag
const env = (await admin('POST', '/envs', { name: 'e2e ' + new Date().toISOString() })).body;
assert.match(env.sdkKey, /^sdk-[0-9a-f]{12}-[0-9a-f]{32}$/);
const flag = {
  on: true,
  variations: ['new', 'old'],
  fallthrough: { variation: 1 },
  offVariation: 1,
  rules: [
    {
      id: 'beta',
      variation: 0,
      clauses: [{ contextKind: 'user', attribute: 'email', op: 'endsWith', values: ['@beta.test'], negate: false }],
    },
  ],
};
assert.equal((await admin('PUT', `/envs/${env.id}/flags/checkout`, flag)).status, 200);
step('environment and flag created');

// SDK auth
const forged = env.sdkKey.slice(0, -4) + '0000';
assert.equal((await fetch(BASE + '/all', { headers: { authorization: forged } })).status, 401);
assert.equal((await fetch(BASE + '/sdk/latest-all', { headers: { authorization: forged } })).status, 401);
step('SDK endpoints reject a forged key');

const polled = await (await fetch(BASE + '/sdk/latest-all', { headers: { authorization: env.sdkKey } })).json();
assert.equal(polled.flags.checkout.version, 1);
step('polling endpoint returns the flag');

// Real SDK
const quiet = { debug() {}, info() {}, warn: console.warn, error: console.error };
const client = init(env.sdkKey, { streamUri: BASE, baseUri: BASE, eventsUri: BASE, logger: quiet });
await client.waitForInitialization({ timeout: 10 });
step('SDK initialised over streaming');

const beta = { kind: 'user', key: 'u1', email: 'asha@beta.test' };
const other = { kind: 'user', key: 'u2', email: 'ravi@example.com' };
assert.equal(await client.variation('checkout', beta, 'default'), 'new');
assert.equal(await client.variation('checkout', other, 'default'), 'old');
const detail = await client.variationDetail('checkout', beta, 'default');
assert.equal(detail.reason.kind, 'RULE_MATCH');
step('targeting rule evaluated correctly');

const nextUpdate = (key) => new Promise((resolve) => client.once('update:' + key, resolve));

let updated = nextUpdate('checkout');
await admin('PUT', `/envs/${env.id}/flags/checkout`, { ...flag, on: false });
await updated;
assert.equal(await client.variation('checkout', beta, 'default'), 'old');
step('live toggle reached the SDK');

updated = nextUpdate('checkout');
assert.equal((await admin('DELETE', `/envs/${env.id}/flags/checkout`)).status, 204);
await updated;
assert.equal(await client.variation('checkout', beta, 'default'), 'default');
step('delete reached the SDK');

updated = nextUpdate('checkout');
await admin('PUT', `/envs/${env.id}/flags/checkout`, flag);
await updated;
assert.equal(await client.variation('checkout', beta, 'default'), 'new');
step('re-created flag reached the SDK');

const overviewLive = (await admin('GET', `/envs/${env.id}`)).body;
assert.equal(overviewLive.connections.server, 1);
step('dashboard sees 1 connected SDK');

await client.flush();
client.close();
const overview = (await admin('GET', `/envs/${env.id}`)).body;
assert.ok(overview.evals.checkout['"new"'] >= 2, 'evaluation counts recorded');
step('evaluation counts recorded: ' + JSON.stringify(overview.evals.checkout));

console.log('\nAll end-to-end checks passed.');
