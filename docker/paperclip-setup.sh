#!/bin/sh
# One-time setup for Paperclip in the Enterprise Brain bundle (docker-compose.yml), run before it starts:
# its database on the shared PostgreSQL server, and the secrets it signs sessions and agent tokens with.
# Safe to run on every start: nothing that exists is changed.
set -eu

# 1. The database. PGHOST, PGUSER and PGPASSWORD come from the compose file.
until pg_isready -q -d postgres; do sleep 1; done
if ! psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'paperclip'" | grep -q 1; then
  psql -q -d postgres -c "CREATE DATABASE paperclip"
  echo "paperclip-setup: created the paperclip database"
fi

# 2. Secrets, generated once and kept in Paperclip's data volume. Paperclip loads this file on start
#    (PAPERCLIP_CONFIG=/paperclip/instances/default/config.json, so <that folder>/.env).
env_file=/paperclip/instances/default/.env
mkdir -p "$(dirname "$env_file")"
touch "$env_file"
for name in BETTER_AUTH_SECRET PAPERCLIP_AGENT_JWT_SECRET PAPERCLIP_TOOL_ACTION_SIGNING_SECRET; do
  if ! grep -q "^$name=" "$env_file"; then
    echo "$name=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')" >> "$env_file"
    echo "paperclip-setup: generated $name"
  fi
done
chmod 600 "$env_file"
echo "paperclip-setup: done"
