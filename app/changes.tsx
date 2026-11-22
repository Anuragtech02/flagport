// Changes: proposed edits that wait for approval, for a set time, or both.
import { useCallback, useEffect, useState } from 'react';
import { api, type Change } from './api';
import { Diff } from './audit';
import { ago } from './model';
import { href, useApp, useCan, useEnv } from './state';
import { Button, Empty, Field, Icon, Modal, ModalForm, Tabs, useToast } from './ui';

export const whenText = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function statusOf(change: Change): { label: string; tone: string } {
  if (change.status === 'pending') return { label: change.applyAt ? `Waiting for approval, then ${whenText(change.applyAt)}` : 'Waiting for approval', tone: 'wait' };
  if (change.status === 'approved') return { label: change.applyAt ? `Scheduled for ${whenText(change.applyAt)}` : 'Approved', tone: 'go' };
  if (change.status === 'applied') return { label: change.closedBy === 'schedule' ? 'Applied on schedule' : 'Applied', tone: 'done' };
  if (change.status === 'failed') return { label: 'Could not be applied', tone: 'bad' };
  return { label: change.status === 'rejected' ? 'Rejected' : 'Cancelled', tone: 'off' };
}

export function ChangesPage() {
  const { me, reload } = useApp();
  const can = useCan();
  const env = useEnv();
  const toast = useToast();
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [open, setOpen] = useState<number | null>(null);
  const [reviewing, setReviewing] = useState<{ change: Change; decision: 'approve' | 'reject' } | null>(null);
  const [comment, setComment] = useState('');

  const load = useCallback(() => api.changes(env.id).then(setChanges, (e) => setError(e.message)), [env.id]);
  // The count in the sidebar changes when a schedule fires, so the list follows it.
  useEffect(() => { void load(); }, [load, env.openChanges]);

  const act = async (action: () => Promise<Change>, done: (change: Change) => string) => {
    try {
      const result = await action();
      toast(done(result), result.status === 'failed' ? 'error' : 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    await Promise.all([load(), reload()]);
  };

  const isOpen = (change: Change) => change.status === 'pending' || change.status === 'approved';
  const shown = (changes ?? []).filter((change) => (tab === 'open' ? isOpen(change) : !isOpen(change)));
  const openCount = (changes ?? []).filter(isOpen).length;

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Changes</h1>
          <p className="muted">
            Edits to flags in {env.name} that are waiting for someone’s approval or for a set time. {env.settings.approvals ? 'This environment requires approval for every flag change.' : 'Approval is optional here; an admin can require it in Settings.'}
          </p>
        </div>
      </header>

      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'open', label: 'Open', count: openCount }, { id: 'closed', label: 'Closed' }]} />

      {error ? <div className="notice notice-error"><Icon name="alert" />{error}</div>
        : !changes ? <div className="loading" aria-label="Loading" />
        : shown.length === 0 ? (
          <Empty title={tab === 'open' ? 'Nothing is waiting' : 'No closed changes yet'}>
            {tab === 'open'
              ? 'To propose a change, edit a flag and choose “Ask for approval” or “Apply at a set time” when you save.'
              : 'Changes that were applied, rejected, cancelled or failed are listed here.'}
          </Empty>
        ) : (
          <ul className="changes">
            {shown.map((change) => {
              const status = statusOf(change);
              const mine = change.author.id === me.id;
              return (
                <li key={change.id} className="change">
                  <div className="change-head">
                    <div className="change-title">
                      <h2><span className="muted">#{change.id}</span> {change.title}</h2>
                      <p className="muted">
                        <a className="mono" href={href(env.id, 'flags', change.flag)}>{change.flag}</a>, proposed by <strong>{change.author.name}</strong> {ago(change.createdAt)}
                      </p>
                    </div>
                    <span className={`badge badge-${status.tone}`}>{status.label}</span>
                  </div>

                  {change.failure && <div className="notice notice-error"><Icon name="alert" />{change.failure}</div>}
                  {change.reviews.length > 0 && (
                    <ul className="reviews">
                      {change.reviews.map((review, i) => (
                        <li key={i}>
                          <Icon name={review.decision === 'approved' ? 'check' : 'x'} size={14} />
                          <span><strong>{review.by.name}</strong> {review.decision} {ago(review.at)}{review.comment && <>: “{review.comment}”</>}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {open === change.id && <Diff before={change.base} after={change.proposed} />}

                  <div className="change-actions">
                    <button type="button" className="link" aria-expanded={open === change.id} onClick={() => setOpen(open === change.id ? null : change.id)}>
                      {open === change.id ? 'Hide what it changes' : 'Show what it changes'}
                    </button>
                    <span className="grow" />
                    {isOpen(change) && (mine || can('admin')) && (
                      <Button small kind="ghost" onClick={() => act(() => api.cancelChange(env.id, change.id), () => `Cancelled change #${change.id}`)}>Cancel change</Button>
                    )}
                    {change.status === 'approved' && can('writer') && (
                      <Button small onClick={() => act(() => api.applyChange(env.id, change.id), (r) => (r.status === 'applied' ? `Applied change #${change.id}` : r.failure ?? 'Could not apply'))}>Apply now</Button>
                    )}
                    {change.status === 'pending' && can('writer') && (
                      <>
                        <Button small onClick={() => { setComment(''); setReviewing({ change, decision: 'reject' }); }}>Reject</Button>
                        <Button small kind="primary" disabled={mine} title={mine ? 'Someone other than the author has to approve' : undefined} onClick={() => { setComment(''); setReviewing({ change, decision: 'approve' }); }}>
                          {change.applyAt ? 'Approve' : 'Approve and apply'}
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

      {reviewing && (
        <Modal title={`${reviewing.decision === 'approve' ? 'Approve' : 'Reject'} change #${reviewing.change.id}?`} onClose={() => setReviewing(null)}>
          <ModalForm
            submit={reviewing.decision === 'approve' ? (reviewing.change.applyAt ? 'Approve' : 'Approve and apply') : 'Reject change'}
            danger={reviewing.decision === 'reject'}
            onClose={() => setReviewing(null)}
            onSubmit={async () => {
              const { change, decision } = reviewing;
              await act(
                () => api.reviewChange(env.id, change.id, decision, comment.trim()),
                (r) => (r.status === 'applied' ? `Approved and applied change #${change.id}` : r.status === 'approved' ? `Approved; it applies ${whenText(r.applyAt!)}` : r.status === 'rejected' ? `Rejected change #${change.id}` : r.failure ?? 'Could not apply'),
              );
            }}
          >
            <p>
              {reviewing.decision === 'reject'
                ? <>“{reviewing.change.title}” by {reviewing.change.author.name} is closed without changing anything.</>
                : reviewing.change.applyAt
                  ? <>“{reviewing.change.title}” will apply to <strong>{env.name}</strong> on its own at {whenText(reviewing.change.applyAt)}.</>
                  : <>“{reviewing.change.title}” takes effect in <strong>{env.name}</strong> straight away.</>}
            </p>
            <Field label={reviewing.decision === 'reject' ? 'Why (the author sees this)' : 'Comment (optional)'}>
              {(id) => <input id={id} maxLength={500} value={comment} onChange={(event) => setComment(event.target.value)} />}
            </Field>
          </ModalForm>
        </Modal>
      )}
    </div>
  );
}
