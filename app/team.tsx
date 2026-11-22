// Members: each person or service signs in with a key of their own, and a role decides what it may do.
import { useCallback, useEffect, useState } from 'react';
import { api, auth, ROLES, type Member, type Role } from './api';
import { ago } from './model';
import { ROLE_NOTES, useApp, useCan } from './state';
import { Button, CopyButton, Field, Icon, Modal, ModalForm, useToast } from './ui';

const label = (role: Role) => role[0].toUpperCase() + role.slice(1);

/** Shows a key once. It cannot be shown again, so closing asks for confirmation that it was saved. */
function KeyReveal({ title, name, secret, onClose }: { title: string; name: string; secret: string; onClose: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <Modal title={title} onClose={() => saved && onClose()}>
      <div className="modal-body">
        <p>This is the only time the key for <strong>{name}</strong> is shown. The server keeps only a hash of it. Hand it over through a password manager, not chat or email.</p>
        <div className="secret"><code>{secret}</code><CopyButton value={secret} /></div>
        <label className="check"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />The key is saved somewhere safe</label>
      </div>
      <footer className="modal-foot"><Button kind="primary" disabled={!saved} onClick={onClose}>Done</Button></footer>
    </Modal>
  );
}

export function TeamPage() {
  const { me, signOut } = useApp();
  const can = useCan();
  const toast = useToast();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('writer');
  const [reveal, setReveal] = useState<{ title: string; name: string; secret: string } | null>(null);
  const [rotating, setRotating] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);

  const load = useCallback(() => api.members().then(setMembers, (e) => setError(e.message)), []);
  useEffect(() => { void load(); }, [load]);

  // Only an owner may manage owners; admins manage everyone else.
  const manages = (member: Member) => can(member.role === 'owner' ? 'owner' : 'admin');
  const grantable = ROLES.filter((r) => r !== 'owner' || can('owner'));

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Team</h1>
          <p className="muted">Each person or service signs in with a key of their own, so the audit log can say who did what. A role decides what a key may do.</p>
        </div>
        <Button kind="primary" icon="plus" disabled={!can('admin')} title={can('admin') ? undefined : 'Adding members needs the admin role'} onClick={() => { setName(''); setRole('writer'); setAdding(true); }}>Add member</Button>
      </header>

      {me.id === 'instance-owner' && (
        <div className="notice"><Icon name="key" /><span>You are signed in with this instance’s admin token, which always has the owner role. Add members here so people do not have to share it.</span></div>
      )}
      {error ? <div className="notice notice-error"><Icon name="alert" />{error}</div> : !members ? <div className="loading" aria-label="Loading" /> : (
        <div className="table table-team" role="table" aria-label="Members">
          <div className="thead" role="row"><span role="columnheader">Member</span><span role="columnheader">Role</span><span role="columnheader">Key last used</span><span role="columnheader" /></div>
          {members.map((member) => (
            <div className="trow" role="row" key={member.id}>
              <span role="cell" className="flag-cell">
                <span className="flag-name">{member.name}{member.id === me.id && <em className="you">You</em>}</span>
                <span className="flag-key-text muted">Added {ago(member.createdAt)}</span>
              </span>
              <span role="cell">
                {manages(member) ? (
                  <select
                    aria-label={`Role of ${member.name}`}
                    value={member.role}
                    onChange={async (event) => {
                      try {
                        await api.updateMember(member.id, { role: event.target.value as Role });
                        toast(`${member.name} is now ${event.target.value}`);
                      } catch (e) {
                        toast((e as Error).message, 'error');
                      }
                      await load();
                    }}
                  >
                    {ROLES.filter((r) => r !== 'owner' || can('owner')).map((r) => <option key={r} value={r}>{label(r)}</option>)}
                  </select>
                ) : <span title={ROLE_NOTES[member.role]}>{label(member.role)}</span>}
              </span>
              <span role="cell" className="muted">{member.lastUsedAt ? ago(member.lastUsedAt) : 'Never'}</span>
              <span role="cell" className="row-actions">
                {(manages(member) || member.id === me.id) && <Button small onClick={() => setRotating(member)}>Replace key</Button>}
                {(manages(member) || member.id === me.id) && <Button small kind="ghost" icon="trash" aria-label={`Remove ${member.name}`} onClick={() => setRemoving(member)} />}
              </span>
            </div>
          ))}
        </div>
      )}

      <section className="roles">
        <h2>What each role can do</h2>
        <dl>{ROLES.map((r) => <div key={r}><dt>{label(r)}</dt><dd>{ROLE_NOTES[r]}</dd></div>)}</dl>
      </section>

      {adding && (
        <Modal title="Add a member" onClose={() => setAdding(false)}>
          <ModalForm
            submit="Add and create key"
            onClose={() => setAdding(false)}
            disabled={!name.trim()}
            onSubmit={async () => {
              const created = await api.addMember(name.trim(), role);
              await load();
              setReveal({ title: `Key for ${created.member.name}`, name: created.member.name, secret: created.key });
            }}
          >
            <Field label="Name" hint="A person, or a service such as “CI pipeline”. It is what the audit log shows.">
              {(id) => <input id={id} autoFocus maxLength={80} placeholder="Asha Rao" value={name} onChange={(event) => setName(event.target.value)} />}
            </Field>
            <fieldset className="choices choices-rows">
              <legend>Role</legend>
              {grantable.map((r) => (
                <label key={r} className={role === r ? 'chosen' : ''}>
                  <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} />
                  <strong>{label(r)}</strong>
                  <span>{ROLE_NOTES[r]}</span>
                </label>
              ))}
            </fieldset>
          </ModalForm>
        </Modal>
      )}

      {rotating && (
        <Modal title={`Replace the key of ${rotating.name}?`} onClose={() => setRotating(null)}>
          <ModalForm
            submit="Replace key"
            onClose={() => setRotating(null)}
            onSubmit={async () => {
              const result = await api.rotateMemberKey(rotating.id);
              // Your own old key has just stopped working, so this browser moves to the new one.
              if (rotating.id === me.id) auth.set(result.key);
              await load();
              setReveal({ title: `New key for ${rotating.name}`, name: rotating.name, secret: result.key });
            }}
          >
            <p>The current key stops working straight away. Anything still using it, such as a script or another browser, is signed out until it gets the new key.</p>
          </ModalForm>
        </Modal>
      )}

      {removing && (
        <Modal title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}>
          <ModalForm
            danger
            submit="Remove member"
            onClose={() => setRemoving(null)}
            onSubmit={async () => {
              await api.removeMember(removing.id);
              if (removing.id === me.id) return signOut();
              toast(`Removed ${removing.name}`);
              await load();
            }}
          >
            <p>{removing.id === me.id ? 'Your key stops working and you are signed out. Someone else has to add you again.' : 'Their key stops working straight away. Their past changes stay in the audit log under their name.'}</p>
          </ModalForm>
        </Modal>
      )}

      {reveal && <KeyReveal {...reveal} onClose={() => setReveal(null)} />}
    </div>
  );
}
