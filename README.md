# Flagport

An open-source server that speaks the LaunchDarkly SDK protocol.

Your apps keep the LaunchDarkly SDKs they already use. You point those SDKs at
Flagport with three lines of configuration, and flag checks, targeting rules,
percentage rollouts and live updates carry on working. Nothing else in your
code changes.

```ts
import { init } from '@launchdarkly/node-server-sdk';

const client = init(process.env.SDK_KEY, {
  baseUri:   'https://your-flagport.example',
  streamUri: 'https://your-flagport.example',
  eventsUri: 'https://your-flagport.example',
});
```

Flagport is one Cloudflare Worker with Durable Objects for storage. There is
no database to run.

Flagport is an independent project. It is not affiliated with, endorsed by or
sponsored by LaunchDarkly. LaunchDarkly is a trademark of its owner.

## What works

| Area | Status |
| --- | --- |
| Server-side SDKs (streaming and polling) | Tested end to end with LaunchDarkly's Node.js server SDK |
| Client-side JavaScript SDKs | Tested with LaunchDarkly's client-side JavaScript SDK |
| Targeting rules, segments, prerequisites, percentage rollouts | Tested; browser results match the server SDK user for user |
| Live updates over streaming | Tested for server, browser and mobile connections |
| Mobile SDK endpoints | Built and protocol-tested; not yet run on real iOS or Android devices |
| Import from LaunchDarkly | Built; the converter is tested on sample API responses, not yet against a live LaunchDarkly account |
| Experimentation, secure mode, big segments | Not supported |
| Data saving mode (the newer SDK protocol) | Not supported |

## Use the hosted server

A hosted instance runs at <https://flagport.anuragpal.cloud>. Open the
dashboard, create a workspace, and you get an access key as its first owner.
There are no accounts and no emails: add a member for each person or service,
and each gets a key of their own with a role.

The hosted instance has no billing, no support contract and no uptime
guarantee. For anything you depend on, self-host.

## Self-host

You need a Cloudflare account and Node.js 22.18 or newer.

```bash
git clone https://github.com/Anuragtech02/flagport
cd flagport
npm install
npx wrangler login
npm run deploy
npx wrangler secret put ADMIN_TOKEN
```

The last command asks for a value. Choose a long random string, for example
the output of `openssl rand -hex 32`. It is the key you sign in to the
dashboard with, at `/app/` on your new Worker's address.

A fresh deploy is private: the admin token is the only key, and nobody can
sign up.

### Configuration

| Name | Kind | Meaning |
| --- | --- | --- |
| `ADMIN_TOKEN` | secret | The instance owner's key. Without it nobody can sign in as the owner. |
| `SIGNUPS` | secret or var | Set to `open` to let any visitor create a workspace of their own. Anything else, or unset, keeps the instance private. |

To open sign-ups, run `npx wrangler secret put SIGNUPS` and enter `open`.

### Custom domain

If the domain's DNS is on the same Cloudflare account, one deploy attaches it:

```bash
npm run deploy -- --domain flags.example.com
```

Cloudflare creates the DNS record and the certificate. The domain stays
attached on later deploys, so plain `npm run deploy` is enough afterwards, and
the `workers.dev` address keeps working alongside it.

## How it is built

- `src/index.ts`: the Worker. Routes the admin API under `/api/` and every
  SDK endpoint.
- `src/sdk.ts`: the endpoints LaunchDarkly's server, browser and mobile SDKs
  call.
- `src/environment.ts`: one Durable Object per environment. It holds that
  environment's flags and segments, keeps the SDK streams open and pushes
  every change to them.
- `src/registry.ts`: one Durable Object that holds workspaces, their members,
  their environments and the audit log. Only a hash of each access key is
  stored. It also queues and sends webhook deliveries.
- `src/webhooks.ts`: the JSON and Slack message formats, signing, and the
  check that an address is public.
- `src/evaluate.ts`: evaluates flags for browser and mobile SDKs with
  LaunchDarkly's own open-source evaluator.
- `src/ldimport.ts`: converts flags and segments read from the LaunchDarkly
  REST API.
- `app/`: the dashboard, a React app bundled into `public/app/` by
  `npm run build`. `public/index.html` and `site/`: the landing page.

Flags are stored in LaunchDarkly's own format, so nothing is translated on
the way in or out.

### Approvals and scheduled changes

A change to a flag can be proposed instead of saved: it then waits for another
member's approval, for a set time, or both. An environment can require
approval for every change to an existing flag; admins can skip it, and the
audit log records that they did.

When a change is applied, only the fields it actually altered are written. An
unrelated edit made in the meantime is kept. If someone else changed the same
field, the change fails rather than overwriting their work.

### Webhooks and Slack

Everything written to the audit log can be sent to a URL as it happens: a flag
switched on, a change waiting for approval, a member added. Admins add
webhooks on the Integrations page. Each one can be limited to kinds of change
and to environments.

- **Slack**: paste an incoming webhook URL. The message reads like a line of
  the audit log, with a link back to what changed.
- **Your own service**: signed JSON with who made the change, where, and the
  full before and after.

```json
{
  "version": 1,
  "event": "flag.updated",
  "id": 270,
  "at": "2026-11-22T16:49:51.404Z",
  "workspace": "5dca0c1421df3806",
  "actor": { "id": "b0eb5448ce8f47a8", "name": "Asha Rao" },
  "environment": { "id": "2663bf4183ee", "name": "Production" },
  "kind": "flags",
  "action": "updated",
  "key": "dark-mode",
  "summary": "Turned off",
  "comment": "Hotfix for the contrast bug",
  "before": { "on": true },
  "after": { "on": false },
  "url": "https://flagport.example/app/#/e/2663bf4183ee/flags/dark-mode"
}
```

`before` and `after` hold the whole flag (shortened here). Events are named `<thing>.<action>`:
`flag.created`, `flag.updated`, `flag.deleted`, the same for `segment`,
`change.requested`, `change.approved`, `change.rejected`, `change.cancelled`,
`change.failed`, `environment.*`, `member.*`, `webhook.*`, and `ping` for a
test message.

Every request carries `X-Flagport-Event`, `X-Flagport-Delivery`,
`X-Flagport-Timestamp` and `X-Flagport-Signature`. The signature is
`sha256=` followed by the HMAC-SHA256, in hex, of the timestamp, a dot and the
raw body, keyed with the webhook's signing secret:

```js
const signed = headers['x-flagport-timestamp'] + '.' + rawBody;
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(signed).digest('hex');
```

Answer with any 2xx status within 10 seconds. A timeout, a connection error, a
5xx, 408 or 429 is tried again after 5 seconds, 1 minute and 10 minutes; any
other answer is final. Redirects are not followed. Each webhook receives its
messages in order, and the last 50 deliveries are kept for troubleshooting.

Only public `https://` addresses are accepted. The full address is never
returned by the API or written to the audit log, because a Slack webhook URL
is itself a secret.

### Admin API

Every route except the first two needs `Authorization: Bearer <key>`, where
the key is a member's access key or the admin token. A key only ever sees its
own workspace.

Roles, each including the one before: `reader` can look, `writer` can change
flags and segments, `admin` can also manage environments and members, and
`owner` can also manage other owners. The admin token is always an owner.

| Route | Does |
| --- | --- |
| `GET /api/instance` | Says whether sign-ups are open |
| `POST /api/workspaces` | Creates a workspace and returns its key (only when sign-ups are open) |
| `GET /api/me` | Who the key belongs to, and its role |
| `GET /api/members` | Lists members |
| `POST /api/members` | Adds a member and returns their key once: `{ "name": "Asha", "role": "writer" }` |
| `PATCH /api/members/:id` | Changes a member's name or role |
| `POST /api/members/:id/rotate` | Replaces a member's key; the old one stops working |
| `DELETE /api/members/:id` | Removes a member |
| `GET /api/audit` | The audit log, newest first. Filters: `env`, `kind`, `key`, `actor`, `before`, `limit`. `format=csv` exports it |
| `GET /api/webhooks` | Lists webhooks with their last delivery (admins only, like every webhook route) |
| `POST /api/webhooks` | Adds a webhook and returns its signing secret once: `{ name, url, format, kinds, envs }`. `format` is `slack` or `json`; empty `kinds` or `envs` mean all |
| `PATCH /api/webhooks/:id` | Changes any of those fields, or `{ "enabled": false }` to turn it off |
| `DELETE /api/webhooks/:id` | Removes a webhook and its delivery record |
| `POST /api/webhooks/:id/test` | Sends a `ping` now and returns how it went |
| `POST /api/webhooks/:id/secret` | Replaces the signing secret and returns the new one once |
| `GET /api/webhooks/:id/deliveries` | The last 50 deliveries: event, result, attempts |
| `GET /api/envs` | Lists environments |
| `POST /api/envs` | Creates an environment: `{ "name": "Production" }` |
| `GET /api/envs/:id` | Keys, flags, segments, connected SDKs and evaluation counts |
| `PATCH /api/envs/:id` | Renames the environment: `{ "name": "Staging" }` |
| `DELETE /api/envs/:id` | Deletes the environment and turns its keys off |
| `PUT /api/envs/:id/flags/:key` | Creates or replaces a flag. `?comment=` adds a note to the audit log; `?ifVersion=` refuses the save if the flag changed since that version |
| `DELETE /api/envs/:id/flags/:key` | Deletes a flag |
| `PUT` and `DELETE /api/envs/:id/segments/:key` | The same, for segments |
| `PATCH /api/envs/:id/settings` | `{ "approvals": true }` requires approval for flag changes in that environment |
| `GET /api/envs/:id/changes` | Proposed changes: open ones first, then recently closed |
| `POST /api/envs/:id/changes` | Proposes a change: `{ flag, title, proposed, review, applyAt }`. `proposed` is the whole flag as it should become; `applyAt` schedules it |
| `POST /api/envs/:id/changes/:n/review` | `{ "decision": "approve" }` or `"reject"`, with an optional `comment`. The author cannot approve their own |
| `POST /api/envs/:id/changes/:n/apply` | Applies an approved change now instead of at its scheduled time |
| `POST /api/envs/:id/changes/:n/cancel` | Cancels an open change (its author, or an admin) |
| `POST /api/envs/:id/import` | Imports from LaunchDarkly: `{ apiToken, projectKey, environmentKey }` |

## Develop and test

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

The dashboard is at <http://localhost:48788/app/>. Sign in with the admin
token from `.dev.vars`, or create a workspace.

With the dev server running:

```bash
npm test          # the importer, checked by the real SDK
npm run test:e2e  # real LaunchDarkly SDKs against the running server, plus workspaces, roles, the audit log, approvals, schedules and webhooks
```

The end-to-end tests also run against a deployed instance:
`BASE=https://your-flagport.example ADMIN_TOKEN=... npm run test:e2e`. The
workspace test needs sign-ups open. Against a deployed instance the webhook
test cannot receive anything on your machine, so it checks sending, retries
and the delivery record with an address that cannot be reached.

## Known limits

- Members sign in with keys, not single sign-on. A lost key is replaced by an
  admin; it cannot be recovered.
- Roles apply to the whole workspace, not per environment or per flag.
- Approvals and schedules cover flags, not segments, and one approval is
  always enough.
- Webhooks go to Slack or to a URL of your own; there is no Microsoft Teams,
  email or PagerDuty format. A workspace can have 10 of them, a failed
  delivery cannot be sent again by hand, and a webhook that keeps failing is
  not turned off automatically.
- A workspace can hold 10 environments. The instance owner is not limited.
- Sign-ups are rate limited per network, and that is the only abuse control.
- The audit log keeps the newest 5,000 entries per workspace.

## Licence

MIT. See [LICENSE](LICENSE).
