import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, auth, type EnvSummary, type Environment } from './api';
import { AppContext, go, href, useRoute, type App, type Section } from './state';
import { Button, CopyButton, Field, Icon, Modal, ModalForm, Skeleton, Toasts, useToast } from './ui';
import { envColor } from './model';
import { FlagList } from './flags';
import { FlagPage } from './flag';
import { SegmentList, SegmentPage } from './segments';
import { ActivityPage, ConnectPage, SettingsPage } from './pages';

const REPO = 'https://github.com/Anuragtech02/flagport';

function Brand() {
  return (
    <a className="brand" href="/">
      <svg viewBox="0 0 34 20" width="30" height="18" aria-hidden="true">
        <defs>
          <linearGradient id="brand" x1="0" x2="1">
            <stop stopColor="#fff" />
            <stop offset=".55" stopColor="#E9FF9C" />
            <stop offset="1" stopColor="#C4F82A" />
          </linearGradient>
        </defs>
        <rect width="34" height="20" rx="10" fill="url(#brand)" />
        <circle cx="24" cy="10" r="7" fill="#fff" />
      </svg>
      Flagport
    </a>
  );
}

// ---- Signing in -----------------------------------------------------------------

function SignIn({ signups, onSignedIn }: { signups: boolean; onSignedIn: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (created) {
    return (
      <main className="gate">
        <div className="gate-card">
          <Brand />
          <h1>Save your workspace key</h1>
          <p className="muted">
            This key is the only way into your workspace. There are no accounts and no reset, and the server keeps only a hash of it. Put it in a password
            manager before you continue.
          </p>
          <div className="secret">
            <code>{created}</code>
            <CopyButton value={created} />
          </div>
          <label className="check">
            <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
            I have saved this key
          </label>
          <Button kind="primary" disabled={!saved} onClick={onSignedIn}>Open my workspace</Button>
        </div>
      </main>
    );
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  return (
    <main className="gate">
      <div className="gate-card">
        <Brand />
        <h1>Open your workspace</h1>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const candidate = value.trim();
              try {
                await api.check(candidate);
              } catch (e) {
                throw new Error(e instanceof Error && 'status' in e && e.status === 401 ? 'That key does not open a workspace here. Check for a missing character.' : (e as Error).message);
              }
              auth.set(candidate);
              onSignedIn();
            });
          }}
        >
          <Field label={signups ? 'Workspace key' : 'Admin token'} error={error}>
            {(id) => <input id={id} type="password" autoComplete="current-password" required autoFocus value={value} onChange={(event) => setValue(event.target.value)} />}
          </Field>
          <Button kind="primary" type="submit" disabled={busy || !value.trim()}>Open workspace</Button>
        </form>
        <div className="gate-alt">
          {signups ? (
            <>
              <p className="muted">New here? A workspace needs no account and no email. You get one key.</p>
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const { key } = await api.createWorkspace();
                    // Signed in before the key is shown, so a closed tab does not lose the workspace.
                    auth.set(key);
                    setCreated(key);
                    setBusy(false);
                  })
                }
              >
                Create a workspace
              </Button>
            </>
          ) : (
            <p className="muted">This instance is private. Sign in with the admin token it was deployed with.</p>
          )}
        </div>
      </div>
    </main>
  );
}

// ---- Command palette --------------------------------------------------------------

type Command = { label: string; hint: string; to: string };

function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands).slice(0, 12);
  }, [commands, query]);
  const choose = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    go(command.to);
  };
  return (
    <Modal title="Go to" onClose={onClose}>
      <div className="palette">
        <input
          autoFocus
          aria-label="Search flags, segments and pages"
          placeholder="Search flags, segments and pages"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(matches.length - 1, i + 1)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
            if (event.key === 'Enter') { event.preventDefault(); choose(matches[active]); }
          }}
        />
        <ul>
          {matches.map((command, i) => (
            <li key={command.to}>
              <button type="button" className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onClick={() => choose(command)}>
                <span>{command.label}</span>
                <span className="muted">{command.hint}</span>
              </button>
            </li>
          ))}
          {matches.length === 0 && <li className="palette-none">Nothing matches “{query}”.</li>}
        </ul>
      </div>
    </Modal>
  );
}

// ---- The signed-in workspace --------------------------------------------------------

function NewEnvironment({ onClose, onCreated }: { onClose: () => void; onCreated: (env: EnvSummary) => void }) {
  const [name, setName] = useState('');
  return (
    <Modal title="New environment" onClose={onClose}>
      <ModalForm submit="Create environment" onClose={onClose} disabled={!name.trim()} onSubmit={async () => onCreated(await api.createEnv(name.trim()))}>
        <Field label="Name" hint="An environment has its own flags and its own SDK keys. Most teams have Production and Staging.">
          {(id) => <input id={id} autoFocus maxLength={80} placeholder="Production" value={name} onChange={(event) => setName(event.target.value)} />}
        </Field>
      </ModalForm>
    </Modal>
  );
}

function EnvSwitcher({ envs, currentId, sectionFor, onNew }: { envs: EnvSummary[] | null; currentId: string | null; sectionFor: Section; onNew: () => void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const current = envs?.find((e) => e.id === currentId);
  const close = () => {
    setOpen(false);
    setFilter('');
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);
  const shown = (envs ?? []).filter((e) => e.name.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <div className="env-switch">
      <button type="button" className="env-current" aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))} disabled={!envs} title={current?.name}>
        <span className="env-dot" style={{ background: current ? envColor(current.id) : undefined }} />
        <span className="env-text">
          <span className="env-label">Environment</span>
          <span className="env-name">{current?.name ?? (envs?.length === 0 ? 'None yet' : 'Loading…')}</span>
        </span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <>
          <div className="scrim" onClick={close} />
          <div className="menu" role="menu" aria-label="Environments">
            {(envs?.length ?? 0) > 6 && (
              <input className="menu-filter" autoFocus aria-label="Find an environment" placeholder="Find an environment" value={filter} onChange={(event) => setFilter(event.target.value)} />
            )}
            <div className="menu-list">
              {shown.map((e) => (
                <a key={e.id} role="menuitem" href={href(e.id, sectionFor)} className={e.id === currentId ? 'current' : ''} title={e.name} onClick={close}>
                  <span className="env-dot" style={{ background: envColor(e.id) }} />
                  <span className="menu-name">{e.name}</span>
                  {e.id === currentId && <Icon name="check" size={14} />}
                </a>
              ))}
              {shown.length === 0 && <p className="menu-none">No environment matches “{filter}”.</p>}
            </div>
            <button type="button" role="menuitem" className="menu-new" onClick={() => { close(); onNew(); }}>
              <Icon name="plus" size={14} />New environment
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const NAV: { section: Section; label: string; icon: string }[] = [
  { section: 'flags', label: 'Flags', icon: 'flag' },
  { section: 'segments', label: 'Segments', icon: 'segment' },
  { section: 'activity', label: 'Activity', icon: 'activity' },
  { section: 'connect', label: 'Connect SDKs', icon: 'plug' },
  { section: 'settings', label: 'Settings', icon: 'settings' },
];

function Workspace({ onSignOut }: { onSignOut: () => void }) {
  const route = useRoute();
  const toast = useToast();
  const [envs, setEnvs] = useState<EnvSummary[] | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [palette, setPalette] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const reloadEnvs = useCallback(async () => {
    const list = await api.envs();
    setEnvs(list);
    return list;
  }, []);

  useEffect(() => {
    reloadEnvs().catch((e) => setFailed(e.message));
  }, [reloadEnvs]);

  // The address decides the environment; without one, the first environment is opened.
  const envId = envs?.some((e) => e.id === route.env) ? route.env : null;
  useEffect(() => {
    if (envs && !envId && envs.length) history.replaceState(null, '', href(envs[0].id)), dispatchEvent(new HashChangeEvent('hashchange'));
  }, [envs, envId]);

  const wanted = useRef<string | null>(null);
  const reload = useCallback(async () => {
    if (!envId) return;
    wanted.current = envId;
    const loaded = await api.env(envId);
    if (wanted.current === envId) setEnv(loaded);
  }, [envId]);

  useEffect(() => {
    setEnv(null);
    if (!envId) return;
    reload().catch((e) => setFailed(e.message));
    // Keeps connection counts and evaluation numbers fresh while the tab is in view.
    const timer = setInterval(() => !document.hidden && reload().catch(() => {}), 8000);
    return () => clearInterval(timer);
  }, [envId, reload]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette(true);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const app: App = useMemo(() => ({ envs: envs ?? [], env, route, reload, reloadEnvs, signOut: onSignOut }), [envs, env, route, reload, reloadEnvs, onSignOut]);

  const commands = useMemo<Command[]>(() => {
    if (!env) return [];
    return [
      ...Object.values(env.flags).map((flag) => ({ label: flag.name || flag.key, hint: 'Flag', to: href(env.id, 'flags', flag.key) })),
      ...Object.values(env.segments).map((segment) => ({ label: segment.name || segment.key, hint: 'Segment', to: href(env.id, 'segments', segment.key) })),
      ...NAV.map((item) => ({ label: item.label, hint: 'Page', to: href(env.id, item.section) })),
      ...(envs ?? []).filter((e) => e.id !== env.id).map((e) => ({ label: e.name, hint: 'Environment', to: href(e.id) })),
    ];
  }, [env, envs]);

  const connected = env ? env.connections.server + env.connections.js + env.connections.mobile : 0;
  const pageLabel = NAV.find((item) => item.section === route.section)!.label;
  const item = env && route.key ? (route.section === 'flags' ? env.flags[route.key] : env.segments[route.key]) : null;
  const itemLabel = route.key ? item?.name || route.key : null;
  useEffect(() => {
    document.title = [itemLabel, pageLabel, env?.name, 'Flagport'].filter(Boolean).join(' · ');
  }, [itemLabel, pageLabel, env?.name]);

  let screen;
  if (failed) screen = <div className="page"><div className="notice notice-error"><Icon name="alert" />{failed}</div></div>;
  else if (!envs || (envId && !env)) screen = <div className="page"><Skeleton /></div>;
  else if (!envs.length || !env) {
    screen = (
      <div className="page">
        <div className="welcome">
          <h1>Create your first environment</h1>
          <p className="muted">An environment holds a set of flags and has its own SDK keys. Start with the one your app runs in today; you can add Staging later.</p>
          <Button kind="primary" icon="plus" onClick={() => setCreating(true)}>New environment</Button>
        </div>
      </div>
    );
  } else if (route.section === 'flags') screen = route.key ? <FlagPage flagKey={route.key} key={route.key} /> : <FlagList />;
  else if (route.section === 'segments') screen = route.key ? <SegmentPage segmentKey={route.key} key={route.key} /> : <SegmentList />;
  else if (route.section === 'activity') screen = <ActivityPage />;
  else if (route.section === 'connect') screen = <ConnectPage />;
  else screen = <SettingsPage />;

  return (
    <AppContext.Provider value={app}>
      <div className="shell">
        <aside className="side">
          <Brand />
          <EnvSwitcher envs={envs} currentId={envId} sectionFor={route.key ? 'flags' : route.section} onNew={() => setCreating(true)} />

          <nav aria-label="Workspace">
            {NAV.map((item) => (
              <a key={item.section} href={envId ? href(envId, item.section) : '#/'} aria-current={route.section === item.section ? 'page' : undefined} aria-disabled={!envId}>
                <Icon name={item.icon} />
                {item.label}
                {env && item.section === 'flags' && <span className="count">{Object.keys(env.flags).length}</span>}
                {env && item.section === 'segments' && <span className="count">{Object.keys(env.segments).length}</span>}
              </a>
            ))}
          </nav>

          <div className="side-foot">
            <a href={REPO} target="_blank" rel="noreferrer"><Icon name="external" />Source and docs</a>
            <button type="button" onClick={async () => { await navigator.clipboard.writeText(auth.key ?? '').then(() => toast('Workspace key copied'), () => toast('Could not copy the key', 'error')); }}>
              <Icon name="key" />Copy workspace key
            </button>
            <button type="button" onClick={() => setLeaving(true)}><Icon name="out" />Sign out</button>
          </div>
        </aside>
        <div className="main">
          {env && (
            <header className="topbar">
              <nav className="crumbs" aria-label="Breadcrumb">
                <span className="crumb" title={env.name}><span className="env-dot" style={{ background: envColor(env.id) }} />{env.name}</span>
                <span className="crumb-sep" aria-hidden="true">/</span>
                {itemLabel ? <a className="crumb" href={href(env.id, route.section)}>{pageLabel}</a> : <span className="crumb crumb-here" aria-current="page">{pageLabel}</span>}
                {itemLabel && (
                  <>
                    <span className="crumb-sep" aria-hidden="true">/</span>
                    <span className="crumb crumb-here" aria-current="page" title={itemLabel}>{itemLabel}</span>
                  </>
                )}
              </nav>
              <a className="live" href={href(env.id, 'connect')} title={`${env.connections.server} server, ${env.connections.js} browser, ${env.connections.mobile} mobile`}>
                <span className={`pulse ${connected ? 'pulse-on' : ''}`} />
                {connected ? `${connected} SDK${connected === 1 ? '' : 's'} connected` : 'No SDKs connected'}
              </a>
              <button type="button" className="searchbtn" onClick={() => setPalette(true)}>
                <Icon name="search" size={14} />Search<kbd>{navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K'}</kbd>
              </button>
            </header>
          )}
          {screen}
        </div>
      </div>

      {creating && (
        <NewEnvironment
          onClose={() => setCreating(false)}
          onCreated={async (created) => {
            await reloadEnvs();
            go(href(created.id, 'connect'));
          }}
        />
      )}
      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
      {leaving && (
        <Modal title="Sign out?" onClose={() => setLeaving(false)}>
          <ModalForm submit="Sign out" onClose={() => setLeaving(false)} onSubmit={onSignOut}>
            <p>This browser forgets your key. You need the key to get back in, and it cannot be recovered or reset.</p>
          </ModalForm>
        </Modal>
      )}
    </AppContext.Provider>
  );
}

function Root() {
  const [signedIn, setSignedIn] = useState(() => !!auth.restore());
  const [signups, setSignups] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api.instance().then((instance) => setSignups(instance.signups), () => {}).finally(() => setReady(true));
  }, []);

  const signOut = useCallback(() => {
    auth.set(null);
    history.replaceState(null, '', '#/');
    setSignedIn(false);
  }, []);
  useEffect(() => auth.onUnauthorized(signOut), [signOut]);

  if (!ready) return null;
  return <Toasts>{signedIn ? <Workspace onSignOut={signOut} /> : <SignIn signups={signups} onSignedIn={() => setSignedIn(true)} />}</Toasts>;
}

createRoot(document.getElementById('app')!).render(<Root />);
