// End-to-end check of workspaces: self-serve sign-up, isolation between
// workspaces, and deleting an environment. Needs a running Flagport with
// SIGNUPS=open (start it with `npm run dev`; .dev.vars.example sets it).
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://localhost:48788';
const ADMIN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const local = /\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE + '/');
// Locally each run pretends to be a different visitor, so the sign-up limit starts fresh.
const visitor = local ? { 'cf-connecting-ip': `10.${Date.now() % 250}.${Math.floor(Math.random() * 250)}.1` } : {};

async function call(method, path, key, body) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), 'content-type': 'application/json', ...visitor },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
}

const step = (name) => console.log('ok  ' + name);

const instance = await call('GET', '/instance');
assert.equal(instance.status, 200);
assert.equal(instance.body.signups, true, 'this test needs SIGNUPS=open');
step('instance reports that sign-ups are open');

const alice = (await call('POST', '/workspaces')).body.key;
const bob = (await call('POST', '/workspaces')).body.key;
assert.match(alice, /^fpk-[0-9a-f]{48}$/);
assert.notEqual(alice, bob);
step('two workspaces created, each with its own key');

assert.equal((await call('GET', '/envs', alice.slice(0, -4) + '0000')).status, 401);
assert.equal((await call('GET', '/envs', null)).status, 401);
step('a forged or missing key is rejected');

assert.deepEqual((await call('GET', '/envs', alice)).body, []);
const env = (await call('POST', '/envs', alice, { name: 'alice production' })).body;
assert.match(env.sdkKey, /^sdk-[0-9a-f]{12}-[0-9a-f]{32}$/);
const flag = { on: true, variations: [true, false], fallthrough: { variation: 0 }, offVariation: 1 };
assert.equal((await call('PUT', `/envs/${env.id}/flags/secret-launch`, alice, flag)).status, 200);
step('a new workspace starts empty and can create an environment and a flag');

assert.deepEqual((await call('GET', '/envs', bob)).body, []);
assert.equal((await call('GET', `/envs/${env.id}`, bob)).status, 404);
assert.equal((await call('PUT', `/envs/${env.id}/flags/secret-launch`, bob, { ...flag, on: false })).status, 404);
assert.equal((await call('DELETE', `/envs/${env.id}/flags/secret-launch`, bob)).status, 404);
assert.equal((await call('DELETE', `/envs/${env.id}`, bob)).status, 404);
assert.equal((await call('GET', `/envs/${env.id}`, alice)).body.flags['secret-launch'].on, true);
step('another workspace cannot list, read, change or delete it');

const ownerEnvs = (await call('GET', '/envs', ADMIN)).body;
assert.ok(!ownerEnvs.some((e) => e.id === env.id));
assert.equal((await call('GET', `/envs/${env.id}`, ADMIN)).status, 404);
step('the instance owner key does not reach into workspaces either');

const sdk = (key) => fetch(BASE + '/sdk/latest-all', { headers: { authorization: key } });
assert.equal((await sdk(env.sdkKey)).status, 200);
assert.equal((await call('DELETE', `/envs/${env.id}`, alice)).status, 204);
assert.equal((await sdk(env.sdkKey)).status, 401);
assert.deepEqual((await call('GET', '/envs', alice)).body, []);
assert.equal((await call('GET', `/envs/${env.id}`, alice)).status, 404);
step('deleting an environment removes it and turns its SDK key off');

const created = [];
for (let i = 0; i < 10; i++) created.push((await call('POST', '/envs', bob, { name: 'env ' + i })).body.id);
assert.equal((await call('POST', '/envs', bob, { name: 'one too many' })).status, 409);
for (const id of created) assert.equal((await call('DELETE', `/envs/${id}`, bob)).status, 204);
step('a workspace is limited to 10 environments');

if (local) {
  // Two created above; the limit is five an hour per visitor.
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/workspaces')).status, 201);
  assert.equal((await call('POST', '/workspaces')).status, 429);
  step('sign-ups are rate limited per visitor');
}

console.log('\nAll workspace checks passed.');
