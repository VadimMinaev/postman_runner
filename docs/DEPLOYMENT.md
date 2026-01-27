# Безопасный деплой одной командой

Эта инструкция настраивает безопасный деплой с бэкапами, проверками и откатом.

## Первый запуск (PM2 режим)

```bash
cd /opt/postman_runner
chmod +x deploy-safe.sh rollback.sh
mkdir -p /opt/backups/postman_runner
mkdir -p /opt/postman_runner/logs

pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## Обновление одной командой

```bash
ssh root@your-server "cd /opt/postman_runner && ./deploy-safe.sh -y"
```

## Откат

```bash
ssh root@your-server "cd /opt/postman_runner && ./rollback.sh --latest --yes"
```

## Настройка Nginx

```bash
cp nginx.conf /etc/nginx/sites-available/postmanrunner.vadminaev.ru
ln -s /etc/nginx/sites-available/postmanrunner.vadminaev.ru /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## Переменные окружения

Можно переопределить значения при запуске:

```bash
PROJECT_NAME=postman_runner \
PM2_APP_NAME=postman-runner \
SITE_URL=https://postmanrunner.vadminaev.ru/health \
KEEP_BACKUPS=5 \
./deploy-safe.sh -y
```

## Что делает deploy-safe.sh

- Делает бэкап файлов проекта
- Обновляет код из Git
- Устанавливает зависимости
- Перезапускает приложение через PM2
- Проверяет доступность `/health`
- Откатывает при проблемах
- Очищает старые бэкапы

## Где лежат бэкапы

```
/opt/backups/postman_runner/backup_YYYYMMDD_HHMMSS.tar.gz
```

---

## Docker режим (рекомендуется для текущей установки)

### Первый запуск

```bash
cd /opt/postman_runner
chmod +x deploy-safe-docker.sh rollback-docker.sh
mkdir -p /opt/backups/postman_runner_docker
```

### Обновление одной командой

```bash
ssh root@your-server "cd /opt/postman_runner && ./deploy-safe-docker.sh -y"
```

### Откат

```bash
ssh root@your-server "cd /opt/postman_runner && ./rollback-docker.sh --latest --yes"
```

### Переменные (если нужно)

```bash
HOST_PORT=3001 \
CONTAINER_PORT=3000 \
DATA_DIR=/opt/postman_runner/data \
KEEP_BACKUPS=5 \
./deploy-safe-docker.sh -y
```
