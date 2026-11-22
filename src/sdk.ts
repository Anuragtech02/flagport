// Every endpoint LaunchDarkly's SDKs call, for all three SDK families:
//   server  - authenticated by SDK key, receives raw flags and evaluates locally
//   js      - browser SDKs, identified by the public client-side ID in the URL
//   mobile  - authenticated by mobile key
// Browser and mobile SDKs send a context and receive evaluated results.
import type { AnyAudience, EnvironmentDO } from './environment';
import type { Audience } from './evaluate';

type GetEnvironment = (id: string) => DurableObjectStub<EnvironmentDO>;

type Action = 'stream' | 'snapshot' | 'evaluate' | 'events' | 'accept' | 'goals';
/** `context` is the base64url context from the URL, or 'body' when sent with REPORT. */
type Route = { audience: AnyAudience; envId: string; action: Action; context?: string };

// Keys carry the environment id, so a request is routed without a lookup:
// sdk-<12 hex env id>-<32 hex secret>, mob-<same id>-<secret>. The client-side
// ID is the bare environment id. The environment itself checks the secret.
const ID = '([0-9a-f]{12})';
const SDK_KEY = new RegExp(`^sdk-${ID}-[0-9a-f]{32}$`);
const MOBILE_KEY = new RegExp(`^mob-${ID}-[0-9a-f]{32}$`);

const SERVER_ROUTES: [string, string, Action][] = [
  ['GET', '/all', 'stream'],
  ['GET', '/sdk/latest-all', 'snapshot'],
  ['POST', '/bulk', 'events'],
  ['POST', '/diagnostic', 'accept'],
];

// "users"/"user" are the pre-context paths that older SDK versions still call.
const JS_ROUTES: [string, RegExp, Action, 'url' | 'body' | null][] = [
  ['GET', new RegExp(`^/sdk/evalx/${ID}/(?:contexts|users)/([^/]+)$`), 'evaluate', 'url'],
  ['REPORT', new RegExp(`^/sdk/evalx/${ID}/(?:context|user)$`), 'evaluate', 'body'],
  ['GET', new RegExp(`^/eval/${ID}/([^/]+)$`), 'stream', 'url'],
  ['REPORT', new RegExp(`^/eval/${ID}$`), 'stream', 'body'],
  ['GET', new RegExp(`^/sdk/goals/${ID}$`), 'goals', null],
  ['POST', new RegExp(`^/events/bulk/${ID}$`), 'events', null],
  ['POST', new RegExp(`^/events/diagnostic/${ID}$`), 'accept', null],
];

const MOBILE_ROUTES: [string, RegExp, Action, 'url' | 'body' | null][] = [
  ['GET', /^\/msdk\/evalx\/(?:contexts|users)\/([^/]+)$/, 'evaluate', 'url'],
  ['REPORT', /^\/msdk\/evalx\/(?:context|user)$/, 'evaluate', 'body'],
  ['GET', /^\/meval\/([^/]+)$/, 'stream', 'url'],
  ['REPORT', /^\/meval$/, 'stream', 'body'],
  ['POST', /^\/mobile(?:\/events(?:\/bulk)?)?$/, 'events', null],
  ['POST', /^\/mobile\/events\/diagnostic$/, 'accept', null],
];

/** Returns a route, 'unauthorized' for a known path with a malformed key, or null for an unknown path. */
function match(method: string, path: string, key: string | null): Route | 'unauthorized' | null {
  for (const [m, p, action] of SERVER_ROUTES) {
    if (m !== method || p !== path) continue;
    const envId = SDK_KEY.exec(key ?? '')?.[1];
    return envId ? { audience: 'server', envId, action } : 'unauthorized';
  }
  for (const [m, pattern, action, source] of JS_ROUTES) {
    const found = m === method && pattern.exec(path);
    if (found) return { audience: 'js', envId: found[1], action, context: source === 'url' ? found[2] : source ?? undefined };
  }
  for (const [m, pattern, action, source] of MOBILE_ROUTES) {
    const found = m === method && pattern.exec(path);
    if (!found) continue;
    const envId = MOBILE_KEY.exec(key ?? '')?.[1];
    if (!envId) return 'unauthorized';
    return { audience: 'mobile', envId, action, context: source === 'url' ? found[1] : source ?? undefined };
  }
  return null;
}

function decodeContext(encoded: string): unknown {
  try {
    const base64 = decodeURIComponent(encoded).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

const readJson = (request: Request) => request.json().catch(() => undefined);

async function respond(request: Request, route: Route, key: string | null, stub: DurableObjectStub<EnvironmentDO>) {
  const { audience, action } = route;
  const status = (code: number) => new Response(null, { status: code });

  if (action === 'accept') return status(202);
  if (action === 'goals') return Response.json([]);
  if (action === 'events') {
    return status((await stub.sdkEvents(audience, key, await readJson(request))) ? 202 : 401);
  }
  if (action === 'snapshot') {
    const snapshot = await stub.sdkSnapshot(key);
    return snapshot ? Response.json(snapshot) : status(401);
  }

  const withReasons = new URL(request.url).searchParams.get('withReasons') === 'true';
  let context: unknown;
  if (audience !== 'server') {
    context = route.context === 'body' ? await readJson(request) : decodeContext(route.context ?? '');
    if (context === undefined) return new Response('Invalid context', { status: 400 });
  }

  if (action === 'evaluate') {
    const result = (await stub.clientEvaluate(audience as Audience, key, context, withReasons)) as {
      status: number;
      flags?: unknown;
    };
    return result.status === 200 ? Response.json(result.flags) : status(result.status);
  }

  // Streams are held open by the environment itself.
  return stub.fetch(`https://environment/stream?audience=${audience}&withReasons=${withReasons}`, {
    method: 'POST',
    headers: key ? { authorization: key } : {},
    body: audience === 'server' ? undefined : JSON.stringify(context),
  });
}

/** Browser SDKs call from any website's origin, so every SDK response allows cross-origin use. */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  return new Response(response.body, { status: response.status, headers });
}

function preflight(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, REPORT, OPTIONS',
      'access-control-allow-headers': request.headers.get('access-control-request-headers') ?? '*',
      'access-control-max-age': '86400',
    },
  });
}

/** Returns null when the path is not an SDK endpoint. */
export async function handleSdk(request: Request, path: string, getEnvironment: GetEnvironment): Promise<Response | null> {
  if (request.method === 'OPTIONS') return preflight(request);
  // Some older SDKs prefix the key with "api_key ".
  const key = request.headers.get('authorization')?.replace(/^api_key /, '') ?? null;
  const route = match(request.method, path, key);
  if (route === null) return null;
  if (route === 'unauthorized') return withCors(new Response(null, { status: 401 }));
  return withCors(await respond(request, route, key, getEnvironment(route.envId)));
}
