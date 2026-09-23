FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config/model-policy.json ./config/model-policy.json
COPY skills ./skills
COPY plugins ./plugins
COPY web ./web
USER node
CMD ["node", "dist/main.js"]
