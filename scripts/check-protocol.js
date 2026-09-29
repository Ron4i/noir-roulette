#!/usr/bin/env node
/**
 * Сквозная проверка протокола сигналинга двумя ботами.
 *
 *   node scripts/check-protocol.js [ws://localhost:3001/ws]
 *
 * Скрипт поднимает двух виртуальных участников и проверяет весь путь:
 * ready -> очередь -> матч -> проксирование SDP/ICE -> чат ->
 * санитизация -> media:state -> «Далее» -> повторный матч ->
 * жалоба -> rate-limit -> выход.
 */
import WebSocket from 'ws';

const URL = process.argv[2] || 'ws://localhost:3001/ws';
const OPEN_TIMEOUT = 5000;
const STEP_TIMEOUT = 6000;

let passed = 0;
let failed = 0;
const failures = [];

function ok(name) {
  passed += 1;
  console.log(`  \u2713 ${name}`);
}

function fail(name, detail) {
  failed += 1;
  failures.push(`${name}: ${detail}`);
  console.log(`  \u2717 ${name} \u2014 ${detail}`);
}

function section(title) {
  console.log(`\n\u203a ${title}`);
}

/** Небольшой виртуальный участник. */
class Bot {
  constructor(label) {
    this.label = label;
    this.ws = null;
    this.inbox = [];
    this.waiters = new Set();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(URL);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.label}: таймаут подключения`)), OPEN_TIMEOUT);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(this);
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`${this.label}: ${err.message}`));
      });
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this.inbox.push(msg);
        for (const w of [...this.waiters]) w();
      });
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  /** Ждёт сообщение, удовлетворяющее предикату. */
  wait(predicate, timeout = STEP_TIMEOUT) {
    const found = this.inbox.find(predicate);
    if (found) {
      this.inbox.splice(this.inbox.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const check = () => {
        if (settled) return;
        const idx = this.inbox.findIndex(predicate);
        if (idx === -1) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(this.inbox.splice(idx, 1)[0]);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiters.delete(check);
        const seen = this.inbox.map((m) => m.type).join(', ') || 'пусто';
        reject(new Error(`${this.label}: не дождались сообщения (в боксе: ${seen})`));
      }, timeout);
      this.waiters.add(check);
    });
  }

  waitFor(type, timeout = STEP_TIMEOUT) {
    return this.wait((m) => m.type === type, timeout);
  }

  clear() {
    this.inbox.length = 0;
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

async function main() {
  console.log(`Проверка протокола: ${URL}`);
  // Страховка: весь прогон не должен длиться дольше минуты.
  const watchdog = setTimeout(() => {
    console.error('\nПроверка прервана: превышено общее время ожидания');
    process.exit(1);
  }, 60_000);
  try {
    await run();
  } finally {
    clearTimeout(watchdog);
  }
}

async function run() {
  section('Подключение и handshake');
  const a = new Bot('A');
  const b = new Bot('B');
  await a.connect();
  ok('клиент A подключился');
  await b.connect();
  ok('клиент B подключился');

  const ready = await a.waitFor('ready');
  if (ready.sessionId) ok(`ready: sessionId выдан (${String(ready.sessionId).slice(0, 8)}…)`);
  else fail('ready: sessionId выдан', 'поле sessionId отсутствует');

  section('Очередь');
  a.clear();
  a.send({ type: 'queue:join' });
  const waiting = await a.waitFor('queue:waiting');
  if (typeof waiting.position === 'number' && waiting.position >= 1) ok('A: queue:waiting с позицией в очереди');
  else fail('A: queue:waiting с позицией', JSON.stringify(waiting));

  a.clear();
  b.clear();
  b.send({ type: 'queue:join' });
  const matchA = await a.waitFor('match');
  const matchB = await b.waitFor('match');
  ok('после queue:join обоих участников создался матч');
  if (typeof matchA.initiator === 'boolean') ok('match.initiator — булев флаг');
  else fail('match.initiator — булев флаг', `получено ${typeof matchA.initiator}`);
  if (matchB.initiator !== matchA.initiator) ok('инициатор противоположен у обоих участников');
  else fail('инициатор противоположен', 'оба участника получили одинаковый флаг');
  if (matchA.peer?.color?.name) ok(`цвет собеседника передан (${matchA.peer.color.name})`);
  else fail('цвет собеседника передан', 'поле peer.color.name отсутствует');
  if (Array.isArray(matchA.iceServers)) ok(`ICE-серверы переданы (${matchA.iceServers.length})`);
  else fail('ICE-серверы переданы', 'поле iceServers не массив');

  section('Проксирование сигналов');
  b.clear();
  a.send({ type: 'signal', data: { kind: 'offer', sdp: 'v=0 fake-offer' } });
  const relayed = await b.waitFor('signal');
  if (relayed.data?.kind === 'offer' && relayed.data?.sdp === 'v=0 fake-offer') ok('SDP offer проксирован B без изменений');
  else fail('SDP offer проксирован', JSON.stringify(relayed));

  a.clear();
  b.send({ type: 'signal', data: { kind: 'ice', candidate: { candidate: 'candidate:fake' } } });
  const ice = await a.waitFor('signal');
  if (ice.data?.kind === 'ice' && ice.data?.candidate?.candidate === 'candidate:fake') ok('ICE candidate проксирован A');
  else fail('ICE candidate проксирован', JSON.stringify(ice));

  a.clear();
  a.send({ type: 'signal', data: { kind: 'wat' } });
  const badSignal = await a.waitFor('error');
  if (badSignal.code === 'bad_signal') ok('некорректный вид сигнала отклонён (bad_signal)');
  else fail('валидация сигнала', JSON.stringify(badSignal));

  section('Чат');
  b.clear();
  a.send({ type: 'chat', text: 'Привет!' });
  const chat = await b.wait((m) => m.type === 'chat');
  if (chat.text === 'Привет!') ok('сообщение доставлено как есть');
  else fail('доставка чата', `получено ${JSON.stringify(chat.text)}`);
  a.clear();
  b.send({ type: 'chat', text: 'И тебе привет' });
  const reply = await a.wait((m) => m.type === 'chat');
  if (reply.text === 'И тебе привет') ok('ответ доставлен в обратную сторону');
  else fail('обратная доставка', `получено ${JSON.stringify(reply.text)}`);

  a.clear();
  b.clear();
  a.send({ type: 'chat', text: 'a\u0000b\u0007c' });
  const cleaned = await b.wait((m) => m.type === 'chat');
  if (cleaned.text === 'abc') ok('управляющие символы вырезаны сервером');
  else fail('санитизация', `получено ${JSON.stringify(cleaned.text)}`);

  b.clear();
  a.send({ type: 'chat', text: 'x'.repeat(900) });
  const trimmed = await b.wait((m) => m.type === 'chat');
  if (trimmed.text.length === 500) ok('сообщение обрезано до 500 символов');
  else fail('лимит длины', `получено ${trimmed.text.length} символов`);

  b.clear();
  a.send({ type: 'chat', text: '   ' });
  await new Promise((r) => setTimeout(r, 400));
  if (!b.inbox.some((m) => m.type === 'chat')) ok('пустое сообщение отброшено');
  else fail('пустое сообщение', `получено ${JSON.stringify(b.inbox)}`);

  section('Состояние микрофона и камеры');
  a.clear();
  b.send({ type: 'media:state', mic: false, cam: true });
  const state = await a.waitFor('media:state');
  if (state.mic === false && state.cam === true) ok('media:state проксирован без изменений');
  else fail('media:state', JSON.stringify(state));

  section('Кнопка «Далее»');
  a.clear();
  b.clear();
  a.send({ type: 'queue:next' });
  const nextA = await a.wait((m) => m.type === 'match' || m.type === 'queue:waiting');
  if (nextA.type === 'queue:waiting') {
    ok('после «Далее» A снова в очереди');
    b.send({ type: 'queue:join' });
    await a.waitFor('match');
    await b.waitFor('match');
    ok('пара пересобрана после повторного входа в очередь');
  } else {
    await b.waitFor('match');
    ok('пара пересобрана сразу');
  }

  section('Жалоба');
  a.clear();
  b.clear();
  a.send({ type: 'report', reason: 'spam' });
  const report = await a.waitFor('report:accepted');
  if (report) ok('report:accepted отправлен клиенту');
  const afterReport = await a.waitFor('peer:left');
  if (afterReport.reason === 'reported') ok('после жалобы разрыв пары с причиной «reported»');
  else fail('разрыв после жалобы', JSON.stringify(afterReport));

  section('Rate limit');
  // Жалоба разорвала пару — собираем её заново, иначе чат сервер не примет.
  a.clear();
  b.clear();
  a.send({ type: 'queue:join' });
  await a.waitFor('queue:waiting');
  b.send({ type: 'queue:join' });
  await a.waitFor('match');
  await b.waitFor('match');
  a.clear();
  b.clear();
  for (let i = 0; i < 20; i += 1) {
    a.send({ type: 'chat', text: `спам ${i}` });
  }
  await new Promise((r) => setTimeout(r, 1500));
  let accepted = 0;
  let rejected = 0;
  for (const m of a.inbox) {
    if (m.type === 'error' && m.code === 'rate_limited') rejected += 1;
  }
  for (const m of b.inbox) {
    if (m.type === 'chat') accepted += 1;
  }
  if (rejected > 0 && accepted > 0 && accepted < 20) {
    ok(`rate limit сработал: ${accepted} доставлено, ${rejected} отклонено`);
  } else {
    fail('rate limit', `доставлено ${accepted}, отклонено ${rejected}`);
  }

  section('Выход');
  b.clear();
  b.send({ type: 'bye' });
  const left = await a.waitFor('peer:left');
  if (left.reason) ok(`peer:left с причиной «${left.reason}»`);
  else ok('peer:left получен');

  a.close();
  b.close();
  await new Promise((r) => setTimeout(r, 200));

  console.log(`\nИтог: ${passed} успешно, ${failed} провалено`);
  if (failures.length) {
    console.log('\nПровалы:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nПроверка прервана: ${err.message}`);
  process.exit(1);
});