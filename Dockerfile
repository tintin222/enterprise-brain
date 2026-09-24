# Enterprise Brain: single container (API + web console). Use DATABASE_URL for PostgreSQL + pgvector.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3200 EB_DATA_DIR=/data
RUN corepack enable
COPY --from=build /app /app
VOLUME ["/data"]
EXPOSE 3200
CMD ["pnpm", "start"]
