import { EnvironmentDO, type Kind } from './environment';
import { OWNER, ROLES, RegistryDO, type Actor, type AuditInput, type Role } from './registry';
import { validKey, type Json } from './flag';
import { fetchFromLaunchDarkly } from './ldimport';
import { handleSdk } from './sdk';

export { EnvironmentDO, RegistryDO };

interface Env {
  ENV_DO: DurableObjectNamespace<EnvironmentDO>;
  REGISTRY: DurableObjectNamespace<RegistryDO>;
  /** The instance owner's key. Without it, nobody is the owner. */
  ADMIN_TOKEN?: string;
  /** "open" lets anyone create a workspace of their own. Anything else: owner only. */
  SIGNUPS?: string;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const error = (message: string, status: number) => json({ error: message }, status);
const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

const environment = (env: Env, id: string) => env.ENV_DO.get(env.ENV_DO.idFromName(id));
const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName('registry'));

const WORKSPACE_KEY = /^fpk-[0-9a-f]{48}$/;
const MAX_BODY_BYTES = 262_144;

const sha256 = (text: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
const toHex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Who is making the request, from its bearer key. Null when the key is not valid. */
async function actorOf(request: Request, env: Env): Promise<Actor | null> {
  const given = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!given) return null;
  const digest = await sha256(given);
  if (env.ADMIN_TOKEN && crypto.subtle.timingSafeEqual(digest, await sha256(env.ADMIN_TOKEN))) {
    return { workspace: OWNER, id: 'instance-owner', name: 'Instance owner', role: 'owner' };
  }
  return WORKSPACE_KEY.test(given) ? registry(env).authenticate(toHex(digest)) : null;
}

const can = (actor: Actor, needed: Role) => ROLES.indexOf(actor.role) >= ROLES.indexOf(needed);
const forbidden = (needed: Role) => error(`This needs the ${needed} role or higher`, 403);
const newKey = () => `fpk-${randomHex(24)}`;

/** Self-serve sign-up: a new, empty workspace and the one key that opens it. */
async function createWorkspace(request: Request, env: Env): Promise<Response> {
  if (env.SIGNUPS !== 'open') return error('This instance does not accept new workspaces', 403);
  // Browsers only send this from our own dashboard; refuse it from other sites.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return error('Forbidden', 403);
  const key = newKey();
  // Cloudflare sets this header on every real request; without it (local development) there is no limit.
  const client = request.headers.get('cf-connecting-ip');
  const result = await registry(env).createWorkspace(randomHex(8), toHex(await sha256(key)), client);
  if (result === 'limited') return error('Too many new workspaces from this network. Try again in an hour.', 429);
  if (result === 'full') return error('This instance is not taking new workspaces right now.', 503);
  return json({ key }, 201);
}

async function readJson(request: Request): Promise<Json | unknown[] | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Json) : null;
  } catch {
    return null;
  }
}

type AuditRow = { at: string; actor: { name: string }; envName: string | null; kind: string; key: string; action: string; summary: string; comment: string };
type UpsertResult = { conflict: true; current: Json | null } | { conflict: false; item: Json; before: Json | null; summary: string };

const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;

/** Members of the workspace: each person or service has a key of their own and a role. */
async function handleMembers(request: Request, env: Env, actor: Actor, parts: string[], log: (entry: Omit<AuditInput, 'workspace' | 'actor'>) => Promise<void>): Promise<Response> {
  const method = request.method;
  const reg = registry(env);
  const readRole = (value: unknown): Role | null => (typeof value === 'string' && (ROLES as string[]).includes(value) ? (value as Role) : null);

  if (parts.length === 1) {
    if (method === 'GET') return json(await reg.members(actor.workspace));
    if (method === 'POST') {
      if (!can(actor, 'admin')) return forbidden('admin');
      const body = (await readJson(request)) as Json | null;
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
      const role = readRole(body?.role);
      if (!name || !role) return error('A name and a role (reader, writer, admin or owner) are required', 400);
      if (role === 'owner' && !can(actor, 'owner')) return forbidden('owner');
      const key = newKey();
      const member = await reg.addMember(actor.workspace, randomHex(8), name, role, toHex(await sha256(key)));
      if (member === 'full') return error('This workspace has reached its limit of members', 409);
      await log({ action: 'created', kind: 'member', key: member.id, summary: `Added ${name} as ${role}`, after: { name, role } });
      return json({ member, key }, 201);
    }
    return error('Method not allowed', 405);
  }

  const target = await reg.member(actor.workspace, parts[1]);
  if (!target) return error('Member not found', 404);
  const self = target.id === actor.id;
  // Only an owner may change, remove or re-key another owner.
  const allowed = (needed: Role) => can(actor, target.role === 'owner' ? 'owner' : needed);

  if (parts.length === 3 && parts[2] === 'rotate' && method === 'POST') {
    if (!self && !allowed('admin')) return forbidden(target.role === 'owner' ? 'owner' : 'admin');
    const key = newKey();
    await reg.rotateMemberKey(actor.workspace, target.id, toHex(await sha256(key)));
    await log({ action: 'updated', kind: 'member', key: target.id, summary: `Replaced the key of ${target.name}` });
    return json({ member: target, key });
  }

  if (parts.length === 2 && method === 'PATCH') {
    if (!allowed('admin')) return forbidden(target.role === 'owner' ? 'owner' : 'admin');
    const body = (await readJson(request)) as Json | null;
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) || undefined : undefined;
    const role = body?.role === undefined ? undefined : readRole(body.role);
    if (role === null) return error('The role must be reader, writer, admin or owner', 400);
    if (role === 'owner' && !can(actor, 'owner')) return forbidden('owner');
    const result = await reg.updateMember(actor.workspace, target.id, { name, role });
    if (result === 'last-owner') return error('A workspace needs at least one owner. Make someone else an owner first.', 409);
    if (result === 'not-found') return error('Member not found', 404);
    const changes = [name && name !== target.name ? `renamed to ${name}` : '', role && role !== target.role ? `role changed from ${target.role} to ${role}` : ''].filter(Boolean);
    if (changes.length) {
      await log({ action: 'updated', kind: 'member', key: target.id, summary: `${target.name}: ${changes.join(', ')}`, before: { name: target.name, role: target.role }, after: { name: result.name, role: result.role } });
    }
    return json(result);
  }

  if (parts.length === 2 && method === 'DELETE') {
    if (!self && !allowed('admin')) return forbidden(target.role === 'owner' ? 'owner' : 'admin');
    const result = await reg.removeMember(actor.workspace, target.id);
    if (result === 'last-owner') return error('A workspace needs at least one owner. Make someone else an owner first.', 409);
    if (result === 'not-found') return error('Member not found', 404);
    await log({ action: 'deleted', kind: 'member', key: target.id, summary: `Removed ${target.name}`, before: { name: target.name, role: target.role } });
    return new Response(null, { status: 204 });
  }
  return error('Not found', 404);
}

async function handleAdmin(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;
  const url = new URL(request.url);
  const parts = path.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // drop "api"
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return error('Request body too large', 413);

  // The two routes that need no key.
  if (parts.length === 1 && parts[0] === 'instance' && method === 'GET') return json({ signups: env.SIGNUPS === 'open' });
  if (parts.length === 1 && parts[0] === 'workspaces' && method === 'POST') return createWorkspace(request, env);

  const actor = await actorOf(request, env);
  if (!actor) return error('Invalid key', 401);
  const reg = registry(env);
  const log = async (entry: Omit<AuditInput, 'workspace' | 'actor'>) => {
    // Cast because the snapshots are arbitrary JSON, which the generated stub types cannot express.
    await (reg as unknown as { record(entry: AuditInput): Promise<void> }).record({ ...entry, workspace: actor.workspace, actor: { id: actor.id, name: actor.name } });
  };

  if (parts.length === 1 && parts[0] === 'me' && method === 'GET') return json({ id: actor.id, name: actor.name, role: actor.role });
  if (parts[0] === 'members') return handleMembers(request, env, actor, parts, log);

  if (parts.length === 1 && parts[0] === 'audit' && method === 'GET') {
    const q = url.searchParams;
    const entries = (await reg.audit(actor.workspace, {
      env: q.get('env') ?? undefined,
      kind: q.get('kind') ?? undefined,
      key: q.get('key') ?? undefined,
      actor: q.get('actor') ?? undefined,
      before: q.get('before') ? Number(q.get('before')) : undefined,
      limit: q.get('limit') ? Number(q.get('limit')) : q.get('format') === 'csv' ? 1000 : undefined,
    })) as unknown as AuditRow[];
    if (q.get('format') !== 'csv') return json(entries);
    const rows = entries.map((e) => [e.at, e.actor.name, e.envName ?? '', e.kind, e.key, e.action, e.summary, e.comment].map(csvCell).join(','));
    return new Response(['"time","who","environment","type","key","action","what changed","note"', ...rows].join('\r\n') + '\r\n', {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="flagport-audit-log.csv"' },
    });
  }

  if (parts[0] !== 'envs') return error('Not found', 404);

  if (parts.length === 1) {
    if (method === 'GET') return json(await reg.list(actor.workspace));
    if (method === 'POST') {
      if (!can(actor, 'admin')) return forbidden('admin');
      const body = (await readJson(request)) as Json | null;
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
      if (!name) return error('Environment name is required', 400);
      if (!(await reg.hasRoom(actor.workspace))) return error('This workspace has reached its limit of environments', 409);
      const id = randomHex(6);
      const sdkKey = `sdk-${id}-${randomHex(16)}`;
      await environment(env, id).provision(sdkKey);
      const created = await reg.add({ id, name, sdkKey, createdAt: new Date().toISOString(), workspace: actor.workspace });
      await log({ envId: id, envName: name, action: 'created', kind: 'environment', key: id, summary: `Created environment ${name}` });
      return json(created, 201);
    }
    return error('Method not allowed', 405);
  }

  const record = await reg.get(parts[1]);
  // Someone else's environment looks exactly like one that does not exist.
  if (!record || record.workspace !== actor.workspace) return error('Environment not found', 404);
  const stub = environment(env, record.id);
  const here = { envId: record.id, envName: record.name };

  if (parts.length === 2 && method === 'DELETE') {
    if (!can(actor, 'admin')) return forbidden('admin');
    await stub.destroy();
    await reg.remove(record.id);
    await log({ ...here, action: 'deleted', kind: 'environment', key: record.id, summary: `Deleted environment ${record.name}` });
    return new Response(null, { status: 204 });
  }

  if (parts.length === 2 && method === 'PATCH') {
    if (!can(actor, 'admin')) return forbidden('admin');
    const body = (await readJson(request)) as Json | null;
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!name) return error('Environment name is required', 400);
    await reg.rename(record.id, name);
    if (name !== record.name) await log({ envId: record.id, envName: name, action: 'updated', kind: 'environment', key: record.id, summary: `Renamed environment ${record.name} to ${name}` });
    return json({ ...record, name });
  }

  // Kept for older dashboards: the audit log, limited to this environment.
  if (parts.length === 3 && parts[2] === 'activity' && method === 'GET') return json((await reg.audit(actor.workspace, { env: record.id, limit: 200 })) as unknown as AuditRow[]);

  if (parts.length === 2 && method === 'GET') return json({ ...record, clientSideId: record.id, ...((await stub.overview()) as object) });

  if (parts.length === 3 && parts[2] === 'import' && method === 'POST') {
    if (!can(actor, 'writer')) return forbidden('writer');
    const body = (await readJson(request)) as Json | null;
    const { apiToken, projectKey, environmentKey } = (body ?? {}) as Record<string, unknown>;
    if (typeof apiToken !== 'string' || typeof projectKey !== 'string' || typeof environmentKey !== 'string') {
      return error('apiToken, projectKey and environmentKey are required', 400);
    }
    try {
      const { flags, segments, skipped } = await fetchFromLaunchDarkly(apiToken, projectKey, environmentKey);
      const imported = await stub.importAll(flags, segments);
      await log({ ...here, action: 'imported', kind: 'flags', key: '', summary: `Imported ${imported.flags} flags and ${imported.segments} segments from LaunchDarkly (${projectKey}/${environmentKey})` });
      return json({ imported, skipped });
    } catch (e) {
      return error(e instanceof Error ? e.message : 'Import failed', 502);
    }
  }

  if (parts.length === 4 && (parts[2] === 'flags' || parts[2] === 'segments')) {
    const kind = parts[2] as Kind;
    const key = parts[3];
    if (!validKey(key)) return error('Keys may use letters, numbers, dot, dash and underscore', 400);
    if (method === 'PUT') {
      if (!can(actor, 'writer')) return forbidden('writer');
      const body = await readJson(request);
      if (!body || Array.isArray(body)) return error('Body must be a JSON object', 400);
      // An optional note from whoever made the change, kept in the audit log.
      const comment = (url.searchParams.get('comment') ?? '').trim().slice(0, 280);
      // The version the editor started from. When it is given, a save over someone else's newer change is refused.
      const expected = url.searchParams.get('ifVersion');
      const result = (await stub.upsert(kind, key, body, expected === null ? undefined : Number(expected))) as unknown as UpsertResult;
      if (result.conflict) return json({ error: 'This was changed by someone else since you opened it. Reload to see their change.', current: result.current }, 409);
      await log({ ...here, action: result.before ? 'updated' : 'created', kind, key, summary: result.summary, comment, before: result.before, after: result.item });
      return json(result.item);
    }
    if (method === 'DELETE') {
      if (!can(actor, 'writer')) return forbidden('writer');
      const before = (await stub.remove(kind, key)) as unknown as Json | null;
      if (!before) return error('Not found', 404);
      await log({ ...here, action: 'deleted', kind, key, summary: 'Deleted', before });
      return new Response(null, { status: 204 });
    }
  }
  return error('Not found', 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/')) return handleAdmin(request, env, path);
    return (await handleSdk(request, path, (id) => environment(env, id))) ?? new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
