# Server Setup (current)

## Requirements

- Node.js 18+ recommended
- npm
- Optional PostgreSQL database (`DATABASE_URL`)

## Local run

```bash
cd server
npm install
npm start
```

Server starts on `PORT` (default `3001`).

## Environment variables

- `PORT` — HTTP port (default `3001`)
- `DATABASE_URL` — PostgreSQL connection string (optional)
- `NODE_ENV` — set to `production` for deployed services
- `AGENT_TIMEOUT` — stale-agent cleanup timeout in ms (default `180000`)
- `TRUST_PROXY` — Express trust proxy value (`true`, `false`, number, etc.)
- `OPENAI_API_KEY` — enables activity summary generation
- `OPENAI_MODEL` — optional model override for activity summaries

## Persistence behavior

- With `DATABASE_URL`: entities, sessions, chats, and rate-limit data persist in Postgres.
- Without `DATABASE_URL`: server runs in-memory only (data lost on restart).

## Deployment notes

The repo includes deployment helpers under `server/`:

- `Dockerfile`
- `railway.json`
- `render.yaml`

Any platform is fine as long as it exposes the Node service and sets required env vars.

## Quick health checks

```bash
curl -s http://localhost:3001/ping
curl -s http://localhost:3001/status
```

## Common issues

- `401` on `/spawn`, `/move`, `/chat`, `/action`: missing/expired Bearer token.
- `409` on `/entity/create`: duplicate `entity_id`, `entity_name`, or public key fingerprint.
- Frequent `429`: entity/IP is hitting configured rate limits.
