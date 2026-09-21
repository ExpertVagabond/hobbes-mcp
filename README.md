# hobbes-mcp

A Model Context Protocol server for the [Hobbes](https://hihobbes.com) API, generated from
Hobbes's own published OpenAPI document, with a client-side policy gate on the operations
that reach production.

## Why this exists

Hobbes already gates its own writes carefully. Read their spec:

- `POST /api/v1/playbook/update-previews` validates restricted JSON Patch operations
  against a clone of staging and returns a deterministic before/after summary. The spec is
  explicit that it **never changes staging**, and previews expire after 24 hours.
- Applying is a separate call against that preview id.
- `POST /api/v1/agent/publish-jobs` requires an explicit `publish_to_production`
  confirmation, and Hobbes runs a conversation-test gate before production changes.

That is preview, then confirm, then act. It is a well-designed boundary, and it lives on
the server where it belongs.

This server adds the client-side half, so the same boundary holds when an **agent** is
composing the calls rather than a human clicking through a UI. Of the 34 operations in the
spec, 21 are read-only and 13 mutate. `src/policy.ts` evaluates every call to `allow`,
`escalate`, or `refuse` before it reaches the network.

Notably, it **allows** `update-previews` unattended, because Hobbes's own contract
guarantees that endpoint cannot change staging. It is a dry run, so an agent should be free
to explore with it. The gate is not "writes are scary", it is a distinction read out of the
API's own semantics.

## Tools

All 34 are generated from `src/openapi.json` ("Hobbes API" 1.0.0, 29 paths), so the surface
is Hobbes's contract rather than a guess at it.

| Tag | Operations |
|---|---|
| Custom Links | 7 |
| Custom Link Campaigns | 6 |
| Custom Link Jobs | 5 |
| Playbook | 5 |
| Sessions | 3 |
| Agent Publishing | 2 |
| People / Accounts / Metrics | 6 |

## Install

```bash
npm install
cp .env.example .env   # add an hb_live_ key
npm run build
```

Register with an MCP client:

```bash
claude mcp add hobbes -- node /path/to/hobbes-mcp/dist/index.js
```

## Configuration

| Variable | Purpose |
|---|---|
| `HOBBES_API_KEY` | An `hb_live_` key. Sent as both `Authorization: Bearer` and `x-api-key`. |
| `HOBBES_BASE_URL` | Defaults to `https://api-us.hihobbes.com`. |
| `HOBBES_SESSION_MUTATION_LIMIT` | Mutating calls allowed per session. Defaults to 10. |

## Verified

Against the live API on 2026-09-20:

```
GET  /health                     {"status":"healthy"}
GET  /api/v1/openapi.json        200, no auth required
tools/list                       34 tools
publish-jobs, no key             refused by policy, before any network call
update-previews, no key          allowed through, reached Hobbes's real 401
```

That last pair is the point: the gate distinguishes the dry run from the operation that
reaches a customer's live sales conversation.

## Notes

`src/openapi.json` is a vendored copy of Hobbes's publicly served spec, kept in-tree so the
generated tool list is reproducible without a network call at build time. Regenerate with
the spec URL in `src/index.ts` if their API changes.

## License

MIT
