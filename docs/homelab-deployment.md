# Deploying Bot Crossing to a Kubernetes cluster

This is the deployment contract for running Bot Crossing as a **display** — a remote,
read-only colony fed by a laptop that pushes snapshots to it (`BOT_CROSSING_MODE=display`).
It is written against a small self-hosted k3s cluster with mixed `amd64`/`arm64` nodes,
GitOps reconciliation from a separate manifest repository, deny-by-default network policy
and a locked-down pod security context. Nothing in this repository deploys itself.

Every section below says either **satisfied** and names the file, or what is left to do.
The manifests themselves live in the cluster's own repository, not here.

> **Status.** The container, the two health endpoints and the CI pipeline are in the tree.
> Display mode itself — `POST /api/sync`, snapshot-fed `/api/threads`, and the refusal to
> spawn anything — is a separate change; sections that describe it are marked as such rather
> than claimed. Nothing below is blocked on the cluster.

---

## 1. Image and registry

**Satisfied — see `Dockerfile` and `.github/workflows/ci.yml`.**

- Published to `ghcr.io/ralton-dev/bot-crossing`.
- Both `linux/amd64` and `linux/arm64`, each built on a native runner (`ubuntu-latest` and
  `ubuntu-24.04-arm`) and pushed **by digest**; a `docker-merge` job assembles the manifest
  list. No QEMU anywhere.
- Tags: `sha-<full 40-character commit sha>` and `latest`, on push to `main` only. A pull
  request builds and smoke-tests the image but pushes nothing, so no tag is ever re-pushed.
- The tag is printed to the job summary, because deployment is a hand-written tag bump and
  that number is the only thing the person doing it needs.

Verify a published tag with:

```
docker buildx imagetools inspect ghcr.io/ralton-dev/bot-crossing:sha-<sha>
```

## 2. CI runners

**Satisfied — no self-hosted runner is used.** The arm64 leg runs on GitHub's free
`ubuntu-24.04-arm`. The whole build is `npm ci` plus a Vite bundle measured in seconds, so
an in-cluster runner would buy nothing and would cost a manual runner-group admission step
and a privileged container on a home network. Nothing here needs adding to a runner group.

## 3. Health endpoints

**Satisfied — see `server/serve.mjs`.** Both are unauthenticated, outside `/api/`, and not
subject to the API's `Host`/`Origin` gate, because the kubelet presents no credentials and
no `Origin`.

| Path | Probe | What it proves | Body |
| --- | --- | --- | --- |
| `/healthz` | liveness | the process is alive and answering | `{ ok: true, version, mode }` |
| `/readyz` | readiness | the data directory is **writable** | `200 { ok: true, … }` or `503 { ok: false, error }` |

They are genuinely different: `/readyz` creates `BOT_CROSSING_DATA` if needed, writes a
`.readyz` probe file and removes it. A volume that is mounted but not writable by the
container's uid — the failure a `stat` would miss — answers 503. Verified locally: on a
read-only mount `/healthz` is 200 and `/readyz` is
`503 {"ok":false,"error":"EROFS: read-only file system, open '/data/.readyz'"}`.

`version` comes from `APP_VERSION`, which the manifest sets equal to the image tag. It is
not read from `package.json` — that number describes the source, not the container.

The same `/readyz` is the image's `HEALTHCHECK`, so there is one health story everywhere.

## 4. It runs locked down

**Satisfied — see `Dockerfile`.**

- `USER node` — the base image's built-in uid/gid 1000, matching a numeric
  `runAsUser`/`runAsGroup`/`fsGroup` of 1000. No name-based user is relied on.
- Listens on `PORT=8080`, above 1024, so no `CAP_NET_BIND_SERVICE` is needed.
- **Read-only root filesystem is fine.** The server writes in exactly one place:
  `BOT_CROSSING_DATA` (`/data` in the image) — `colony.json`, its `.tmp` sibling during an
  atomic write, the `/readyz` probe file, and, in display mode, `snapshots/`. Nothing else on
  disk is ever written at runtime.
- **`$HOME` unwritable is harmless.** The image sets `HOME=/tmp` as a belt-and-braces
  default, but nothing under `server/` writes to `$HOME` at all: the harness scanners only
  *read* `~/.claude`, `~/.codex` and `~/.cursor`, and in display mode they are not called.
  An empty or unreadable home directory is a pod with no local threads to scan, which is
  precisely the intent. Mount `/tmp` as an `emptyDir` anyway — Node will use it for whatever
  it decides it needs.
- No entrypoint chowns, chmods or writes config at startup. `mkdir -p /data && chown
  node:node /data` happens at **build** time; at run time the mount's ownership is the
  cluster's job (`fsGroup: 1000`).
- Nothing in display mode spawns a process. (The three endpoints that shell out —
  `/api/open`, `/api/new-session`, `/api/reveal` — answer 403 in display mode before they
  read a body. That refusal ships with the display-mode change, not with the image.)

## 5. Configuration is environment variables only

**Satisfied — every setting is an environment variable, and there is no config file anywhere
in the app.**

| variable | default | secret | meaning |
| --- | --- | --- | --- |
| `BOT_CROSSING_MODE` | `local` (image sets `display`) | no | `local` or `display` |
| `BOT_CROSSING_SYNC_TOKEN` | — | **yes** | bearer token for `POST /api/sync`; required in display mode |
| `BOT_CROSSING_PUBLIC_HOST` | — | no | the public hostname the page is served under; required in display mode |
| `BOT_CROSSING_STALE_AFTER_S` | `180` | no | a snapshot older than this yields a warning, not an error |
| `BOT_CROSSING_DATA` | `<repo>/data` (image: `/data`) | no | the one writable path |
| `BOT_CROSSING_HOST` | `0.0.0.0` in display mode, `127.0.0.1` otherwise | no | bind address |
| `PORT` | `5274` (image: `8080`) | no | listen port |
| `APP_VERSION` | `dev` | no | reported by `/healthz`; set it to the image tag |
| `HOME` | — (image: `/tmp`) | no | unused in display mode; set for the runtime's benefit |

The secret one belongs in a Secret, the rest in a ConfigMap. `BOT_CROSSING_MODE`,
`BOT_CROSSING_DATA`, `BOT_CROSSING_HOST`, `PORT` and `APP_VERSION` are read by
`server/serve.mjs` today; the four display-mode variables are read by the display-mode change
that adds `/api/sync`, which must **fail at startup naming the missing variable** rather than
starting and failing on the first request.

Environment injected wholesale does not roll pods when it changes; bump a `config-rev`
annotation on the pod template in the same commit. The app tolerates a restart to pick
config up — there is no live reload and no in-memory state that matters. `colony.json` on
the volume survives a restart and is the only thing that has to.

## 6. Postgres

**Does not apply.** There is no database. The only persisted state is JSON files on one
volume (`colony.json` and `snapshots/*.json`), so nothing here connects to a shared Postgres
cluster and its certificate is not this app's problem.

## 7. Migrations

**Does not apply.** No schema, so no migration job. The one state file carries a `version`
field and migrates itself in place on read, at process start, with no external step.

## 8. Networking

**Satisfied, and the list is short. Enumerated in full:**

**Inbound**

| from | to | port | why |
| --- | --- | --- | --- |
| Traefik (the ingress) | the pod | `8080` (`http`) | the page itself, `/api/*` for the page's own reads and state writes, and `POST /api/sync` for the laptop's pushes |
| the kubelet | the pod | `8080` | liveness `/healthz` and readiness `/readyz`, from the node subnet |

One port, one Service, one Ingress. No WebSockets — the page polls `/api/threads` over
plain HTTP. No sub-path hosting: serve it from a domain root.

**Outbound: none.** Not "none except DNS-resolvable APIs" — none at all. The network policy
can deny egress outright.

Verified by grepping the tree for runtime external calls:

- `grep -rn 'fetch(' src/ server/` finds four call sites, all same-origin and relative:
  `src/game/api.js` (`/api/…`) and `src/audio/ambience.js`
  (`import.meta.env.BASE_URL + 'audio/manifest.json'`, and sample files resolved against the
  same base).
- `grep -rn 'https\?://' src/ server/` finds no external host. Every hit is either an inline
  `data:` SVG carrying the SVG XML namespace, or `new URL(req.url, 'http://localhost')` — a
  parser base, not a request.
- `index.html` loads no CDN script and no web font. The CSS uses system font stacks only
  (`ui-sans-serif`, `ui-monospace`).
- No analytics, no update check, no crash reporter, no licence call.

One theoretical exception, worth knowing about and not a hole: the audio layer will fetch an
absolute URL if a hand-written `public/audio/manifest.json` names one. The image ships no
such manifest (`.dockerignore` excludes `public/audio/*` except its README) and the fetch
would run in the **viewer's** browser, not in the pod, so it is not pod egress either way.

**Bind address:** `0.0.0.0` is the default when `BOT_CROSSING_MODE=display`, which the image
sets. Local mode still defaults to `127.0.0.1`, deliberately.

## 9. Tracing

**Does not apply.** The app emits no telemetry and loads no OpenTelemetry SDK. Logging is
one line per event to stdout, which is where a cluster's log collector already looks.

## 10. It runs behind two reverse proxies

**Satisfied, mostly by having nothing to get wrong.**

- **`X-Forwarded-Proto` is not needed.** The app generates no absolute URL: every asset
  reference is root-relative, every API call is relative, there are no redirect URIs, no
  password reset links and no canonical tags. It never redirects on scheme.
- **No cookies.** There is no session and no login of its own; the page's per-browser
  preferences live in `localStorage`. So no `Secure`/`HttpOnly`/`SameSite` decision to make.
- **Client IP is not used** for anything — no rate limiting, no audit log — so the app does
  not need to trust a forwarded address.
- **Serve from the domain root.** No base path setting exists and none is needed.

**Endpoints that must bypass an interactive identity challenge:** exactly one.

| path | why it cannot log in |
| --- | --- |
| `POST /api/sync` | a headless agent on a laptop pushing a snapshot every 30 s; it authenticates with a bearer token compared in constant time, and has no browser to complete a challenge |

Everything else — the page and the rest of `/api/*` — is fine sitting behind whatever
identity proxy fronts the hostname. The token is the gate on `/api/sync`, and that path is
deliberately checked **before** the `Host`/`Origin` gate, so the bypass and the app agree.

If the identity proxy in front of the hostname supports it, rate-limit `POST /api/sync`
there as well: the body is a full thread list and the endpoint is the one unauthenticated
surface.

## 11. How deployment actually happens

Push to `main` → CI builds and pushes `sha-<full sha>` → **a human** edits the manifest
repository to point at that tag → the GitOps controller rolls it out. A merge is not a
release, and the running version being deliberately behind `main` is normal.

The tag for a given commit is printed in the `docker-merge` job summary.

---

## Checklist

- [x] Multi-arch `linux/amd64` + `linux/arm64` image
- [x] Tagged `sha-<full sha>`, immutable, on `ghcr.io/ralton-dev/bot-crossing`
- [x] No self-hosted runner, so no runner-group admission step
- [x] `/healthz` and `/readyz`, unauthenticated, meaningfully different
- [x] `APP_VERSION` surfaced by `/healthz`
- [x] Runs as uid 1000, read-only root filesystem tolerated, no capabilities, port 8080
- [x] Writes only under `BOT_CROSSING_DATA`; tolerates an unwritable `$HOME`
- [x] Every setting an env var, documented, with defaults
- [ ] Fails loudly at startup on the two required display-mode variables (ships with display mode)
- [n/a] Postgres TLS — no database
- [n/a] Migrations — no schema
- [x] Every inbound and outbound network path enumerated (outbound: none)
- [x] Binds `0.0.0.0` in display mode; no unlisted outbound calls
- [x] No absolute URLs, no cookies, no scheme-based redirect, so no `X-Forwarded-Proto` trap
- [x] `POST /api/sync` listed as the one endpoint needing a login bypass

## What is left to do outside this repository

1. Write the manifests: Namespace, Deployment, Service, Ingress, PVC (`ReadWriteOnce`,
   ~1 GiB, mounted at `/data`), ConfigMap, Secret and NetworkPolicy.
2. Generate the sync token, seal it into the Secret, and give the same value to the laptop
   agent. It is never printed.
3. Set `APP_VERSION` in the Deployment to the image tag it pins.
4. Use the `Recreate` update strategy: the volume is `ReadWriteOnce` and two replicas would
   fight over one `colony.json` anyway. One replica is the design.
5. Point monitoring at `GET /readyz` on the Service, and at the public hostname if you want
   the tunnel and the identity proxy covered as well.
