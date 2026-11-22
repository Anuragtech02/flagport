// Pulls flags and segments out of a LaunchDarkly account through its REST API
// and converts them to the wire format the SDKs consume.
import type { Json } from './flag';

const LD_API = 'https://app.launchdarkly.com';
const MAX_PAGES = 100;

type Any = any;

const convertClause = (c: Any) => ({
  contextKind: c.contextKind ?? 'user',
  attribute: c.attribute,
  op: c.op,
  values: c.values ?? [],
  negate: c.negate === true,
});

/** A rule or fallthrough serves either one variation or a percentage rollout. */
const variationOrRollout = (src: Any) =>
  src?.rollout
    ? {
        rollout: {
          kind: src.rollout.experimentAllocation ? 'experiment' : 'rollout',
          contextKind: src.rollout.contextKind ?? 'user',
          bucketBy: src.rollout.bucketBy,
          seed: src.rollout.seed,
          variations: (src.rollout.variations ?? []).map((v: Any) => ({
            variation: v.variation,
            weight: v.weight,
            untracked: v._untracked === true || v.untracked === true,
          })),
        },
      }
    : { variation: src?.variation };

/** Returns null when the flag has no configuration for the chosen environment. */
export function convertFlag(flag: Any, envKey: string): Json | null {
  const env = flag?.environments?.[envKey];
  if (!env) return null;

  const targets = (env.targets ?? []).map((t: Any) => ({ values: t.values ?? [], variation: t.variation }));
  const contextTargets = (env.contextTargets ?? []).map((t: Any) => ({
    contextKind: t.contextKind,
    values: t.values ?? [],
    variation: t.variation,
  }));
  // Once a flag has any contextTargets, the SDK only honours user targets that
  // also have a (value-less) "user" placeholder there. Add any that are missing.
  for (const target of targets) {
    const hasPlaceholder = contextTargets.some(
      (c: Any) => c.contextKind === 'user' && c.variation === target.variation,
    );
    if (contextTargets.length > 0 && !hasPlaceholder) {
      contextTargets.push({ contextKind: 'user', values: [], variation: target.variation });
    }
  }

  return {
    key: flag.key,
    on: env.on === true,
    salt: env.salt,
    variations: (flag.variations ?? []).map((v: Any) => v.value),
    offVariation: env.offVariation,
    fallthrough: variationOrRollout(env.fallthrough),
    prerequisites: (env.prerequisites ?? []).map((p: Any) => ({ key: p.key, variation: p.variation })),
    targets,
    contextTargets,
    rules: (env.rules ?? []).map((r: Any) => ({
      id: r._id ?? r.id,
      ...variationOrRollout(r),
      clauses: (r.clauses ?? []).map(convertClause),
      trackEvents: r.trackEvents === true,
    })),
    trackEvents: env.trackEvents === true,
    trackEventsFallthrough: env.trackEventsFallthrough === true,
    clientSideAvailability: flag.clientSideAvailability,
  };
}

/** Returns null for big ("unbounded") segments, which need a separate store. */
export function convertSegment(segment: Any): Json | null {
  if (segment?.unbounded) return null;
  const targets = (list: Any) =>
    (list ?? []).map((t: Any) => ({ contextKind: t.contextKind, values: t.values ?? [] }));
  return {
    key: segment.key,
    salt: segment.salt,
    included: segment.included ?? [],
    excluded: segment.excluded ?? [],
    includedContexts: targets(segment.includedContexts),
    excludedContexts: targets(segment.excludedContexts),
    rules: (segment.rules ?? []).map((r: Any) => ({
      id: r._id ?? r.id,
      clauses: (r.clauses ?? []).map(convertClause),
      weight: r.weight,
      bucketBy: r.bucketBy,
      rolloutContextKind: r.rolloutContextKind,
    })),
  };
}

async function fetchAll(path: string, apiToken: string): Promise<Any[]> {
  const items: Any[] = [];
  let next: string | undefined = path;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const res: Response = await fetch(new URL(next, LD_API), {
      headers: { authorization: apiToken, 'ld-api-version': '20240415' },
    });
    if (!res.ok) {
      throw new Error(`LaunchDarkly API returned ${res.status} for ${new URL(next, LD_API).pathname}`);
    }
    const body: Any = await res.json();
    items.push(...(body.items ?? []));
    next = body._links?.next?.href;
  }
  return items;
}

export async function fetchFromLaunchDarkly(apiToken: string, projectKey: string, envKey: string) {
  const p = encodeURIComponent(projectKey);
  const e = encodeURIComponent(envKey);
  const [rawFlags, rawSegments] = await Promise.all([
    fetchAll(`/api/v2/flags/${p}?env=${e}&summary=0&limit=100`, apiToken),
    fetchAll(`/api/v2/segments/${p}/${e}?limit=100`, apiToken),
  ]);
  const skipped: string[] = [];
  const flags: Json[] = [];
  for (const raw of rawFlags) {
    const flag = convertFlag(raw, envKey);
    if (flag) flags.push(flag);
    else skipped.push(`flag ${raw.key}: no configuration for environment "${envKey}"`);
  }
  const segments: Json[] = [];
  for (const raw of rawSegments) {
    const segment = convertSegment(raw);
    if (segment) segments.push(segment);
    else skipped.push(`segment ${raw.key}: big segments are not supported yet`);
  }
  return { flags, segments, skipped };
}
