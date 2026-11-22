import { DurableObject } from 'cloudflare:workers';
import { normalizeFlag, normalizeSegment, type Json } from './flag';
import { ClientEvaluator, type Audience, type Snapshot } from './evaluate';
import type { AuditInput, RegistryDO } from './registry';

/** The environment reaches the registry to write audit entries, including for changes it applies on a timer. */
type Bindings = { REGISTRY: DurableObjectNamespace<RegistryDO> };

export type Person = { id: string; name: string };
export type Review = { by: Person; decision: 'approved' | 'rejected'; comment: string; at: string };
export type ChangeStatus = 'pending' | 'approved' | 'applied' | 'rejected' | 'cancelled' | 'failed';
/** A proposed edit to one flag. It may need approval, wait for a set time, or both. */
export type Change = {
  id: number;
  flag: string;
  title: string;
  base: Json;
  proposed: Json;
  author: Person;
  createdAt: string;
  status: ChangeStatus;
  needsApproval: boolean;
  applyAt: string | null;
  reviews: Review[];
  closedAt: string | null;
  closedBy: string | null;
  failure: string | null;
};
export type EnvSettings = { approvals: boolean };

/** Fields that record bookkeeping, not anyone's intent. */
const BOOKKEEPING = ['version', 'updatedAt', 'deleted', 'key'];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies a proposal to the flag as it is now. Only the fields the proposal
 * actually changed are written, so an unrelated edit made in the meantime
 * survives. If someone else changed one of the same fields, it is a conflict.
 */
export function mergeProposal(base: Json, proposed: Json, current: Json): { merged: Json } | { conflicts: string[] } {
  const fields = [...new Set([...Object.keys(base), ...Object.keys(proposed)])].filter((field) => !BOOKKEEPING.includes(field) && !same(base[field], proposed[field]));
  const conflicts = fields.filter((field) => !same(current[field], base[field]) && !same(current[field], proposed[field]));
  if (conflicts.length) return { conflicts };
  const merged: Json = { ...current };
  for (const field of fields) {
    if (field in proposed) merged[field] = proposed[field];
    else delete merged[field];
  }
  return { merged };
}

export type Kind = 'flags' | 'segments';
export type AnyAudience = 'server' | Audience;

type Writer = WritableStreamDefaultWriter<Uint8Array>;
/** What each open stream needs: server SDKs get raw flags, client SDKs get results for their context. */
type Subscriber = { audience: 'server' } | { audience: Audience; context: unknown; withReasons: boolean };

const encoder = new TextEncoder();
const HEARTBEAT_MS = 25_000;
const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

const TARGETING = ['variations', 'offVariation', 'fallthrough', 'prerequisites', 'targets', 'contextTargets', 'rules'];

/** One line for the activity log: what a save actually changed. */
function describeChange(kind: Kind, before: Json | null, after: Json): string {
  if (!before) return 'Created';
  const differs = (fields: string[]) => fields.some((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
  const ignored = ['on', 'version', 'updatedAt', ...(kind === 'flags' ? TARGETING : [])];
  const other = differs(Object.keys({ ...before, ...after }).filter((field) => !ignored.includes(field)));
  if (kind === 'segments') return other ? 'Changed who is in it or its details' : 'Saved with no changes';
  const parts: string[] = [];
  if (before.on !== after.on) parts.push(after.on ? 'Turned on' : 'Turned off');
  if (differs(TARGETING)) parts.push(parts.length ? 'changed targeting' : 'Changed targeting');
  if (other) parts.push(parts.length ? 'changed settings' : 'Changed settings');
  return parts.join(', ') || 'Saved with no changes';
}

/**
 * One instance per environment. Holds that environment's flags and segments,
 * keeps the open SDK streams, and pushes every change to them.
 */
export class EnvironmentDO extends DurableObject<Bindings> {
  private sdkKey: string | null = null;
  private mobileKey: string | null = null;
  private subscribers = new Map<Writer, Subscriber>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private evaluator = new ClientEvaluator(() => this.snapshot());

  private settings: EnvSettings = { approvals: false };

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.sdkKey = (await ctx.storage.get<string>('sdkKey')) ?? null;
      // Only provisioned environments get tables, so probing random keys stores nothing.
      if (this.sdkKey) await this.setUp();
    });
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  private async setUp() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS items (
        kind TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL,
        data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (kind, key)
      );
      CREATE TABLE IF NOT EXISTS evals (
        day TEXT NOT NULL, flag TEXT NOT NULL, variation TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY (day, flag, variation)
      );
    `);
    // Environments created before mobile support get their key on first load.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, flag TEXT NOT NULL, title TEXT NOT NULL,
        base TEXT NOT NULL, proposed TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL,
        created_at TEXT NOT NULL, status TEXT NOT NULL, needs_approval INTEGER NOT NULL, apply_at TEXT,
        reviews TEXT NOT NULL DEFAULT '[]', closed_at TEXT, closed_by TEXT, failure TEXT,
        workspace TEXT NOT NULL, env_name TEXT NOT NULL
      );
    `);
    this.settings = (await this.ctx.storage.get<EnvSettings>('settings')) ?? { approvals: false };
    this.mobileKey = (await this.ctx.storage.get<string>('mobileKey')) ?? null;
    if (!this.mobileKey && this.sdkKey) {
      this.mobileKey = `mob-${this.sdkKey.split('-')[1]}-${randomHex(16)}`;
      await this.ctx.storage.put('mobileKey', this.mobileKey);
    }
  }

  async provision(sdkKey: string) {
    if (this.sdkKey) return;
    await this.ctx.storage.put('sdkKey', sdkKey);
    this.sdkKey = sdkKey;
    await this.setUp();
  }

  /**
   * Server SDKs prove themselves with the SDK key and mobile SDKs with the
   * mobile key. Browser SDKs carry only the public client-side ID, as with
   * LaunchDarkly, so for them the environment just has to exist.
   */
  private authorized(audience: AnyAudience, key: string | null): boolean {
    if (!this.sdkKey) return false;
    if (audience === 'server') return key === this.sdkKey;
    if (audience === 'mobile') return key === this.mobileKey;
    return true;
  }

  // ---- SDK-facing -------------------------------------------------------

  /** A streaming connection: full state first, then an update per change. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const audience = (url.searchParams.get('audience') ?? 'server') as AnyAudience;
    if (!this.authorized(audience, request.headers.get('authorization'))) {
      return new Response(null, { status: 401 });
    }

    let subscriber: Subscriber = { audience: 'server' };
    let first: unknown = { path: '/', data: this.snapshot() };
    if (audience !== 'server') {
      const context = await request.json().catch(() => null);
      const withReasons = url.searchParams.get('withReasons') === 'true';
      first = await this.evaluator.evaluate(context, audience, withReasons);
      if (first === null) return new Response('Invalid context', { status: 400 });
      subscriber = { audience, context, withReasons };
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.subscribers.set(writer, subscriber);
    // Forget the stream as soon as the SDK disconnects.
    writer.closed.catch(() => {}).finally(() => this.subscribers.delete(writer));
    this.send(writer, 'put', first);
    this.heartbeat ??= setInterval(() => this.beat(), HEARTBEAT_MS);
    return new Response(readable, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  }

  sdkSnapshot(key: string | null) {
    return this.authorized('server', key) ? this.snapshot() : null;
  }

  /** One-off evaluation for client SDKs in polling mode. */
  async clientEvaluate(audience: Audience, key: string | null, context: unknown, withReasons: boolean) {
    if (!this.authorized(audience, key)) return { status: 401 as const };
    const flags = await this.evaluator.evaluate(context, audience, withReasons);
    return flags ? { status: 200 as const, flags } : { status: 400 as const };
  }

  /** Stores per-flag evaluation counts from the SDK's summary events. */
  sdkEvents(audience: AnyAudience, key: string | null, events: unknown): boolean {
    if (!this.authorized(audience, key)) return false;
    if (!Array.isArray(events)) return true;
    for (const event of events) {
      if (event?.kind !== 'summary' || typeof event.features !== 'object') continue;
      const day = new Date(event.endDate ?? Date.now()).toISOString().slice(0, 10);
      for (const [flag, feature] of Object.entries<any>(event.features ?? {})) {
        for (const counter of feature?.counters ?? []) {
          const variation = counter.unknown ? 'unknown flag' : JSON.stringify(counter.value);
          this.sql.exec(
            `INSERT INTO evals (day, flag, variation, count) VALUES (?, ?, ?, ?)
             ON CONFLICT (day, flag, variation) DO UPDATE SET count = count + excluded.count`,
            day,
            flag,
            variation,
            Number(counter.count) || 0,
          );
        }
      }
    }
    return true;
  }

  // ---- Admin-facing -----------------------------------------------------

  snapshot(): Snapshot {
    const out: Snapshot = { flags: {}, segments: {} };
    for (const row of this.sql.exec('SELECT kind, key, data FROM items WHERE deleted = 0 ORDER BY key')) {
      out[row.kind as Kind][row.key as string] = JSON.parse(row.data as string);
    }
    return out;
  }

  overview() {
    const since = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    const evals: Record<string, Record<string, number>> = {};
    for (const row of this.sql.exec(
      'SELECT flag, variation, SUM(count) AS total FROM evals WHERE day >= ? GROUP BY flag, variation',
      since,
    )) {
      (evals[row.flag as string] ??= {})[row.variation as string] = row.total as number;
    }
    // Day by day for the last two weeks, for the charts: flag -> day -> variation -> count.
    const series: Record<string, Record<string, Record<string, number>>> = {};
    const from = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);
    for (const row of this.sql.exec('SELECT day, flag, variation, count FROM evals WHERE day >= ?', from)) {
      ((series[row.flag as string] ??= {})[row.day as string] ??= {})[row.variation as string] = row.count as number;
    }
    const connections = { server: 0, js: 0, mobile: 0 };
    for (const subscriber of this.subscribers.values()) connections[subscriber.audience]++;
    const openChanges = this.sql.exec(`SELECT COUNT(*) AS n FROM changes WHERE status IN ('pending', 'approved')`).one().n as number;
    return { ...this.snapshot(), evals, series, connections, mobileKey: this.mobileKey, settings: this.settings, openChanges };
  }

  /**
   * Creates or replaces a flag or segment. With `expectVersion`, the write is
   * refused when someone else saved in the meantime, so edits are not lost silently.
   */
  upsert(kind: Kind, key: string, input: Json, expectVersion?: number) {
    const before = this.current(kind, key);
    if (expectVersion !== undefined && (before?.version ?? 0) !== expectVersion) return { conflict: true as const, current: before };
    const item = this.store(kind, key, input);
    this.changed('patch', { path: `/${kind}/${key}`, data: item });
    return { conflict: false as const, item, before, summary: describeChange(kind, before, item) };
  }

  /** Returns what was deleted, or null when there was nothing to delete. */
  remove(kind: Kind, key: string): Json | null {
    const before = this.current(kind, key);
    if (!before) return null;
    const next = this.currentVersion(kind, key) + 1;
    this.sql.exec(
      'UPDATE items SET version = ?, deleted = 1, data = ? WHERE kind = ? AND key = ?',
      next,
      JSON.stringify({ key, version: next, deleted: true }),
      kind,
      key,
    );
    this.changed('delete', { path: `/${kind}/${key}`, version: next });
    return before;
  }

  /** Deletes the environment for good: its keys stop working and every connected SDK is cut off. */
  async destroy() {
    for (const writer of this.subscribers.keys()) writer.close().catch(() => {});
    this.subscribers.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.sdkKey = null;
    this.mobileKey = null;
    this.evaluator.invalidate();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Bulk load (used by the importer); connected SDKs get one fresh full state. */
  importAll(flags: Json[], segments: Json[]) {
    for (const segment of segments) this.store('segments', String(segment.key), segment);
    for (const flag of flags) this.store('flags', String(flag.key), flag);
    this.changed('put', { path: '/', data: this.snapshot() });
    return { flags: flags.length, segments: segments.length };
  }

  // ---- Approvals and scheduled changes -----------------------------------

  getSettings(): EnvSettings {
    return this.settings;
  }

  async updateSettings(change: Partial<EnvSettings>): Promise<EnvSettings> {
    this.settings = { ...this.settings, ...change };
    await this.ctx.storage.put('settings', this.settings);
    return this.settings;
  }

  private toChange(row: Record<string, unknown>): Change {
    return {
      id: row.id as number,
      flag: row.flag as string,
      title: row.title as string,
      base: JSON.parse(row.base as string),
      proposed: JSON.parse(row.proposed as string),
      author: { id: row.author_id as string, name: row.author_name as string },
      createdAt: row.created_at as string,
      status: row.status as ChangeStatus,
      needsApproval: row.needs_approval === 1,
      applyAt: (row.apply_at as string) ?? null,
      reviews: JSON.parse(row.reviews as string),
      closedAt: (row.closed_at as string) ?? null,
      closedBy: (row.closed_by as string) ?? null,
      failure: (row.failure as string) ?? null,
    };
  }

  private change(id: number): (Change & { workspace: string; envName: string }) | null {
    const rows = this.sql.exec('SELECT * FROM changes WHERE id = ?', id).toArray();
    return rows.length ? { ...this.toChange(rows[0]), workspace: rows[0].workspace as string, envName: rows[0].env_name as string } : null;
  }

  /** Open changes first, then the most recently closed. */
  changes(): Change[] {
    return this.sql
      .exec(`SELECT * FROM changes ORDER BY CASE WHEN status IN ('pending', 'approved') THEN 0 ELSE 1 END, id DESC LIMIT 200`)
      .toArray()
      .map((row) => this.toChange(row));
  }

  private async audit(change: { workspace: string; envName: string; flag: string }, actor: Person, entry: Pick<AuditInput, 'action' | 'kind' | 'summary'> & Partial<AuditInput>) {
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName('registry')) as unknown as { record(entry: AuditInput): Promise<void> };
    await registry.record({ workspace: change.workspace, actor, envId: this.sdkKey?.split('-')[1], envName: change.envName, key: change.flag, ...entry });
  }

  private close(id: number, status: ChangeStatus, by: string, failure: string | null = null) {
    this.sql.exec('UPDATE changes SET status = ?, closed_at = ?, closed_by = ?, failure = ? WHERE id = ?', status, new Date().toISOString(), by, failure, id);
  }

  /** Wakes the environment when the next scheduled change is due. */
  private async scheduleNext() {
    const rows = this.sql.exec(`SELECT MIN(apply_at) AS next FROM changes WHERE status = 'approved' AND apply_at IS NOT NULL`).toArray();
    const next = rows[0]?.next as string | null;
    if (next) await this.ctx.storage.setAlarm(Math.max(Date.parse(next), Date.now() + 1000));
    else await this.ctx.storage.deleteAlarm();
  }

  async createChange(input: { workspace: string; envName: string; flag: string; title: string; proposed: Json; author: Person; review: boolean; applyAt: string | null }) {
    const base = this.current('flags', input.flag);
    if (!base) return { error: 'That flag does not exist' };
    const proposed = normalizeFlag(input.flag, input.proposed);
    const changed = Object.keys({ ...base, ...proposed }).some((field) => !BOOKKEEPING.includes(field) && !same(base[field], proposed[field]));
    if (!changed) return { error: 'This proposes no change' };
    const needsApproval = this.settings.approvals || input.review;
    this.sql.exec(
      `INSERT INTO changes (flag, title, base, proposed, author_id, author_name, created_at, status, needs_approval, apply_at, workspace, env_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.flag,
      input.title,
      JSON.stringify(base),
      JSON.stringify(proposed),
      input.author.id,
      input.author.name,
      new Date().toISOString(),
      needsApproval ? 'pending' : 'approved',
      needsApproval ? 1 : 0,
      input.applyAt,
      input.workspace,
      input.envName,
    );
    const id = this.sql.exec('SELECT last_insert_rowid() AS id').one().id as number;
    const when = input.applyAt ? `, scheduled for ${input.applyAt}` : '';
    await this.audit(input, input.author, { action: 'requested', kind: 'change', summary: `${needsApproval ? 'Requested approval for' : 'Scheduled'} change #${id}: ${input.title}${when}`, before: base, after: proposed });
    await this.scheduleNext();
    return { change: this.change(id)! as Change };
  }

  async reviewChange(id: number, reviewer: Person, decision: 'approved' | 'rejected', comment: string) {
    const change = this.change(id);
    if (!change) return { error: 'Change not found', status: 404 };
    if (change.status !== 'pending') return { error: 'This change is no longer waiting for a review', status: 409 };
    // Four eyes: the person who proposed a change cannot be the one who approves it.
    if (decision === 'approved' && change.author.id === reviewer.id) return { error: 'You cannot approve your own change. Ask another member.', status: 403 };
    const reviews = [...change.reviews, { by: reviewer, decision, comment, at: new Date().toISOString() }];
    this.sql.exec('UPDATE changes SET reviews = ? WHERE id = ?', JSON.stringify(reviews), id);
    if (decision === 'rejected') {
      this.close(id, 'rejected', reviewer.name);
      await this.audit(change, reviewer, { action: 'rejected', kind: 'change', summary: `Rejected change #${id}: ${change.title}`, comment });
      return { change: this.change(id)! as Change };
    }
    this.sql.exec(`UPDATE changes SET status = 'approved' WHERE id = ?`, id);
    await this.audit(change, reviewer, { action: 'approved', kind: 'change', summary: `Approved change #${id}: ${change.title}`, comment });
    // With no time set, an approved change takes effect at once.
    if (!change.applyAt || Date.parse(change.applyAt) <= Date.now()) await this.applyChange(id, reviewer);
    else await this.scheduleNext();
    return { change: this.change(id)! as Change };
  }

  /** Puts an approved change into effect. `by` is who triggered it; a timer passes the author. */
  async applyChange(id: number, by: Person, scheduled = false) {
    const change = this.change(id);
    if (!change) return { error: 'Change not found', status: 404 };
    if (change.status !== 'approved') return { error: change.status === 'pending' ? 'This change has not been approved yet' : 'This change is already closed', status: 409 };
    const current = this.current('flags', change.flag);
    const result = current ? mergeProposal(change.base, change.proposed, current) : null;
    if (!current || !result || 'conflicts' in result) {
      const failure = !current ? 'The flag was deleted before this change could be applied.' : `Someone else changed ${(result as { conflicts: string[] }).conflicts.join(', ')} after this was proposed. Propose it again from the current flag.`;
      this.close(id, 'failed', by.name, failure);
      await this.audit(change, by, { action: 'failed', kind: 'change', summary: `Change #${id} could not be applied: ${failure}` });
      await this.scheduleNext();
      return { change: this.change(id)! as Change };
    }
    const item = this.store('flags', change.flag, result.merged);
    this.changed('patch', { path: `/flags/${change.flag}`, data: item });
    this.close(id, 'applied', scheduled ? 'schedule' : by.name);
    const approvers = change.reviews.filter((review) => review.decision === 'approved').map((review) => review.by.name);
    const how = [scheduled ? 'on schedule' : '', approvers.length ? `approved by ${approvers.join(', ')}` : ''].filter(Boolean).join(', ');
    await this.audit(change, scheduled ? change.author : by, {
      action: 'updated',
      kind: 'flags',
      summary: `${describeChange('flags', current, item)} (change #${id}${how ? ', ' + how : ''})`,
      comment: change.title,
      before: current,
      after: item,
    });
    await this.scheduleNext();
    return { change: this.change(id)! as Change };
  }

  async cancelChange(id: number, by: Person, mayCancelOthers: boolean) {
    const change = this.change(id);
    if (!change) return { error: 'Change not found', status: 404 };
    if (change.status !== 'pending' && change.status !== 'approved') return { error: 'This change is already closed', status: 409 };
    if (change.author.id !== by.id && !mayCancelOthers) return { error: 'Only the author or an admin can cancel a change', status: 403 };
    this.close(id, 'cancelled', by.name);
    await this.audit(change, by, { action: 'cancelled', kind: 'change', summary: `Cancelled change #${id}: ${change.title}` });
    await this.scheduleNext();
    return { change: this.change(id)! as Change };
  }

  /** The timer: applies every scheduled change that is due, then sleeps until the next one. */
  async alarm() {
    const due = this.sql.exec(`SELECT id FROM changes WHERE status = 'approved' AND apply_at IS NOT NULL AND apply_at <= ? ORDER BY apply_at, id`, new Date().toISOString()).toArray();
    for (const row of due) {
      const change = this.change(row.id as number)!;
      await this.applyChange(change.id, change.author, true);
    }
    await this.scheduleNext();
  }

  // ---- Internals --------------------------------------------------------

  private currentVersion(kind: Kind, key: string): number {
    const rows = this.sql.exec('SELECT version FROM items WHERE kind = ? AND key = ?', kind, key).toArray();
    return rows.length ? (rows[0].version as number) : 0;
  }

  /** The stored item, or null when it does not exist or was deleted. */
  private current(kind: Kind, key: string): Json | null {
    const rows = this.sql.exec('SELECT data, deleted FROM items WHERE kind = ? AND key = ?', kind, key).toArray();
    return rows.length && !rows[0].deleted ? JSON.parse(rows[0].data as string) : null;
  }

  private store(kind: Kind, key: string, input: Json): Json {
    // Versions only ever go up, including across delete and re-create, because
    // SDKs ignore any update that is not newer than what they hold.
    const version = this.currentVersion(kind, key) + 1;
    const normalized = kind === 'flags' ? normalizeFlag(key, input) : normalizeSegment(key, input);
    const item = { ...normalized, version, updatedAt: Date.now() };
    this.sql.exec(
      'INSERT OR REPLACE INTO items (kind, key, version, data, deleted) VALUES (?, ?, ?, ?, 0)',
      kind,
      key,
      version,
      JSON.stringify(item),
    );
    return item;
  }

  /**
   * Tells every open stream about a change. Server SDKs get the raw change.
   * Client SDKs get their flags re-evaluated in full, since one change (a
   * segment, a prerequisite) can alter the result of several flags.
   */
  private changed(serverEvent: string, serverData: unknown) {
    this.evaluator.invalidate();
    for (const [writer, subscriber] of this.subscribers) {
      if (subscriber.audience === 'server') {
        this.send(writer, serverEvent, serverData);
        continue;
      }
      this.evaluator
        .evaluate(subscriber.context, subscriber.audience, subscriber.withReasons)
        .then((flags) => flags && this.send(writer, 'put', flags))
        .catch(() => {});
    }
  }

  private send(writer: Writer, event: string, data: unknown) {
    this.write(writer, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private write(writer: Writer, text: string) {
    writer.write(encoder.encode(text)).catch(() => this.subscribers.delete(writer));
  }

  /** Keeps idle streams open through proxies and finds the ones that went away. */
  private beat() {
    for (const writer of this.subscribers.keys()) this.write(writer, ':\n\n');
    if (this.subscribers.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}
