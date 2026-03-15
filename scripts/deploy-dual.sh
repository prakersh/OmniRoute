#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${OMNI_REMOTE_HOST:-root@100.100.1.5}"
REMOTE_DIR="${OMNI_REMOTE_DIR:-/root/omni-remote}"
COMPOSE_PROFILE="${OMNI_COMPOSE_PROFILE:-base}"

log() {
  printf "\n[%s] %s\n" "$(date '+%H:%M:%S')" "$*"
}

deploy_local() {
  log "Deploying local gateway from ${ROOT_DIR}"
  if [[ ! -f "${ROOT_DIR}/.env" && -f "${ROOT_DIR}/.env.example" ]]; then
    cp -f "${ROOT_DIR}/.env.example" "${ROOT_DIR}/.env"
  fi
  docker build --target runner-base -t omniroute:base -f "${ROOT_DIR}/Dockerfile" "${ROOT_DIR}"
  docker rm -f omniroute >/dev/null 2>&1 || true
  docker compose -f "${ROOT_DIR}/docker-compose.yml" --profile "${COMPOSE_PROFILE}" up -d --force-recreate --remove-orphans
  docker ps --filter name=omniroute --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
}

sync_remote() {
  log "Syncing source to ${REMOTE_HOST}:${REMOTE_DIR}"
  rsync -az --delete \
    --exclude ".git" \
    --exclude "node_modules" \
    --exclude ".next" \
    --exclude ".env" \
    --exclude "/data/" \
    --exclude "/logs/" \
    --filter "P .env" \
    "${ROOT_DIR}/" "${REMOTE_HOST}:${REMOTE_DIR}/"
}

deploy_remote() {
  log "Deploying remote gateway on ${REMOTE_HOST}"
  ssh -o BatchMode=yes "${REMOTE_HOST}" "
set -euo pipefail
cd '${REMOTE_DIR}'
if [ ! -f .env ] && [ -f .env.example ]; then
  cp -f .env.example .env
fi
docker build --target runner-base -t omniroute:base -f Dockerfile .
docker rm -f omniroute >/dev/null 2>&1 || true
docker compose -f docker-compose.yml --profile '${COMPOSE_PROFILE}' up -d --force-recreate --remove-orphans
docker ps --filter name=omniroute --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
"
}

deploy_local
sync_remote
deploy_remote

log "Dual deployment complete."
