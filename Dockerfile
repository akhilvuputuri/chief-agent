FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY coding_runtime_pi ./coding_runtime_pi
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config/model-policy.json config/tool-picker.json config/decisions.json config/runtime.json ./config/
COPY config/coding.json config/coding-pi.json config/coding-backend.json config/mcp.json ./config/
COPY skills ./skills
COPY plugins ./plugins
COPY web ./web
# Set by the release handler; the gateway reports it in operational logs.
ARG RELEASE_SHA=
ENV RELEASE_SHA=$RELEASE_SHA
USER node
CMD ["node", "dist/main.js"]
