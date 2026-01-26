#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="${PROJECT_NAME:-postman_runner}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/${PROJECT_NAME}}"
PM2_APP_NAME="${PM2_APP_NAME:-postman-runner}"
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

if [ ! -d "$BACKUP_DIR" ]; then
  err "Backup directory not found: $BACKUP_DIR"
  exit 1
fi

list_backups() {
  ls -1t "$BACKUP_DIR"/backup_*.tar.gz 2>/dev/null || true
}

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

log "Restoring backup..."
tar -xzf "$TARGET" -C "$PROJECT_DIR"

if [ -f "$PROJECT_DIR/.previous_commit.txt" ]; then
  prev_commit="$(cat "$PROJECT_DIR/.previous_commit.txt" || true)"
  if [ -n "$prev_commit" ]; then
    log "Resetting git to $prev_commit"
    git -C "$PROJECT_DIR" reset --hard "$prev_commit"
  fi
fi

log "Restarting PM2..."
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart "$PM2_APP_NAME" || pm2 start "$PROJECT_DIR/ecosystem.config.js"
fi

rm -f "${PROJECT_DIR}/.previous_commit.txt"
ok "Rollback complete."
