// Снимки экрана для README через Chrome DevTools Protocol.
// Запуск: node scripts/shot.js http://localhost:3001
//
// Работает на headless Chrome с фальшивыми камерой и микрофоном
// (--use-fake-device-for-media-stream), поэтому в кадре видно живое
// приложение, а не пустой экран.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || 'http://localhost:3001';
const OUT = path.join(HERE, '..', 'docs', 'img');
const PORT = 9222;

const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** Кадры, которые снимаем: имя + подготовка состояния страницы. */
const SHOTS = [
  { name: 'landing', setup: null },
  {
    name: 'settings',
    setup: async (page) => {
      await page.evaluate(() => document.getElementById('settingsBtn').click());
    },
  },
  {
    name: 'rooms',
    setup: async (page) => {
      await page.evaluate(() => document.getElementById('roomsBtn').click());
    },
  },
  {
    name: 'call',
    setup: async (page) => {
      await page.evaluate(() => document.getElementById('startBtn').click());
      await new Promise((r) => setTimeout(r, 3500));
    },
  },
  {
    name: 'light',
    setup: async (page) => {
      await page.evaluate(() => document.getElementById('themeBtn').click());
    },
  },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--window-size=1280,900',
      '--user-data-dir=' + path.join(os.tmpdir(), 'noir-shot-profile'),
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  // Ждём, пока DevTools-порт откроется.
  let list = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      list = await res.json();
      if (list.length) break;
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!list || !list.length) throw new Error('Chrome не запустился');

  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  // Обёртка над Runtime.evaluate с ожиданием промисов.
    // Принимает функцию, выполняет её тело как скрипт и ждёт промис,
    // если скрипт вернул его.
    const page = {
      evaluate: async (fn) => {
        const source = `(${fn.toString()})()`;
        const r = await send('Runtime.evaluate', {
          expression: source,
          awaitPromise: true,
          returnByValue: true,
        });
        if (r.exceptionDetails) {
          throw new Error(r.exceptionDetails.text || 'ошибка в странице');
        }
        return r.result?.value;
      },
    };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
      // 1x, а не 2x: GitHub всё равно не отдаёт README-картинки в retina,
      // а вдвое меньший вес заметно легче для клонирования репозитория.
      deviceScaleFactor: 1,
      mobile: false,
    });

  // Ожидание загрузки страницы: без него между кадрами накапливаются
    // старые DOM-узлы, и getElementById находит не тот элемент.
    const waitForLoad = () =>
      new Promise((resolve) => {
        const onEvent = (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.method === 'Page.loadEventFired') {
            ws.off('message', onEvent);
            resolve();
          }
        };
        ws.on('message', onEvent);
        setTimeout(resolve, 8000);
      });

    for (const shot of SHOTS) {
      await send('Page.navigate', { url: BASE });
      await waitForLoad();
      // Даём клиенту подключиться и hydrated каталог тем.
      await new Promise((r) => setTimeout(r, 1500));
      if (shot.setup) await shot.setup(page);

      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, `${shot.name}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`ok ${shot.name}.png`);
    }

  // `--keep-alive` оставляет Chrome запущенным для отладки DOM.
    if (process.argv.includes('--keep-alive')) {
      console.log('\nChrome остаётся запущенным для отладки. Ctrl+C для выхода.');
      await new Promise(() => {});
    }

    ws.close();
    chrome.kill();
    console.log(`\nГотово: ${OUT}`);
}

main().catch((err) => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});