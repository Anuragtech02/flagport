// The audit log: who changed what, when, with the exact difference.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type AuditEntry, type AuditFilter, type Member } from './api';
import { ago } from './model';
import { href, useEnv } from './state';
import { Button, Empty, Icon, useToast } from './ui';

// ---- Differences ---------------------------------------------------------------

/** Bookkeeping fields that change on every save and say nothing about what the person did. */
const NOISE = ['version', 'updatedAt', 'deleted'];
const lines = (value: unknown): string[] => {
  if (value === null || value === undefined) return [];
  const cleaned = typeof value === 'object' ? Object.fromEntries(Object.entries(value as object).filter(([field]) => !NOISE.includes(field))) : value;
  return JSON.stringify(cleaned, null, 2).split('\n');
};

type Line = { mark: ' ' | '+' | '-'; text: string };

/** A line-by-line difference, by longest common subsequence. */
function difference(before: string[], after: string[]): Line[] {
  if (before.length * after.length > 1_500_000) return [...before.map((text) => ({ mark: '-' as const, text })), ...after.map((text) => ({ mark: '+' as const, text }))];
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * width + j] = before[i] === after[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out: Line[] = [];
  let i = 0, j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) { out.push({ mark: ' ', text: before[i] }); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) out.push({ mark: '-', text: before[i++] });
    else out.push({ mark: '+', text: after[j++] });
  }
  while (i < before.length) out.push({ mark: '-', text: before[i++] });
  while (j < after.length) out.push({ mark: '+', text: after[j++] });
  return out;
}

function Diff({ before, after }: { before: unknown; after: unknown }) {
  const rows = useMemo(() => {
    const all = difference(lines(before), lines(after));
    // Only the changed lines, with two unchanged lines either side for bearings.
    const keep = all.map((line, i) => line.mark !== ' ' || all.slice(Math.max(0, i - 2), i + 3).some((near) => near.mark !== ' '));
    const shown: (Line | null)[] = [];
    all.forEach((line, i) => {
      if (keep[i]) shown.push(line);
      else if (shown.length && shown[shown.length - 1] !== null) shown.push(null);
    });
    while (shown.length && shown[shown.length - 1] === null) shown.pop();
    return shown;
  }, [before, after]);
  if (!rows.some((row) => row && row.mark !== ' ')) return <p className="diff-none">Nothing in the stored configuration changed.</p>;
  return (
    <pre className="diff" aria-label="What changed">
      {rows.map((row, i) => (row ? <span key={i} className={row.mark === '+' ? 'diff-add' : row.mark === '-' ? 'diff-del' : ''}>{row.mark} {row.text}{'\n'}</span> : <span key={i} className="diff-gap">{'  ⋯\n'}</span>))}
    </pre>
  );
}

// ---- The list ------------------------------------------------------------------

export function AuditList({ entries, showKey, showEnv }: { entries: AuditEntry[]; showKey: boolean; showEnv?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <ul className="activity">
      {entries.map((entry) => {
        const linked = showKey && entry.key && entry.envId && (entry.kind === 'flags' || entry.kind === 'segments');
        const detailed = entry.before !== null || entry.after !== null;
        return (
          <li key={entry.id} className={open === entry.id ? 'activity-open' : ''}>
            <span className={`activity-mark activity-${entry.action}`} aria-hidden="true" />
            <div className="activity-main">
              <p>
                {linked && <><a className="mono" href={href(entry.envId!, entry.kind as 'flags' | 'segments', entry.key)}>{entry.key}</a>{' '}</>}
                <span className={linked ? 'lower' : ''}>{entry.summary}</span>
              </p>
              <p className="activity-by">
                by <strong>{entry.actor.name}</strong>
                {showEnv && entry.envName && (entry.kind === 'flags' || entry.kind === 'segments') ? <> in {entry.envName}</> : null}
              </p>
              {entry.comment && <p className="activity-comment">{entry.comment}</p>}
              {open === entry.id && <Diff before={entry.before} after={entry.after} />}
            </div>
            <div className="activity-side">
              <time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>{ago(entry.at)}</time>
              {detailed && (
                <button type="button" className="link" aria-expanded={open === entry.id} onClick={() => setOpen(open === entry.id ? null : entry.id)}>
                  {open === entry.id ? 'Hide changes' : 'Show changes'}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---- The page ------------------------------------------------------------------

const PAGE = 100;
const KINDS = [['', 'Everything'], ['flags', 'Flags'], ['segments', 'Segments'], ['environment', 'Environments'], ['member', 'Members']];

export function AuditPage() {
  const env = useEnv();
  const toast = useToast();
  const [scope, setScope] = useState<'env' | 'all'>('all');
  const [kind, setKind] = useState('');
  const [actor, setActor] = useState('');
  const [search, setSearch] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filter: AuditFilter = useMemo(() => ({ env: scope === 'env' ? env.id : undefined, kind: kind || undefined, actor: actor || undefined }), [scope, kind, actor, env.id]);
  const load = useCallback(async () => {
    setError(null);
    try {
      const loaded = await api.audit({ ...filter, limit: PAGE });
      setEntries(loaded);
      setMore(loaded.length === PAGE);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filter]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api.members().then(setMembers, () => {}); }, []);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (entries ?? []).filter((e) => !q || [e.key, e.summary, e.comment, e.actor.name].some((text) => text.toLowerCase().includes(q)));
  }, [entries, search]);
  const groups = new Map<string, AuditEntry[]>();
  for (const entry of shown) {
    const day = new Date(entry.at).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    groups.set(day, [...(groups.get(day) ?? []), entry]);
  }
  // People who appear in the log but are no longer members can still be filtered on.
  const people = new Map<string, string>(members.map((m) => [m.id, m.name]));
  for (const entry of entries ?? []) if (!people.has(entry.actor.id)) people.set(entry.actor.id, entry.actor.name);

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="muted">Every change in this workspace: who made it, when, and exactly what changed. The newest 5,000 entries are kept.</p>
        </div>
        <Button
          icon="external"
          onClick={async () => {
            try {
              const url = URL.createObjectURL(await api.auditCsv(filter));
              const link = Object.assign(document.createElement('a'), { href: url, download: 'flagport-audit-log.csv' });
              link.click();
              URL.revokeObjectURL(url);
            } catch (e) {
              toast((e as Error).message, 'error');
            }
          }}
        >
          Export CSV
        </Button>
      </header>

      <div className="toolbar">
        <label className="search">
          <Icon name="search" />
          <input aria-label="Search the audit log" placeholder="Search by key, change, note or person" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <select aria-label="Environment" value={scope} onChange={(event) => setScope(event.target.value as 'env' | 'all')}>
          <option value="all">All environments</option>
          <option value="env">{env.name} only</option>
        </select>
        <select aria-label="Type of change" value={kind} onChange={(event) => setKind(event.target.value)}>
          {KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select aria-label="Who" value={actor} onChange={(event) => setActor(event.target.value)}>
          <option value="">Anyone</option>
          {[...people].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>

      {error ? <div className="notice notice-error"><Icon name="alert" />{error}</div>
        : !entries ? <div className="loading" aria-label="Loading" />
        : shown.length === 0 ? (
          <Empty title={entries.length ? 'No entry matches' : 'Nothing has changed yet'}>
            {entries.length ? 'Try a different search or filter.' : 'When someone creates, edits, switches or deletes something, it is recorded here with their name and the note they added.'}
          </Empty>
        ) : [...groups].map(([day, list]) => (
          <section key={day} className="activity-day">
            <h2>{day}</h2>
            <AuditList entries={list} showKey showEnv={scope === 'all'} />
          </section>
        ))}

      {more && entries && (
        <div>
          <Button
            onClick={async () => {
              const older = await api.audit({ ...filter, limit: PAGE, before: entries[entries.length - 1].id });
              setEntries([...entries, ...older]);
              setMore(older.length === PAGE);
            }}
          >
            Load older entries
          </Button>
        </div>
      )}
    </div>
  );
}
