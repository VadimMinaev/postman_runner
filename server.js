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
const PORT = 3000;

// ----------------------- Пути к рабочим директориям и файлам -----------------------
const collDir = path.join(__dirname, 'collections');
const envDir = path.join(__dirname, 'environments');
const allureResults = path.join(__dirname, 'allure-results');
const allureReport = path.join(__dirname, 'allure-report');
const configPath = path.join(__dirname, 'config.json');

// гарантируем наличие папок/конфига
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
/**
 * collectionResults: Map<string, {
 *   resultLine: string,        // статичная строка результата
 *   failures: number,          // число ошибок
 *   status: 'idle'|'running'|'done'|'error',
 *   startedAt?: number,
 *   finishedAt?: number,
 * }>
 */
const collectionResults = new Map();

// Удобный помощник формирования “одной строки результата”
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
let lastCompletionMessage = ''; // хранит последнее сообщение "✅ Завершено: ..."

function ssePush(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function sseLog(message, extra = {}) {
  console.log(message);

  // Запоминаем последнее завершение
  if (message.startsWith('✅ Завершено:')) {
    lastCompletionMessage = message;
  }

  ssePush({
    type: 'log',
    ts: Date.now(),
    message,
    lastCompletionMessage,
    ...extra
  });
}

// endpoint для EventSource
app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 1000\n\n');

  // Сразу отдать снапшот последних результатов (для статичных строк в UI)
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

// ----------------------- Список коллекций -----------------------
app.get('/collections', async (req, res) => {
  if (config.useApiMode) {
    try {
      const { data } = await axios.get(
        `https://api.getpostman.com/collections?workspace=${config.workspaceId}`,
        { headers: { 'X-Api-Key': config.apiKey } }
      );
      const names = data.collections.map(c => ({ name: c.name, uid: c.uid }));
      return res.json(names);
    } catch (err) {
      return res.status(500).json({ error: 'API error' });
    }
  } else {
    const files = fs.readdirSync(collDir).filter(f => f.endsWith('.json'));
    const names = files.map(name => ({ name, uid: null }));
    res.json(names);
  }
});

// ----------------------- Список окружений -----------------------
app.get('/environments', async (req, res) => {
  if (config.useApiMode) {
    try {
      const { data } = await axios.get(
        `https://api.getpostman.com/environments?workspace=${config.workspaceId}`,
        { headers: { 'X-Api-Key': config.apiKey } }
      );
      const names = data.environments.map(e => ({ name: e.name, uid: e.uid }));
      return res.json(names);
    } catch (err) {
      return res.status(500).json({ error: 'API error' });
    }
  } else {
    const files = fs.readdirSync(envDir).filter(f => f.endsWith('.json'));
    const names = files.map(name => ({ name, uid: null }));
    res.json(names);
  }
});

// ----------------------- Синхронизация локального кэша из облака -----------------------
app.post('/refresh', async (req, res) => {
  try {
    fs.emptyDirSync(collDir);
    fs.emptyDirSync(envDir);

    const [colls, envs] = await Promise.all([
      axios.get(`https://api.getpostman.com/collections?workspace=${config.workspaceId}`, {
        headers: { 'X-Api-Key': config.apiKey }
      }),
      axios.get(`https://api.getpostman.com/environments?workspace=${config.workspaceId}`, {
        headers: { 'X-Api-Key': config.apiKey }
      })
    ]);

    for (const coll of colls.data.collections) {
      const { data: collData } = await axios.get(
        `https://api.getpostman.com/collections/${coll.uid}`,
        { headers: { 'X-Api-Key': config.apiKey } }
      );
      fs.writeFileSync(
        path.join(collDir, `${coll.name}.json`),
        JSON.stringify(collData.collection, null, 2)
      );
    }

    for (const env of envs.data.environments) {
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

// ----------------------- Функция устойчивой генерации Allure -----------------------
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
      child.on('error', err => reject(err));
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${label} exit ${code}`))));
    });

  // 1) локальный бинарь в node_modules/.bin
  try {
    if (fs.existsSync(localAllure)) {
      const args = ['generate', resultsDir, '--clean', '-o', reportDir];
      const p = spawn(localAllure, args, { stdio: 'pipe' });
      await asPromise(p, 'local-allure');
      return { ok: true, strategy: 'local' };
    }
  } catch (e) {
    ssePush({ type: 'allure', level: 'err', message: `local allure failed: ${e.message}` });
  }

  // 2) npx allure-commandline (shell:true устраняет EINVAL)
  try {
    const cmd = `npx allure-commandline generate "${resultsDir}" --clean -o "${reportDir}"`;
    const p = spawn(cmd, { shell: true });
    await asPromise(p, 'npx-allure');
    return { ok: true, strategy: 'npx' };
  } catch (e) {
    ssePush({ type: 'allure', level: 'err', message: `npx allure failed: ${e.message}` });
  }

  // 3) не удалось — сообщаем в UI, но не валим весь прогон
  return { ok: false, strategy: 'none' };
}

// ----------------------- Запуск коллекций и генерация отчёта -----------------------
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

        if (environment && environment.uid) {
          const { data: envData } = await axios.get(
            `https://api.getpostman.com/environments/${environment.uid}`,
            { headers: { 'X-Api-Key': config.apiKey } }
          );
          envObj = envData.environment;
        }
      } else {
        const content = fs.readFileSync(path.join(collDir, name), 'utf-8');
        collection = JSON.parse(content);

        if (environment && environment.name) {
          const envContent = fs.readFileSync(path.join(envDir, environment.name), 'utf-8');
          envObj = JSON.parse(envContent);
        }
      }
    } catch (e) {
      const msg = `❌ Ошибка загрузки "${name}": ${e.message}`;
      console.error(msg);
      ssePush({ type: 'error', collection: name, message: msg });
      setStatusError(name, e.message);
      ssePush({ type: 'collection-status', collection: name, ...collectionResults.get(name) });
      return;
    }

    // Обновим “статичную строку” в хранилище и пошлём статус
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
          if (!err) ssePush({ type: 'item', collection: name, item: args.item?.name });
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
            status: args?.response?.code,
            time: args?.response?.responseTime
          });

          // сохраняем prettified JSON-ответ, если это JSON
          try {
            const body = args.response.stream.toString();
            const pretty = JSON.stringify(JSON.parse(body), null, 2);
            fs.writeFileSync(
              path.join(allureResults, `${Date.now()}-${args.item.name}-response.json`),
              pretty
            );
          } catch (_) { /* игнор не-JSON */ }
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
          ssePush({ type: 'pm-console', collection: name, message: (args?.messages || []).join(' ') });
        })
        .on('done', (err, summary) => {
          const failures = summary?.run?.failures?.length || 0;

          // фиксируем финальный статус + “строку результата”
          setStatusDone(name, failures);
          const { resultLine } = collectionResults.get(name);

          sseLog(`✅ Завершено: ${name} (ошибок: ${failures})`, { collection: name, failures });

          // отдаём событие с готовой resultLine — фронт может просто отрисовать её
          ssePush({
            type: 'collection-done',
            collection: name,
            failures,
            resultLine
          });

          // и отдельным событием общий статус (если удобно слушать единый тип)
          ssePush({ type: 'collection-status', collection: name, ...collectionResults.get(name) });

          resolve();
        });
    });
  };

  try {
    if (parallel) {
      await Promise.all(files.map(file => runCollection(file)));
    } else {
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        await runCollection(file);
      }
    }

    // Генерация Allure
    const genRes = await generateAllure({ resultsDir: allureResults, reportDir: allureReport });

    if (!genRes.ok) {
      const warn = '⚠️ Отчёт Allure не сгенерирован. Проверьте установку: npm i -D allure-commandline или доступ к npx.';
      console.warn(warn);
      ssePush({ type: 'allure-done', ok: false, message: warn });
      return res.json({ message: 'Test run complete (без Allure отчёта)', reportUrl: null });
    }

    const url = `http://localhost:${PORT}/allure-report/index.html`;
    if (process.platform === 'win32') exec(`start "" "${url}"`);
    console.log('📊 Отчет Allure успешно сгенерирован.');
    ssePush({ type: 'allure-done', ok: true, url });
    return res.json({ message: 'Test run complete', reportUrl: url });

  } catch (e) {
    console.error('❌ Ошибка запуска тестов:', e.message);
    ssePush({ type: 'error', message: e.message });
    return res.status(500).json({ error: 'Test run failed' });
  }
});

// ----------------------- Старт HTTP-сервера -----------------------
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
});
