FROM node:22.23.4-bookworm-slim AS build
# kite replaces npm (pinned and checksum-verified in tools/kite.json);
# npm itself is removed so nothing can fall back to it.
COPY tools/kite.json tools/install-kite.mjs /opt/kite/
RUN node /opt/kite/install-kite.mjs --dir /usr/local/bin && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY package*.json ./
COPY coding_runtime_pi ./coding_runtime_pi
RUN kite ci
COPY scripts/build-image.mjs ./scripts/
COPY tsconfig.json ./
COPY src ./src
# Transpile only: CI's typecheck gates every release (journal 132). /out holds what the
# final stage needs besides node_modules, so it is one COPY: dist, package.json, and the
# file: dependency's package.json and dist (links must resolve after pruning).
RUN kite run build:image && kite install --omit=dev \
 && mkdir -p /out/coding_runtime_pi && cp -r dist package.json /out/ \
 && cp -r coding_runtime_pi/package.json coding_runtime_pi/dist /out/coding_runtime_pi/
FROM node:22.23.4-bookworm-slim
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /out/ ./
COPY config/model-policy.json config/tool-picker.json config/decisions.json config/runtime.json config/reasoning-effort.json config/coding.json config/coding-pi.json config/coding-backend.json config/mcp.json config/boxes.json ./config/
COPY skills ./skills
COPY plugins ./plugins
COPY web ./web
# Set by the release build; the gateway reports it in operational logs.
ARG RELEASE_SHA=
ENV RELEASE_SHA=$RELEASE_SHA
USER node
CMD ["node", "dist/main.js"]
