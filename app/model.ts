// What the interface says about a flag: plain-language summaries, the
// operator list, percentage maths and the list of unsaved changes.
import type { Clause, Flag, Rule, Segment, Serve, Target } from './api';

export const show = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** One colour per variation, stable by position, so a variation looks the same everywhere. */
const PALETTE = ['#C8F53A', '#7CC7FF', '#FFB454', '#D7A6FF', '#FF8FA3', '#7FE0C4', '#F2E36B', '#9FA8FF'];
export function variationColor(flag: Pick<Flag, 'variations'>, index: number): string {
  const value = flag.variations[index];
  if (flag.variations.length === 2 && typeof value === 'boolean') return value ? PALETTE[0] : '#8E8E8A';
  return PALETTE[index % PALETTE.length];
}

export type FlagType = 'boolean' | 'string' | 'number' | 'json';
export function flagType(flag: Pick<Flag, 'variations'>): FlagType {
  const types = new Set(flag.variations.map((v) => typeof v));
  if (types.size === 1 && types.has('boolean')) return 'boolean';
  if (types.size === 1 && types.has('string')) return 'string';
  if (types.size === 1 && types.has('number')) return 'number';
  return 'json';
}

// ---- Percentages --------------------------------------------------------------
// The SDK counts weights in thousandths of a percent: 100% is 100000.

export const toPercent = (weight: number) => weight / 1000;
export const toWeight = (percent: number) => Math.round(percent * 1000);
export const formatPercent = (weight: number) => `${+toPercent(weight).toFixed(3)}%`;

export function describeServe(flag: Pick<Flag, 'variations'>, serve: Serve | undefined): string {
  if (!serve) return 'nothing';
  if (serve.rollout) {
    const parts = serve.rollout.variations.filter((v) => v.weight > 0);
    return parts.map((v) => `${formatPercent(v.weight)} ${show(flag.variations[v.variation])}`).join(', ') || 'an empty rollout';
  }
  return show(flag.variations[serve.variation ?? 0]);
}

export function countRules(flag: Flag): number {
  return flag.rules.length + individualTargets(flag).filter((t) => t.values.length).length;
}

/** The one-line status shown in the flag list. */
export function describeFlag(flag: Flag): string {
  if (!flag.on) return `Off, serving ${show(flag.variations[flag.offVariation])}`;
  const rules = countRules(flag);
  const fallback = flag.fallthrough.rollout ? `a rollout (${describeServe(flag, flag.fallthrough)})` : show(flag.variations[flag.fallthrough.variation ?? 0]);
  return rules ? `${rules} ${rules === 1 ? 'rule' : 'rules'}, then ${fallback}` : `Serving ${fallback}`;
}

export function audience(flag: Flag): { browser: boolean; mobile: boolean } {
  const a = flag.clientSideAvailability;
  return { browser: a?.usingEnvironmentId ?? flag.clientSide === true, mobile: a?.usingMobileKey ?? true };
}

// ---- Individual targets ---------------------------------------------------------
// The SDK format keeps "user" targets and other context kinds in two lists.
// The editor shows one list and splits it again on save.

export function individualTargets(flag: Pick<Flag, 'targets' | 'contextTargets'>): Target[] {
  const users = flag.targets.map((t) => ({ contextKind: 'user', values: [...t.values], variation: t.variation }));
  const others = flag.contextTargets
    .filter((t) => (t.contextKind ?? 'user') !== 'user' || (t.values.length > 0 && !users.some((u) => u.variation === t.variation)))
    .map((t) => ({ contextKind: t.contextKind ?? 'user', values: [...t.values], variation: t.variation }));
  return [...users, ...others];
}

export function splitTargets(list: Target[]): Pick<Flag, 'targets' | 'contextTargets'> {
  const filled = list.filter((t) => t.values.length > 0);
  const targets = filled.filter((t) => (t.contextKind ?? 'user') === 'user').map((t) => ({ values: t.values, variation: t.variation }));
  const others = filled.filter((t) => (t.contextKind ?? 'user') !== 'user').map((t) => ({ contextKind: t.contextKind, values: t.values, variation: t.variation }));
  // With other kinds present, the SDK walks contextTargets and expects a placeholder that points back at each user target.
  const contextTargets = others.length ? [...others, ...targets.map((t) => ({ contextKind: 'user', values: [], variation: t.variation }))] : [];
  return { targets, contextTargets };
}

// ---- Clauses ------------------------------------------------------------------

export type Operator = { id: string; op: string; negate: boolean; label: string; values: 'text' | 'number' | 'segment' | 'any' };
const pair = (op: string, yes: string, no: string, values: Operator['values']): Operator[] => [
  { id: op, op, negate: false, label: yes, values },
  { id: op + '!', op, negate: true, label: no, values },
];
export const OPERATORS: Operator[] = [
  ...pair('in', 'is one of', 'is not one of', 'any'),
  ...pair('endsWith', 'ends with', 'does not end with', 'text'),
  ...pair('startsWith', 'starts with', 'does not start with', 'text'),
  ...pair('contains', 'contains', 'does not contain', 'text'),
  ...pair('matches', 'matches regex', 'does not match regex', 'text'),
  { id: 'greaterThan', op: 'greaterThan', negate: false, label: 'is greater than', values: 'number' },
  { id: 'greaterThanOrEqual', op: 'greaterThanOrEqual', negate: false, label: 'is at least', values: 'number' },
  { id: 'lessThan', op: 'lessThan', negate: false, label: 'is less than', values: 'number' },
  { id: 'lessThanOrEqual', op: 'lessThanOrEqual', negate: false, label: 'is at most', values: 'number' },
  { id: 'before', op: 'before', negate: false, label: 'is before (date)', values: 'text' },
  { id: 'after', op: 'after', negate: false, label: 'is after (date)', values: 'text' },
  { id: 'semVerEqual', op: 'semVerEqual', negate: false, label: 'is version', values: 'text' },
  { id: 'semVerGreaterThan', op: 'semVerGreaterThan', negate: false, label: 'is version above', values: 'text' },
  { id: 'semVerLessThan', op: 'semVerLessThan', negate: false, label: 'is version below', values: 'text' },
  ...pair('segmentMatch', 'is in segment', 'is not in segment', 'segment'),
];

export const operatorOf = (clause: Clause): Operator =>
  OPERATORS.find((o) => o.op === clause.op && o.negate === (clause.negate === true)) ??
  { id: clause.op, op: clause.op, negate: clause.negate === true, label: clause.op, values: 'any' };

export function describeClause(clause: Clause): string {
  const operator = operatorOf(clause);
  const values = clause.values.map(show).join(', ') || '…';
  if (operator.values === 'segment') return `${operator.label} ${values}`;
  const kind = clause.contextKind && clause.contextKind !== 'user' ? `${clause.contextKind} ` : '';
  return `${kind}${clause.attribute || '…'} ${operator.label} ${values}`;
}

export const newClause = (): Clause => ({ contextKind: 'user', attribute: '', op: 'in', values: [], negate: false });
export const newId = () => crypto.randomUUID();

// ---- Validation and unsaved changes ---------------------------------------------

export function serveProblem(serve: Serve): string | null {
  if (!serve.rollout) return null;
  const total = serve.rollout.variations.reduce((sum, v) => sum + v.weight, 0);
  return total === 100000 ? null : `Percentages add up to ${formatPercent(total)}; they need to add up to 100%.`;
}

export function clauseProblem(clause: Clause): string | null {
  const operator = operatorOf(clause);
  if (operator.values !== 'segment' && !clause.attribute.trim()) return 'Choose an attribute.';
  if (clause.values.length === 0) return operator.values === 'segment' ? 'Choose a segment.' : 'Add at least one value.';
  return null;
}

export function flagProblems(flag: Flag): string[] {
  const problems: string[] = [];
  flag.rules.forEach((rule, i) => {
    if (rule.clauses.length === 0) problems.push(`Rule ${i + 1} has no conditions.`);
    rule.clauses.forEach((clause) => {
      const problem = clauseProblem(clause);
      if (problem) problems.push(`Rule ${i + 1}: ${problem}`);
    });
    const serve = serveProblem(rule);
    if (serve) problems.push(`Rule ${i + 1}: ${serve}`);
  });
  const fallthrough = serveProblem(flag.fallthrough);
  if (fallthrough) problems.push(`Default rule: ${fallthrough}`);
  return problems;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const serveOf = (rule: Serve): Serve => (rule.rollout ? { rollout: rule.rollout } : { variation: rule.variation });

/** Each unsaved change as a sentence, for the review step and the save bar. */
export function flagChanges(saved: Flag, draft: Flag): string[] {
  const changes: string[] = [];
  if (saved.on !== draft.on) changes.push(draft.on ? 'Turn targeting on' : 'Turn targeting off');
  if (!same(individualTargets(saved), individualTargets(draft))) changes.push('Change individual targets');

  const before = new Map(saved.rules.map((rule) => [rule.id, rule]));
  const after = new Map(draft.rules.map((rule) => [rule.id, rule]));
  draft.rules.forEach((rule, i) => {
    const old = before.get(rule.id);
    if (!old) changes.push(`Add rule ${i + 1}: ${describeRule(draft, rule)}`);
    else if (!same(old, rule)) changes.push(`Change rule ${i + 1} to: ${describeRule(draft, rule)}`);
  });
  saved.rules.forEach((rule, i) => {
    if (!after.has(rule.id)) changes.push(`Remove rule ${i + 1} (${describeRule(saved, rule)})`);
  });
  const kept = (rules: Rule[], other: Map<string, Rule>) => rules.filter((r) => other.has(r.id)).map((r) => r.id);
  if (!same(kept(saved.rules, after), kept(draft.rules, before))) changes.push('Reorder rules');

  if (!same(serveOf(saved.fallthrough), serveOf(draft.fallthrough))) {
    changes.push(`Change the default rule from ${describeServe(saved, saved.fallthrough)} to ${describeServe(draft, draft.fallthrough)}`);
  }
  if (saved.offVariation !== draft.offVariation) {
    changes.push(`When off, serve ${show(draft.variations[draft.offVariation])} instead of ${show(saved.variations[saved.offVariation])}`);
  }
  if (!same(saved.prerequisites, draft.prerequisites)) changes.push('Change prerequisites');
  if (!same(saved.variations, draft.variations)) changes.push('Change variations');
  if (!same(audience(saved), audience(draft))) changes.push('Change which SDKs can see this flag');
  if ((saved.name ?? '') !== (draft.name ?? '') || (saved.description ?? '') !== (draft.description ?? '') || !same(saved.tags ?? [], draft.tags ?? [])) {
    changes.push('Change name, description or tags');
  }
  return changes;
}

export function describeRule(flag: Pick<Flag, 'variations'>, rule: Rule): string {
  const conditions = rule.clauses.map(describeClause).join(' and ') || 'no conditions';
  return `if ${conditions}, serve ${describeServe(flag, rule)}`;
}

export function segmentChanges(saved: Segment, draft: Segment): string[] {
  const changes: string[] = [];
  if (!same([saved.included, saved.includedContexts], [draft.included, draft.includedContexts])) changes.push('Change who is always included');
  if (!same([saved.excluded, saved.excludedContexts], [draft.excluded, draft.excludedContexts])) changes.push('Change who is always excluded');
  if (!same(saved.rules, draft.rules)) changes.push('Change rules');
  if ((saved.name ?? '') !== (draft.name ?? '') || (saved.description ?? '') !== (draft.description ?? '')) changes.push('Change name or description');
  return changes;
}

/** Every place a variation index is used, so a variation in use is not removed. */
export function variationInUse(flag: Flag, index: number): boolean {
  const serves = (s: Serve) => (s.rollout ? s.rollout.variations.some((v) => v.variation === index && v.weight > 0) : s.variation === index);
  return (
    flag.offVariation === index ||
    serves(flag.fallthrough) ||
    flag.rules.some(serves) ||
    individualTargets(flag).some((t) => t.variation === index && t.values.length > 0)
  );
}

// ---- Time ---------------------------------------------------------------------

export function ago(time: number | string | undefined): string {
  if (!time) return '';
  const seconds = Math.max(0, (Date.now() - new Date(time).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const units: [number, string][] = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2629800, 'month'], [31557600, 'year']];
  let label = 'just now';
  for (const [size, name] of units) {
    if (seconds >= size * 0.75) {
      const n = Math.max(1, Math.round(seconds / size));
      label = `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return label;
}

export const lastDays = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => new Date(Date.now() - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10));

export const compact = (n: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
