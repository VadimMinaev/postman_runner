#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="${PROJECT_NAME:-postman_runner}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/${PROJECT_NAME}_docker}"
IMAGE_NAME="${IMAGE_NAME:-postman-runner}"
CONTAINER_NAME="${CONTAINER_NAME:-postman-runner}"
HOST_PORT="${HOST_PORT:-3001}"
CONTAINER_PORT="${CONTAINER_PORT:-3000}"
DATA_DIR="${DATA_DIR:-/opt/postman_runner/data}"
AUTO_YES=false
TARGET=""

for arg in "$@"; do
  case "$arg" in
    -y|--yes) AUTO_YES=true ;;
    --latest) TARGET="latest" ;;
    *) TARGET="$arg" ;;
  esac
done

RED='\033[0;31m'
GRN='\033[0;32m'
YEL='\033[0;33m'
BLU='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLU}[INFO]${NC} $*"; }
ok() { echo -e "${GRN}[OK]${NC} $*"; }
warn() { echo -e "${YEL}[WARN]${NC} $*"; }
err() { echo -e "${RED}[ERR]${NC} $*"; }

confirm() {
  if [ "$AUTO_YES" = true ]; then
    return 0
  fi
  read -r -p "$1 [y/N]: " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

list_backups() {
  ls -1t "$BACKUP_DIR"/backup_*.tar.gz 2>/dev/null || true
}

if [ ! -d "$BACKUP_DIR" ]; then
  err "Backup directory not found: $BACKUP_DIR"
  exit 1
fi

if [ -z "$TARGET" ] || [ "$TARGET" = "list" ]; then
  log "Available backups:"
  list_backups
  exit 0
fi

if [ "$TARGET" = "latest" ]; then
  TARGET="$(list_backups | head -n 1)"
fi

if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  err "Backup not found: $TARGET"
  exit 1
fi

confirm "Restore backup $TARGET?" || { warn "Cancelled"; exit 0; }

log "Restoring data directory..."
mkdir -p "$DATA_DIR"
tar -xzf "$TARGET" -C "$DATA_DIR"

meta="${TARGET%.tar.gz}.meta"
image_id=""
if [ -f "$meta" ]; then
  image_id="$(grep -E '^image_id=' "$meta" | cut -d= -f2- || true)"
fi

if [ -z "$image_id" ]; then
  warn "No image_id found in metadata. Using latest image tag."
  image_ref="${IMAGE_NAME}:latest"
else
  image_ref="$image_id"
fi

log "Restarting container with image: $image_ref"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER_NAME" --restart=always \
  -p "127.0.0.1:${HOST_PORT}:${CONTAINER_PORT}" \
  -v "${DATA_DIR}/config.json:/app/config.json" \
  -v "${DATA_DIR}/auth-sessions.json:/app/auth-sessions.json" \
  -v "${DATA_DIR}/collections:/app/collections" \
  -v "${DATA_DIR}/environments:/app/environments" \
  -v "${DATA_DIR}/allure-results:/app/allure-results" \
  -v "${DATA_DIR}/allure-report:/app/allure-report" \
  -e PORT="${CONTAINER_PORT}" \
  -e BASIC_AUTH_USER="${BASIC_AUTH_USER:-vadmin}" \
  -e BASIC_AUTH_PASS="${BASIC_AUTH_PASS:-vadmin}" \
  "$image_ref"

ok "Docker rollback complete."
