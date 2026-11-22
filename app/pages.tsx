// Activity, connecting SDKs, and settings.
import { useEffect, useState } from 'react';
import { api, auth, type Activity } from './api';
import { go, href, useApp, useEnv } from './state';
import { Button, CopyButton, Empty, Field, Icon, Modal, ModalForm, useToast } from './ui';
import { ActivityList } from './flag';

export function ActivityPage() {
  const env = useEnv();
  const [entries, setEntries] = useState<Activity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.activity(env.id).then(setEntries, (e) => setError(e.message));
  }, [env.id, env.flags, env.segments]);

  const groups = new Map<string, Activity[]>();
  for (const entry of entries ?? []) {
    const day = new Date(entry.at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    groups.set(day, [...(groups.get(day) ?? []), entry]);
  }
  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="muted">Every change to flags and segments in {env.name}, newest first. The last 200 are kept on screen.</p>
        </div>
      </header>
      {error ? <div className="notice notice-error"><Icon name="alert" />{error}</div>
        : !entries ? <div className="loading" aria-label="Loading" />
        : entries.length === 0 ? <Empty title="Nothing has changed yet">When someone creates, edits, switches or deletes a flag, it is recorded here with the note they added.</Empty>
        : [...groups].map(([day, list]) => (
          <section key={day} className="activity-day">
            <h2>{day}</h2>
            <ActivityList entries={list} envId={env.id} showKey />
          </section>
        ))}
    </div>
  );
}

// ---- Connect SDKs ------------------------------------------------------------------

function Secret({ value, secret }: { value: string; secret: boolean }) {
  const [shown, setShown] = useState(!secret);
  return (
    <div className="secret">
      <code>{shown ? value : value.slice(0, 16) + '•'.repeat(18)}</code>
      {secret && <Button small icon="eye" onClick={() => setShown(!shown)}>{shown ? 'Hide' : 'Show'}</Button>}
      <CopyButton value={value} />
    </div>
  );
}

export function ConnectPage() {
  const env = useEnv();
  const origin = location.origin;
  const cards = [
    {
      id: 'server', title: 'Server-side SDKs', count: env.connections.server, keyLabel: 'SDK key', secret: true, value: env.sdkKey,
      note: 'For your backend. Keep this key out of browsers and apps.',
      file: 'Node.js',
      code: `import { init } from '@launchdarkly/node-server-sdk';\n\nconst client = init('${env.sdkKey}', {\n  baseUri:   '${origin}',\n  streamUri: '${origin}',\n  eventsUri: '${origin}',\n});`,
    },
    {
      id: 'js', title: 'Browser SDKs', count: env.connections.js, keyLabel: 'Client-side ID', secret: false, value: env.clientSideId,
      note: 'Safe to ship in web pages. Only flags marked for browser SDKs are visible to it.',
      file: 'JavaScript',
      code: `import { initialize } from 'launchdarkly-js-client-sdk';\n\nconst client = initialize('${env.clientSideId}', context, {\n  baseUrl:   '${origin}',\n  streamUrl: '${origin}',\n  eventsUrl: '${origin}',\n});`,
    },
    {
      id: 'mobile', title: 'Mobile SDKs', count: env.connections.mobile, keyLabel: 'Mobile key', secret: true, value: env.mobileKey,
      note: 'For iOS, Android and React Native apps. Not yet tested on real devices.',
      file: 'React Native',
      code: `import { AutoEnvAttributes, ReactNativeLDClient } from '@launchdarkly/react-native-client-sdk';\n\nconst client = new ReactNativeLDClient('${env.mobileKey}', AutoEnvAttributes.Enabled, {\n  baseUri:   '${origin}',\n  streamUri: '${origin}',\n  eventsUri: '${origin}',\n});`,
    },
  ];
  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Connect SDKs</h1>
          <p className="muted">Keep the LaunchDarkly SDK you already use. Swap in the key for {env.name} and point three addresses here.</p>
        </div>
      </header>
      {cards.map((card) => (
        <section className="connect" key={card.id}>
          <header>
            <h2>{card.title}</h2>
            <span className="live"><span className={`pulse ${card.count ? 'pulse-on' : ''}`} />{card.count ? `${card.count} connected now` : 'Waiting for a connection'}</span>
          </header>
          <p className="muted">{card.note}</p>
          <div className="field">
            <label>{card.keyLabel}</label>
            <Secret value={card.value} secret={card.secret} />
          </div>
          <div className="snippet">
            <div className="snippet-head"><span>{card.file}</span><CopyButton value={card.code} /></div>
            <pre>{card.secret ? card.code.replace(card.value, card.value.slice(0, 16) + '…') : card.code}</pre>
          </div>
        </section>
      ))}
      <p className="muted">Other languages work the same way: every LaunchDarkly SDK has options for the base, streaming and events addresses. Only the Node.js server SDK and the JavaScript browser SDK are tested end to end so far.</p>
    </div>
  );
}

// ---- Settings ------------------------------------------------------------------------

export function SettingsPage() {
  const { reload, reloadEnvs } = useApp();
  const env = useEnv();
  const toast = useToast();
  const [name, setName] = useState(env.name);
  const [importing, setImporting] = useState(false);
  const [form, setForm] = useState({ apiToken: '', projectKey: '', environmentKey: '' });
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState('');
  useEffect(() => setName(env.name), [env.id, env.name]);

  return (
    <div className="page page-narrow">
      <header className="page-head"><div><h1>Settings</h1><p className="muted">For the {env.name} environment and this workspace.</p></div></header>

      <section className="setting">
        <h2>Environment name</h2>
        <form
          className="inline"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await api.renameEnv(env.id, name.trim());
              await Promise.all([reloadEnvs(), reload()]);
              toast('Environment renamed');
            } catch (e) {
              toast((e as Error).message, 'error');
            }
          }}
        >
          <input aria-label="Environment name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
          <Button type="submit" disabled={!name.trim() || name.trim() === env.name}>Rename</Button>
        </form>
      </section>

      <section className="setting">
        <h2>Import from LaunchDarkly</h2>
        <p className="muted">Copies flags, targeting rules and segments from one LaunchDarkly environment into {env.name}. A flag that already exists here with the same key is replaced. Your LaunchDarkly account is only read.</p>
        <Button icon="plus" onClick={() => setImporting(true)}>Import flags and segments</Button>
      </section>

      <section className="setting">
        <h2>Workspace key</h2>
        <p className="muted">The key you signed in with. It opens every environment in this workspace and cannot be recovered or reset, so keep a copy in a password manager.</p>
        <CopyButton value={auth.key ?? ''} label="Copy workspace key" small={false} />
      </section>

      <section className="setting">
        <div className="danger-zone">
          <div>
            <strong>Delete {env.name}</strong>
            <p className="muted">Its keys stop working at once, connected SDKs are cut off, and every flag and segment in it is erased.</p>
          </div>
          <Button kind="danger" onClick={() => { setTyped(''); setDeleting(true); }}>Delete environment</Button>
        </div>
      </section>

      {importing && (
        <Modal title="Import from LaunchDarkly" onClose={() => setImporting(false)}>
          <ModalForm
            submit={`Import into ${env.name}`}
            onClose={() => setImporting(false)}
            disabled={!form.apiToken || !form.projectKey || !form.environmentKey}
            onSubmit={async () => {
              const result = await api.importFromLaunchDarkly(env.id, form);
              await reload();
              setForm({ apiToken: '', projectKey: '', environmentKey: '' });
              toast(`Imported ${result.imported.flags} flags and ${result.imported.segments} segments${result.skipped.length ? `, skipped ${result.skipped.length}` : ''}`);
              go(href(env.id, 'flags'));
            }}
          >
            <Field label="LaunchDarkly API access token" hint="A read-only token is enough. It is used once for this import and is not stored.">
              {(id) => <input id={id} type="password" autoComplete="off" value={form.apiToken} onChange={(event) => setForm({ ...form, apiToken: event.target.value })} />}
            </Field>
            <div className="cols">
              <Field label="Project key">{(id) => <input id={id} className="mono" placeholder="default" value={form.projectKey} onChange={(event) => setForm({ ...form, projectKey: event.target.value })} />}</Field>
              <Field label="Environment key">{(id) => <input id={id} className="mono" placeholder="production" value={form.environmentKey} onChange={(event) => setForm({ ...form, environmentKey: event.target.value })} />}</Field>
            </div>
          </ModalForm>
        </Modal>
      )}

      {deleting && (
        <Modal title={`Delete ${env.name}?`} onClose={() => setDeleting(false)}>
          <ModalForm
            danger
            submit="Delete environment"
            onClose={() => setDeleting(false)}
            disabled={typed !== env.name}
            onSubmit={async () => {
              const deleted = env.name;
              await api.deleteEnv(env.id);
              const rest = await reloadEnvs();
              toast(`Deleted ${deleted}`);
              go(rest.length ? href(rest[0].id) : '#/');
            }}
          >
            <p>The SDK key, client-side ID and mobile key stop working straight away, and apps fall back to the default values in their code. {Object.keys(env.flags).length} flags and {Object.keys(env.segments).length} segments are erased. This cannot be undone.</p>
            <Field label={`Type ${env.name} to confirm`}>{(id) => <input id={id} autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} />}</Field>
          </ModalForm>
        </Modal>
      )}
    </div>
  );
}
