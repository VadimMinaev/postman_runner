// ----------------------- Импорт зависимостей -----------------------
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const newman = require('newman');
const axios = require('axios');
require('dotenv').config();

// ----------------------- Базовая настройка приложения -----------------------
const app = express();
const PORT = process.env.PORT || 3000; // 🔥 Обязательно для Railway

// ----------------------- Пути к рабочим директориям и файлам -----------------------
const collDir = path.join(__dirname, 'collections');
const envDir = path.join(__dirname, 'environments');
const allureResults = path.join(__dirname, 'allure-results');
const allureReport = path.join(__dirname, 'allure-report');
const configPath = path.join(__dirname, 'config.json');

// Гарантируем наличие папок/конфига
fs.ensureDirSync(collDir);
fs.ensureDirSync(envDir);
fs.ensureDirSync(allureResults);
fs.ensureDirSync(allureReport);
fs.ensureFileSync(configPath);

// ----------------------- Загрузка и инициализация конфига -----------------------
let config = { apiKey: '', workspaceId: '', useApiMode: true };

try {
  const file = fs.readFileSync(configPath);
  if (file.length) config = JSON.parse(file);
} catch (err) {
  console.error('❌ Ошибка чтения config.json:', err.message);
}

// ----------------------- Мидлвары Express -----------------------
app.use(express.static(path.join(__dirname, 'public')));
app.use('/allure-report', express.static(allureReport));
app.use(express.json());

// ----------------------- Хранилище результатов по коллекциям -----------------------
const collectionResults = new Map();

function makeResultLine(name, failures, finishedAtTs = Date.now()) {
  const dt = new Date(finishedAtTs);
  const when =
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')} ` +
    `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
  const verdict = failures > 0 ? `❌ Ошибок: ${failures}` : '✅ Успешно';
  return `${name} — ${verdict} (${when})`;
}

function setStatusRunning(name) {
  collectionResults.set(name, {
    ...(collectionResults.get(name) || {}),
    status: 'running',
    failures: null,
    startedAt: Date.now(),
    resultLine: `${name} — ▶ Выполняется...`,
  });
}

function setStatusDone(name, failures) {
  const finishedAt = Date.now();
  const resultLine = makeResultLine(name, failures, finishedAt);
  collectionResults.set(name, {
    status: 'done',
    failures,
    finishedAt,
    resultLine,
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

// ----------------------- SSE: клиенты и утилиты -----------------------
const sseClients = new Set();
let lastCompletionMessage = '';

function ssePush(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (e) {
      sseClients.delete(res);
    }
  }
}

function sseLog(message, extra = {}) {
  console.log(message);
  if (message.startsWith('✅ Завершено:')) {
    lastCompletionMessage = message;
  }
  ssePush({ type: 'log', ts: Date.now(), message, lastCompletionMessage, ...extra });
}

app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 1000\n\n');

  const snapshot = Array.from(collectionResults.entries()).map(([name, v]) => ({
    collection: name,
    ...v,
  }));
  res.write(`data: ${JSON.stringify({ type: 'snapshot', items: snapshot })}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ----------------------- Маршруты: статичные результаты -----------------------
app.get('/results', (req, res) => {
  const items = Array.from(collectionResults.entries()).map(([name, v]) => ({
    collection: name,
    ...v,
  }));
  res.json({ items });
});

app.get('/results/:name', (req, res) => {
  const name = req.params.name;
  const v = collectionResults.get(name);
  if (!v) return res.status(404).json({ error: 'not found' });
  res.json({ collection: name, ...v });
});

// ----------------------- Маршруты для конфигурации -----------------------
app.get('/config', (req, res) => {
  res.json(config);
});

app.post('/config', (req, res) => {
  const { apiKey, workspaceId, useApi } = req.body;
  config.apiKey = apiKey || '';
  config.workspaceId = workspaceId || '';
  config.useApiMode = !!useApi;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  res.json({ success: true });
});

// ----------------------- Список коллекций и окружений -----------------------
async function fetchFromPostman(endpoint) {
  const url = `https://api.getpostman.com${endpoint}?workspace=${encodeURIComponent(config.workspaceId)}`;
  const { data } = await axios.get(url, { headers: { 'X-Api-Key': config.apiKey } });
  return data;
}

app.get('/collections', async (req, res) => {
  try {
    if (config.useApiMode) {
      const data = await fetchFromPostman('/collections');
      const names = data.collections.map(c => ({ name: c.name, uid: c.uid }));
      return res.json(names);
    } else {
      const files = fs.readdirSync(collDir).filter(f => f.endsWith('.json'));
      const names = files.map(name => ({ name, uid: null }));
      return res.json(names);
    }
  } catch (err) {
    console.error('Ошибка /collections:', err.message);
    return res.status(500).json({ error: 'API error' });
  }
});

app.get('/environments', async (req, res) => {
  try {
    if (config.useApiMode) {
      const data = await fetchFromPostman('/environments');
      const names = data.environments.map(e => ({ name: e.name, uid: e.uid }));
      return res.json(names);
    } else {
      const files = fs.readdirSync(envDir).filter(f => f.endsWith('.json'));
      const names = files.map(name => ({ name, uid: null }));
      return res.json(names);
    }
  } catch (err) {
    console.error('Ошибка /environments:', err.message);
    return res.status(500).json({ error: 'API error' });
  }
});

// ----------------------- Синхронизация из облака -----------------------
app.post('/refresh', async (req, res) => {
  try {
    fs.emptyDirSync(collDir);
    fs.emptyDirSync(envDir);

    const [collsRes, envsRes] = await Promise.all([
      axios.get(`https://api.getpostman.com/collections?workspace=${encodeURIComponent(config.workspaceId)}`, {
        headers: { 'X-Api-Key': config.apiKey }
      }),
      axios.get(`https://api.getpostman.com/environments?workspace=${encodeURIComponent(config.workspaceId)}`, {
        headers: { 'X-Api-Key': config.apiKey }
      })
    ]);

    for (const coll of collsRes.data.collections) {
      const { data: collData } = await axios.get(
        `https://api.getpostman.com/collections/${coll.uid}`,
        { headers: { 'X-Api-Key': config.apiKey } }
      );
      fs.writeFileSync(
        path.join(collDir, `${coll.name}.json`),
        JSON.stringify(collData.collection, null, 2)
      );
    }

    for (const env of envsRes.data.environments) {
      const { data: envData } = await axios.get(
        `https://api.getpostman.com/environments/${env.uid}`,
        { headers: { 'X-Api-Key': config.apiKey } }
      );
      fs.writeFileSync(
        path.join(envDir, `${env.name}.json`),
        JSON.stringify(envData.environment, null, 2)
      );
    }

    return res.json({ updated: true });
  } catch (err) {
    console.error('❌ Ошибка обновления из облака:', err?.response?.data || err.message);
    return res.status(500).json({ updated: false });
  }
});

// ----------------------- Генерация Allure -----------------------
async function generateAllure({ resultsDir, reportDir }) {
  const localAllure = path.join(
    __dirname,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'allure.cmd' : 'allure'
  );

  const asPromise = (child, label) =>
    new Promise((resolve, reject) => {
      child.stdout?.on('data', d => ssePush({ type: 'allure', message: `[${label}] ${d.toString()}` }));
      child.stderr?.on('data', d => ssePush({ type: 'allure', level: 'err', message: `[${label}] ${d.toString()}` }));
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${label} exit ${code}`))));
    });

  // Стратегия 1: локальный бинарник
  if (fs.existsSync(localAllure)) {
    try {
      const args = ['generate', resultsDir, '--clean', '-o', reportDir];
      const p = spawn(localAllure, args, { stdio: 'pipe' });
      await asPromise(p, 'local-allure');
      return { ok: true, strategy: 'local' };
    } catch (e) {
      console.warn('Local Allure failed:', e.message);
    }
  }

  // Стратегия 2: npx (работает, если установлен как dependency)
  try {
    const cmd = `npx allure-commandline generate "${resultsDir}" --clean -o "${reportDir}"`;
    const p = spawn(cmd, { shell: true, stdio: 'pipe' });
    await asPromise(p, 'npx-allure');
    return { ok: true, strategy: 'npx' };
  } catch (e) {
    console.warn('npx Allure failed:', e.message);
  }

  return { ok: false, strategy: 'none' };
}

// ----------------------- Запуск коллекций -----------------------
app.post('/run', async (req, res) => {
  const { files, environment, parallel } = req.body;

  fs.emptyDirSync(allureResults);
  fs.emptyDirSync(allureReport);

  const runCollection = async (file) => {
    const { name, uid } = file;
    let collection, envObj;

    try {
      if (config.useApiMode) {
        const { data } = await axios.get(
          `https://api.getpostman.com/collections/${uid}`,
          { headers: { 'X-Api-Key': config.apiKey } }
        );
        collection = data.collection;

        if (environment?.uid) {
          const { data: envData } = await axios.get(
            `https://api.getpostman.com/environments/${environment.uid}`,
            { headers: { 'X-Api-Key': config.apiKey } }
          );
          envObj = envData.environment;
        }
      } else {
        const content = fs.readFileSync(path.join(collDir, name), 'utf8');
        collection = JSON.parse(content);

        if (environment?.name) {
          const envContent = fs.readFileSync(path.join(envDir, environment.name), 'utf8');
          envObj = JSON.parse(envContent);
        }
      }
    } catch (e) {
      const msg = `❌ Ошибка загрузки "${name}": ${e.message}`;
      console.error(msg);
      setStatusError(name, e.message);
      ssePush({ type: 'error', collection: name, message: msg });
      ssePush({ type: 'collection-status', collection: name, ...collectionResults.get(name) });
      return;
    }

    setStatusRunning(name);
    ssePush({ type: 'collection-status', collection: name, ...collectionResults.get(name) });
    sseLog(`▶ Запуск коллекции: ${name}`, { collection: name });

    return new Promise(resolve => {
      newman
        .run({
          collection,
          environment: envObj,
          reporters: ['cli', 'allure'],
          reporter: { allure: { export: allureResults } }
        })
        .on('start', () => {
          ssePush({ type: 'start', collection: name });
        })
        .on('beforeItem', (err, args) => {
          if (!err && args?.item?.name) {
            ssePush({ type: 'item', collection: name, item: args.item.name });
          }
        })
        .on('request', (err, args) => {
          if (err) {
            ssePush({ type: 'error', collection: name, message: String(err) });
            return;
          }
          ssePush({
            type: 'request',
            collection: name,
            item: args.item?.name,
            status: args.response?.code,
            time: args.response?.responseTime
          });

          try {
            const body = args.response.stream?.toString() || '';
            const pretty = JSON.stringify(JSON.parse(body), null, 2);
            fs.writeFileSync(
              path.join(allureResults, `${Date.now()}-${args.item.name.replace(/\W/g, '_')}-response.json`),
              pretty
            );
          } catch (_) { /* ignore non-JSON */ }
        })
        .on('assertion', (err, args) => {
          ssePush({
            type: 'assertion',
            collection: name,
            item: args?.item?.name,
            assertion: args?.assertion,
            error: err ? String(err) : null
          });
        })
        .on('console', (err, args) => {
          if (args?.messages?.length) {
            ssePush({ type: 'pm-console', collection: name, message: args.messages.join(' ') });
          }
        })
        .on('done', (err, summary) => {
          const failures = summary?.run?.failures?.length || 0;
          setStatusDone(name, failures);
          const { resultLine } = collectionResults.get(name);
          sseLog(`✅ Завершено: ${name} (ошибок: ${failures})`, { collection: name, failures });
          ssePush({ type: 'collection-done', collection: name, failures, resultLine });
          ssePush({ type: 'collection-status', collection: name, ...collectionResults.get(name) });
          resolve();
        });
    });
  };

  try {
    if (parallel) {
      await Promise.all(files.map(runCollection));
    } else {
      for (const file of files) {
        await runCollection(file);
      }
    }

    // Генерация отчёта
    const genRes = await generateAllure({ resultsDir: allureResults, reportDir: allureReport });

    let reportUrl = null;
    if (genRes.ok) {
      reportUrl = `/allure-report/index.html`; // относительный URL — работает на любом хосте
      console.log('📊 Allure отчёт успешно сгенерирован.');
      ssePush({ type: 'allure-done', ok: true, url: reportUrl });
    } else {
      const warn = '⚠️ Allure отчёт не сгенерирован. Убедитесь, что allure-commandline установлен.';
      console.warn(warn);
      ssePush({ type: 'allure-done', ok: false, message: warn });
    }

    return res.json({ message: 'Test run complete', reportUrl });

  } catch (e) {
    console.error('❌ Ошибка запуска тестов:', e.message);
    ssePush({ type: 'error', message: e.message });
    return res.status(500).json({ error: 'Test run failed' });
  }
});

// ----------------------- Старт сервера -----------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🌐 Доступен по: http://localhost:${PORT} (локально)`);
});
