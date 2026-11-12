# syntax=docker/dockerfile:1
# Imagem única para api, worker-fiscal e worker-general (ADR-0020/0021): muda só o comando.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Migrations SQL (não são compiladas pelo tsc); usadas pelo job de deploy: node dist/db/migrate.js
COPY --from=build /app/src/db/migrations ./dist/db/migrations
# Guias em Markdown servidos em /guides/ e indexados em /llms.txt (ADR-0027 item 8).
COPY docs/api ./docs/api
# XSD oficiais versionados (ADR-0013): conferidos por SHA-256 na subida da API e do worker-fiscal.
COPY resources/fiscal ./resources/fiscal
# Usuário sem privilégios; o filesystem pode ser montado read-only pelo Coolify.
USER node
EXPOSE 3000
# Sem inspector em produção; core dumps desabilitados via ulimit no deploy (docs/architecture/13 §8).
CMD ["node", "--disable-proto=throw", "dist/main/api.js"]
