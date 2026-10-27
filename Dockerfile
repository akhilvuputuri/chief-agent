FROM node:22.23.4-bookworm-slim AS build
# lockstep replaces npm (pinned and checksum-verified in tools/lockstep.json);
# npm itself is removed so nothing can fall back to it.
COPY tools/lockstep.json tools/install-lockstep.mjs /opt/lockstep/
RUN node /opt/lockstep/install-lockstep.mjs --dir /usr/local/bin && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY package*.json ./
COPY coding_runtime_pi ./coding_runtime_pi
RUN lockstep ci
COPY tsconfig.json ./
COPY src ./src
RUN lockstep run build && lockstep ci --omit=dev
FROM node:22.23.4-bookworm-slim
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# file: dependency links must resolve after development packages are pruned.
COPY --from=build /app/coding_runtime_pi/package.json ./coding_runtime_pi/package.json
COPY --from=build /app/coding_runtime_pi/dist ./coding_runtime_pi/dist
COPY package.json ./
COPY config/model-policy.json config/tool-picker.json config/decisions.json config/runtime.json config/reasoning-effort.json ./config/
COPY config/coding.json config/coding-pi.json config/coding-backend.json config/mcp.json config/boxes.json ./config/
COPY skills ./skills
COPY plugins ./plugins
COPY web ./web
# Set by the release handler; the gateway reports it in operational logs.
ARG RELEASE_SHA=
ENV RELEASE_SHA=$RELEASE_SHA
USER node
CMD ["node", "dist/main.js"]
