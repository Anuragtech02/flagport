// Browser and mobile SDKs do not evaluate rules themselves: they send a context
// and expect each flag's result back. The evaluation is done by LaunchDarkly's
// own open-source (Apache-2.0) evaluator, so results match theirs exactly,
// including percentage-rollout bucketing.
import { init, type LDClient, type LDContext } from '@launchdarkly/cloudflare-server-sdk';
import type { Json } from './flag';

export type Audience = 'js' | 'mobile';
export type Snapshot = { flags: Record<string, Json>; segments: Record<string, Json> };

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Which flags a client SDK may see. Mirrors LaunchDarkly's per-flag setting. */
export function visibleTo(flag: Json, audience: Audience): boolean {
  const availability = flag.clientSideAvailability as { usingEnvironmentId?: boolean; usingMobileKey?: boolean } | undefined;
  if (audience === 'js') return availability?.usingEnvironmentId ?? flag.clientSide === true;
  return availability?.usingMobileKey ?? true;
}

export class ClientEvaluator {
  private client: LDClient | null = null;
  private flags: Record<string, Json> = {};

  constructor(private readonly load: () => Snapshot) {}

  /** Call after any flag or segment change. */
  invalidate() {
    this.client = null;
  }

  private async ready(): Promise<LDClient> {
    if (!this.client) {
      const snapshot = this.load();
      const data = JSON.stringify(snapshot);
      // The evaluator reads its data from a KV-shaped source; ours is in memory.
      // Its event sending is off by default, so nothing is sent to LaunchDarkly.
      const source = { get: async () => data } as unknown as KVNamespace;
      const client = init('flagport', source as never, { logger: silent });
      await client.waitForInitialization();
      this.client = client;
      this.flags = snapshot.flags;
    }
    return this.client;
  }

  /** Returns null when the context is not a valid LaunchDarkly context. */
  async evaluate(context: unknown, audience: Audience, withReasons: boolean): Promise<Json | null> {
    const client = await this.ready();
    const state = await client.allFlagsState(context as LDContext, { withReasons });
    if (!state.valid) return null;
    const all = state.toJSON() as Record<string, any>;
    const meta = all.$flagsState ?? {};
    const out: Json = {};
    for (const [key, flag] of Object.entries(this.flags)) {
      if (!visibleTo(flag, audience) || !(key in meta)) continue;
      const m = meta[key];
      out[key] = {
        value: all[key],
        variation: m.variation,
        version: m.version,
        flagVersion: m.version,
        reason: m.reason,
        trackEvents: m.trackEvents,
        trackReason: m.trackReason,
        debugEventsUntilDate: m.debugEventsUntilDate,
      };
    }
    return out;
  }
}
