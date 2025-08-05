const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const newman = require('newman');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = 3000;

const collDir = path.join(__dirname, 'collections');
const envDir = path.join(__dirname, 'environments');
const allureResults = path.join(__dirname, 'allure-results');
const allureReport = path.join(__dirname, 'allure-report');
const configPath = path.join(__dirname, 'config.json');

fs.ensureDirSync(collDir);
fs.ensureDirSync(envDir);
fs.ensureFileSync(configPath);

// Загружаем конфиг
let config = { apiKey: '', workspaceId: '', useApiMode: true };
try {
  const file = fs.readFileSync(configPath);
  if (file.length) config = JSON.parse(file);
} catch (err) {
  console.error('❌ Ошибка чтения config.json:', err.message);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/allure-report', express.static(allureReport));
app.use(express.json());

app.get('/config', (req, res) => {
  res.json(config);
});

app.post('/config', (req, res) => {
  const { apiKey, workspaceId, useApi } = req.body;
  config.apiKey = apiKey;
  config.workspaceId = workspaceId;
  config.useApiMode = useApi;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  res.json({ success: true });
});

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
      fs.writeFileSync(path.join(collDir, `${coll.name}.json`), JSON.stringify(collData.collection, null, 2));
    }

    for (const env of envs.data.environments) {
      const { data: envData } = await axios.get(
        `https://api.getpostman.com/environments/${env.uid}`,
        { headers: { 'X-Api-Key': config.apiKey } }
      );
      fs.writeFileSync(path.join(envDir, `${env.name}.json`), JSON.stringify(envData.environment, null, 2));
    }

    return res.json({ updated: true });
  } catch (err) {
    console.error('❌ Ошибка обновления из облака:', err?.response?.data || err.message);
    return res.status(500).json({ updated: false });
  }
});


app.post('/run', async (req, res) => {
  const { files, environment, parallel } = req.body;
  fs.emptyDirSync(allureResults);
  fs.emptyDirSync(allureReport);

  const runCollection = async (file) => {
    const { name, uid } = file;
    let collection, envObj;

    try {
      if (config.useApiMode) {
        // Загружаем коллекцию из Postman API
        const { data } = await axios.get(
          `https://api.getpostman.com/collections/${uid}`,
          { headers: { 'X-Api-Key': config.apiKey } }
        );
        collection = data.collection;

        // Загружаем окружение (если есть)
        if (environment && environment.uid) {
          const { data: envData } = await axios.get(
            `https://api.getpostman.com/environments/${environment.uid}`,
            { headers: { 'X-Api-Key': config.apiKey } }
          );
          envObj = envData.environment;
        }
      } else {
        // Загружаем коллекцию из локального файла (без require кеша!)
        const content = fs.readFileSync(path.join(collDir, name), 'utf-8');
        collection = JSON.parse(content);

        if (environment && environment.name) {
          const envContent = fs.readFileSync(path.join(envDir, environment.name), 'utf-8');
          envObj = JSON.parse(envContent);
        }
      }
    } catch (e) {
      console.error(`❌ Ошибка загрузки "${name}":`, e.message);
      return;
    }

    console.log(`▶ Запуск коллекции: ${name}`);

    return new Promise(resolve => {
      newman.run({
        collection,
        environment: envObj,
        reporters: ['cli', 'allure'],
        reporter: { allure: { export: allureResults } }
      }).on('request', (err, args) => {
        if (err || !args?.response) return;
        try {
          const body = args.response.stream.toString();
          const pretty = JSON.stringify(JSON.parse(body), null, 2);
          fs.writeFileSync(
            path.join(allureResults, `${Date.now()}-${args.item.name}-response.json`),
            pretty
          );
        } catch (_) { }
      }).on('done', () => {
        console.log(`✅ Завершено: ${name}`);
        resolve();
      });
    });
  };

  try {
    if (parallel) {
      // 🔁 Параллельный запуск всех коллекций
      await Promise.all(files.map(file => runCollection(file)));
    } else {
      // 🔂 Последовательный запуск
      for (const file of files) {
        await runCollection(file);
      }
    }

    // 📦 Генерация Allure отчета
    exec(`npx allure-commandline generate ${allureResults} --clean -o ${allureReport}`, (err) => {
      if (err) {
        console.error('❌ Ошибка генерации Allure:', err.message);
        return res.status(500).json({ error: 'Allure generation failed' });
      }

      const url = `http://localhost:${PORT}/allure-report/index.html`;

      // 🔓 Открываем отчет в браузере только на Windows
      if (process.platform === 'win32') {
        exec(`start "" "${url}"`);
      }

      console.log('📊 Отчет Allure успешно сгенерирован.');
      res.json({ message: 'Test run complete', reportUrl: url });
    });

  } catch (e) {
    console.error('❌ Ошибка запуска тестов:', e.message);
    res.status(500).json({ error: 'Test run failed' });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
});
