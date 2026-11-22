// Integrations: send every change to Slack or to a service of your own, as it happens.
import { useCallback, useEffect, useState } from 'react';
import { api, type Delivery, type Webhook, type WebhookFormat } from './api';
import { ago } from './model';
import { useApp, useCan } from './state';
import { KeyReveal } from './team';
import { Button, CopyButton, Empty, Field, Icon, Modal, ModalForm, Toggle, useToast } from './ui';

const KINDS: [string, string][] = [
  ['flags', 'Flags'],
  ['segments', 'Segments'],
  ['change', 'Change requests'],
  ['environment', 'Environments'],
  ['member', 'Members'],
  ['webhook', 'Integrations'],
];
const FORMATS: Record<WebhookFormat, { label: string; note: string }> = {
  slack: { label: 'Slack', note: 'Posts a readable message to a channel. Paste an incoming webhook URL from Slack.' },
  json: { label: 'Your own service', note: 'Posts signed JSON with the full before and after, for scripts and automation tools.' },
};

const VERIFY = `import crypto from 'node:crypto';

// rawBody is the request body exactly as received, before any JSON parsing.
function isFromFlagport(headers, rawBody, secret) {
  const signed = headers['x-flagport-timestamp'] + '.' + rawBody;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(signed).digest('hex');
  const given = headers['x-flagport-signature'] ?? '';
  return given.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}`;

function outcome(delivery: Delivery): { text: string; tone: 'ok' | 'wait' | 'bad' } {
  if (delivery.status === 'delivered') return { text: `Delivered ${ago(delivery.finishedAt ?? delivery.createdAt)}`, tone: 'ok' };
  if (delivery.status === 'failed') return { text: `Failed ${ago(delivery.finishedAt ?? delivery.createdAt)}: ${delivery.error ?? 'unknown reason'}`, tone: 'bad' };
  return delivery.error ? { text: `${delivery.error}. Trying again at ${new Date(delivery.nextAt ?? Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, tone: 'wait' } : { text: 'Sending', tone: 'wait' };
}

type Draft = { id: string | null; name: string; url: string; format: WebhookFormat; allKinds: boolean; kinds: string[]; allEnvs: boolean; envs: string[]; urlHint: string };
const blank: Draft = { id: null, name: '', url: '', format: 'slack', allKinds: true, kinds: ['flags', 'change'], allEnvs: true, envs: [], urlHint: '' };

function Deliveries({ hook, version }: { hook: Webhook; version: number }) {
  const [list, setList] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.deliveries(hook.id).then(setList, (e) => setError(e.message)), [hook.id]);
  useEffect(() => { void load(); }, [load, version]);
  if (error) return <div className="notice notice-error"><Icon name="alert" />{error}</div>;
  if (!list) return <div className="loading" aria-label="Loading" />;
  if (!list.length) return <p className="muted hook-none">Nothing has been sent to this webhook yet. Change a flag, or send a test.</p>;
  return (
    <div className="deliveries">
      <div className="table table-deliveries" role="table" aria-label={`Recent deliveries to ${hook.name}`}>
        <div className="thead" role="row"><span role="columnheader">Event</span><span role="columnheader">What happened</span><span role="columnheader">Result</span></div>
        {list.map((delivery) => {
          const result = outcome(delivery);
          return (
            <div className="trow" role="row" key={delivery.id}>
              <span role="cell" className="mono">{delivery.event}</span>
              <span role="cell" className="delivery-what">{delivery.summary}</span>
              <span role="cell" className={`delivery-result tone-${result.tone}`}>
                {result.text}{delivery.attempts > 1 && delivery.status !== 'pending' ? ` after ${delivery.attempts} attempts` : ''}
              </span>
            </div>
          );
        })}
      </div>
      <p className="muted">The newest 50 are kept. <button type="button" className="link" onClick={() => void load()}>Refresh</button></p>
    </div>
  );
}

export function IntegrationsPage() {
  const { envs } = useApp();
  const can = useCan();
  const toast = useToast();
  const admin = can('admin');
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [testing, setTesting] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ title: string; name: string; secret: string } | null>(null);
  const [rotating, setRotating] = useState<Webhook | null>(null);
  const [removing, setRemoving] = useState<Webhook | null>(null);

  const load = useCallback(async () => {
    if (!admin) return;
    try {
      setHooks(await api.webhooks());
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [admin]);
  useEffect(() => { void load(); }, [load]);
  // A message on its way out is usually delivered within a second, so look again shortly.
  const sending = hooks?.some((hook) => hook.enabled && hook.last?.status === 'pending' && !hook.last.error) ?? false;
  useEffect(() => {
    if (!sending) return;
    const timer = setTimeout(() => void load(), 1500);
    return () => clearTimeout(timer);
  }, [sending, version, load]);

  const envName = (id: string) => envs.find((e) => e.id === id)?.name ?? 'a deleted environment';
  const sends = (hook: Webhook) => {
    const what = hook.kinds.length ? hook.kinds.map((kind) => KINDS.find(([id]) => id === kind)?.[1].toLowerCase() ?? kind).join(', ') : 'every change';
    return `${what[0].toUpperCase()}${what.slice(1)} in ${hook.envs.length ? hook.envs.map(envName).join(', ') : 'all environments'}`;
  };
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const head = (
    <header className="page-head">
      <div>
        <h1>Integrations</h1>
        <p className="muted">Send changes to Slack or to a service of your own the moment they happen: a flag switched on, a change waiting for approval, a member added. Everything in the audit log can be sent.</p>
      </div>
      {admin && <Button kind="primary" icon="plus" onClick={() => setDraft(blank)}>Add webhook</Button>}
    </header>
  );

  if (!admin) {
    return (
      <div className="page page-narrow">
        {head}
        <div className="notice"><Icon name="shield" /><span><strong>Integrations are managed by admins.</strong> A webhook address lets anyone who has it post to a channel, so only admins and owners can see or change them.</span></div>
      </div>
    );
  }

  return (
    <div className="page page-narrow">
      {head}

      {error ? <div className="notice notice-error"><Icon name="alert" />{error}</div>
        : !hooks ? <div className="loading" aria-label="Loading" />
        : hooks.length === 0 ? (
          <Empty title="No webhooks yet" action={<Button kind="primary" icon="plus" onClick={() => setDraft(blank)}>Add webhook</Button>}>
            Add one to tell a Slack channel when a flag changes or a change is waiting for approval, or to feed changes to your own tools.
          </Empty>
        ) : (
          <ul className="hooks">
            {hooks.map((hook) => {
              const result = hook.last ? outcome(hook.last) : null;
              return (
                <li key={hook.id} className={`hook ${hook.enabled ? '' : 'hook-off'}`}>
                  <div className="hook-head">
                    <div className="hook-title">
                      <h2>{hook.name}</h2>
                      <p className="muted">{FORMATS[hook.format].label} at <span className="mono">{hook.urlHint}</span></p>
                    </div>
                    <Toggle
                      on={hook.enabled}
                      label={`${hook.name} is ${hook.enabled ? 'on' : 'off'}`}
                      onChange={async (enabled) => {
                        try {
                          await api.updateWebhook(hook.id, { enabled });
                          toast(enabled ? `${hook.name} is on` : `${hook.name} is off; nothing is sent to it`);
                        } catch (e) {
                          toast((e as Error).message, 'error');
                        }
                        await load();
                      }}
                    />
                  </div>
                  <dl className="hook-facts">
                    <div><dt>Sends</dt><dd>{sends(hook)}</dd></div>
                    <div>
                      <dt>Last delivery</dt>
                      <dd className={result ? `tone-${result.tone}` : 'muted'}>{!hook.enabled ? 'Turned off' : result ? result.text : 'Nothing sent yet'}</dd>
                    </div>
                  </dl>
                  {open === hook.id && <Deliveries hook={hook} version={version} />}
                  <div className="change-actions">
                    <button type="button" className="link" aria-expanded={open === hook.id} onClick={() => setOpen(open === hook.id ? null : hook.id)}>
                      {open === hook.id ? 'Hide recent deliveries' : 'Show recent deliveries'}
                    </button>
                    <span className="grow" />
                    <Button
                      small
                      disabled={testing === hook.id}
                      onClick={async () => {
                        setTesting(hook.id);
                        try {
                          const delivery = await api.testWebhook(hook.id);
                          if (delivery.status === 'delivered') toast(`Test delivered to ${hook.name}`);
                          else toast(`Test failed: ${delivery.error ?? 'unknown reason'}`, 'error');
                        } catch (e) {
                          toast((e as Error).message, 'error');
                        }
                        setTesting(null);
                        await load();
                      }}
                    >
                      {testing === hook.id ? 'Sending…' : 'Send test'}
                    </Button>
                    <Button small onClick={() => setDraft({ id: hook.id, name: hook.name, url: '', format: hook.format, allKinds: !hook.kinds.length, kinds: hook.kinds.length ? hook.kinds : blank.kinds, allEnvs: !hook.envs.length, envs: hook.envs, urlHint: hook.urlHint })}>Edit</Button>
                    {hook.format === 'json' && <Button small onClick={() => setRotating(hook)}>New signing secret</Button>}
                    <Button small kind="ghost" icon="trash" aria-label={`Remove ${hook.name}`} onClick={() => setRemoving(hook)} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}

      {hooks && hooks.some((hook) => hook.format === 'json') && (
        <section className="setting hook-docs">
          <h2>Checking that a request is from Flagport</h2>
          <p className="muted">
            Each request carries <code>X-Flagport-Signature</code>: an HMAC-SHA256 of the timestamp header, a dot and the raw body, keyed with the webhook’s signing secret. Recompute it and compare before trusting the body. Answer with any 2xx status within 10 seconds; anything else is tried again after 5 seconds, 1 minute and 10 minutes.
          </p>
          <div className="snippet">
            <div className="snippet-head"><span>Node.js</span><CopyButton value={VERIFY} /></div>
            <pre>{VERIFY}</pre>
          </div>
        </section>
      )}

      {draft && (
        <Modal title={draft.id ? `Edit ${draft.name || 'webhook'}` : 'Add a webhook'} onClose={() => setDraft(null)} wide>
          <ModalForm
            submit={draft.id ? 'Save webhook' : 'Add webhook'}
            onClose={() => setDraft(null)}
            disabled={!draft.name.trim() || (!draft.id && !draft.url.trim()) || (!draft.allKinds && !draft.kinds.length) || (!draft.allEnvs && !draft.envs.length)}
            onSubmit={async () => {
              const input = {
                name: draft.name.trim(),
                format: draft.format,
                kinds: draft.allKinds ? [] : draft.kinds,
                envs: draft.allEnvs ? [] : draft.envs,
                ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
              };
              if (draft.id) {
                await api.updateWebhook(draft.id, input);
                toast(`Saved ${input.name}`);
              } else {
                const created = await api.createWebhook(input as typeof input & { url: string });
                if (created.webhook.format === 'json') setReveal({ title: `Signing secret for ${created.webhook.name}`, name: created.webhook.name, secret: created.secret });
                else toast(`Added ${created.webhook.name}. Send a test to see it arrive.`);
              }
              await load();
            }}
          >
            <fieldset className="choices choices-rows choices-wide">
              <legend>Send to</legend>
              {(Object.keys(FORMATS) as WebhookFormat[]).map((format) => (
                <label key={format} className={draft.format === format ? 'chosen' : ''}>
                  <input type="radio" name="format" checked={draft.format === format} onChange={() => setDraft({ ...draft, format })} />
                  <strong>{FORMATS[format].label}</strong>
                  <span>{FORMATS[format].note}</span>
                </label>
              ))}
            </fieldset>
            <div className="cols">
              <Field label="Name" hint="Shown here and in the audit log.">
                {(id) => <input id={id} maxLength={80} placeholder={draft.format === 'slack' ? '#releases' : 'Deploy bot'} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />}
              </Field>
              <Field label="URL" hint={draft.id ? `Leave empty to keep ${draft.urlHint}` : 'Must start with https://. It is not shown again in full.'}>
                {(id) => <input id={id} type="url" className="mono" autoComplete="off" spellCheck={false} placeholder={draft.format === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://example.com/flagport'} value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} />}
              </Field>
            </div>
            <fieldset className="scope">
              <legend>What to send</legend>
              <label className="check"><input type="radio" name="kinds" checked={draft.allKinds} onChange={() => setDraft({ ...draft, allKinds: true })} />Every change</label>
              <label className="check"><input type="radio" name="kinds" checked={!draft.allKinds} onChange={() => setDraft({ ...draft, allKinds: false })} />Only changes to</label>
              {!draft.allKinds && (
                <div className="scope-some">
                  {KINDS.map(([kind, label]) => (
                    <label className="check" key={kind}><input type="checkbox" checked={draft.kinds.includes(kind)} onChange={() => setDraft({ ...draft, kinds: toggle(draft.kinds, kind) })} />{label}</label>
                  ))}
                </div>
              )}
            </fieldset>
            <fieldset className="scope">
              <legend>From</legend>
              <label className="check"><input type="radio" name="envs" checked={draft.allEnvs} onChange={() => setDraft({ ...draft, allEnvs: true })} />All environments, and the workspace itself</label>
              <label className="check"><input type="radio" name="envs" checked={!draft.allEnvs} onChange={() => setDraft({ ...draft, allEnvs: false })} />Only these environments</label>
              {!draft.allEnvs && (
                <>
                  <div className="scope-some">
                    {envs.map((e) => (
                      <label className="check" key={e.id}><input type="checkbox" checked={draft.envs.includes(e.id)} onChange={() => setDraft({ ...draft, envs: toggle(draft.envs, e.id) })} />{e.name}</label>
                    ))}
                  </div>
                  <p className="field-hint">Changes to members and integrations belong to no environment, so they are not sent.</p>
                </>
              )}
            </fieldset>
          </ModalForm>
        </Modal>
      )}

      {rotating && (
        <Modal title={`New signing secret for ${rotating.name}?`} onClose={() => setRotating(null)}>
          <ModalForm
            submit="Replace secret"
            onClose={() => setRotating(null)}
            onSubmit={async () => {
              const result = await api.rotateWebhookSecret(rotating.id);
              setReveal({ title: `New signing secret for ${rotating.name}`, name: rotating.name, secret: result.secret });
            }}
          >
            <p>Requests are signed with the new secret straight away. Until the receiving service has it, it will reject what Flagport sends.</p>
          </ModalForm>
        </Modal>
      )}

      {removing && (
        <Modal title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}>
          <ModalForm
            danger
            submit="Remove webhook"
            onClose={() => setRemoving(null)}
            onSubmit={async () => {
              await api.deleteWebhook(removing.id);
              toast(`Removed ${removing.name}`);
              await load();
            }}
          >
            <p>Nothing more is sent to it, and its record of deliveries is erased. The audit log keeps the fact that it existed.</p>
          </ModalForm>
        </Modal>
      )}

      {reveal && (
        <KeyReveal {...reveal} label="The secret is saved somewhere safe" onClose={() => setReveal(null)}>
          This is the only time the signing secret for <strong>{reveal.name}</strong> is shown. The receiving service needs it to check that a request really came from Flagport.
        </KeyReveal>
      )}
    </div>
  );
}
