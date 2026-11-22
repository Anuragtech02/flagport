// End-to-end check of members, roles and the audit log. Needs a running
// Flagport with SIGNUPS=open (start it with `npm run dev`).
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://localhost:48788';
const local = /\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE + '/');
const visitor = local ? { 'cf-connecting-ip': `10.${Date.now() % 250}.${Math.floor(Math.random() * 250)}.2` } : {};

async function call(method, path, key, body) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), 'content-type': 'application/json', ...visitor },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, type: res.headers.get('content-type') };
}

const step = (name) => console.log('ok  ' + name);
const flag = { on: false, variations: [true, false], fallthrough: { variation: 0 }, offVariation: 1 };

const owner = (await call('POST', '/workspaces')).body.key;
const me = (await call('GET', '/me', owner)).body;
assert.equal(me.role, 'owner');
step('a new workspace starts with one owner');

const add = async (name, role, key = owner) => call('POST', '/members', key, { name, role });
const asha = (await add('Asha', 'writer')).body;
const ci = (await add('CI pipeline', 'reader')).body;
const ravi = (await add('Ravi', 'admin')).body;
assert.match(asha.key, /^fpk-[0-9a-f]{48}$/);
assert.equal((await call('GET', '/members', owner)).body.length, 4);
assert.equal((await call('GET', '/me', asha.key)).body.name, 'Asha');
step('members get their own key and role');

const env = (await call('POST', '/envs', owner, { name: 'Production' })).body;
assert.equal((await call('GET', '/envs', ci.key)).body.length, 1);
assert.equal((await call('GET', `/envs/${env.id}`, ci.key)).status, 200);
assert.equal((await call('PUT', `/envs/${env.id}/flags/a`, ci.key, flag)).status, 403);
assert.equal((await call('DELETE', `/envs/${env.id}/flags/a`, ci.key)).status, 403);
assert.equal((await call('POST', '/envs', ci.key, { name: 'x' })).status, 403);
assert.equal((await add('Mallory', 'admin', ci.key)).status, 403);
step('a reader can look but not change anything');

assert.equal((await call('PUT', `/envs/${env.id}/flags/a`, asha.key, flag)).status, 200);
assert.equal((await call('POST', '/envs', asha.key, { name: 'x' })).status, 403);
assert.equal((await call('DELETE', `/envs/${env.id}`, asha.key)).status, 403);
assert.equal((await add('Mallory', 'reader', asha.key)).status, 403);
step('a writer can change flags but not environments or members');

const staging = await call('POST', '/envs', ravi.key, { name: 'Staging' });
assert.equal(staging.status, 201);
assert.equal((await add('Dev', 'writer', ravi.key)).status, 201);
assert.equal((await add('Second owner', 'owner', ravi.key)).status, 403);
const ownerMember = (await call('GET', '/members', owner)).body.find((m) => m.role === 'owner');
assert.equal((await call('DELETE', `/members/${ownerMember.id}`, ravi.key)).status, 403);
assert.equal((await call('POST', `/members/${ownerMember.id}/rotate`, ravi.key)).status, 403);
step('an admin manages environments and members, but not owners');

assert.equal((await call('DELETE', `/members/${ownerMember.id}`, owner)).status, 409);
assert.equal((await call('PATCH', `/members/${ownerMember.id}`, owner, { role: 'admin' })).status, 409);
step('the last owner cannot be removed or demoted');

const saved = (await call('PUT', `/envs/${env.id}/flags/a?comment=${encodeURIComponent('Launch day')}`, asha.key, { ...flag, on: true })).body;
const stale = await call('PUT', `/envs/${env.id}/flags/a?ifVersion=${saved.version - 1}`, asha.key, flag);
assert.equal(stale.status, 409);
assert.equal(stale.body.current.version, saved.version);
assert.equal((await call('PUT', `/envs/${env.id}/flags/a?ifVersion=${saved.version}`, asha.key, flag)).status, 200);
step('a save over someone else’s newer change is refused');

const audit = (await call('GET', '/audit', owner)).body;
const launch = audit.find((e) => e.comment === 'Launch day');
assert.equal(launch.actor.name, 'Asha');
assert.equal(launch.summary, 'Turned on');
assert.equal(launch.before.on, false);
assert.equal(launch.after.on, true);
assert.equal(launch.envName, 'Production');
assert.ok(audit.some((e) => e.kind === 'member' && e.summary === 'Added Ravi as admin' && e.actor.name === 'Owner'));
assert.ok(audit.some((e) => e.kind === 'environment' && e.summary === 'Created environment Staging' && e.actor.name === 'Ravi'));
step('the audit log records who changed what, with before and after');

const byAsha = (await call('GET', `/audit?actor=${asha.member.id}`, owner)).body;
assert.ok(byAsha.length >= 3 && byAsha.every((e) => e.actor.name === 'Asha'));
const flagOnly = (await call('GET', `/audit?kind=flags&key=a&env=${env.id}`, ci.key)).body;
assert.ok(flagOnly.length >= 3 && flagOnly.every((e) => e.key === 'a'));
const page = (await call('GET', `/audit?limit=2&before=${audit[1].id}`, owner)).body;
assert.equal(page.length, 2);
assert.ok(page[0].id < audit[1].id);
const csv = await call('GET', '/audit?format=csv', owner);
assert.match(csv.type, /text\/csv/);
assert.match(csv.body, /^"time","who","environment"/);
assert.match(csv.body, /"Asha","Production","flags","a","updated","Turned on","Launch day"/);
step('the audit log filters, pages and exports as CSV');

const rotated = (await call('POST', `/members/${asha.member.id}/rotate`, asha.key)).body.key;
assert.equal((await call('GET', '/me', asha.key)).status, 401);
assert.equal((await call('GET', '/me', rotated)).body.name, 'Asha');
step('replacing a key turns the old one off');

assert.equal((await call('PATCH', `/members/${asha.member.id}`, ravi.key, { role: 'reader' })).body.role, 'reader');
assert.equal((await call('PUT', `/envs/${env.id}/flags/a`, rotated, flag)).status, 403);
assert.equal((await call('DELETE', `/members/${asha.member.id}`, ravi.key)).status, 204);
assert.equal((await call('GET', '/me', rotated)).status, 401);
step('changing a role takes effect at once, and removing a member turns their key off');

const other = (await call('POST', '/workspaces')).body.key;
assert.equal((await call('GET', '/audit', other)).body.length, 0);
assert.equal((await call('GET', '/members', other)).body.length, 1);
assert.equal((await call('DELETE', `/members/${ravi.member.id}`, other)).status, 404);
step('another workspace sees none of the members or audit log');

for (const e of (await call('GET', '/envs', owner)).body) await call('DELETE', `/envs/${e.id}`, owner);
console.log('\nAll access checks passed.');
