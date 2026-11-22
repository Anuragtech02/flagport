// Routing and the data every screen shares.
import { createContext, useContext, useEffect, useState } from 'react';
import type { EnvSummary, Environment } from './api';

export type Section = 'flags' | 'segments' | 'activity' | 'connect' | 'settings';
export type Route = { env: string | null; section: Section; key: string | null };
const SECTIONS: Section[] = ['flags', 'segments', 'activity', 'connect', 'settings'];

// Addresses look like #/e/<environment id>/<section>/<flag or segment key>.
export function parseRoute(hash: string): Route {
  const [, e, env, section, key] = hash.replace(/^#/, '').split('/');
  if (e !== 'e' || !env) return { env: null, section: 'flags', key: null };
  return { env, section: SECTIONS.includes(section as Section) ? (section as Section) : 'flags', key: key ? decodeURIComponent(key) : null };
}

export const href = (env: string, section: Section = 'flags', key?: string) => `#/e/${env}/${section}${key ? '/' + encodeURIComponent(key) : ''}`;
export const go = (to: string) => {
  location.hash = to.replace(/^#/, '');
};

// A screen with unsaved edits sets this, and leaving the screen asks first.
let unsaved = false;
export const setUnsaved = (value: boolean) => {
  unsaved = value;
};

export function useRoute(): Route {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    let current = location.hash;
    const onChange = () => {
      if (unsaved && !window.confirm('You have unsaved changes. Leave without saving?')) {
        history.replaceState(null, '', current || '#/');
        return;
      }
      unsaved = false;
      current = location.hash;
      setHash(current);
    };
    const onLeave = (event: BeforeUnloadEvent) => {
      if (unsaved) event.preventDefault();
    };
    addEventListener('hashchange', onChange);
    addEventListener('beforeunload', onLeave);
    return () => {
      removeEventListener('hashchange', onChange);
      removeEventListener('beforeunload', onLeave);
    };
  }, []);
  return parseRoute(hash);
}

export type App = {
  envs: EnvSummary[];
  /** The environment on screen, with its flags. Null while loading or when there is none. */
  env: Environment | null;
  route: Route;
  /** Fetches the current environment again, after a change. */
  reload: () => Promise<void>;
  reloadEnvs: () => Promise<EnvSummary[]>;
  signOut: () => void;
};

export const AppContext = createContext<App | null>(null);
export const useApp = () => useContext(AppContext)!;
/** For screens that only render once an environment is loaded. */
export const useEnv = () => useApp().env!;
