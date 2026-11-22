// Converts a LaunchDarkly REST API flag and segment, then has the real SDK
// evaluate the result, so the importer's output is known to be SDK-valid.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { init, integrations } from '@launchdarkly/node-server-sdk';
import { convertFlag, convertSegment } from '../src/ldimport.ts';

// Shaped like GET /api/v2/flags/{project}?env=production&summary=0
const restFlag = {
  key: 'pricing-page',
  kind: 'multivariate',
  variations: [
    { _id: 'a', value: 'control' },
    { _id: 'b', value: 'annual-first' },
    { _id: 'c', value: 'usage-first' },
  ],
  clientSideAvailability: { usingMobileKey: false, usingEnvironmentId: true },
  environments: {
    production: {
      on: true,
      salt: 'f3a1',
      version: 17,
      offVariation: 0,
      trackEvents: false,
      targets: [{ values: ['vip-1'], variation: 2, contextKind: 'user' }],
      contextTargets: [{ values: ['acme'], variation: 1, contextKind: 'organization' }],
      prerequisites: [],
      rules: [
        {
          _id: 'rule-1',
          variation: 1,
          clauses: [{ _id: 'c1', attribute: 'plan', op: 'in', values: ['enterprise'], negate: false, contextKind: 'user' }],
          trackEvents: true,
        },
        {
          _id: 'rule-2',
          variation: 2,
          clauses: [{ _id: 'c2', attribute: '', op: 'segmentMatch', values: ['internal'], negate: false }],
        },
      ],
      fallthrough: {
        rollout: { variations: [{ variation: 0, weight: 100000 }, { variation: 1, weight: 0 }], contextKind: 'user' },
      },
    },
  },
};

// Shaped like GET /api/v2/segments/{project}/{env}
const restSegment = {
  key: 'internal',
  included: ['staff-1'],
  excluded: [],
  includedContexts: [],
  excludedContexts: [],
  rules: [{ _id: 's1', clauses: [{ attribute: 'email', op: 'endsWith', values: ['@ourco.test'], negate: false, contextKind: 'user' }] }],
  version: 4,
};

test('flag missing from the chosen environment is skipped', () => {
  assert.equal(convertFlag(restFlag, 'staging'), null);
});

test('big segments are skipped', () => {
  assert.equal(convertSegment({ key: 'huge', unbounded: true }), null);
});

test('converted flag keeps its salt, unwraps variations and drops REST-only fields', () => {
  const flag = convertFlag(restFlag, 'production');
  assert.equal(flag.salt, 'f3a1');
  assert.deepEqual(flag.variations, ['control', 'annual-first', 'usage-first']);
  assert.equal(flag.rules[0].id, 'rule-1');
  assert.equal(flag.rules[0]._id, undefined);
  assert.equal(flag.rules[1].clauses[0].contextKind, 'user');
  assert.equal(flag.fallthrough.rollout.variations[0].weight, 100000);
});

test('the real SDK evaluates the converted data as LaunchDarkly would', async () => {
  const td = new integrations.TestData();
  const flag = { ...convertFlag(restFlag, 'production'), version: 1 };
  const segment = { ...convertSegment(restSegment), version: 1 };
  td.usePreconfiguredFlag(flag);
  td.usePreconfiguredSegment(segment);
  const client = init('unused', { updateProcessor: td.getFactory(), sendEvents: false, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  await client.waitForInitialization({ timeout: 5 });
  const check = async (context, expected, reason) => {
    const detail = await client.variationDetail('pricing-page', context, 'fallback');
    assert.equal(detail.value, expected);
    assert.equal(detail.reason.kind, reason);
  };
  await check({ kind: 'user', key: 'vip-1' }, 'usage-first', 'TARGET_MATCH');
  await check({ kind: 'organization', key: 'acme' }, 'annual-first', 'TARGET_MATCH');
  await check({ kind: 'user', key: 'u1', plan: 'enterprise' }, 'annual-first', 'RULE_MATCH');
  await check({ kind: 'user', key: 'staff-1' }, 'usage-first', 'RULE_MATCH');
  await check({ kind: 'user', key: 'u2', email: 'dev@ourco.test' }, 'usage-first', 'RULE_MATCH');
  await check({ kind: 'user', key: 'u3' }, 'control', 'FALLTHROUGH');
  client.close();
});
