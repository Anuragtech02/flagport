import { DurableObject } from 'cloudflare:workers';

export interface EnvRecord {
  id: string;
  name: string;
  sdkKey: string;
  createdAt: string;
  /** The workspace that owns it. */
  workspace: string;
}

/** The workspace of whoever holds the instance's ADMIN_TOKEN. */
export const OWNER = 'owner';

const MAX_WORKSPACES = 5_000;
const WORKSPACES_PER_HOUR = 5;
/** Per workspace. The instance owner is not limited. */
const MAX_ENVS = 10;

/** Workspaces and the environments each one owns. A single instance, addressed by a fixed name. */
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
       )`,
    );
    // Environments from before workspaces existed belong to the instance owner.
    const columns = sql.exec(`SELECT name FROM pragma_table_info('envs')`).toArray();
    if (!columns.some((column) => column.name === 'workspace')) {
      sql.exec(`ALTER TABLE envs ADD COLUMN workspace TEXT NOT NULL DEFAULT '${OWNER}'`);
    }
  }

  // ---- Workspaces -------------------------------------------------------

  /** Only a hash of the key is kept, so a workspace key cannot be read back out of storage. */
  createWorkspace(id: string, keyHash: string, client: string | null): 'created' | 'limited' | 'full' {
    if (client) {
      const now = Date.now();
      const recent = (this.recentCreates.get(client) ?? []).filter((at) => now - at < 3_600_000);
      if (recent.length >= WORKSPACES_PER_HOUR) return 'limited';
      this.recentCreates.set(client, [...recent, now]);
      if (this.recentCreates.size > 5_000) this.recentCreates.clear();
    }
    const sql = this.ctx.storage.sql;
    if ((sql.exec('SELECT COUNT(*) AS n FROM workspaces').one().n as number) >= MAX_WORKSPACES) return 'full';
    sql.exec('INSERT INTO workspaces (id, key_hash, created_at) VALUES (?, ?, ?)', id, keyHash, new Date().toISOString());
    return 'created';
  }

  workspaceFor(keyHash: string): string | null {
    const rows = this.ctx.storage.sql.exec('SELECT id FROM workspaces WHERE key_hash = ?', keyHash).toArray();
    return rows.length ? (rows[0].id as string) : null;
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
    return this.ctx.storage.sql
      .exec('SELECT * FROM envs WHERE workspace = ? ORDER BY created_at', workspace)
      .toArray()
      .map((row) => this.toRecord(row));
  }

  get(id: string): EnvRecord | null {
    const rows = this.ctx.storage.sql.exec('SELECT * FROM envs WHERE id = ?', id).toArray();
    return rows.length ? this.toRecord(rows[0]) : null;
  }

  /** True when the workspace may create another environment. */
  hasRoom(workspace: string): boolean {
    if (workspace === OWNER) return true;
    const count = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM envs WHERE workspace = ?', workspace).one().n as number;
    return count < MAX_ENVS;
  }

  add(record: EnvRecord): EnvRecord {
    this.ctx.storage.sql.exec(
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
    this.ctx.storage.sql.exec('UPDATE envs SET name = ? WHERE id = ?', name, id);
  }

  remove(id: string) {
    this.ctx.storage.sql.exec('DELETE FROM envs WHERE id = ?', id);
  }
}
