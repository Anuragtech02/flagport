// One flag: the targeting editor, its variations, numbers, history and settings.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api, type AuditEntry, type Clause, type Flag, type Rule, type Segment, type Serve, type Target } from './api';
import { AuditList } from './audit';
import {
  OPERATORS, ago, audience, compact, describeServe, flagChanges, flagProblems, flagType, formatPercent, individualTargets, lastDays, newClause, newId,
  operatorOf, serveProblem, show, splitTargets, toPercent, toWeight, variationColor, variationInUse,
} from './model';
import { go, href, setUnsaved, useApp, useCan, useEnv } from './state';
import { Button, Chips, CopyButton, Empty, Field, Icon, Modal, ModalForm, Swatch, Tabs, Toggle, useToast } from './ui';
import { VariationPill, parseVariation } from './flags';

const ATTRIBUTES = ['key', 'email', 'name', 'country', 'ip', 'anonymous', 'plan', 'role', 'organization', 'appVersion'];

// ---- Conditions -------------------------------------------------------------------

type ValueType = 'text' | 'number' | 'boolean';
const typeOf = (values: unknown[]): ValueType => (values.length && values.every((v) => typeof v === 'number') ? 'number' : values.length && values.every((v) => typeof v === 'boolean') ? 'boolean' : 'text');

export function ClauseEditor({ clause, onChange, onRemove, segments }: { clause: Clause; onChange: (clause: Clause) => void; onRemove?: () => void; segments: Segment[] }) {
  const operator = operatorOf(clause);
  const [valueType, setValueType] = useState<ValueType>(() => typeOf(clause.values));
  const isSegment = operator.values === 'segment';
  const kind = operator.values === 'number' ? 'number' : operator.values === 'any' ? valueType : 'text';
  const parse = (text: string): unknown => {
    if (kind === 'number') return Number.isNaN(Number(text)) ? undefined : Number(text);
    if (kind === 'boolean') return text === 'true' ? true : text === 'false' ? false : undefined;
    return text;
  };
  return (
    <div className={`clause ${isSegment ? 'clause-segment' : ''}`}>
      {!isSegment && (
        <>
          <input className="clause-kind" aria-label="Context kind" value={clause.contextKind ?? 'user'} onChange={(event) => onChange({ ...clause, contextKind: event.target.value.trim() || 'user' })} />
          <input className="clause-attr mono" aria-label="Attribute" placeholder="attribute" list="attributes" value={clause.attribute} onChange={(event) => onChange({ ...clause, attribute: event.target.value })} />
        </>
      )}
      <select
        aria-label="Condition"
        value={operator.id}
        onChange={(event) => {
          const next = OPERATORS.find((o) => o.id === event.target.value)!;
          // Values only carry over when both operators take the same kind of value.
          const keep = next.values === operator.values || (next.values !== 'segment' && operator.values !== 'segment' && next.values !== 'number' && operator.values !== 'number');
          onChange({ ...clause, op: next.op, negate: next.negate, attribute: next.values === 'segment' ? '' : clause.attribute, values: keep ? clause.values : [] });
        }}
      >
        {OPERATORS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <Chips
        label={isSegment ? 'Segments' : 'Values'}
        values={clause.values}
        parse={parse}
        suggestions={isSegment ? segments.map((s) => s.key) : kind === 'boolean' ? ['true', 'false'] : undefined}
        placeholder={isSegment ? 'Segment key' : kind === 'number' ? 'A number' : kind === 'boolean' ? 'true or false' : 'Type a value, press Enter'}
        onChange={(values) => onChange({ ...clause, values })}
      />
      {operator.values === 'any' && (
        <select
          className="clause-type"
          aria-label="Value type"
          value={valueType}
          onChange={(event) => {
            setValueType(event.target.value as ValueType);
            onChange({ ...clause, values: [] });
          }}
        >
          <option value="text">text</option>
          <option value="number">number</option>
          <option value="boolean">true/false</option>
        </select>
      )}
      {onRemove && <Button kind="ghost" small icon="x" aria-label="Remove condition" onClick={onRemove} />}
    </div>
  );
}

// ---- What to serve ----------------------------------------------------------------

function evenSplit(count: number) {
  const each = Math.floor(100000 / count);
  return Array.from({ length: count }, (_, i) => ({ variation: i, weight: i === 0 ? 100000 - each * (count - 1) : each }));
}

function ServeEditor({ flag, serve, onChange, label }: { flag: Flag; serve: Serve; onChange: (serve: Serve) => void; label: string }) {
  const rollout = serve.rollout;
  const problem = serveProblem(serve);
  const weightOf = (index: number) => rollout?.variations.find((v) => v.variation === index)?.weight ?? 0;
  return (
    <div className="serve">
      <div className="serve-choice">
        <span className="serve-dot" style={{ background: rollout ? 'transparent' : variationColor(flag, serve.variation ?? 0) }} />
        <select
          aria-label={label}
          value={rollout ? 'rollout' : String(serve.variation ?? 0)}
          onChange={(event) =>
            onChange(event.target.value === 'rollout' ? { rollout: { kind: 'rollout', contextKind: 'user', variations: evenSplit(flag.variations.length) } } : { variation: Number(event.target.value) })
          }
        >
          {flag.variations.map((value, i) => <option key={i} value={i}>{show(value)}</option>)}
          <option value="rollout">a percentage rollout</option>
        </select>
      </div>
      {rollout && (
        <div className="rollout">
          <div className="split split-big" aria-hidden="true">
            {flag.variations.map((_, i) => (weightOf(i) > 0 ? <i key={i} style={{ flexGrow: weightOf(i), background: variationColor(flag, i) }} /> : null))}
          </div>
          <div className="rollout-rows">
            {flag.variations.map((value, i) => (
              <label key={i} className="rollout-row">
                <Swatch color={variationColor(flag, i)} />
                <span className="variation-value">{show(value)}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="any"
                  aria-label={`Percent for ${show(value)}`}
                  value={toPercent(weightOf(i))}
                  onChange={(event) => {
                    const weight = toWeight(Math.min(100, Math.max(0, Number(event.target.value) || 0)));
                    const variations = flag.variations.map((_, j) => ({ variation: j, weight: j === i ? weight : weightOf(j) }));
                    // With two variations the other one follows, so the total stays at 100%.
                    if (variations.length === 2) variations[1 - i].weight = 100000 - weight;
                    onChange({ rollout: { ...rollout, variations } });
                  }}
                />
                <span className="muted">%</span>
              </label>
            ))}
          </div>
          <div className="rollout-foot">
            <label>
              Split by
              <input className="mono" aria-label="Attribute to split by" placeholder="key" value={rollout.bucketBy ?? ''} onChange={(event) => onChange({ rollout: { ...rollout, bucketBy: event.target.value.trim() || undefined } })} />
            </label>
            {problem ? <span className="problem"><Icon name="alert" size={14} />{problem}</span> : <span className="muted">Each {rollout.contextKind ?? 'user'} always lands in the same group.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- The waterfall: steps a request falls through, top to bottom ---------------------

function Step({ title, note, children, actions, tone }: { title: string; note?: ReactNode; children: ReactNode; actions?: ReactNode; tone?: 'last' }) {
  return (
    <li className={`step ${tone === 'last' ? 'step-last' : ''}`}>
      <span className="step-node" aria-hidden="true" />
      <div className="step-body">
        <header className="step-head">
          <h3>{title}</h3>
          {note && <span className="muted">{note}</span>}
          <span className="grow" />
          {actions}
        </header>
        {children}
      </div>
    </li>
  );
}

function Targeting({ draft, setDraft, targets, setTargets }: { draft: Flag; setDraft: (flag: Flag) => void; targets: Target[]; setTargets: (targets: Target[]) => void }) {
  const env = useEnv();
  const segments = Object.values(env.segments);
  const others = Object.values(env.flags).filter((flag) => flag.key !== draft.key);
  const setRule = (index: number, rule: Rule) => setDraft({ ...draft, rules: draft.rules.map((r, i) => (i === index ? rule : r)) });
  const move = (index: number, by: number) => {
    const rules = [...draft.rules];
    const [rule] = rules.splice(index, 1);
    rules.splice(index + by, 0, rule);
    setDraft({ ...draft, rules });
  };

  return (
    <div className={`targeting ${draft.on ? '' : 'targeting-off'}`}>
      <datalist id="attributes">{ATTRIBUTES.map((a) => <option key={a} value={a} />)}</datalist>
      {!draft.on && (
        <div className="notice">
          <Icon name="alert" />
          <span>This flag is off, so everyone gets <strong>{show(draft.variations[draft.offVariation])}</strong>. The steps below start working when you turn it on.</span>
        </div>
      )}

      <ol className="flow">
        {draft.prerequisites.length > 0 && (
          <Step title="Prerequisites" note="If any of these is not met, the flag behaves as if it were off.">
            {draft.prerequisites.map((prerequisite, i) => {
              const other = env.flags[prerequisite.key];
              const update = (next: { key: string; variation: number }) => setDraft({ ...draft, prerequisites: draft.prerequisites.map((p, j) => (j === i ? next : p)) });
              return (
                <div className="line" key={i}>
                  <select aria-label="Flag" value={prerequisite.key} onChange={(event) => update({ key: event.target.value, variation: 0 })}>
                    {!other && <option value={prerequisite.key}>{prerequisite.key} (missing)</option>}
                    {others.map((flag) => <option key={flag.key} value={flag.key}>{flag.name || flag.key}</option>)}
                  </select>
                  <span className="muted">must be serving</span>
                  <select aria-label="Variation" value={prerequisite.variation} onChange={(event) => update({ ...prerequisite, variation: Number(event.target.value) })}>
                    {(other?.variations ?? [prerequisite.variation]).map((value, j) => <option key={j} value={j}>{show(value)}</option>)}
                  </select>
                  <Button kind="ghost" small icon="x" aria-label="Remove prerequisite" onClick={() => setDraft({ ...draft, prerequisites: draft.prerequisites.filter((_, j) => j !== i) })} />
                </div>
              );
            })}
          </Step>
        )}

        {targets.length > 0 && (
          <Step title="Individual targets" note="Named people or accounts, checked first.">
            {targets.map((target, i) => {
              const update = (next: Target) => setTargets(targets.map((t, j) => (j === i ? next : t)));
              return (
                <div className="line line-target" key={i}>
                  <span className="muted">Serve</span>
                  <span className="pick">
                    <Swatch color={variationColor(draft, target.variation)} />
                    <select aria-label="Variation" value={target.variation} onChange={(event) => update({ ...target, variation: Number(event.target.value) })}>
                      {draft.variations.map((value, j) => <option key={j} value={j}>{show(value)}</option>)}
                    </select>
                  </span>
                  <span className="muted">to</span>
                  <input className="clause-kind" aria-label="Context kind" value={target.contextKind ?? 'user'} onChange={(event) => update({ ...target, contextKind: event.target.value.trim() || 'user' })} />
                  <Chips label="Keys" values={target.values} placeholder="Keys, one per line or comma separated" onChange={(values) => update({ ...target, values: values as string[] })} />
                  <Button kind="ghost" small icon="x" aria-label="Remove these targets" onClick={() => setTargets(targets.filter((_, j) => j !== i))} />
                </div>
              );
            })}
          </Step>
        )}

        {draft.rules.map((rule, i) => (
          <Step
            key={rule.id}
            title={`Rule ${i + 1}`}
            note={<input className="rule-name" aria-label={`Name of rule ${i + 1}`} placeholder="Add a name" value={rule.description ?? ''} onChange={(event) => setRule(i, { ...rule, description: event.target.value || undefined })} />}
            actions={
              <>
                <Button kind="ghost" small icon="up" aria-label={`Move rule ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                <Button kind="ghost" small icon="down" aria-label={`Move rule ${i + 1} down`} disabled={i === draft.rules.length - 1} onClick={() => move(i, 1)} />
                <Button kind="ghost" small icon="trash" aria-label={`Remove rule ${i + 1}`} onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })} />
              </>
            }
          >
            <div className="rule">
              {rule.clauses.map((clause, j) => (
                <div className="rule-line" key={j}>
                  <span className="word">{j === 0 ? 'If' : 'and'}</span>
                  <ClauseEditor
                    clause={clause}
                    segments={segments}
                    onChange={(next) => setRule(i, { ...rule, clauses: rule.clauses.map((c, k) => (k === j ? next : c)) })}
                    onRemove={rule.clauses.length > 1 ? () => setRule(i, { ...rule, clauses: rule.clauses.filter((_, k) => k !== j) }) : undefined}
                  />
                </div>
              ))}
              <div className="rule-line">
                <span className="word" />
                <Button small icon="plus" onClick={() => setRule(i, { ...rule, clauses: [...rule.clauses, newClause()] })}>Add condition</Button>
              </div>
              <div className="rule-line rule-serve">
                <span className="word">serve</span>
                <ServeEditor flag={draft} serve={rule} label={`What rule ${i + 1} serves`} onChange={(serve) => { const { variation, rollout, ...rest } = rule; setRule(i, { ...rest, ...serve }); }} />
              </div>
            </div>
          </Step>
        ))}

        <li className="step step-add">
          <span className="step-node step-node-add" aria-hidden="true" />
          <div className="add-row">
            <Button small icon="plus" onClick={() => setDraft({ ...draft, rules: [...draft.rules, { id: newId(), clauses: [newClause()], variation: 0 }] })}>Add rule</Button>
            <Button small icon="plus" onClick={() => setTargets([...targets, { contextKind: 'user', values: [], variation: 0 }])}>Add individual targets</Button>
            {others.length > 0 && (
              <Button small icon="plus" onClick={() => setDraft({ ...draft, prerequisites: [...draft.prerequisites, { key: others[0].key, variation: 0 }] })}>Add prerequisite</Button>
            )}
          </div>
        </li>

        <Step title="Default rule" note={draft.rules.length || targets.length ? 'Everyone the steps above did not catch.' : 'Everyone.'} tone="last">
          <div className="rule-line rule-serve">
            <span className="word">serve</span>
            <ServeEditor flag={draft} serve={draft.fallthrough} label="What the default rule serves" onChange={(serve) => setDraft({ ...draft, fallthrough: serve })} />
          </div>
        </Step>
      </ol>

      <div className="off-rule">
        <span>When the flag is off, serve</span>
        <span className="pick">
          <Swatch color={variationColor(draft, draft.offVariation)} />
          <select aria-label="Variation served when off" value={draft.offVariation} onChange={(event) => setDraft({ ...draft, offVariation: Number(event.target.value) })}>
            {draft.variations.map((value, i) => <option key={i} value={i}>{show(value)}</option>)}
          </select>
        </span>
      </div>
    </div>
  );
}

// ---- Variations -----------------------------------------------------------------------

function VariationInput({ flag, index, onChange }: { flag: Flag; index: number; onChange: (value: unknown) => void }) {
  const type = flagType(flag);
  const [text, setText] = useState(() => show(flag.variations[index]));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(show(flag.variations[index])), [flag.variations[index]]);
  return (
    <div className="variation-edit">
      <input
        className="mono"
        aria-label={`Value of variation ${index + 1}`}
        aria-invalid={!!error}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          try {
            onChange(parseVariation(type === 'boolean' ? 'json' : type, text));
            setError(null);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

function Variations({ draft, setDraft }: { draft: Flag; setDraft: (flag: Flag) => void }) {
  const type = flagType(draft);
  const last = draft.variations.length - 1;
  return (
    <section className="panel">
      <p className="muted">The values your code can receive. {type === 'boolean' ? 'An on or off flag always has exactly true and false.' : 'Changing a value changes it for everyone already receiving it.'}</p>
      <div className="variation-list">
        {draft.variations.map((value, i) => (
          <div className="row" key={i}>
            <Swatch color={variationColor(draft, i)} />
            {type === 'boolean' ? <span className="mono variation-fixed">{show(value)}</span> : <VariationInput flag={draft} index={i} onChange={(next) => setDraft({ ...draft, variations: draft.variations.map((v, j) => (j === i ? next : v)) })} />}
            {type !== 'boolean' && i === last && draft.variations.length > 2 && (
              <Button kind="ghost" small icon="x" aria-label={`Remove variation ${i + 1}`} disabled={variationInUse(draft, i)} title={variationInUse(draft, i) ? 'In use by a rule or target' : undefined} onClick={() => setDraft({ ...draft, variations: draft.variations.slice(0, -1) })} />
            )}
          </div>
        ))}
      </div>
      {type !== 'boolean' && (
        <Button small icon="plus" onClick={() => setDraft({ ...draft, variations: [...draft.variations, type === 'number' ? 0 : type === 'string' ? `variation-${draft.variations.length + 1}` : {}] })}>
          Add variation
        </Button>
      )}
    </section>
  );
}

// ---- Numbers ------------------------------------------------------------------------------

function Insights({ flag }: { flag: Flag }) {
  const env = useEnv();
  const days = useMemo(() => lastDays(14), []);
  const series = env.series[flag.key] ?? {};
  const names = flag.variations.map((value) => JSON.stringify(value));
  const totals = days.map((day) => Object.values(series[day] ?? {}).reduce((sum, n) => sum + n, 0));
  const max = Math.max(1, ...totals);
  const week = env.evals[flag.key] ?? {};
  const weekTotal = Object.values(week).reduce((sum, n) => sum + n, 0);
  const colorOf = (name: string) => (names.includes(name) ? variationColor(flag, names.indexOf(name)) : '#5E5E5B');

  if (!Object.keys(series).length) {
    return <Empty title="No evaluations yet">Numbers appear here once an SDK connected to {env.name} asks for this flag. SDKs report in batches, so it can take a minute.</Empty>;
  }
  return (
    <section className="panel">
      <div className="chart" role="img" aria-label={`Evaluations per day for the last 14 days, ${compact(totals.reduce((a, b) => a + b, 0))} in total`}>
        {days.map((day, i) => (
          <div className="chart-day" key={day} title={`${day}: ${totals[i].toLocaleString()}`}>
            <div className="chart-bar" style={{ height: `${(totals[i] / max) * 100}%` }}>
              {Object.entries(series[day] ?? {}).map(([name, count]) => <i key={name} style={{ flexGrow: count, background: colorOf(name) }} />)}
            </div>
            <span>{i % 2 === 1 || i === days.length - 1 ? Number(day.slice(8)) : ''}</span>
          </div>
        ))}
      </div>
      <div className="table table-plain" role="table" aria-label="Evaluations by variation, last 7 days">
        <div className="thead" role="row"><span role="columnheader">Variation, last 7 days</span><span role="columnheader" className="num">Evaluations</span><span role="columnheader" className="num">Share</span></div>
        {Object.entries(week).sort((a, b) => b[1] - a[1]).map(([name, count]) => (
          <div className="trow" role="row" key={name}>
            <span role="cell" className="variation"><Swatch color={colorOf(name)} /><span className="variation-value">{names.includes(name) ? show(flag.variations[names.indexOf(name)]) : name}</span></span>
            <span role="cell" className="num">{count.toLocaleString()}</span>
            <span role="cell" className="num muted">{weekTotal ? `${((count / weekTotal) * 100).toFixed(1)}%` : ''}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function History({ flagKey }: { flagKey: string }) {
  const env = useEnv();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    api.audit({ env: env.id, kind: 'flags', key: flagKey, limit: 200 }).then(setEntries, () => setEntries([]));
  }, [env.id, flagKey, env.flags[flagKey]?.version]);
  if (!entries) return <div className="loading" aria-label="Loading" />;
  if (!entries.length) return <Empty title="No recorded changes">Changes made from now on are listed here, with who made them and the note they added.</Empty>;
  return <section className="panel"><AuditList entries={entries} showKey={false} /></section>;
}

// ---- The page ---------------------------------------------------------------------------------

type Tab = 'targeting' | 'variations' | 'insights' | 'history' | 'settings';

export function FlagPage({ flagKey }: { flagKey: string }) {
  const { reload, me } = useApp();
  const canWrite = useCan()('writer');
  const env = useEnv();
  const toast = useToast();
  const saved = env.flags[flagKey] as Flag | undefined;
  const [tab, setTab] = useState<Tab>('targeting');
  const [base, setBase] = useState(saved);
  const [draft, setDraft] = useState(saved);
  const [targets, setTargets] = useState<Target[]>(() => (saved ? individualTargets(saved) : []));
  const [reviewing, setReviewing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [comment, setComment] = useState('');

  const edited = useMemo(() => (draft ? { ...draft, ...splitTargets(targets) } : undefined), [draft, targets]);
  const changes = useMemo(() => (base && edited ? flagChanges(base, edited) : []), [base, edited]);
  const problems = useMemo(() => (edited ? flagProblems(edited) : []), [edited]);
  const dirty = changes.length > 0;
  const stale = !!saved && !!base && saved.version !== base.version;

  const adopt = (flag: Flag) => {
    setBase(flag);
    setDraft(flag);
    setTargets(individualTargets(flag));
  };
  // Changes made elsewhere are picked up straight away unless there are edits here to protect.
  useEffect(() => {
    if (saved && stale && !dirty) adopt(saved);
  }, [saved, stale, dirty]);
  useEffect(() => {
    setUnsaved(dirty);
    return () => setUnsaved(false);
  }, [dirty]);

  if (!saved || !draft || !edited || !base) {
    return (
      <div className="page">
        <Empty title="This flag does not exist" action={<a className="btn btn-default" href={href(env.id, 'flags')}>Back to flags</a>}>
          There is no flag with the key “{flagKey}” in {env.name}. It may have been deleted, or it may live in another environment.
        </Empty>
      </div>
    );
  }

  const reach = audience(draft);
  const save = async () => {
    const { version, updatedAt, deleted, key, ...body } = edited;
    let result: Flag;
    try {
      result = await api.saveFlag(env.id, flagKey, body, comment.trim(), base.version);
    } catch (e) {
      // Someone else saved first: fetch their version so the warning above the editor appears.
      if (e instanceof ApiError && e.status === 409) await reload();
      throw e;
    }
    adopt(result);
    setComment('');
    await reload();
    toast('Changes saved and sent to connected SDKs');
  };

  return (
    <div className="page page-flag">
      <header className="flag-head">
        <div className="flag-title">
          <h1>{draft.name || draft.key}</h1>
          <div className="flag-meta">
            <code>{draft.key}</code>
            <CopyButton value={draft.key} label="Copy key" />
            {draft.description && <span className="muted">{draft.description}</span>}
          </div>
        </div>
        <label className={`master ${draft.on ? 'master-on' : ''}`}>
          <span>{draft.on ? 'On' : 'Off'}</span>
          <Toggle on={draft.on} label={`Turn ${draft.on ? 'off' : 'on'} ${draft.key}`} onChange={(on) => setDraft({ ...draft, on })} />
        </label>
      </header>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'targeting', label: 'Targeting', count: draft.rules.length + targets.length || undefined },
          { id: 'variations', label: 'Variations', count: draft.variations.length },
          { id: 'insights', label: 'Evaluations' },
          { id: 'history', label: 'History' },
          { id: 'settings', label: 'Settings' },
        ]}
      />

      {stale && dirty && (
        <div className="notice notice-warn">
          <Icon name="alert" />
          <span>This flag was changed somewhere else while you were editing. Saving now would overwrite that change.</span>
          <Button small onClick={() => adopt(saved)}>Discard my edits and load it</Button>
        </div>
      )}

      {tab === 'targeting' && <Targeting draft={draft} setDraft={setDraft} targets={targets} setTargets={setTargets} />}
      {tab === 'variations' && <Variations draft={draft} setDraft={setDraft} />}
      {tab === 'insights' && <Insights flag={saved} />}
      {tab === 'history' && <History flagKey={flagKey} />}
      {tab === 'settings' && (
        <section className="panel form">
          <Field label="Name">{(id) => <input id={id} maxLength={120} value={draft.name ?? ''} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />}</Field>
          <Field label="Description">{(id) => <textarea id={id} rows={2} maxLength={500} value={draft.description ?? ''} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />}</Field>
          <div className="field">
            <label>Tags</label>
            <Chips label="Tags" values={draft.tags ?? []} placeholder="Type a tag, press Enter" onChange={(tags) => setDraft({ ...draft, tags: tags as string[] })} />
          </div>
          <fieldset className="checks">
            <legend>Who can read it, besides server SDKs</legend>
            <label className="check">
              <input type="checkbox" checked={reach.browser} onChange={(event) => setDraft({ ...draft, clientSideAvailability: { usingEnvironmentId: event.target.checked, usingMobileKey: reach.mobile } })} />
              Browser SDKs, using the client-side ID
            </label>
            <label className="check">
              <input type="checkbox" checked={reach.mobile} onChange={(event) => setDraft({ ...draft, clientSideAvailability: { usingEnvironmentId: reach.browser, usingMobileKey: event.target.checked } })} />
              Mobile SDKs, using the mobile key
            </label>
          </fieldset>
          <div className="danger-zone">
            <div>
              <strong>Delete this flag</strong>
              <p className="muted">SDKs fall back to the default value written in your code.</p>
            </div>
            <Button kind="danger" disabled={!canWrite} onClick={() => setDeleting(true)}>Delete flag</Button>
          </div>
        </section>
      )}

      {dirty && (
        <div className="savebar" role="region" aria-label="Unsaved changes">
          <div className="savebar-text">
            <strong>{changes.length} unsaved {changes.length === 1 ? 'change' : 'changes'}</strong>
            <span className="muted">{canWrite ? problems[0] ?? changes[0] : `Your role is ${me.role}, which can look but not save.`}</span>
          </div>
          <Button onClick={() => adopt(base)}>Discard</Button>
          <Button kind="primary" disabled={!canWrite} onClick={() => setReviewing(true)}>Review and save</Button>
        </div>
      )}

      {reviewing && (
        <Modal title={`Review changes to ${draft.name || draft.key}`} onClose={() => setReviewing(false)} wide>
          <ModalForm submit={`Save to ${env.name}`} onClose={() => setReviewing(false)} disabled={problems.length > 0} onSubmit={save}>
            <ul className="review">
              {changes.map((change) => <li key={change}><Icon name="check" size={14} />{change}</li>)}
            </ul>
            {problems.length > 0 && (
              <div className="notice notice-error">
                <Icon name="alert" />
                <div>
                  <strong>Fix these before saving</strong>
                  <ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
                </div>
              </div>
            )}
            <p className="muted">
              After saving, {edited.on ? <>this flag serves by its rules, with <strong>{describeServe(edited, edited.fallthrough)}</strong> as the default.</> : <>this flag is off and everyone gets <strong>{show(edited.variations[edited.offVariation])}</strong>.</>} Connected SDKs get the change within moments.
            </p>
            <Field label="Note for the activity log (optional)">
              {(id) => <input id={id} maxLength={280} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Why this change?" />}
            </Field>
          </ModalForm>
        </Modal>
      )}

      {deleting && (
        <Modal title={`Delete ${draft.key}?`} onClose={() => setDeleting(false)}>
          <ModalForm
            danger
            submit="Delete flag"
            onClose={() => setDeleting(false)}
            onSubmit={async () => {
              await api.deleteFlag(env.id, flagKey);
              setUnsaved(false);
              await reload();
              toast(`Deleted ${flagKey}`);
              go(href(env.id, 'flags'));
            }}
          >
            <p>Every SDK asking for <code>{draft.key}</code> gets the default value written in your code from now on. The flag and its rules are erased and cannot be brought back.</p>
          </ModalForm>
        </Modal>
      )}
    </div>
  );
}

export { VariationPill, formatPercent };
