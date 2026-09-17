# syntax=docker/dockerfile:1

# One process, one port: the same Node server answers `/api/*`, `/healthz` and `/readyz` and
# serves the Vite build, so the cluster needs one container and one ingress. The only stateful
# thing is BOT_CROSSING_DATA, which is a volume.
#
# Two stages. The build stage has the dev dependencies (Vite, the glTF packers) and the whole
# tree; the runtime stage has neither — it gets a production-only `node_modules`, the built
# `dist/` and `server/`, and none of the sources.

FROM node:22-alpine AS build

WORKDIR /src

# Manifests first, so a source-only change does not re-resolve dependencies.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# `npm run build` runs tools/build-assets.mjs before Vite. The raw art packs are not in the
# repository and the packed glbs are, so each packer finds no `assets-src/`, keeps the
# committed glb and exits 0 — a no-op here, exactly as on a fresh clone.
RUN npm run build


FROM node:22-alpine AS runtime

ENV NODE_ENV=production
# Above 1024: the container drops every capability, so it cannot bind a privileged port.
ENV PORT=8080
# This image only ever runs remotely — a laptop runs the repo, not the container. Display mode
# is also what makes serve.mjs bind 0.0.0.0 by default. BOT_CROSSING_SYNC_TOKEN and
# BOT_CROSSING_PUBLIC_HOST have no safe default and come from the manifest.
ENV BOT_CROSSING_MODE=display
# The one mount. Colony state and pushed snapshots are the only things written.
ENV BOT_CROSSING_DATA=/data
# The root filesystem is read-only in the cluster and `/tmp` is the one writable emptyDir.
# Node and npm both scribble in $HOME given the chance, and $HOME is not writable here.
ENV HOME=/tmp
# What `/healthz` reports. `dev` is honest for an image built by hand; the manifest sets it to
# the tag it deployed, because package.json's version is not what a container is running.
ENV APP_VERSION=dev

WORKDIR /app

# The server imports nothing but node: builtins today, so this tree is very nearly empty — it
# is here so that a runtime dependency added later ships without anyone remembering to.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# dist/ is gitignored and comes from the build stage, never from the context — this is what
# stops the image silently shipping without a client.
COPY --from=build /src/dist ./dist
COPY server ./server

# uid 1000: the node image's built-in `node` user, which is the id the cluster's
# runAsUser/fsGroup: 1000 resolves to. A name-based user does not survive a numeric context.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080

# `/readyz`, the same probe the cluster uses — one health story everywhere. It answers 503
# while the data directory is unwritable, so a container that cannot serve is unhealthy rather
# than crashed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server/serve.mjs"]
