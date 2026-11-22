// Segments: reusable groups of people that flag rules can point at.
import { useEffect, useMemo, useState } from 'react';
import { api, type Flag, type Segment } from './api';
import { ago, describeClause, newClause, newId, segmentChanges, clauseProblem } from './model';
import { go, href, setUnsaved, useApp, useEnv } from './state';
import { Button, Chips, CopyButton, Empty, Field, Icon, Modal, ModalForm, useToast } from './ui';
import { ClauseEditor } from './flag';

const usedBy = (flags: Record<string, Flag>, segmentKey: string) =>
  Object.values(flags).filter((flag) => flag.rules.some((rule) => rule.clauses.some((clause) => clause.op === 'segmentMatch' && clause.values.includes(segmentKey))));

const size = (segment: Segment) => {
  const included = segment.included.length + segment.includedContexts.reduce((sum, t) => sum + t.values.length, 0);
  const parts = [];
  if (included) parts.push(`${included} included by key`);
  if (segment.rules.length) parts.push(`${segment.rules.length} ${segment.rules.length === 1 ? 'rule' : 'rules'}`);
  if (segment.excluded.length) parts.push(`${segment.excluded.length} excluded`);
  return parts.join(', ') || 'Empty';
};

const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

function NewSegment({ onClose }: { onClose: () => void }) {
  const { env, reload } = useApp();
  const [name, setName] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const segmentKey = key ?? slug(name);
  const taken = !!env!.segments[segmentKey];
  return (
    <Modal title="New segment" onClose={onClose}>
      <ModalForm
        submit="Create segment"
        onClose={onClose}
        disabled={!segmentKey || taken}
        onSubmit={async () => {
          if (!/^[A-Za-z0-9._-]+$/.test(segmentKey)) throw new Error('A key can use letters, numbers, dots, dashes and underscores.');
          await api.saveSegment(env!.id, segmentKey, { name: name.trim() || segmentKey, description: '' });
          await reload();
          go(href(env!.id, 'segments', segmentKey));
        }}
      >
        <Field label="Name">{(id) => <input id={id} autoFocus maxLength={120} placeholder="Beta testers" value={name} onChange={(event) => setName(event.target.value)} />}</Field>
        <Field label="Key" error={taken ? 'A segment with this key already exists.' : null} hint="Flag rules refer to the segment by this key. It cannot be changed later.">
          {(id) => <input id={id} className="mono" maxLength={256} placeholder="beta-testers" value={segmentKey} onChange={(event) => setKey(event.target.value)} />}
        </Field>
      </ModalForm>
    </Modal>
  );
}

export function SegmentList() {
  const env = useEnv();
  const [creating, setCreating] = useState(false);
  const segments = Object.values(env.segments).sort((a, b) => (a.name || a.key).localeCompare(b.name || b.key));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Segments</h1>
          <p className="muted">Groups of people you can name once and use in any flag’s rules.</p>
        </div>
        <Button kind="primary" icon="plus" onClick={() => setCreating(true)}>New segment</Button>
      </header>
      {segments.length === 0 ? (
        <Empty title="No segments yet" action={<Button kind="primary" icon="plus" onClick={() => setCreating(true)}>New segment</Button>}>
          A segment is a list like “beta testers” or “enterprise accounts”. Define it here, then add a rule to a flag that says “is in segment”.
        </Empty>
      ) : (
        <div className="table table-segments" role="table" aria-label="Segments">
          <div className="thead" role="row"><span role="columnheader">Segment</span><span role="columnheader">Who is in it</span><span role="columnheader">Used by</span><span role="columnheader" className="num">Changed</span></div>
          {segments.map((segment) => {
            const flags = usedBy(env.flags, segment.key);
            return (
              <div className="trow" role="row" key={segment.key}>
                <a role="cell" className="flag-cell" href={href(env.id, 'segments', segment.key)}>
                  <span className="flag-name">{segment.name || segment.key}</span>
                  <span className="flag-key">{segment.key}</span>
                </a>
                <span role="cell" className="muted">{size(segment)}</span>
                <span role="cell" className="muted">{flags.length ? `${flags.length} ${flags.length === 1 ? 'flag' : 'flags'}` : 'No flags'}</span>
                <span role="cell" className="num muted">{ago(segment.updatedAt) || 'Earlier'}</span>
              </div>
            );
          })}
        </div>
      )}
      {creating && <NewSegment onClose={() => setCreating(false)} />}
    </div>
  );
}

export function SegmentPage({ segmentKey }: { segmentKey: string }) {
  const { reload } = useApp();
  const env = useEnv();
  const toast = useToast();
  const saved = env.segments[segmentKey] as Segment | undefined;
  const [base, setBase] = useState(saved);
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const changes = useMemo(() => (base && draft ? segmentChanges(base, draft) : []), [base, draft]);
  const problems = useMemo(() => (draft ? draft.rules.flatMap((rule, i) => rule.clauses.map(clauseProblem).filter(Boolean).map((p) => `Rule ${i + 1}: ${p}`)) : []), [draft]);
  const dirty = changes.length > 0;
  useEffect(() => {
    if (saved && base && saved.version !== base.version && !dirty) {
      setBase(saved);
      setDraft(saved);
    }
  }, [saved, base, dirty]);
  useEffect(() => {
    setUnsaved(dirty);
    return () => setUnsaved(false);
  }, [dirty]);

  if (!saved || !draft || !base) {
    return (
      <div className="page">
        <Empty title="This segment does not exist" action={<a className="btn btn-default" href={href(env.id, 'segments')}>Back to segments</a>}>
          There is no segment with the key “{segmentKey}” in {env.name}.
        </Empty>
      </div>
    );
  }

  const flags = usedBy(env.flags, segmentKey);
  const save = async () => {
    setBusy(true);
    try {
      const { version, updatedAt, deleted, key, ...body } = draft;
      const result = await api.saveSegment(env.id, segmentKey, body);
      setBase(result);
      setDraft(result);
      await reload();
      toast('Segment saved and sent to connected SDKs');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page-flag">
      <a className="back" href={href(env.id, 'segments')}><Icon name="back" size={14} />Segments</a>
      <header className="flag-head">
        <div className="flag-title">
          <h1>{draft.name || draft.key}</h1>
          <div className="flag-meta">
            <code>{draft.key}</code>
            <CopyButton value={draft.key} label="Copy key" />
            <span className="muted">{flags.length ? <>Used by {flags.map((flag, i) => <span key={flag.key}>{i ? ', ' : ''}<a href={href(env.id, 'flags', flag.key)}>{flag.name || flag.key}</a></span>)}</> : 'Not used by any flag yet'}</span>
          </div>
        </div>
      </header>

      <section className="panel form">
        <div className="field">
          <label>Always in this segment</label>
          <Chips label="Included user keys" values={draft.included} placeholder="User keys, one per line or comma separated" onChange={(values) => setDraft({ ...draft, included: values as string[] })} />
        </div>
        <div className="field">
          <label>Never in this segment</label>
          <Chips label="Excluded user keys" values={draft.excluded} placeholder="User keys that are left out even if a rule matches" onChange={(values) => setDraft({ ...draft, excluded: values as string[] })} />
        </div>

        <div className="field">
          <label>Also anyone who matches a rule</label>
          {draft.rules.map((rule, i) => (
            <div className="segment-rule" key={rule.id}>
              <div className="rule">
                {rule.clauses.map((clause, j) => (
                  <div className="rule-line" key={j}>
                    <span className="word">{j === 0 ? 'If' : 'and'}</span>
                    <ClauseEditor
                      clause={clause}
                      segments={Object.values(env.segments).filter((s) => s.key !== segmentKey)}
                      onChange={(next) => setDraft({ ...draft, rules: draft.rules.map((r, k) => (k === i ? { ...r, clauses: r.clauses.map((c, m) => (m === j ? next : c)) } : r)) })}
                      onRemove={rule.clauses.length > 1 ? () => setDraft({ ...draft, rules: draft.rules.map((r, k) => (k === i ? { ...r, clauses: r.clauses.filter((_, m) => m !== j) } : r)) }) : undefined}
                    />
                  </div>
                ))}
                <div className="rule-line">
                  <span className="word" />
                  <Button small icon="plus" onClick={() => setDraft({ ...draft, rules: draft.rules.map((r, k) => (k === i ? { ...r, clauses: [...r.clauses, newClause()] } : r)) })}>Add condition</Button>
                  <span className="grow" />
                  <Button small kind="ghost" icon="trash" onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, k) => k !== i) })}>Remove rule</Button>
                </div>
              </div>
            </div>
          ))}
          <div><Button small icon="plus" onClick={() => setDraft({ ...draft, rules: [...draft.rules, { id: newId(), clauses: [newClause()] }] })}>Add rule</Button></div>
        </div>

        <Field label="Name">{(id) => <input id={id} maxLength={120} value={draft.name ?? ''} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />}</Field>
        <Field label="Description">{(id) => <textarea id={id} rows={2} maxLength={500} value={draft.description ?? ''} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />}</Field>

        <div className="danger-zone">
          <div>
            <strong>Delete this segment</strong>
            <p className="muted">{flags.length ? `${flags.length} ${flags.length === 1 ? 'flag uses' : 'flags use'} it. Their “is in segment” rules stop matching anyone.` : 'No flag uses it.'}</p>
          </div>
          <Button kind="danger" onClick={() => setDeleting(true)}>Delete segment</Button>
        </div>
      </section>

      {dirty && (
        <div className="savebar" role="region" aria-label="Unsaved changes">
          <div className="savebar-text">
            <strong>{changes.length} unsaved {changes.length === 1 ? 'change' : 'changes'}</strong>
            <span className="muted">{problems[0] ?? changes.join(', ')}</span>
          </div>
          <Button onClick={() => setDraft(base)}>Discard</Button>
          <Button kind="primary" disabled={busy || problems.length > 0} onClick={save}>{busy ? 'Saving…' : 'Save segment'}</Button>
        </div>
      )}

      {deleting && (
        <Modal title={`Delete ${draft.key}?`} onClose={() => setDeleting(false)}>
          <ModalForm
            danger
            submit="Delete segment"
            onClose={() => setDeleting(false)}
            onSubmit={async () => {
              await api.deleteSegment(env.id, segmentKey);
              setUnsaved(false);
              await reload();
              toast(`Deleted ${segmentKey}`);
              go(href(env.id, 'segments'));
            }}
          >
            <p>The segment is erased and cannot be brought back.{flags.length > 0 && <> Rules in {flags.map((flag) => flag.name || flag.key).join(', ')} that point at it stop matching anyone.</>}</p>
          </ModalForm>
        </Modal>
      )}
    </div>
  );
}

export { describeClause };
