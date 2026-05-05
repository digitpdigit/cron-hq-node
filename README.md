# cron-hq

Small dashboard + HTTP API to schedule outbound HTTP jobs with cron expressions (`node-cron`). Jobs load from `SETTINGS` env or `settings.json`.

## Requirements

- Node.js 18+

## Run locally

```bash
npm install
cp .env.example .env   # edit PORT / SETTINGS / DEBUG
npm run dev            # hot reload (nodemon)
# or
node index.js
```

Web UI: `http://localhost:<PORT>/` (default port **3040**).

API probe: `GET /api` lists endpoints (JSON).

## Environment

| Variable   | Description |
| ---------- | ----------- |
| `PORT`     | HTTP port (default `3040`) |
| `SETTINGS` | Optional JSON array of jobs (or legacy `{ "jobs": [...] }`). If non-empty and valid, overrides `settings.json` **at process start** only. |
| `DEBUG`    | `true` enables verbose caller logging |
| `LOG_PURGE_CRON` | **Env only** — scheduled in-memory log purge. Variable **omitted** → default `0 0 3 * * 0` (weekly Sun 03:00). `false` → off. `true` → default expression. Any other value → full `node-cron` string. Changing it requires a **process restart** (not saved in `settings.json`). |

Job objects need at least `jobs`, `cron`, `method`, and `url`.

## Docker

```bash
docker build -t cron-hq .
docker run --rm -p 3040:3040 \
  -e SETTINGS='[{"jobs":"demo","cron":"*/30 * * * * *","method":"GET","url":"https://example.com"}]' \
  cron-hq
```

Mount `settings.json` instead of using `SETTINGS`:

```bash
docker run --rm -p 3040:3040 -v "${PWD}/settings.json:/app/settings.json:ro" cron-hq
```
