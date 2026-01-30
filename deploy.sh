#!/bin/bash
set -e

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ============================================
# Проверка .env
# ============================================
if [ ! -f .env ]; then
    log_error "Файл .env не найден!"
    log_info "Скопируйте .env.example в .env и заполните переменные:"
    echo "    cp .env.example .env"
    echo "    nano .env"
    exit 1
fi

# Загружаем переменные
set -a
source .env
set +a

log_info "Проект: ${PROJECT_NAME:-postman-runner}"
log_info "Домен: ${DOMAIN:-localhost}"

# ============================================
# Проверка Docker
# ============================================
if ! command -v docker &> /dev/null; then
    log_error "Docker не установлен!"
    exit 1
fi

if ! command -v docker compose &> /dev/null && ! docker compose version &> /dev/null; then
    log_error "Docker Compose не установлен!"
    exit 1
fi

log_ok "Docker и Docker Compose найдены"

# ============================================
# Сборка и запуск
# ============================================
log_info "Собираем образы..."
docker compose build --no-cache

log_info "Запускаем контейнеры..."
docker compose up -d

# ============================================
# Проверка здоровья
# ============================================
log_info "Ожидаем запуска сервисов..."
sleep 5

# Проверяем статус контейнеров
if docker compose ps | grep -q "unhealthy\|Exit"; then
    log_error "Некоторые сервисы не запустились корректно:"
    docker compose ps
    docker compose logs --tail=50
    exit 1
fi

log_ok "Все сервисы запущены!"

# ============================================
# Итоговая информация
# ============================================
echo ""
echo "=========================================="
echo -e "${GREEN}Деплой завершён успешно!${NC}"
echo "=========================================="
echo ""
echo "Приложение доступно по адресу:"
echo -e "  ${BLUE}https://${DOMAIN}${NC}"
echo ""
echo "Полезные команды:"
echo "  docker compose logs -f        # Логи в реальном времени"
echo "  docker compose ps             # Статус контейнеров"
echo "  docker compose down           # Остановить всё"
echo "  docker compose restart app    # Перезапустить приложение"
echo ""
