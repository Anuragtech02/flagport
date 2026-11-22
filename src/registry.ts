import { DurableObject } from 'cloudflare:workers';

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
       CREATE INDEX IF NOT EXISTS audit_by_workspace ON audit (workspace, id)`,
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

  record(entry: AuditInput) {
    this.sql.exec(
      `INSERT INTO audit (workspace, at, actor_id, actor_name, env_id, env_name, action, kind, key, summary, comment, before, after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.workspace,
      new Date().toISOString(),
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
