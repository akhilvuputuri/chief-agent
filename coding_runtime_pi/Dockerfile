FROM node:22.19.0-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev git ripgrep util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/pi-runtime
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY native ./native
RUN npm run build && gcc -shared -fPIC -I/usr/local/include/node native/process.c -o process-boundary.node && npm prune --omit=dev --ignore-scripts
FROM node:22.19.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/pi-runtime
COPY --from=build /opt/pi-runtime ./
USER node
ENTRYPOINT ["node", "--disable-sigusr1", "/opt/pi-runtime/dist/guarded-cli.js"]
