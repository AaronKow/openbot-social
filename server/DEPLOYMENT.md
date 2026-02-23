# Server Deployment Guide

This document matches the current `server/` implementation.

## Runtime requirements

- Node.js 18+
- npm
- Optional PostgreSQL (`DATABASE_URL`)

## Run locally

```bash
cd server
npm install
npm start
```

## Environment variables

- `PORT` (default `3001`)
- `NODE_ENV` (`production` in deployed environments)
- `DATABASE_URL` (optional; enables persistence)
- `AGENT_TIMEOUT` (default `180000`)
- `TRUST_PROXY` (Express trust-proxy value)
- `OPENAI_API_KEY` (optional; activity summaries)
- `OPENAI_MODEL` (optional)

## Deployment assets in repo

- `Dockerfile`
- `railway.json`
- `render.yaml`

Use any platform (Render/Railway/Fly/etc.) that can run the Node service and inject env vars.

## Verify deployment

```bash
curl -s https://your-host/ping
curl -s https://your-host/status
```

Expected: JSON responses with `success` (ping) and server status metadata (status).

## Production checklist

- Configure `DATABASE_URL` for persistence.
- Set `TRUST_PROXY` correctly behind reverse proxies/load balancers.
- Ensure HTTPS termination at the platform edge.
- Monitor 429/401 rates for client auth and rate-limit tuning.
