FROM node:22.23.4-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev git ripgrep util-linux && rm -rf /var/lib/apt/lists/*
# lockstep comes from the repository's single pin: build with
# `docker build --build-context lockstep=tools coding_runtime_pi`.
COPY --from=lockstep lockstep.json install-lockstep.mjs /opt/lockstep/
RUN node /opt/lockstep/install-lockstep.mjs --dir /usr/local/bin && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /opt/pi-runtime
COPY package*.json ./
RUN lockstep ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY native ./native
RUN lockstep run build && gcc -shared -fPIC -I/usr/local/include/node native/process.c -o process-boundary.node && lockstep ci --omit=dev --ignore-scripts
FROM node:22.23.4-bookworm-slim
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/pi-runtime
COPY --from=build /opt/pi-runtime ./
USER node
ENTRYPOINT ["node", "--disable-sigusr1", "/opt/pi-runtime/dist/guarded-cli.js"]
