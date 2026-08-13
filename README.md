# RailPanel

A small VLESS panel built for Railway, with a Cloudflare-backed node generator.

It drives Xray directly, with no other panel underneath, and has **no npm
dependencies** — everything comes from the Node standard library, so the build
installs nothing and there is no dependency tree to audit.

## Inside the container

```
nginx        the only process reachable from outside, on $PORT
railpanel    Node: the panel UI and its API, on 127.0.0.1
xray         the engine, running a config the panel writes
```

## Deploy

1. Push this repo to GitHub, then Railway → Deploy from GitHub repo.
2. **Settings → Volumes** → mount a volume at `/data`. Without it, every
   redeploy wipes your inbounds, clients and node set.
3. **Settings → Networking → Generate Domain.**
4. Open the panel, sign in with `railpanel` / `railpanel`, and change it.

## Variables

Everything has a working default; set these only if you need to.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | public port, injected by Railway |
| `PANEL_PORT` | `8090` | internal panel port |
| `XRAY_API_PORT` | `10085` | internal Xray stats API |
| `DATA_DIR` | `/data` | volume mount path |
| `TZ` | `Asia/Tehran` | container timezone |
| `PANEL_PATH` | *(none)* | serve the panel under a path, e.g. `railpanel` |

### Hiding the panel

Set `PANEL_PATH` to something only you know and the panel moves to
`https://your-domain.com/<that>/`. Every other address — the root, a wrong
guess, even `/api/...` — returns the same blank page, so a scanner cannot
tell whether it is close.

Subscription links stay on the root (`/sub/<id>`): they are handed to other
people and should not carry the panel's whereabouts. `/healthz` stays public
too, for Railway's health check.

It lives in a variable rather than in the panel's own settings on purpose —
a typo saved through the interface would lock you out with no way back,
whereas a variable can always be changed from the Railway dashboard.

### A second domain

Railway accepts several domains on one service, and all of them reach the
same container. Add the second one with the same target port, `8080`.

Do not generate nodes on Railway's own `up.railway.app` address: it is not
behind Cloudflare, so it has neither clean IPs nor the alternate ports, and
it exposes the origin.

## Layout

```
Dockerfile          node + nginx + a pinned Xray release
start.sh            renders the bootstrap nginx config, then runs the panel
nginx.conf.tmpl     bootstrap only; the panel rewrites it at runtime
server/index.js     HTTP server, static files, session gate
server/api.js       API routes
server/lib/         store, auth, sysstat, http helpers
web/index.html      the panel itself, one self-contained file
```

## Notes on storage

All state lives in one file, `/data/railpanel.json`, written atomically. The
Railway API token inside it is encrypted with a key derived from your panel
password, which the panel only holds while you are signed in — so copying the
file off the volume does not reveal the token. Changing your password clears
the stored token, and the panel asks for it again.

## Status

Foundation: container, storage, authentication, account changes, system stats.
Xray control, inbounds, clients and the node generator come next.
