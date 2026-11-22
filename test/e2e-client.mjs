// End-to-end check of browser and mobile SDK support against a running
// Flagport (start it first with `npm run dev`).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { init } from '@launchdarkly/node-server-sdk';

const require = createRequire(import.meta.url);
const NodeClient = require('launchdarkly-node-client-sdk');

const BASE = process.env.BASE ?? 'http://localhost:48788';
const ADMIN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const quiet = { debug() {}, info() {}, warn() {}, error: console.error };
const step = (name) => console.log('ok  ' + name);

async function admin(method, path, body) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { authorization: 'Bearer ' + ADMIN, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(res.ok, `${method} ${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

const b64 = (context) => Buffer.from(JSON.stringify(context)).toString('base64url');
const everywhere = { usingEnvironmentId: true, usingMobileKey: true };

// ---- Setup -----------------------------------------------------------------
const created = await admin('POST', '/envs', { name: 'client e2e ' + new Date().toISOString() });
const put = (key, flag) => admin('PUT', `/envs/${created.id}/flags/${key}`, flag);
const banner = {
  on: true,
  variations: ['new', 'old'],
  fallthrough: { variation: 1 },
  offVariation: 1,
  clientSideAvailability: everywhere,
  rules: [{ id: 'beta', variation: 0, clauses: [{ contextKind: 'user', attribute: 'email', op: 'endsWith', values: ['@beta.test'], negate: false }] }],
};
await put('banner', banner);
await put('server-secret', { on: true, variations: ['s3cret', 'x'], fallthrough: { variation: 0 }, clientSideAvailability: { usingEnvironmentId: false, usingMobileKey: false } });
await put('mobile-only', { on: true, variations: [true, false], fallthrough: { variation: 0 }, clientSideAvailability: { usingEnvironmentId: false, usingMobileKey: true } });
await put('half', {
  on: true,
  variations: ['a', 'b'],
  clientSideAvailability: everywhere,
  fallthrough: { rollout: { contextKind: 'user', variations: [{ variation: 0, weight: 50000 }, { variation: 1, weight: 50000 }] } },
});
const env = await admin('GET', `/envs/${created.id}`);
assert.equal(env.clientSideId, created.id);
assert.match(env.mobileKey, /^mob-[0-9a-f]{12}-[0-9a-f]{32}$/);
const id = env.clientSideId;
step('environment has a client-side ID and a mobile key');

const beta = { kind: 'user', key: 'u1', email: 'asha@beta.test' };
const other = { kind: 'user', key: 'u2', email: 'ravi@example.com' };

// ---- Browser endpoints (raw) -------------------------------------------------
let res = await fetch(`${BASE}/sdk/evalx/${id}/contexts/${b64(beta)}`);
assert.equal(res.status, 200);
assert.equal(res.headers.get('access-control-allow-origin'), '*');
let flags = await res.json();
assert.equal(flags.banner.value, 'new');
assert.equal(flags.banner.variation, 0);
assert.equal(typeof flags.banner.version, 'number');
assert.equal(flags.banner.reason, undefined);
step('browser polling endpoint evaluates for the context');

assert.deepEqual(Object.keys(flags).sort(), ['banner', 'half']);
step('browser SDKs cannot see server-only or mobile-only flags');

flags = await (await fetch(`${BASE}/sdk/evalx/${id}/contexts/${b64(beta)}?withReasons=true`)).json();
assert.equal(flags.banner.reason.kind, 'RULE_MATCH');
res = await fetch(`${BASE}/sdk/evalx/${id}/context`, { method: 'REPORT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(other) });
assert.equal((await res.json()).banner.value, 'old');
flags = await (await fetch(`${BASE}/sdk/evalx/${id}/contexts/${b64({ key: 'legacy', email: 'x@beta.test' })}`)).json();
assert.equal(flags.banner.value, 'new');
step('reasons, REPORT and legacy user objects work');

assert.equal((await fetch(`${BASE}/sdk/evalx/${id}/contexts/not-base64-json`)).status, 400);
assert.equal((await fetch(`${BASE}/sdk/evalx/${id}/contexts/${b64({ kind: 'user' })}`)).status, 400);
assert.equal((await fetch(`${BASE}/sdk/evalx/000000000000/contexts/${b64(beta)}`)).status, 401);
step('bad contexts get 400, unknown environments get 401');

res = await fetch(`${BASE}/events/bulk/${id}`, { method: 'OPTIONS', headers: { origin: 'https://shop.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-launchdarkly-event-schema' } });
assert.equal(res.status, 204);
assert.equal(res.headers.get('access-control-allow-origin'), '*');
assert.match(res.headers.get('access-control-allow-headers'), /x-launchdarkly-event-schema/);
assert.deepEqual(await (await fetch(`${BASE}/sdk/goals/${id}`)).json(), []);
step('CORS preflight and goals endpoint respond');

// ---- Mobile endpoints (raw) --------------------------------------------------
const mobile = { authorization: env.mobileKey };
flags = await (await fetch(`${BASE}/msdk/evalx/contexts/${b64(beta)}`, { headers: mobile })).json();
assert.deepEqual(Object.keys(flags).sort(), ['banner', 'half', 'mobile-only']);
assert.equal(flags['mobile-only'].value, true);
res = await fetch(`${BASE}/msdk/evalx/context`, { method: 'REPORT', headers: { authorization: 'api_key ' + env.mobileKey, 'content-type': 'application/json' }, body: JSON.stringify(beta) });
assert.equal((await res.json()).banner.value, 'new');
step('mobile polling endpoint works and sees mobile-only flags');

const forgedMobile = env.mobileKey.slice(0, -4) + '0000';
assert.equal((await fetch(`${BASE}/msdk/evalx/contexts/${b64(beta)}`, { headers: { authorization: forgedMobile } })).status, 401);
assert.equal((await fetch(`${BASE}/msdk/evalx/contexts/${b64(beta)}`)).status, 401);
assert.equal((await fetch(`${BASE}/meval/${b64(beta)}`, { headers: { authorization: env.sdkKey } })).status, 401);
assert.equal((await fetch(`${BASE}/all`, { headers: mobile })).status, 401);
step('mobile endpoints reject missing, forged and wrong-type keys');

async function readEvents(response, count) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const events = () => text.split('\n\n').filter((b) => b.startsWith('event:'));
  while (events().length < count || !text.endsWith('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return {
    reader,
    events: events().map((block) => ({ event: /^event: (.*)$/m.exec(block)[1], data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) })),
  };
}
res = await fetch(`${BASE}/meval/${b64(beta)}`, { headers: mobile });
assert.equal(res.headers.get('content-type'), 'text/event-stream');
let stream = await readEvents(res, 1);
assert.equal(stream.events[0].event, 'put');
assert.equal(stream.events[0].data.banner.value, 'new');
const pending = readEvents({ body: { getReader: () => stream.reader } }, 1);
await put('banner', { ...banner, on: false });
const update = (await pending).events[0];
assert.equal(update.event, 'put');
assert.equal(update.data.banner.value, 'old');
await stream.reader.cancel();
await put('banner', banner);
step('mobile stream sends results, then re-evaluated results after a change');

// ---- Real client-side SDK ----------------------------------------------------
const client = NodeClient.initialize(id, beta, { baseUrl: BASE, streamUrl: BASE, eventsUrl: BASE, streaming: true, logger: quiet });
await client.waitForInitialization();
assert.equal(client.variation('banner', 'default'), 'new');
assert.equal(client.variation('server-secret', 'default'), 'default');
step('real client-side SDK initialised and evaluated');

let changed = new Promise((resolve) => client.on('change:banner', (now, before) => resolve([before, now])));
await put('banner', { ...banner, on: false });
assert.deepEqual(await changed, ['new', 'old']);
step('real client-side SDK received a live change');

changed = new Promise((resolve) => client.on('change', resolve));
await client.identify(other);
assert.equal(client.variation('banner', 'default'), 'old');
await put('banner', banner);
await changed.catch(() => {});
step('real client-side SDK switched context');

// identify() drops the SDK's stream and opens a new one in the background, so
// give the new one a moment to arrive. (Locally the old stream can also still
// be counted until the next heartbeat, hence "at least one".)
let live;
for (let attempt = 0; attempt < 25; attempt++) {
  live = await admin('GET', `/envs/${created.id}`);
  if (live.connections.js >= 1) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
assert.ok(live.connections.js >= 1, 'the SDK reconnected its stream after identify()');
await client.flush();
await client.close();
const after = await admin('GET', `/envs/${created.id}`);
assert.ok(after.evals.banner['"new"'] >= 1, 'client evaluation counts recorded');
step('dashboard counted the browser connection and its evaluations: ' + JSON.stringify(after.evals.banner));

// ---- Same answers as a server SDK ---------------------------------------------
const server = init(env.sdkKey, { streamUri: BASE, baseUri: BASE, eventsUri: BASE, sendEvents: false, logger: quiet });
await server.waitForInitialization({ timeout: 10 });
const split = { a: 0, b: 0 };
for (let i = 0; i < 200; i++) {
  const context = { kind: 'user', key: 'user-' + i };
  const [fromServer, fromClient] = await Promise.all([
    server.variation('half', context, 'none'),
    fetch(`${BASE}/sdk/evalx/${id}/contexts/${b64(context)}`).then((r) => r.json()),
  ]);
  assert.equal(fromClient.half.value, fromServer, 'bucketing differs for ' + context.key);
  split[fromServer]++;
}
server.close();
assert.ok(split.a > 60 && split.b > 60, 'rollout is roughly even');
step(`50/50 rollout gives 200 users the same bucket on both paths (${split.a} a, ${split.b} b)`);

console.log('\nAll client-side checks passed.');
console.log(`For the browser test page: ?id=${id}`);
