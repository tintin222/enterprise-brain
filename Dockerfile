# Enterprise Brain: one container with the API, the web console and the Paperclip plugin.
# Use DATABASE_URL for PostgreSQL + pgvector; docker-compose.yml runs it together with Paperclip.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3200 EB_DATA_DIR=/data
COPY --from=build /app /app
WORKDIR /app/apps/server
VOLUME ["/data"]
EXPOSE 3200
# Plain node with the tsx loader: nothing is downloaded when the container starts.
CMD ["node", "--import", "tsx", "src/main.ts"]
