// Webhooks: every audit entry can be sent to a URL, as signed JSON or as a Slack message.

export type WebhookFormat = 'json' | 'slack';
/** The kinds of audit entry a webhook can be limited to. None chosen means all of them. */
export const WEBHOOK_KINDS = ['flags', 'segments', 'change', 'environment', 'member', 'webhook'];

export interface Delivery {
  id: number;
  /** flag.updated, change.requested, ping, and so on. */
  event: string;
  summary: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  /** The HTTP status of the last attempt, when the endpoint answered at all. */
  code: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** When the next attempt is due, while it is still being retried. */
  nextAt: string | null;
}

export interface Webhook {
  id: string;
  name: string;
  /** Enough of the URL to recognise it. The rest is kept back, because a Slack URL is itself a secret. */
  urlHint: string;
  format: WebhookFormat;
  kinds: string[];
  envs: string[];
  enabled: boolean;
  createdAt: string;
  last: Delivery | null;
}

/** An audit entry on its way out. */
export interface WebhookEvent {
  id: number;
  at: string;
  workspace: string;
  actor: { id: string; name: string };
  envId?: string | null;
  envName?: string | null;
  action: string;
  kind: string;
  key: string;
  summary: string;
  comment?: string;
  before?: unknown;
  after?: unknown;
}

const PRIVATE_V4 = /^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/** Accepts public https addresses only. `allowLocal` lets a local development server post to this machine. */
export function checkWebhookUrl(raw: unknown, allowLocal: boolean): { url: string } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'A URL is required' };
  if (raw.length > 2000) return { error: 'The URL is too long' };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: 'That is not a valid URL' };
  }
  const host = url.hostname.toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1';
  if (local && allowLocal && (url.protocol === 'http:' || url.protocol === 'https:')) return { url: url.href };
  if (url.protocol !== 'https:') return { error: 'The URL must start with https://' };
  if (url.username || url.password) return { error: 'The URL must not contain a user name or password' };
  if (local || host.startsWith('[') || !host.includes('.') || PRIVATE_V4.test(host) || /\.(local|localhost|internal|lan|home\.arpa)$/.test(host)) {
    return { error: 'The URL must be a public address' };
  }
  return { url: url.href };
}

export function urlHint(raw: string): string {
  const url = new URL(raw);
  const rest = url.pathname + url.search;
  return url.origin + (rest.length > 14 ? rest.slice(0, 13) + '…' : rest);
}

const SINGULAR: Record<string, string> = { flags: 'flag', segments: 'segment' };
export const eventName = (kind: string, action: string) => (action === 'ping' ? 'ping' : `${SINGULAR[kind] ?? kind}.${action}`);

/** Where in the dashboard the thing that changed can be seen. */
export function linkFor(base: string, event: WebhookEvent): string {
  if (!event.envId || (event.kind === 'environment' && event.action === 'deleted')) return base;
  const section = { flags: 'flags', segments: 'segments', change: 'changes', member: 'team', webhook: 'integrations' }[event.kind] ?? 'flags';
  const item = (event.kind === 'flags' || event.kind === 'segments') && event.key && event.action !== 'deleted' ? '/' + encodeURIComponent(event.key) : '';
  return `${base}#/e/${event.envId}/${section}${item}`;
}

export function jsonBody(event: WebhookEvent, link: string): string {
  return JSON.stringify({
    version: 1,
    event: eventName(event.kind, event.action),
    id: event.id,
    at: event.at,
    workspace: event.workspace,
    actor: event.actor,
    environment: event.envId ? { id: event.envId, name: event.envName ?? '' } : null,
    kind: event.kind,
    action: event.action,
    key: event.key,
    summary: event.summary,
    comment: event.comment ?? '',
    before: event.before ?? null,
    after: event.after ?? null,
    url: link,
  });
}

const escapeSlack = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The same entry as a Slack message. It reads like a line of the audit log. */
export function slackBody(event: WebhookEvent, link: string): string {
  // A change request is about a flag too, and its key is that flag's.
  const subject = !event.key ? '' : event.kind === 'flags' || event.kind === 'change' ? `Flag \`${event.key}\`` : event.kind === 'segments' ? `Segment \`${event.key}\`` : '';
  const where = event.envName ? ` in ${event.envName}` : '';
  const lines = [`*${escapeSlack(event.summary)}*`];
  if (subject) lines.push(escapeSlack(subject + where));
  if (event.comment) lines.push(`> ${escapeSlack(event.comment)}`);
  const by = `By ${event.actor.name}${subject ? '' : where}`;
  return JSON.stringify({
    text: `${subject ? `${subject}${where}: ` : ''}${event.summary}, by ${event.actor.name}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${escapeSlack(by)}  |  <${link}|Open in Flagport>` }] },
    ],
  });
}

/** HMAC-SHA256 over "<timestamp>.<body>", as lowercase hex. The receiver recomputes it to know the request is ours. */
export async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
