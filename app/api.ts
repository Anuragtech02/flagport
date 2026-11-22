// The admin API, and the shapes it returns. Flags and segments are stored in
// the format LaunchDarkly's SDKs read, so these types mirror that format.

export type Clause = { contextKind?: string; attribute: string; op: string; values: unknown[]; negate?: boolean };
export type Rollout = {
  kind?: string;
  contextKind?: string;
  bucketBy?: string;
  seed?: number;
  variations: { variation: number; weight: number; untracked?: boolean }[];
};
/** A rule, or the default rule, serves one variation or splits traffic by percentage. */
export type Serve = { variation?: number; rollout?: Rollout };
export type Rule = Serve & { id: string; description?: string; clauses: Clause[]; trackEvents?: boolean };
export type Target = { contextKind?: string; values: string[]; variation: number };

export type Flag = {
  key: string;
  name?: string;
  description?: string;
  tags?: string[];
  on: boolean;
  variations: unknown[];
  offVariation: number;
  fallthrough: Serve;
  prerequisites: { key: string; variation: number }[];
  targets: Target[];
  contextTargets: Target[];
  rules: Rule[];
  clientSide?: boolean;
  clientSideAvailability?: { usingEnvironmentId: boolean; usingMobileKey: boolean };
  version: number;
  updatedAt?: number;
  deleted?: boolean;
  [other: string]: unknown;
};

export type SegmentRule = { id: string; clauses: Clause[]; weight?: number; bucketBy?: string };
export type Segment = {
  key: string;
  name?: string;
  description?: string;
  included: string[];
  excluded: string[];
  includedContexts: { contextKind: string; values: string[] }[];
  excludedContexts: { contextKind: string; values: string[] }[];
  rules: SegmentRule[];
  version: number;
  updatedAt?: number;
  deleted?: boolean;
  [other: string]: unknown;
};

export type EnvSummary = { id: string; name: string; sdkKey: string; createdAt: string };
export type Environment = EnvSummary & {
  clientSideId: string;
  mobileKey: string;
  flags: Record<string, Flag>;
  segments: Record<string, Segment>;
  /** Totals for the last 7 days: flag -> variation (as JSON text) -> count. */
  evals: Record<string, Record<string, number>>;
  /** The last 14 days: flag -> day -> variation -> count. */
  series: Record<string, Record<string, Record<string, number>>>;
  connections: { server: number; js: number; mobile: number };
};

export type Role = 'reader' | 'writer' | 'admin' | 'owner';
export const ROLES: Role[] = ['reader', 'writer', 'admin', 'owner'];
export type Me = { id: string; name: string; role: Role };
export type Member = { id: string; name: string; role: Role; createdAt: string; lastUsedAt: string | null };
export type AuditEntry = {
  id: number;
  at: string;
  actor: { id: string; name: string };
  envId: string | null;
  envName: string | null;
  action: string;
  /** flags, segments, environment or member. */
  kind: string;
  key: string;
  summary: string;
  comment: string;
  before: unknown;
  after: unknown;
};
export type AuditFilter = { env?: string; kind?: string; key?: string; actor?: string; before?: number; limit?: number };

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly data?: unknown) {
    super(message);
  }
}

let key: string | null = null;
let onUnauthorized = () => {};

export const auth = {
  get key() {
    return key;
  },
  set(value: string | null) {
    key = value;
    try {
      if (value) localStorage.setItem('flagport-key', value);
      else localStorage.removeItem('flagport-key');
    } catch {
      // Private windows may refuse storage; the key then lasts until the tab closes.
    }
  },
  restore() {
    try {
      key = localStorage.getItem('flagport-key');
    } catch {
      key = null;
    }
    return key;
  },
  onUnauthorized(handler: () => void) {
    onUnauthorized = handler;
  },
};

async function request<T>(method: string, path: string, body?: unknown, useKey: string | null = key): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: {
        ...(useKey ? { authorization: 'Bearer ' + useKey } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }
  if (res.status === 401 && useKey === key && key) onUnauthorized();
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((data as { error?: string } | null)?.error ?? `Request failed (${res.status})`, res.status, data);
  return data as T;
}

const query = (values: Record<string, string | number | undefined>) => {
  const filled = Object.entries(values).filter(([, value]) => value !== undefined && value !== '');
  return filled.length ? '?' + filled.map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join('&') : '';
};
const enc = encodeURIComponent;

export const api = {
  instance: () => request<{ signups: boolean }>('GET', '/instance'),
  createWorkspace: () => request<{ key: string }>('POST', '/workspaces', undefined, null),
  /** Lists environments with a key that is not signed in yet, to check it. */
  check: (candidate: string) => request<EnvSummary[]>('GET', '/envs', undefined, candidate),
  envs: () => request<EnvSummary[]>('GET', '/envs'),
  createEnv: (name: string) => request<EnvSummary>('POST', '/envs', { name }),
  env: (id: string) => request<Environment>('GET', `/envs/${enc(id)}`),
  renameEnv: (id: string, name: string) => request<EnvSummary>('PATCH', `/envs/${enc(id)}`, { name }),
  deleteEnv: (id: string) => request<null>('DELETE', `/envs/${enc(id)}`),
  me: () => request<Me>('GET', '/me'),
  members: () => request<Member[]>('GET', '/members'),
  addMember: (name: string, role: Role) => request<{ member: Member; key: string }>('POST', '/members', { name, role }),
  updateMember: (id: string, change: { name?: string; role?: Role }) => request<Member>('PATCH', `/members/${enc(id)}`, change),
  removeMember: (id: string) => request<null>('DELETE', `/members/${enc(id)}`),
  rotateMemberKey: (id: string) => request<{ member: Member; key: string }>('POST', `/members/${enc(id)}/rotate`),
  audit: (filter: AuditFilter = {}) => request<AuditEntry[]>('GET', `/audit${query(filter)}`),
  /** The audit log as a CSV file. Fetched with the key, so it cannot be a plain link. */
  async auditCsv(filter: AuditFilter = {}): Promise<Blob> {
    const res = await fetch(`/api/audit${query({ ...filter, format: 'csv' })}`, { headers: { authorization: 'Bearer ' + key } });
    if (!res.ok) throw new ApiError(`Export failed (${res.status})`, res.status);
    return res.blob();
  },
  /** `ifVersion` is the version the edit started from; the server refuses the save if someone else saved since. */
  saveFlag: (id: string, flagKey: string, flag: object, comment?: string, ifVersion?: number) =>
    request<Flag>('PUT', `/envs/${enc(id)}/flags/${enc(flagKey)}${query({ comment, ifVersion })}`, flag),
  deleteFlag: (id: string, flagKey: string) => request<null>('DELETE', `/envs/${enc(id)}/flags/${enc(flagKey)}`),
  saveSegment: (id: string, segmentKey: string, segment: object, comment?: string, ifVersion?: number) =>
    request<Segment>('PUT', `/envs/${enc(id)}/segments/${enc(segmentKey)}${query({ comment, ifVersion })}`, segment),
  deleteSegment: (id: string, segmentKey: string) => request<null>('DELETE', `/envs/${enc(id)}/segments/${enc(segmentKey)}`),
  importFromLaunchDarkly: (id: string, input: { apiToken: string; projectKey: string; environmentKey: string }) =>
    request<{ imported: { flags: number; segments: number }; skipped: unknown[] }>('POST', `/envs/${enc(id)}/import`, input),
};
