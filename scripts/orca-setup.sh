#!/usr/bin/env bash
# Orca repo setup hook — runs once per worktree, before any worker starts.
#
# Wire it up in the Orca app: Repo settings -> hooks -> setup script:
#   bash scripts/orca-setup.sh
# Set the repo's setup policy to wait-for-setup, not start-immediately. An agent
# that begins before `bun install` finishes runs `bun test` against a
# half-installed tree, reads the resulting module-resolution errors as a broken
# repo, and starts fixing what is not wrong.
#
# Two jobs:
#   1. Give this worktree an isolated Docker stack and a port block no other
#      live worktree holds, written to an untracked .env.local.
#   2. Install dependencies.
#
# Why isolation is the whole point here. This repo's dev loop is
# `docker compose up`: Postgres plus the dashboard. Two worktrees running that
# unnamespaced do not merely fight over ports — Compose derives container and
# VOLUME names from the project name, which defaults to the directory name. Two
# checkouts named `aio` share one `aio_db-data` volume, so one agent's migration
# lands in the other's database and both believe they are isolated. That failure
# is silent and it looks like flaky tests.
#
# So each worktree gets COMPOSE_PROJECT_NAME as well as its own ports.
#
# Compose does NOT read .env.local — it reads .env, which here holds the human's
# API keys and must not be rewritten. Compose commands in a worktree therefore
# need an explicit:
#
#   docker compose --env-file .env.local up -d
#
# Idempotent: re-running keeps the block this worktree already holds.
set -euo pipefail

WORKTREE="$(pwd -P)"
CLAIMS="${XDG_CACHE_HOME:-$HOME/.cache}/aio/portblocks"
ENVFILE="$WORKTREE/.env.local"
BLOCK=10
BASE_MIN=3400
BASE_MAX=3550

mkdir -p "$CLAIMS"

listening() { # is anything bound to this port right now?
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  fi
}

block_free() { # every port in the block unbound by anyone, Orca or not
  local base="$1" i
  for ((i = 0; i < BLOCK; i++)); do
    listening "$((base + i))" && return 1
  done
  return 0
}

claim_owner() { [ -f "$CLAIMS/$1" ] && cat "$CLAIMS/$1" || true; }

# A claim whose worktree directory is gone is stale. Orca removes worktrees on
# `worktree rm`, so this is how blocks return to circulation when the archive
# hook did not get to run.
reap_stale() {
  local owner
  owner="$(claim_owner "$1")"
  if [ -n "$owner" ] && [ ! -d "$owner" ]; then
    rm -f "$CLAIMS/$1"
  fi
}

# Already hold a block? Keep it, so re-running setup is a no-op.
if [ -f "$ENVFILE" ]; then
  existing="$(sed -n 's/^AIO_PORT_BASE=\([0-9]\{1,\}\)$/\1/p' "$ENVFILE" | head -1)"
  if [ -n "$existing" ] && [ "$(claim_owner "$existing")" = "$WORKTREE" ]; then
    echo "orca-setup: keeping AIO_PORT_BASE=$existing"
    BASE="$existing"
  fi
fi

if [ -z "${BASE:-}" ]; then
  for b in $(seq "$BASE_MIN" "$BLOCK" "$BASE_MAX"); do
    reap_stale "$b"
    [ -e "$CLAIMS/$b" ] && continue
    block_free "$b" || continue
    # noclobber makes this create-or-fail, which is the atomic bit: two workers
    # starting at the same instant cannot both win the same block.
    if (
      set -o noclobber
      printf '%s\n' "$WORKTREE" >"$CLAIMS/$b"
    ) 2>/dev/null; then
      BASE="$b"
      echo "orca-setup: claimed AIO_PORT_BASE=$BASE"
      break
    fi
  done
fi

if [ -z "${BASE:-}" ]; then
  echo "orca-setup: no free block in $BASE_MIN-$((BASE_MAX + BLOCK - 1))." >&2
  echo "orca-setup: stale claims live in $CLAIMS — remove any whose worktree is gone." >&2
  exit 1
fi

WEB=$((BASE + 0))
DB=$((BASE + 1))

{
  echo "# Written by scripts/orca-setup.sh. Do not edit; setup rewrites it."
  echo "# This worktree owns ports $BASE-$((BASE + BLOCK - 1))."
  echo "#"
  echo "# Compose does not read this file. Use:"
  echo "#   docker compose --env-file .env.local up -d"
  echo "AIO_PORT_BASE=$BASE"
  echo "AIO_PORT_WEB=$WEB"
  echo "AIO_PORT_DB=$DB"
  echo
  echo "# Namespaces this worktree's containers AND its database volume. Without"
  echo "# it, two worktrees silently share one Postgres volume."
  echo "COMPOSE_PROJECT_NAME=aio-$BASE"
  echo
  echo "# Host-side tools (bun run ingest, drizzle-kit) talk to this worktree's"
  echo "# Postgres on its own published port. Bun loads .env.local automatically,"
  echo "# so these apply without any flag."
  echo "DATABASE_URL=postgres://aio:aio@localhost:$DB/aio"
  echo "DATABASE_SSL=disable"
} >"$ENVFILE"

if command -v bun >/dev/null 2>&1; then
  echo "orca-setup: bun install"
  bun install --frozen-lockfile
fi

echo "orca-setup: ready — ports $BASE-$((BASE + BLOCK - 1)) (web $WEB, db $DB), project aio-$BASE"
