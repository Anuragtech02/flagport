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

A hosted instance runs at <https://flagport.apal895.workers.dev>. Open the
dashboard, create a workspace, and you get a workspace key. There are no
accounts and no emails: the key is the only way into your workspace and cannot
be recovered, so save it.

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

## How it is built

- `src/index.ts`: the Worker. Routes the admin API under `/api/` and every
  SDK endpoint.
- `src/sdk.ts`: the endpoints LaunchDarkly's server, browser and mobile SDKs
  call.
- `src/environment.ts`: one Durable Object per environment. It holds that
  environment's flags and segments, keeps the SDK streams open and pushes
  every change to them.
- `src/registry.ts`: one Durable Object that lists workspaces and the
  environments each one owns. Only a hash of each workspace key is stored.
- `src/evaluate.ts`: evaluates flags for browser and mobile SDKs with
  LaunchDarkly's own open-source evaluator.
- `src/ldimport.ts`: converts flags and segments read from the LaunchDarkly
  REST API.
- `public/app/`: the dashboard. `public/index.html` and `site/`: the landing
  page.

Flags are stored in LaunchDarkly's own format, so nothing is translated on
the way in or out.

### Admin API

Every route except the first two needs `Authorization: Bearer <key>`, where
the key is a workspace key or the admin token. A key only ever sees its own
workspace's environments.

| Route | Does |
| --- | --- |
| `GET /api/instance` | Says whether sign-ups are open |
| `POST /api/workspaces` | Creates a workspace and returns its key (only when sign-ups are open) |
| `GET /api/envs` | Lists environments |
| `POST /api/envs` | Creates an environment: `{ "name": "Production" }` |
| `GET /api/envs/:id` | Keys, flags, segments, connected SDKs and evaluation counts |
| `DELETE /api/envs/:id` | Deletes the environment and turns its keys off |
| `PUT /api/envs/:id/flags/:key` | Creates or replaces a flag |
| `DELETE /api/envs/:id/flags/:key` | Deletes a flag |
| `PUT` and `DELETE /api/envs/:id/segments/:key` | The same, for segments |
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
npm run test:e2e  # real LaunchDarkly SDKs against the running server, plus workspace isolation
```

The end-to-end tests also run against a deployed instance:
`BASE=https://your-flagport.example ADMIN_TOKEN=... npm run test:e2e`. The
workspace test needs sign-ups open.

## Known limits

- A workspace key cannot be recovered or rotated yet.
- One key per workspace: there are no team members or roles.
- A workspace can hold 10 environments. The instance owner is not limited.
- Sign-ups are rate limited per network, and that is the only abuse control.
- There is no audit log.

## Licence

MIT. See [LICENSE](LICENSE).
