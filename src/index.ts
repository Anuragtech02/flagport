import { EnvironmentDO, type Kind } from './environment';
import { OWNER, RegistryDO } from './registry';
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

/** The workspace a request's bearer key belongs to, or null when the key is not valid. */
async function workspaceOf(request: Request, env: Env): Promise<string | null> {
  const given = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!given) return null;
  const digest = await sha256(given);
  if (env.ADMIN_TOKEN && crypto.subtle.timingSafeEqual(digest, await sha256(env.ADMIN_TOKEN))) return OWNER;
  return WORKSPACE_KEY.test(given) ? registry(env).workspaceFor(toHex(digest)) : null;
}

/** Self-serve sign-up: a new, empty workspace and the one key that opens it. */
async function createWorkspace(request: Request, env: Env): Promise<Response> {
  if (env.SIGNUPS !== 'open') return error('This instance does not accept new workspaces', 403);
  // Browsers only send this from our own dashboard; refuse it from other sites.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return error('Forbidden', 403);
  const key = `fpk-${randomHex(24)}`;
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

async function handleAdmin(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;
  const parts = path.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // drop "api"
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return error('Request body too large', 413);

  // The two routes that need no key.
  if (parts.length === 1 && parts[0] === 'instance' && method === 'GET') return json({ signups: env.SIGNUPS === 'open' });
  if (parts.length === 1 && parts[0] === 'workspaces' && method === 'POST') return createWorkspace(request, env);

  const workspace = await workspaceOf(request, env);
  if (!workspace) return error('Invalid key', 401);
  if (parts[0] !== 'envs') return error('Not found', 404);

  if (parts.length === 1) {
    if (method === 'GET') return json(await registry(env).list(workspace));
    if (method === 'POST') {
      const body = (await readJson(request)) as Json | null;
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
      if (!name) return error('Environment name is required', 400);
      if (!(await registry(env).hasRoom(workspace))) return error('This workspace has reached its limit of environments', 409);
      const id = randomHex(6);
      const sdkKey = `sdk-${id}-${randomHex(16)}`;
      await environment(env, id).provision(sdkKey);
      return json(await registry(env).add({ id, name, sdkKey, createdAt: new Date().toISOString(), workspace }), 201);
    }
    return error('Method not allowed', 405);
  }

  const record = await registry(env).get(parts[1]);
  // Someone else's environment looks exactly like one that does not exist.
  if (!record || record.workspace !== workspace) return error('Environment not found', 404);
  const stub = environment(env, record.id);

  if (parts.length === 2 && method === 'DELETE') {
    await stub.destroy();
    await registry(env).remove(record.id);
    return new Response(null, { status: 204 });
  }

  if (parts.length === 2 && method === 'GET') return json({ ...record, clientSideId: record.id, ...((await stub.overview()) as object) });

  if (parts.length === 3 && parts[2] === 'import' && method === 'POST') {
    const body = (await readJson(request)) as Json | null;
    const { apiToken, projectKey, environmentKey } = (body ?? {}) as Record<string, unknown>;
    if (typeof apiToken !== 'string' || typeof projectKey !== 'string' || typeof environmentKey !== 'string') {
      return error('apiToken, projectKey and environmentKey are required', 400);
    }
    try {
      const { flags, segments, skipped } = await fetchFromLaunchDarkly(apiToken, projectKey, environmentKey);
      return json({ imported: await stub.importAll(flags, segments), skipped });
    } catch (e) {
      return error(e instanceof Error ? e.message : 'Import failed', 502);
    }
  }

  if (parts.length === 4 && (parts[2] === 'flags' || parts[2] === 'segments')) {
    const kind = parts[2] as Kind;
    const key = parts[3];
    if (!validKey(key)) return error('Keys may use letters, numbers, dot, dash and underscore', 400);
    if (method === 'PUT') {
      const body = await readJson(request);
      if (!body || Array.isArray(body)) return error('Body must be a JSON object', 400);
      return json(await stub.upsert(kind, key, body));
    }
    if (method === 'DELETE') {
      return (await stub.remove(kind, key)) ? new Response(null, { status: 204 }) : error('Not found', 404);
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
