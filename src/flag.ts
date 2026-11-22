// The flag and segment shapes here are the ones LaunchDarkly's server-side SDKs
// expect on the wire. The SDK evaluates rules itself; we only store and stream.

export type Json = Record<string, unknown>;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Fill in every field the SDK's evaluator reads, so a sparse flag can't break it. */
export function normalizeFlag(key: string, input: Json): Json {
  const variations = arr(input.variations);
  if (variations.length === 0) variations.push(true, false);
  const lastIndex = variations.length - 1;
  const fallthrough =
    input.fallthrough && typeof input.fallthrough === 'object' ? input.fallthrough : { variation: lastIndex };
  return {
    ...input,
    key,
    on: input.on === true,
    salt: typeof input.salt === 'string' && input.salt ? input.salt : key,
    variations,
    offVariation: typeof input.offVariation === 'number' ? input.offVariation : lastIndex,
    fallthrough,
    prerequisites: arr(input.prerequisites),
    targets: arr(input.targets),
    contextTargets: arr(input.contextTargets),
    rules: arr(input.rules),
    trackEvents: input.trackEvents === true,
    deleted: false,
  };
}

export function normalizeSegment(key: string, input: Json): Json {
  return {
    ...input,
    key,
    salt: typeof input.salt === 'string' && input.salt ? input.salt : key,
    included: arr(input.included),
    excluded: arr(input.excluded),
    includedContexts: arr(input.includedContexts),
    excludedContexts: arr(input.excludedContexts),
    rules: arr(input.rules),
    deleted: false,
  };
}

export const validKey = (key: string) => /^[A-Za-z0-9._-]{1,256}$/.test(key);
