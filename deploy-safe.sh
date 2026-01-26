#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="${PROJECT_NAME:-postman_runner}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/${PROJECT_NAME}}"
PM2_APP_NAME="${PM2_APP_NAME:-postman-runner}"
SITE_URL="${SITE_URL:-http://127.0.0.1:3000/health}"
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
require pm2
require curl
require tar
require npm
require node

if [ ! -d "$PROJECT_DIR/.git" ]; then
  err "No git repo in $PROJECT_DIR"
  exit 1
fi

log "Project: $PROJECT_DIR"
log "Backup dir: $BACKUP_DIR"
log "PM2 app: $PM2_APP_NAME"
log "Health URL: $SITE_URL"

confirm "Proceed with deployment?" || { warn "Cancelled"; exit 0; }

mkdir -p "$BACKUP_DIR"
ts="$(date +%Y%m%d_%H%M%S)"
backup_path="${BACKUP_DIR}/backup_${ts}.tar.gz"

log "Creating backup..."
git -C "$PROJECT_DIR" rev-parse HEAD > "${PROJECT_DIR}/.previous_commit.txt"

tar --exclude="./.git" \
  --exclude="./node_modules" \
  --exclude="./allure-results" \
  --exclude="./allure-report" \
  -czf "$backup_path" \
  -C "$PROJECT_DIR" \
  .previous_commit.txt \
  package.json \
  package-lock.json \
  server.js \
  public \
  config.json \
  auth-sessions.json \
  collections \
  environments \
  .env \
  .env.example \
  ecosystem.config.js \
  2>/dev/null || true

ok "Backup created: $backup_path"

log "Fetching updates..."
git -C "$PROJECT_DIR" fetch --all --prune
log "Current commit: $(git -C "$PROJECT_DIR" rev-parse --short HEAD)"
log "Incoming changes:"
git -C "$PROJECT_DIR" log --oneline HEAD..@{u} || true

log "Pulling latest..."
git -C "$PROJECT_DIR" pull --ff-only

log "Installing dependencies..."
if [ -f "$PROJECT_DIR/package-lock.json" ]; then
  npm --prefix "$PROJECT_DIR" ci --omit=dev
else
  npm --prefix "$PROJECT_DIR" install --omit=dev
fi

if node -e "const p=require('${PROJECT_DIR.replace(/\\/g, '\\\\')}/package.json'); process.exit(p.scripts&&p.scripts.build?0:1)" >/dev/null 2>&1; then
  log "Building application..."
  npm --prefix "$PROJECT_DIR" run build
else
  log "No build script found, skipping build."
fi

log "Reloading PM2..."
if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  pm2 reload "$PM2_APP_NAME" --update-env || pm2 restart "$PM2_APP_NAME"
else
  warn "PM2 app not found, starting new instance."
  pm2 start "$PROJECT_DIR/ecosystem.config.js"
fi

log "Checking PM2 status..."
pm2 status "$PM2_APP_NAME" | cat

log "Health check..."
status_code="$(curl -fsS -o /dev/null -w "%{http_code}" "$SITE_URL" || true)"
if [[ ! "$status_code" =~ ^2|3 ]]; then
  err "Health check failed (HTTP $status_code). Rolling back..."
  "$PROJECT_DIR/rollback.sh" --latest --yes
  exit 1
fi
ok "Health check passed (HTTP $status_code)."

log "Cleaning old backups (keep $KEEP_BACKUPS)..."
ls -1dt "${BACKUP_DIR}/backup_"*.tar.gz 2>/dev/null | tail -n +"$((KEEP_BACKUPS+1))" | xargs -r rm -f

rm -f "${PROJECT_DIR}/.previous_commit.txt"

ok "Deployment complete."
