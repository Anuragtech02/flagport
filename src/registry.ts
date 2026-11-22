import { DurableObject } from 'cloudflare:workers';
import { eventName, jsonBody, linkFor, sign, slackBody, urlHint, type Delivery, type Webhook, type WebhookEvent, type WebhookFormat } from './webhooks';

export interface EnvRecord {
  id: string;
  name: string;
  sdkKey: string;
  createdAt: string;
  /** The workspace that owns it. */
  workspace: string;
}

/** What a member may do. Each role includes everything the one before it can do. */
export type Role = 'reader' | 'writer' | 'admin' | 'owner';
export const ROLES: Role[] = ['reader', 'writer', 'admin', 'owner'];

export interface Member {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Whoever is making a request: a member of a workspace, or the holder of the instance's ADMIN_TOKEN. */
export interface Actor {
  workspace: string;
  id: string;
  name: string;
  role: Role;
}

export interface AuditInput {
  workspace: string;
  actor: Pick<Actor, 'id' | 'name'>;
  envId?: string;
  envName?: string;
  /** created, updated, deleted, imported, and so on. */
  action: string;
  /** What kind of thing changed: flags, segments, environment, member. */
  kind: string;
  key: string;
  summary: string;
  comment?: string;
  before?: unknown;
  after?: unknown;
}

export interface AuditFilter {
  env?: string;
  kind?: string;
  key?: string;
  actor?: string;
  /** Only entries older than this id, for paging. */
  before?: number;
  limit?: number;
}

/** The workspace of whoever holds the instance's ADMIN_TOKEN. */
export const OWNER = 'owner';

const MAX_WORKSPACES = 5_000;
const WORKSPACES_PER_HOUR = 5;
/** Per workspace. The instance owner's workspace is not limited. */
const MAX_ENVS = 10;
const MAX_MEMBERS = 50;
const AUDIT_KEPT = 5_000;
/** A before or after snapshot larger than this is left out of the audit entry. */
const MAX_SNAPSHOT = 65_536;
const MAX_WEBHOOKS = 10;
/** Finished deliveries kept per webhook, for troubleshooting. */
const DELIVERIES_KEPT = 50;
/** How long to wait before each further attempt. After the last one the delivery is given up. */
const RETRY_AFTER = [5_000, 60_000, 600_000];
const DELIVERY_TIMEOUT = 10_000;

const snapshot = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const text = JSON.stringify(value);
  return text.length > MAX_SNAPSHOT ? null : text;
};

/** Workspaces, their members, their environments and their audit log. A single instance, addressed by a fixed name. */
export class RegistryDO extends DurableObject<unknown> {
  /** Recent workspace creations per client, in memory only, to slow down scripted sign-ups. */
  private recentCreates = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS envs (
         id TEXT PRIMARY KEY, name TEXT NOT NULL, sdk_key TEXT NOT NULL, created_at TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS workspaces (
         id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS members (
         id TEXT PRIMARY KEY, workspace TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
         key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT
       );
       CREATE INDEX IF NOT EXISTS members_by_workspace ON members (workspace);
       CREATE TABLE IF NOT EXISTS audit (
         id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, at TEXT NOT NULL,
         actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, env_id TEXT, env_name TEXT,
         action TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, summary TEXT NOT NULL,
         comment TEXT NOT NULL DEFAULT '', before TEXT, after TEXT
       );
       CREATE INDEX IF NOT EXISTS audit_by_workspace ON audit (workspace, id);
       CREATE TABLE IF NOT EXISTS webhooks (
         id TEXT PRIMARY KEY, workspace TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
         format TEXT NOT NULL, secret TEXT NOT NULL, kinds TEXT NOT NULL, envs TEXT NOT NULL,
         enabled INTEGER NOT NULL DEFAULT 1, link TEXT NOT NULL, created_at TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS webhooks_by_workspace ON webhooks (workspace);
       CREATE TABLE IF NOT EXISTS deliveries (
         id INTEGER PRIMARY KEY AUTOINCREMENT, webhook TEXT NOT NULL, event TEXT NOT NULL, summary TEXT NOT NULL,
         body TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER,
         code INTEGER, error TEXT, created_at TEXT NOT NULL, finished_at TEXT
       );
       CREATE INDEX IF NOT EXISTS deliveries_by_webhook ON deliveries (webhook, id);
       CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (next_at)`,
    );
    // Environments from before workspaces existed belong to the instance owner.
    const columns = sql.exec(`SELECT name FROM pragma_table_info('envs')`).toArray();
    if (!columns.some((column) => column.name === 'workspace')) {
      sql.exec(`ALTER TABLE envs ADD COLUMN workspace TEXT NOT NULL DEFAULT '${OWNER}'`);
    }
    // Workspaces from before members existed had one shared key. It becomes their first owner's key.
    for (const row of sql.exec(
      `SELECT id, key_hash, created_at FROM workspaces WHERE id NOT IN (SELECT workspace FROM members)`,
    ).toArray()) {
      sql.exec(
        `INSERT OR IGNORE INTO members (id, workspace, name, role, key_hash, created_at) VALUES (?, ?, 'Owner', 'owner', ?, ?)`,
        crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        row.id,
        row.key_hash,
        row.created_at,
      );
    }
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  // ---- Workspaces and signing in ----------------------------------------

  /** A new workspace with one owner. Only a hash of the key is kept, so it cannot be read back out of storage. */
  createWorkspace(id: string, keyHash: string, client: string | null): 'created' | 'limited' | 'full' {
    if (client) {
      const now = Date.now();
      const recent = (this.recentCreates.get(client) ?? []).filter((at) => now - at < 3_600_000);
      if (recent.length >= WORKSPACES_PER_HOUR) return 'limited';
      this.recentCreates.set(client, [...recent, now]);
      if (this.recentCreates.size > 5_000) this.recentCreates.clear();
    }
    if ((this.sql.exec('SELECT COUNT(*) AS n FROM workspaces').one().n as number) >= MAX_WORKSPACES) return 'full';
    const now = new Date().toISOString();
    // The workspace row no longer holds a usable key; members do.
    this.sql.exec('INSERT INTO workspaces (id, key_hash, created_at) VALUES (?, ?, ?)', id, `workspace:${id}`, now);
    this.sql.exec(
      `INSERT INTO members (id, workspace, name, role, key_hash, created_at) VALUES (?, ?, 'Owner', 'owner', ?, ?)`,
      crypto.randomUUID().replace(/-/g, '').slice(0, 16),
      id,
      keyHash,
      now,
    );
    return 'created';
  }

  /** The member a key belongs to. Also notes, at most hourly, that the key was used. */
  authenticate(keyHash: string): Actor | null {
    const rows = this.sql.exec('SELECT id, workspace, name, role, last_used_at FROM members WHERE key_hash = ?', keyHash).toArray();
    if (!rows.length) return null;
    const row = rows[0];
    const last = row.last_used_at ? Date.parse(row.last_used_at as string) : 0;
    if (Date.now() - last > 3_600_000) this.sql.exec('UPDATE members SET last_used_at = ? WHERE id = ?', new Date().toISOString(), row.id);
    return { workspace: row.workspace as string, id: row.id as string, name: row.name as string, role: row.role as Role };
  }

  // ---- Members ----------------------------------------------------------

  private toMember(row: Record<string, unknown>): Member {
    return {
      id: row.id as string,
      name: row.name as string,
      role: row.role as Role,
      createdAt: row.created_at as string,
      lastUsedAt: (row.last_used_at as string) ?? null,
    };
  }

  members(workspace: string): Member[] {
    return this.sql
      .exec('SELECT * FROM members WHERE workspace = ? ORDER BY created_at', workspace)
      .toArray()
      .map((row) => this.toMember(row));
  }

  member(workspace: string, id: string): Member | null {
    const rows = this.sql.exec('SELECT * FROM members WHERE workspace = ? AND id = ?', workspace, id).toArray();
    return rows.length ? this.toMember(rows[0]) : null;
  }

  addMember(workspace: string, id: string, name: string, role: Role, keyHash: string): Member | 'full' {
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM members WHERE workspace = ?', workspace).one().n as number;
    if (count >= MAX_MEMBERS) return 'full';
    this.sql.exec(
      'INSERT INTO members (id, workspace, name, role, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      workspace,
      name,
      role,
      keyHash,
      new Date().toISOString(),
    );
    return this.member(workspace, id)!;
  }

  /** A workspace must keep at least one owner, or nobody could manage it. The instance owner's workspace always has one. */
  private isLastOwner(workspace: string, member: Member): boolean {
    if (workspace === OWNER || member.role !== 'owner') return false;
    return (this.sql.exec(`SELECT COUNT(*) AS n FROM members WHERE workspace = ? AND role = 'owner'`, workspace).one().n as number) <= 1;
  }

  updateMember(workspace: string, id: string, change: { name?: string; role?: Role }): Member | 'not-found' | 'last-owner' {
    const member = this.member(workspace, id);
    if (!member) return 'not-found';
    if (change.role && change.role !== 'owner' && this.isLastOwner(workspace, member)) return 'last-owner';
    this.sql.exec('UPDATE members SET name = ?, role = ? WHERE id = ?', change.name ?? member.name, change.role ?? member.role, id);
    return this.member(workspace, id)!;
  }

  removeMember(workspace: string, id: string): Member | 'not-found' | 'last-owner' {
    const member = this.member(workspace, id);
    if (!member) return 'not-found';
    if (this.isLastOwner(workspace, member)) return 'last-owner';
    this.sql.exec('DELETE FROM members WHERE id = ?', id);
    return member;
  }

  /** Replaces a member's key. The old key stops working at once. */
  rotateMemberKey(workspace: string, id: string, keyHash: string): Member | null {
    const member = this.member(workspace, id);
    if (!member) return null;
    this.sql.exec('UPDATE members SET key_hash = ?, last_used_at = NULL WHERE id = ?', keyHash, id);
    return member;
  }

  // ---- Audit log --------------------------------------------------------

  async record(entry: AuditInput) {
    const at = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO audit (workspace, at, actor_id, actor_name, env_id, env_name, action, kind, key, summary, comment, before, after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.workspace,
      at,
      entry.actor.id,
      entry.actor.name,
      entry.envId ?? null,
      entry.envName ?? null,
      entry.action,
      entry.kind,
      entry.key,
      entry.summary,
      entry.comment ?? '',
      snapshot(entry.before),
      snapshot(entry.after),
    );
    // Keeps the newest entries per workspace.
    this.sql.exec(
      `DELETE FROM audit WHERE workspace = ? AND id <= (
         SELECT id FROM audit WHERE workspace = ? ORDER BY id DESC LIMIT 1 OFFSET ?
       )`,
      entry.workspace,
      entry.workspace,
      AUDIT_KEPT,
    );
    const id = this.sql.exec('SELECT MAX(id) AS id FROM audit WHERE workspace = ?', entry.workspace).one().id as number;
    await this.announce({ ...entry, id, at });
  }

  audit(workspace: string, filter: AuditFilter = {}) {
    const where = ['workspace = ?'];
    const values: (string | number)[] = [workspace];
    const add = (clause: string, value: string | number | undefined) => {
      if (value === undefined || value === '') return;
      where.push(clause);
      values.push(value);
    };
    add('env_id = ?', filter.env);
    add('kind = ?', filter.kind);
    add('key = ?', filter.key);
    add('actor_id = ?', filter.actor);
    add('id < ?', filter.before);
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    return this.sql
      .exec(`SELECT * FROM audit WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`, ...values)
      .toArray()
      .map((row) => ({
        id: row.id as number,
        at: row.at as string,
        actor: { id: row.actor_id as string, name: row.actor_name as string },
        envId: (row.env_id as string) ?? null,
        envName: (row.env_name as string) ?? null,
        action: row.action as string,
        kind: row.kind as string,
        key: row.key as string,
        summary: row.summary as string,
        comment: row.comment as string,
        before: row.before ? JSON.parse(row.before as string) : null,
        after: row.after ? JSON.parse(row.after as string) : null,
      }));
  }

  // ---- Webhooks ---------------------------------------------------------

  private toDelivery(row: Record<string, unknown>): Delivery {
    return {
      id: row.id as number,
      event: row.event as string,
      summary: row.summary as string,
      status: row.status as Delivery['status'],
      attempts: row.attempts as number,
      code: (row.code as number) ?? null,
      error: (row.error as string) ?? null,
      createdAt: row.created_at as string,
      finishedAt: (row.finished_at as string) ?? null,
      nextAt: row.next_at ? new Date(row.next_at as number).toISOString() : null,
    };
  }

  private toWebhook(row: Record<string, unknown>): Webhook {
    const last = this.sql.exec('SELECT * FROM deliveries WHERE webhook = ? ORDER BY id DESC LIMIT 1', row.id).toArray();
    return {
      id: row.id as string,
      name: row.name as string,
      urlHint: urlHint(row.url as string),
      format: row.format as WebhookFormat,
      kinds: JSON.parse(row.kinds as string),
      envs: JSON.parse(row.envs as string),
      enabled: row.enabled === 1,
      createdAt: row.created_at as string,
      last: last.length ? this.toDelivery(last[0]) : null,
    };
  }

  private webhookRow(workspace: string, id: string) {
    const rows = this.sql.exec('SELECT * FROM webhooks WHERE workspace = ? AND id = ?', workspace, id).toArray();
    return rows.length ? rows[0] : null;
  }

  webhooks(workspace: string): Webhook[] {
    return this.sql
      .exec('SELECT * FROM webhooks WHERE workspace = ? ORDER BY created_at', workspace)
      .toArray()
      .map((row) => this.toWebhook(row));
  }

  /** `link` is the address of the dashboard, so messages can point back to what changed. */
  createWebhook(workspace: string, input: { id: string; name: string; url: string; format: WebhookFormat; kinds: string[]; envs: string[]; secret: string; link: string }): Webhook | 'full' {
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM webhooks WHERE workspace = ?', workspace).one().n as number;
    if (count >= MAX_WEBHOOKS) return 'full';
    this.sql.exec(
      'INSERT INTO webhooks (id, workspace, name, url, format, secret, kinds, envs, enabled, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
      input.id,
      workspace,
      input.name,
      input.url,
      input.format,
      input.secret,
      JSON.stringify(input.kinds),
      JSON.stringify(input.envs),
      input.link,
      new Date().toISOString(),
    );
    return this.toWebhook(this.webhookRow(workspace, input.id)!);
  }

  updateWebhook(workspace: string, id: string, change: { name?: string; url?: string; format?: WebhookFormat; kinds?: string[]; envs?: string[]; enabled?: boolean; link?: string }): { before: Webhook; after: Webhook } | null {
    const row = this.webhookRow(workspace, id);
    if (!row) return null;
    const before = this.toWebhook(row);
    this.sql.exec(
      'UPDATE webhooks SET name = ?, url = ?, format = ?, kinds = ?, envs = ?, enabled = ?, link = ? WHERE id = ?',
      change.name ?? row.name,
      change.url ?? row.url,
      change.format ?? row.format,
      change.kinds ? JSON.stringify(change.kinds) : row.kinds,
      change.envs ? JSON.stringify(change.envs) : row.envs,
      change.enabled === undefined ? row.enabled : change.enabled ? 1 : 0,
      change.link ?? row.link,
      id,
    );
    // Nothing more is sent once a webhook is turned off, including what was waiting for a retry.
    if (change.enabled === false) {
      this.sql.exec(
        `UPDATE deliveries SET status = 'failed', next_at = NULL, body = NULL, finished_at = ?, error = 'The webhook was turned off before this was delivered'
         WHERE webhook = ? AND status = 'pending' AND next_at IS NOT NULL`,
        new Date().toISOString(),
        id,
      );
    }
    return { before, after: this.toWebhook(this.webhookRow(workspace, id)!) };
  }

  removeWebhook(workspace: string, id: string): Webhook | null {
    const row = this.webhookRow(workspace, id);
    if (!row) return null;
    const removed = this.toWebhook(row);
    this.sql.exec('DELETE FROM deliveries WHERE webhook = ?', id);
    this.sql.exec('DELETE FROM webhooks WHERE id = ?', id);
    return removed;
  }

  rotateWebhookSecret(workspace: string, id: string, secret: string): Webhook | null {
    const row = this.webhookRow(workspace, id);
    if (!row) return null;
    this.sql.exec('UPDATE webhooks SET secret = ? WHERE id = ?', secret, id);
    return this.toWebhook(row);
  }

  deliveries(workspace: string, id: string): Delivery[] | null {
    if (!this.webhookRow(workspace, id)) return null;
    return this.sql
      .exec('SELECT * FROM deliveries WHERE webhook = ? ORDER BY id DESC LIMIT ?', id, DELIVERIES_KEPT)
      .toArray()
      .map((row) => this.toDelivery(row));
  }

  /** Sends a sample message now, without retries, and reports how it went. */
  async testWebhook(workspace: string, id: string, by: { id: string; name: string }): Promise<Delivery | null> {
    const row = this.webhookRow(workspace, id);
    if (!row) return null;
    const event: WebhookEvent = { id: 0, at: new Date().toISOString(), workspace, actor: by, action: 'ping', kind: 'webhook', key: id, summary: `Test message for the webhook “${row.name}”` };
    const body = row.format === 'slack' ? slackBody(event, row.link as string) : jsonBody(event, row.link as string);
    this.sql.exec(`INSERT INTO deliveries (webhook, event, summary, body, status, created_at) VALUES (?, 'ping', ?, ?, 'pending', ?)`, id, event.summary, body, event.at);
    const delivery = this.sql.exec('SELECT * FROM deliveries WHERE webhook = ? ORDER BY id DESC LIMIT 1', id).one();
    await this.attempt({ ...delivery, url: row.url, secret: row.secret }, false);
    return this.toDelivery(this.sql.exec('SELECT * FROM deliveries WHERE id = ?', delivery.id).one());
  }

  /** Queues an audit entry for every webhook of the workspace that asked for its kind and environment. */
  private async announce(event: WebhookEvent) {
    let queued = false;
    for (const hook of this.sql.exec('SELECT * FROM webhooks WHERE workspace = ? AND enabled = 1', event.workspace).toArray()) {
      const kinds = JSON.parse(hook.kinds as string) as string[];
      const envs = JSON.parse(hook.envs as string) as string[];
      if (kinds.length && !kinds.includes(event.kind)) continue;
      // A webhook limited to some environments hears nothing about workspace-wide things such as members.
      if (envs.length && (!event.envId || !envs.includes(event.envId))) continue;
      const link = linkFor(hook.link as string, event);
      this.sql.exec(
        `INSERT INTO deliveries (webhook, event, summary, body, status, next_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        hook.id,
        eventName(event.kind, event.action),
        ((event.kind === 'flags' || event.kind === 'segments') && event.key ? `${event.key}: ${event.summary}` : event.summary).slice(0, 300),
        hook.format === 'slack' ? slackBody(event, link) : jsonBody(event, link),
        Date.now(),
        event.at,
      );
      queued = true;
    }
    // Sending happens in the alarm, so whoever made the change does not wait for someone else's server.
    if (queued) await this.ctx.storage.setAlarm(Date.now());
  }

  /** One attempt at one delivery. A failure that may pass is tried again later; anything else is final. */
  private async attempt(row: Record<string, unknown>, retry = true) {
    const attempts = (row.attempts as number) + 1;
    this.sql.exec('UPDATE deliveries SET next_at = NULL, attempts = ? WHERE id = ?', attempts, row.id);
    let code: number | null = null;
    let failure: string | null = null;
    let passing = true;
    try {
      const body = row.body as string;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await fetch(row.url as string, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Flagport-Webhooks/1',
          'x-flagport-event': row.event as string,
          'x-flagport-delivery': String(row.id),
          'x-flagport-timestamp': timestamp,
          'x-flagport-signature': `sha256=${await sign(row.secret as string, timestamp, body)}`,
        },
        body,
      });
      code = response.status;
      await response.body?.cancel();
      if (!response.ok) {
        failure = code >= 300 && code < 400 ? 'The endpoint answered with a redirect, which is not followed' : `The endpoint answered ${code}`;
        passing = code === 408 || code === 429 || code >= 500;
      }
    } catch (e) {
      failure = e instanceof Error && e.name === 'TimeoutError' ? `No answer within ${DELIVERY_TIMEOUT / 1000} seconds` : 'Could not connect to the endpoint';
    }
    // A webhook that was turned off or deleted while this was in flight is not tried again.
    const live = retry && failure && passing && this.sql.exec('SELECT enabled FROM webhooks WHERE id = ?', row.webhook).toArray()[0]?.enabled === 1;
    const wait = live ? RETRY_AFTER[attempts - 1] : undefined;
    if (wait !== undefined) {
      this.sql.exec('UPDATE deliveries SET next_at = ?, code = ?, error = ? WHERE id = ?', Date.now() + wait, code, failure, row.id);
      return;
    }
    this.sql.exec(
      'UPDATE deliveries SET status = ?, code = ?, error = ?, body = NULL, finished_at = ? WHERE id = ?',
      failure ? 'failed' : 'delivered',
      code,
      failure,
      new Date().toISOString(),
      row.id,
    );
    this.sql.exec(
      `DELETE FROM deliveries WHERE webhook = ? AND status != 'pending' AND id <= (
         SELECT id FROM deliveries WHERE webhook = ? AND status != 'pending' ORDER BY id DESC LIMIT 1 OFFSET ?
       )`,
      row.webhook,
      row.webhook,
      DELIVERIES_KEPT,
    );
  }

  /** Sends whatever is due. Each webhook gets its messages one at a time, in order; webhooks do not wait for each other. */
  async alarm() {
    const due = this.sql
      .exec(
        `SELECT d.*, w.url, w.secret FROM deliveries d JOIN webhooks w ON w.id = d.webhook
         WHERE d.next_at IS NOT NULL AND d.next_at <= ? ORDER BY d.id LIMIT 40`,
        Date.now(),
      )
      .toArray();
    const queues = new Map<string, Record<string, unknown>[]>();
    for (const row of due) queues.set(row.webhook as string, [...(queues.get(row.webhook as string) ?? []), row]);
    await Promise.all(
      [...queues.values()].map(async (queue) => {
        for (const row of queue) await this.attempt(row).catch(() => {});
      }),
    );
    const next = this.sql.exec('SELECT MIN(next_at) AS at FROM deliveries WHERE next_at IS NOT NULL').one().at as number | null;
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
  }

  // ---- Environments -----------------------------------------------------

  private toRecord(row: Record<string, unknown>): EnvRecord {
    return {
      id: row.id as string,
      name: row.name as string,
      sdkKey: row.sdk_key as string,
      createdAt: row.created_at as string,
      workspace: row.workspace as string,
    };
  }

  list(workspace: string): EnvRecord[] {
    return this.sql
      .exec('SELECT * FROM envs WHERE workspace = ? ORDER BY created_at', workspace)
      .toArray()
      .map((row) => this.toRecord(row));
  }

  get(id: string): EnvRecord | null {
    const rows = this.sql.exec('SELECT * FROM envs WHERE id = ?', id).toArray();
    return rows.length ? this.toRecord(rows[0]) : null;
  }

  /** True when the workspace may create another environment. */
  hasRoom(workspace: string): boolean {
    if (workspace === OWNER) return true;
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM envs WHERE workspace = ?', workspace).one().n as number;
    return count < MAX_ENVS;
  }

  add(record: EnvRecord): EnvRecord {
    this.sql.exec(
      'INSERT INTO envs (id, name, sdk_key, created_at, workspace) VALUES (?, ?, ?, ?, ?)',
      record.id,
      record.name,
      record.sdkKey,
      record.createdAt,
      record.workspace,
    );
    return record;
  }

  rename(id: string, name: string) {
    this.sql.exec('UPDATE envs SET name = ? WHERE id = ?', name, id);
  }

  remove(id: string) {
    this.sql.exec('DELETE FROM envs WHERE id = ?', id);
  }
}
