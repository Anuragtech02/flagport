import { DurableObject } from 'cloudflare:workers';
import { normalizeFlag, normalizeSegment, type Json } from './flag';
import { ClientEvaluator, type Audience, type Snapshot } from './evaluate';

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
export class EnvironmentDO extends DurableObject<unknown> {
  private sdkKey: string | null = null;
  private mobileKey: string | null = null;
  private subscribers = new Map<Writer, Subscriber>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private evaluator = new ClientEvaluator(() => this.snapshot());

  constructor(ctx: DurableObjectState, env: unknown) {
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
    return { ...this.snapshot(), evals, series, connections, mobileKey: this.mobileKey };
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
    await this.ctx.storage.deleteAll();
  }

  /** Bulk load (used by the importer); connected SDKs get one fresh full state. */
  importAll(flags: Json[], segments: Json[]) {
    for (const segment of segments) this.store('segments', String(segment.key), segment);
    for (const flag of flags) this.store('flags', String(flag.key), flag);
    this.changed('put', { path: '/', data: this.snapshot() });
    return { flags: flags.length, segments: segments.length };
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
