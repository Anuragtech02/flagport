// The flag list, creating a flag, and switching one on or off.
import { useMemo, useState } from 'react';
import { api, type Flag } from './api';
import { ago, audience, compact, describeFlag, describeServe, flagType, lastDays, show, variationColor, type FlagType } from './model';
import { go, href, useApp, useEnv } from './state';
import { Button, Empty, Field, Icon, Modal, ModalForm, Spark, Swatch, Toggle, useToast } from './ui';

export function VariationPill({ flag, index }: { flag: Pick<Flag, 'variations'>; index: number }) {
  return (
    <span className="variation">
      <Swatch color={variationColor(flag, index)} />
      <span className="variation-value">{show(flag.variations[index])}</span>
    </span>
  );
}

/** What a flag is serving right now, as colour swatches and a sentence. */
export function Serving({ flag }: { flag: Flag }) {
  const serve = flag.on ? flag.fallthrough : { variation: flag.offVariation };
  const parts = serve.rollout ? serve.rollout.variations.filter((v) => v.weight > 0) : [{ variation: serve.variation ?? 0, weight: 100000 }];
  return (
    <div className="serving">
      <span className="split" aria-hidden="true">
        {parts.map((part) => <i key={part.variation} style={{ flexGrow: part.weight, background: variationColor(flag, part.variation) }} />)}
      </span>
      <span className="serving-text">{describeFlag(flag)}</span>
    </div>
  );
}

export const dailyTotals = (series: Record<string, Record<string, number>> | undefined, days: string[]) =>
  days.map((day) => Object.values(series?.[day] ?? {}).reduce((sum, n) => sum + n, 0));

/** Asks before a flag changes for everyone, and takes an optional note for the activity log. */
export function SwitchFlag({ flag, onClose }: { flag: Flag; onClose: () => void }) {
  const { env, reload } = useApp();
  const toast = useToast();
  const [comment, setComment] = useState('');
  const turningOn = !flag.on;
  const after = { ...flag, on: turningOn };
  return (
    <Modal title={`Turn ${turningOn ? 'on' : 'off'} ${flag.name || flag.key}?`} onClose={onClose}>
      <ModalForm
        submit={turningOn ? 'Turn on' : 'Turn off'}
        onClose={onClose}
        onSubmit={async () => {
          const { version, updatedAt, deleted, key, ...body } = after;
          await api.saveFlag(env!.id, flag.key, body, comment.trim());
          await reload();
          toast(`${flag.key} is ${turningOn ? 'on' : 'off'}`);
        }}
      >
        <p>
          {turningOn
            ? <>Targeting starts straight away in <strong>{env!.name}</strong>: {describeFlag(after).replace(/^Serving/, 'serving')}.</>
            : <>Everyone in <strong>{env!.name}</strong> gets <strong>{describeServe(flag, { variation: flag.offVariation })}</strong> straight away.</>}
        </p>
        <Field label="Note for the activity log (optional)">
          {(id) => <input id={id} maxLength={280} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Why this change?" />}
        </Field>
      </ModalForm>
    </Modal>
  );
}

const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

const TYPES: { id: FlagType; label: string; hint: string; defaults: string[] }[] = [
  { id: 'boolean', label: 'On or off', hint: 'true or false', defaults: [] },
  { id: 'string', label: 'Text', hint: 'for example a layout name', defaults: ['control', 'treatment'] },
  { id: 'number', label: 'Number', hint: 'for example a limit', defaults: ['10', '25'] },
  { id: 'json', label: 'JSON', hint: 'a structured value', defaults: ['{"enabled": false}', '{"enabled": true}'] },
];

export function parseVariation(type: FlagType, text: string): unknown {
  if (type === 'string') return text;
  if (type === 'number') {
    const n = Number(text);
    if (text.trim() === '' || Number.isNaN(n)) throw new Error(`“${text}” is not a number.`);
    return n;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`“${text}” is not valid JSON.`);
  }
}

function NewFlag({ onClose }: { onClose: () => void }) {
  const { env, reload } = useApp();
  const [name, setName] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [type, setType] = useState<FlagType>('boolean');
  const [values, setValues] = useState<string[]>([]);
  const [browser, setBrowser] = useState(false);
  const [mobile, setMobile] = useState(false);
  const flagKey = key ?? slug(name);
  const taken = !!env!.flags[flagKey];

  return (
    <Modal title="New flag" onClose={onClose} wide>
      <ModalForm
        submit="Create flag"
        onClose={onClose}
        disabled={!flagKey || taken}
        onSubmit={async () => {
          if (!/^[A-Za-z0-9._-]+$/.test(flagKey)) throw new Error('A key can use letters, numbers, dots, dashes and underscores.');
          const variations = type === 'boolean' ? [true, false] : values.map((value) => parseVariation(type, value));
          if (variations.length < 2) throw new Error('A flag needs at least two variations.');
          if (new Set(variations.map((v) => JSON.stringify(v))).size !== variations.length) throw new Error('Two variations have the same value.');
          await api.saveFlag(env!.id, flagKey, {
            name: name.trim() || flagKey,
            description: description.trim(),
            tags: [],
            on: false,
            variations,
            // Boolean flags serve true when on and false when off. Others serve the first variation
            // either way until rules say otherwise, so switching one on changes nothing by surprise.
            fallthrough: { variation: 0 },
            offVariation: type === 'boolean' ? 1 : 0,
            clientSideAvailability: { usingEnvironmentId: browser, usingMobileKey: mobile },
          });
          await reload();
          go(href(env!.id, 'flags', flagKey));
        }}
      >
        <div className="cols">
          <Field label="Name">
            {(id) => <input id={id} autoFocus maxLength={120} placeholder="New checkout" value={name} onChange={(event) => setName(event.target.value)} />}
          </Field>
          <Field label="Key" error={taken ? 'A flag with this key already exists.' : null} hint="What your code asks for. It cannot be changed later.">
            {(id) => <input id={id} className="mono" maxLength={256} placeholder="new-checkout" value={flagKey} onChange={(event) => setKey(event.target.value)} />}
          </Field>
        </div>
        <Field label="Description (optional)">
          {(id) => <input id={id} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What does this flag control?" />}
        </Field>

        <fieldset className="choices">
          <legend>What it returns</legend>
          {TYPES.map((option) => (
            <label key={option.id} className={type === option.id ? 'chosen' : ''}>
              <input type="radio" name="type" checked={type === option.id} onChange={() => { setType(option.id); setValues(option.defaults); }} />
              <strong>{option.label}</strong>
              <span>{option.hint}</span>
            </label>
          ))}
        </fieldset>

        {type !== 'boolean' && (
          <div className="field">
            <label>Variations</label>
            {values.map((value, i) => (
              <div className="row" key={i}>
                <Swatch color={variationColor({ variations: values }, i)} />
                <input className="mono" aria-label={`Variation ${i + 1}`} value={value} onChange={(event) => setValues(values.map((v, j) => (j === i ? event.target.value : v)))} />
                <Button kind="ghost" small icon="x" aria-label={`Remove variation ${i + 1}`} disabled={values.length <= 2} onClick={() => setValues(values.filter((_, j) => j !== i))} />
              </div>
            ))}
            <Button small icon="plus" onClick={() => setValues([...values, ''])}>Add variation</Button>
          </div>
        )}

        <fieldset className="checks">
          <legend>Who can read it, besides server SDKs</legend>
          <label className="check"><input type="checkbox" checked={browser} onChange={(event) => setBrowser(event.target.checked)} />Browser SDKs, using the client-side ID</label>
          <label className="check"><input type="checkbox" checked={mobile} onChange={(event) => setMobile(event.target.checked)} />Mobile SDKs, using the mobile key</label>
        </fieldset>
        <p className="field-hint">The flag is created switched off. Add targeting, then turn it on.</p>
      </ModalForm>
    </Modal>
  );
}

type Filter = 'all' | 'on' | 'off';
type Sort = 'changed' | 'name' | 'evaluations';

export function FlagList() {
  const env = useEnv();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('changed');
  const [creating, setCreating] = useState(false);
  const [switching, setSwitching] = useState<Flag | null>(null);
  const days = useMemo(() => lastDays(14), []);

  const all = Object.values(env.flags);
  const total = (flag: Flag) => Object.values(env.evals[flag.key] ?? {}).reduce((sum, n) => sum + n, 0);
  const flags = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((flag) => (filter === 'all' ? true : filter === 'on' ? flag.on : !flag.on))
      .filter((flag) => !q || flag.key.toLowerCase().includes(q) || (flag.name ?? '').toLowerCase().includes(q) || (flag.tags ?? []).some((tag) => tag.toLowerCase().includes(q)))
      .sort((a, b) => (sort === 'name' ? (a.name || a.key).localeCompare(b.name || b.key) : sort === 'evaluations' ? total(b) - total(a) : (b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
  }, [env, query, filter, sort]);

  const onCount = all.filter((flag) => flag.on).length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Flags</h1>
          <p className="muted">{all.length === 0 ? `Nothing in ${env.name} yet.` : `${all.length} in ${env.name}, ${onCount} switched on.`}</p>
        </div>
        <Button kind="primary" icon="plus" onClick={() => setCreating(true)}>New flag</Button>
      </header>

      {all.length === 0 ? (
        <Empty
          title="Create a flag, or bring yours across"
          action={
            <div className="empty-actions">
              <Button kind="primary" icon="plus" onClick={() => setCreating(true)}>New flag</Button>
              <a className="btn btn-default" href={href(env.id, 'settings')}>Import from LaunchDarkly</a>
            </div>
          }
        >
          A flag lets you change what your app does without deploying. Your code asks for it by key; you decide here who gets which value.
        </Empty>
      ) : (
        <>
          <div className="toolbar">
            <label className="search">
              <Icon name="search" />
              <input aria-label="Search flags" placeholder="Search by name, key or tag" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <div className="segmented" role="group" aria-label="Filter by state">
              {(['all', 'on', 'off'] as Filter[]).map((id) => (
                <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>
                  {id === 'all' ? 'All' : id === 'on' ? 'On' : 'Off'}
                </button>
              ))}
            </div>
            <select aria-label="Sort flags" value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
              <option value="changed">Recently changed</option>
              <option value="name">Name</option>
              <option value="evaluations">Most evaluated</option>
            </select>
          </div>

          <div className="table" role="table" aria-label="Flags">
            <div className="thead" role="row">
              <span role="columnheader" />
              <span role="columnheader">Flag</span>
              <span role="columnheader">Serving</span>
              <span role="columnheader" className="num">Evaluations, 7 days</span>
              <span role="columnheader" className="num">Changed</span>
            </div>
            {flags.map((flag) => {
              const reach = audience(flag);
              const named = !!flag.name && flag.name !== flag.key;
              return (
                <div className="trow" role="row" key={flag.key}>
                  <span role="cell"><Toggle on={flag.on} label={`${flag.on ? 'Turn off' : 'Turn on'} ${flag.key}`} onChange={() => setSwitching(flag)} /></span>
                  <a role="cell" className="flag-cell" href={href(env.id, 'flags', flag.key)}>
                    <span className={`flag-name ${named ? '' : 'mono'}`}>{named ? flag.name : flag.key}</span>
                    <span className="flag-key">
                      {named && <span className="flag-key-text">{flag.key}</span>}
                      {(flag.tags ?? []).slice(0, 3).map((tag) => <em key={tag} className="tag">{tag}</em>)}
                      {!reach.browser && !reach.mobile ? <em>server only</em> : !reach.browser ? <em>server and mobile</em> : !reach.mobile ? <em>server and browser</em> : null}
                    </span>
                  </a>
                  <span role="cell"><Serving flag={flag} /></span>
                  <span role="cell" className="num evals">
                    <Spark values={dailyTotals(env.series[flag.key], days)} />
                    <span>{total(flag) ? compact(total(flag)) : 'None'}</span>
                  </span>
                  <span role="cell" className="num muted">{ago(flag.updatedAt) || '—'}</span>
                </div>
              );
            })}
            {flags.length === 0 && <div className="trow-none">No flag matches. <button type="button" className="link" onClick={() => { setQuery(''); setFilter('all'); }}>Clear the search</button></div>}
          </div>
        </>
      )}

      {creating && <NewFlag onClose={() => setCreating(false)} />}
      {switching && <SwitchFlag flag={switching} onClose={() => setSwitching(null)} />}
    </div>
  );
}
