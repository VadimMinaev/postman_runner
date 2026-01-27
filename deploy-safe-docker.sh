#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="${PROJECT_NAME:-postman_runner}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/${PROJECT_NAME}_docker}"
IMAGE_NAME="${IMAGE_NAME:-postman-runner}"
CONTAINER_NAME="${CONTAINER_NAME:-postman-runner}"
HOST_PORT="${HOST_PORT:-3001}"
CONTAINER_PORT="${CONTAINER_PORT:-3000}"
TEMP_PORT="${TEMP_PORT:-3003}"
DATA_DIR="${DATA_DIR:-/opt/postman_runner/data}"
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
AUTO_YES=false

for arg in "$@"; do
  case "$arg" in
    -y|--yes) AUTO_YES=true ;;
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

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    exit 1
  fi
}

confirm() {
  if [ "$AUTO_YES" = true ]; then
    return 0
  fi
  read -r -p "$1 [y/N]: " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

require git
require docker
require curl
require tar

if [ ! -d "$PROJECT_DIR/.git" ]; then
  err "No git repo in $PROJECT_DIR"
  exit 1
fi

mkdir -p "$BACKUP_DIR"
mkdir -p "$DATA_DIR"

log "Project: $PROJECT_DIR"
log "Backup dir: $BACKUP_DIR"
log "Container: $CONTAINER_NAME"
log "Image: $IMAGE_NAME"
log "Ports: ${HOST_PORT}->${CONTAINER_PORT} (temp ${TEMP_PORT})"

confirm "Proceed with Docker deployment?" || { warn "Cancelled"; exit 0; }

ts="$(date +%Y%m%d_%H%M%S)"
backup_path="${BACKUP_DIR}/backup_${ts}.tar.gz"
meta_path="${BACKUP_DIR}/backup_${ts}.meta"

log "Creating backup..."
current_image="$(docker inspect -f '{{.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)"
echo "image_id=${current_image}" > "$meta_path"
echo "host_port=${HOST_PORT}" >> "$meta_path"
echo "container_port=${CONTAINER_PORT}" >> "$meta_path"
echo "data_dir=${DATA_DIR}" >> "$meta_path"

tar -czf "$backup_path" -C "$DATA_DIR" . || true
ok "Backup created: $backup_path"

log "Updating code..."
git -C "$PROJECT_DIR" fetch --all --prune
git -C "$PROJECT_DIR" pull --ff-only

log "Building new image..."
docker build -t "${IMAGE_NAME}:${ts}" "$PROJECT_DIR"

log "Starting temp container for health check..."
docker rm -f "${CONTAINER_NAME}-temp" >/dev/null 2>&1 || true
docker run -d --name "${CONTAINER_NAME}-temp" \
  -p "127.0.0.1:${TEMP_PORT}:${CONTAINER_PORT}" \
  -v "${DATA_DIR}/config.json:/app/config.json" \
  -v "${DATA_DIR}/auth-sessions.json:/app/auth-sessions.json" \
  -v "${DATA_DIR}/collections:/app/collections" \
  -v "${DATA_DIR}/environments:/app/environments" \
  -v "${DATA_DIR}/allure-results:/app/allure-results" \
  -v "${DATA_DIR}/allure-report:/app/allure-report" \
  -e PORT="${CONTAINER_PORT}" \
  -e BASIC_AUTH_USER="${BASIC_AUTH_USER:-vadmin}" \
  -e BASIC_AUTH_PASS="${BASIC_AUTH_PASS:-vadmin}" \
  "${IMAGE_NAME}:${ts}"

sleep 2
status_code="$(curl -fsS -o /dev/null -w "%{http_code}" "http://127.0.0.1:${TEMP_PORT}/health" || true)"
if [[ ! "$status_code" =~ ^2|3 ]]; then
  err "Health check failed (HTTP $status_code). Rolling back..."
  docker logs "${CONTAINER_NAME}-temp" || true
  docker rm -f "${CONTAINER_NAME}-temp" || true
  ./rollback-docker.sh --latest --yes
  exit 1
fi
ok "Health check passed (HTTP $status_code)."

log "Switching containers..."
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
  "${IMAGE_NAME}:${ts}"

docker rm -f "${CONTAINER_NAME}-temp" >/dev/null 2>&1 || true

log "Cleaning old backups (keep $KEEP_BACKUPS)..."
ls -1dt "${BACKUP_DIR}/backup_"*.tar.gz 2>/dev/null | tail -n +"$((KEEP_BACKUPS+1))" | xargs -r rm -f
ls -1dt "${BACKUP_DIR}/backup_"*.meta 2>/dev/null | tail -n +"$((KEEP_BACKUPS+1))" | xargs -r rm -f

ok "Docker deployment complete."
