// The small set of building blocks every screen uses.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';

const PATHS: Record<string, string> = {
  flag: 'M5 21V4m0 0h11l-1.5 4L16 12H5',
  segment: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1m17 0v-1a4 4 0 0 0-3-3.87M14 4.13a4 4 0 0 1 0 7.75M13 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  plug: 'M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4',
  settings: 'M4 7h9m4 0h3M4 17h3m4 0h9M15 5v4M9 15v4',
  search: 'm20 20-4.2-4.2M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z',
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  down: 'm6 9 6 6 6-6',
  x: 'M6 6l12 12M18 6 6 18',
  up: 'm6 15 6-6 6 6',
  trash: 'M5 7h14M10 7V4h4v3m-7 0 1 13h8l1-13',
  key: 'M14.5 9.5a4 4 0 1 1-3.6 2.3L4 18.7V21h2.5v-2H9v-2.3l1.7-1.7a4 4 0 0 1 3.8-5.5Zm1.5 2.5h.01',
  external: 'M14 5h5v5m0-5-8 8M11 6H6v12h12v-5',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm9.5 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  out: 'M10 5H5v14h5m5-11 4 4-4 4m4-4H9',
  back: 'M15 6 9 12l6 6',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  alert: 'M12 8v5m0 3.5h.01M10.3 4.3 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z',
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'default' | 'ghost' | 'danger'; small?: boolean; icon?: string };
export function Button({ kind = 'default', small, icon, className = '', children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={`btn btn-${kind} ${small ? 'btn-small' : ''} ${children ? '' : 'btn-icon'} ${className}`} {...rest}>
      {icon && <Icon name={icon} size={small ? 14 : 16} />}
      {children}
    </button>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className="toggle" onClick={() => onChange(!on)} />;
}

export function Swatch({ color }: { color: string }) {
  return <span className="swatch" style={{ background: color }} aria-hidden="true" />;
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {error ? <p className="field-error">{error}</p> : hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

// ---- Modal --------------------------------------------------------------------

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    // Start on the first field when there is one, not on the close button.
    if (!dialog.querySelector('[autofocus]')) dialog.querySelector<HTMLElement>('.modal-body input, .modal-body select, .modal-body textarea')?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      onClose={onClose}
      onMouseDown={(event) => event.target === ref.current && onClose()}
    >
      <header className="modal-head">
        <h2>{title}</h2>
        <Button kind="ghost" small icon="x" aria-label="Close" onClick={onClose} />
      </header>
      {children}
    </dialog>
  );
}

/** A form inside a modal: runs the action, shows its error, closes when it succeeds. */
export function ModalForm({ onSubmit, onClose, submit, danger, disabled, children }: {
  onSubmit: () => Promise<void> | void;
  onClose: () => void;
  submit: string;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSubmit();
          onClose();
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Something went wrong.');
          setBusy(false);
        }
      }}
    >
      <div className="modal-body">{children}</div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="modal-foot">
        <Button onClick={onClose}>Cancel</Button>
        <Button kind={danger ? 'danger' : 'primary'} type="submit" disabled={busy || disabled}>{busy ? 'Working…' : submit}</Button>
      </footer>
    </form>
  );
}

// ---- Toasts -------------------------------------------------------------------

const ToastContext = createContext<(message: string, tone?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function Toasts({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; message: string; tone: string }[]>([]);
  const push = useCallback((message: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list, { id, message, tone }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === 'error' ? 5200 : 2600);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon name={t.tone === 'error' ? 'alert' : 'check'} size={15} />
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function CopyButton({ value, label = 'Copy', small = true }: { value: string; label?: string; small?: boolean }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <Button
      small={small}
      icon={done ? 'check' : 'copy'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          toast('Could not copy. Select the text and copy it by hand.', 'error');
        }
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

// ---- Chips: a list of values typed one at a time ---------------------------------

export function Chips({ values, onChange, placeholder, parse = (text) => text, suggestions, label }: {
  values: unknown[];
  onChange: (values: unknown[]) => void;
  placeholder?: string;
  parse?: (text: string) => unknown;
  suggestions?: string[];
  label: string;
}) {
  const [text, setText] = useState('');
  const listId = useId();
  const add = (raw: string) => {
    const parts = raw.split(/[\n,]/).map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...values];
    for (const part of parts) {
      const value = parse(part);
      if (value !== undefined && !next.some((v) => JSON.stringify(v) === JSON.stringify(value))) next.push(value);
    }
    onChange(next);
    setText('');
  };
  return (
    <div className="chips">
      {values.map((value, i) => (
        <span className="chip" key={i}>
          {typeof value === 'string' ? value : JSON.stringify(value)}
          <button type="button" aria-label={`Remove ${String(value)}`} onClick={() => onChange(values.filter((_, j) => j !== i))}>
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        value={text}
        list={suggestions ? listId : undefined}
        placeholder={values.length ? '' : placeholder}
        onChange={(event) => (/[\n,]/.test(event.target.value) ? add(event.target.value) : setText(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && text.trim()) {
            event.preventDefault();
            add(text);
          } else if (event.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
        }}
        onBlur={() => add(text)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData('text');
          if (/[\n,]/.test(pasted)) {
            event.preventDefault();
            add(pasted);
          }
        }}
      />
      {suggestions && <datalist id={listId}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.id} role="tab" type="button" aria-selected={tab.id === value} className="tab" onClick={() => onChange(tab.id)}>
          {tab.label}
          {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

/** Stands in for a list while it loads, so the page does not jump when the data arrives. */
export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      <div className="skeleton-title" />
      <div className="skeleton-table">{Array.from({ length: rows }, (_, i) => <div key={i} style={{ animationDelay: `${i * 90}ms` }} />)}</div>
    </div>
  );
}

/** Tiny bar chart of daily totals. */
export function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <span className="spark" aria-hidden="true">
      {values.map((v, i) => <i key={i} style={{ height: `${v ? Math.max(12, (v / max) * 100) : 4}%`, opacity: v ? 1 : 0.35 }} />)}
    </span>
  );
}
