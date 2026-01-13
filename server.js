// ----------------------- Импорт зависимостей -----------------------
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec, spawn } = require('child_process');
const newman = require('newman');
const axios = require('axios');
require('dotenv').config();

// ----------------------- Базовая настройка приложения -----------------------
const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = !!process.env.RAILWAY_ENVIRONMENT;

// ----------------------- Пути к рабочим директориям и файлам -----------------------
const collDir = path.join(__dirname, 'collections');
const envDir = path.join(__dirname, 'environments');
const allureResults = path.join(__dirname, 'allure-results');
const allureReport = path.join(__dirname, 'allure-report');
const configPath = path.join(__dirname, 'config.json');

// гарантируем наличие папок
fs.ensureDirSync(collDir);
fs.ensureDirSync(envDir);
fs.ensureDirSync(allureResults);
fs.ensureDirSync(allureReport);

// ----------------------- Загрузка и инициализация конфига -----------------------
let config = {
  apiKey: '',
  workspaceId: '',
  useApiMode: true,
};

try {
  if (fs.existsSync(configPath)) {
    const file = fs.readFileSync(configPath);
    if (file.length) config = JSON.parse(file);
  }
} catch (err) {
  console.error('❌ Ошибка чтения config.json:', err.message);
}

// ENV имеет приоритет (Railway)
config.apiKey = process.env.POSTMAN_API_KEY || config.apiKey;
config.workspaceId = process.env.POSTMAN_WORKSPACE_ID || config.workspaceId;
config.useApiMode =
  process.env.USE_API_MODE !== undefined
    ? process.env.USE_API_MODE === 'true'
    : config.useApiMode;

// ----------------------- Мидлвары Express -----------------------
app.use(express.static(path.join(__dirname, 'public')));
app.use('/allure-report', express.static(allureReport));
app.use(express.json());

// ----------------------- Хранилище результатов -----------------------
const collectionResults = new Map();

// ----------------------- Helpers -----------------------
function makeResultLine(name, failures, ts = Date.now()) {
  const dt = new Date(ts);
  const when =
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ` +
    `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  const verdict = failures > 0 ? `❌ Ошибок: ${failures}` : '✅ Успешно';
  return `${name} — ${verdict} (${when})`;
}

function setStatusRunning(name) {
  collectionResults.set(name, {
    status: 'running',
    failures: null,
    startedAt: Date.now(),
    resultLine: `${name} — ▶ Выполняется...`,
  });
}

function setStatusDone(name, failures) {
  const finishedAt = Date.now();
  collectionResults.set(name, {
    status: 'done',
    failures,
    finishedAt,
    resultLine: makeResultLine(name, failures, finishedAt),
  });
}

function setStatusError(name, message) {
  collectionResults.set(name, {
    status: 'error',
    failures: null,
    finishedAt: Date.now(),
    resultLine: `${name} — ❌ Ошибка запуска: ${message}`,
  });
}

// ----------------------- SSE -----------------------
const sseClients = new Set();
let lastCompletionMessage = '';

function ssePush(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function sseLog(message, extra = {}) {
  console.log(message);
  if (message.startsWith('✅ Завершено:')) {
    lastCompletionMessage = message;
  }
  ssePush({
    type: 'log',
    ts: Date.now(),
    message,
    lastCompletionMessage,
    ...extra,
  });
}

app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const snapshot = [...collectionResults.entries()].map(([name, v]) => ({
    collection: name,
    ...v,
  }));

  res.write(`data: ${JSON.stringify({ type: 'snapshot', items: snapshot })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ----------------------- Config routes -----------------------
app.get('/config', (req, res) => res.json(config));

app.post('/config', (req, res) => {
  if (IS_PROD) {
    return res.status(403).json({ error: 'Config editing disabled in production' });
  }

  const { apiKey, workspaceId, useApi } = req.body;
  config.apiKey = apiKey || '';
  config.workspaceId = workspaceId || '';
  config.useApiMode = !!useApi;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  res.json({ success: true });
});

// ----------------------- Collections / Envs -----------------------
app.get('/collections', async (req, res) => {
  if (!config.useApiMode) {
    const files = fs.readdirSync(collDir).filter(f => f.endsWith('.json'));
    return res.json(files.map(name => ({ name, uid: null })));
  }

  try {
    const { data } = await axios.get(
      `https://api.getpostman.com/collections?workspace=${config.workspaceId}`,
      { headers: { 'X-Api-Key': config.apiKey } }
    );
    res.json(data.collections.map(c => ({ name: c.name, uid: c.uid })));
  } catch {
    res.status(500).json({ error: 'Postman API error' });
  }
});

// ----------------------- Allure -----------------------
async function generateAllure({ resultsDir, reportDir }) {
  const cmd = `npx allure-commandline generate "${resultsDir}" --clean -o "${reportDir}"`;
  return new Promise(resolve => {
    const p = spawn(cmd, { shell: true });
    p.on('close', code => resolve(code === 0));
  });
}

// ----------------------- Run -----------------------
app.post('/run', async (req, res) => {
  const { files, parallel } = req.body;

  fs.emptyDirSync(allureResults);
  fs.emptyDirSync(allureReport);

  const runCollection = async ({ name, uid }) => {
    setStatusRunning(name);
    ssePush({ type: 'collection-status', collection: name });

    const { data } = await axios.get(
      `https://api.getpostman.com/collections/${uid}`,
      { headers: { 'X-Api-Key': config.apiKey } }
    );

    return new Promise(resolve => {
      newman
        .run({
          collection: data.collection,
          reporters: ['cli', 'allure'],
          reporter: { allure: { export: allureResults } },
        })
        .on('done', (_, summary) => {
          const failures = summary?.run?.failures?.length || 0;
          setStatusDone(name, failures);
          sseLog(`✅ Завершено: ${name} (ошибок: ${failures})`);
          ssePush({
            type: 'collection-done',
            collection: name,
            failures,
            resultLine: collectionResults.get(name).resultLine,
          });
          resolve();
        });
    });
  };

  if (parallel) {
    await Promise.all(files.map(runCollection));
  } else {
    for (const f of files) await runCollection(f);
  }

  const ok = await generateAllure({ resultsDir: allureResults, reportDir: allureReport });
  const reportUrl = ok ? `/allure-report/index.html` : null;

  if (!IS_PROD && reportUrl && process.platform === 'win32') {
    exec(`start "" "http://localhost:${PORT}${reportUrl}"`);
  }

  ssePush({ type: 'allure-done', ok, url: reportUrl });
  res.json({ ok, reportUrl });
});

// ----------------------- Start -----------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
