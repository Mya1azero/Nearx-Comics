#!/usr/bin/env node
// Дежурный бота: владелец пишет в телеграм — сервер рисует страницу комикса.
// Команды владельца:
//   страница <что происходит>  — сгенерить страницу с его героями (~2 мин, ~3 цента)
//   баланс                     — сколько осталось в копилке
//   помощь                     — подсказка
// Запуск: node worker.js (крутится вечно, лог в worker.log)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const ROOT = path.resolve(DIR, '..', 'neo3-visual');
const OUT = path.join(ROOT, 'out');
const OFFSET_PATH = path.join(DIR, 'offset.json');
const LOG_PATH = path.join(DIR, 'worker.log');

const token = fs.readFileSync(path.join(DIR, '.env'), 'utf8').match(/TG_BOT_TOKEN\s*=\s*(\S+)/)[1];
const OWNER = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).chat_id;

const REF1 = 'out/2026-08-10_2158_лист-персонажей-комикса-двое-в-п/01_nano-banana-2.jpg';
const REF2 = 'out/2026-08-10_2211_целая-страница-комикса-вертикаль/04_gpt-image-2-image-to-image.jpg';
const MODEL = 'gpt-image-2-image-to-image';

const HELP = 'Я рисую страницы твоего комикса. Команды:\n\n' +
  'страница <что происходит> — нарисую страницу с твоими героями (~2 минуты, ~3 цента)\n' +
  'баланс — сколько осталось в копилке\n\n' +
  'Пример: страница герои застряли в лифте и знакомятся с соседской собакой';

function log(msg) {
  fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
}

async function api(method, payload, isForm = false) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const opts = isForm
    ? { method: 'POST', body: payload }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const say = text => api('sendMessage', { chat_id: OWNER, text });

async function sendPhoto(file, caption) {
  const fd = new FormData();
  fd.append('chat_id', String(OWNER));
  if (caption) fd.append('caption', caption);
  fd.append('photo', new Blob([fs.readFileSync(file)]), path.basename(file));
  return api('sendPhoto', fd, true);
}

function newestPage() {
  const dirs = fs.readdirSync(OUT)
    .map(d => path.join(OUT, d))
    .filter(d => fs.statSync(d).isDirectory())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!dirs.length) return null;
  const files = fs.readdirSync(dirs[0]).filter(f => f.endsWith('.jpg'));
  return files.length ? path.join(dirs[0], files[0]) : null;
}

function makePage(story) {
  const prompt =
    'Страница комикса, вертикальная, живая журнальная вёрстка: ТРИ ЯРУСА, кадры разной ширины, ' +
    'белые канавки, одна фишка на страницу — круглая врезка поверх стыка кадров или финальный кадр ' +
    'навылет до краёв. Рисовка, атмосфера и ГЕРОИ точно как на референсах: парень — короткая тёмная ' +
    'стрижка, аккуратная борода, серо-голубые глаза, красная футболка, цепочка; девушка — тёмно-рыжие ' +
    'волнистые волосы до плеч, зелёные глаза, джинсовка поверх белой футболки; лица узнаваемые во всех ' +
    `кадрах. Сюжет страницы: ${story}. Короткие реплики в аккуратных скруглённых пузырях, хвост ко рту ` +
    'говорящего, первый говорящий выше и левее, весь текст на русском, чистый, крупный, без ошибок.';
  const out = execFileSync('node', ['bin/vis.js', 'crea', prompt,
    '--ref', REF1, '--ref', REF2, '--models', MODEL, '--format', '2:3', '--resolution', '2K'],
    { cwd: ROOT, stdio: 'pipe', timeout: 8 * 60 * 1000 }).toString();
  const m = out.match(/Папка:\s*(\S.*)/);
  if (m) {
    const dir = m[1].trim();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jpg'));
    if (files.length) return path.join(dir, files[0]);
  }
  return newestPage();
}

function spent() {
  try {
    return execFileSync('node', ['bin/vis.js', 'spent'], { cwd: ROOT, stdio: 'pipe', timeout: 60000 })
      .toString().trim();
  } catch (e) {
    return 'Не смог посчитать: ' + e.message;
  }
}

async function handle(text) {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (lower.startsWith('страница')) {
    const story = t.slice('страница'.length).trim();
    if (!story) return say('Напиши, что происходит на странице. Пример: страница герои попали под ливень и спрятались в старом кинотеатре');
    await say('Принял. Рисую страницу, это ~2 минуты…');
    try {
      const file = makePage(story);
      if (!file) throw new Error('результат не нашёлся');
      await sendPhoto(file, 'Готово. Хочешь ещё — напиши «страница …»');
      log(`страница ок: ${story.slice(0, 60)}`);
    } catch (e) {
      const msg = /бюджет|budget|лимит/i.test(String(e.message || e))
        ? 'Копилка на генерации закончилась. Скажи Клоду в чате поднять предохранитель.'
        : 'Не вышло нарисовать, попробуй ещё раз чуть позже.';
      await say(msg);
      log(`страница ошибка: ${e.message}`);
    }
  } else if (lower.startsWith('баланс')) {
    await say(spent());
  } else {
    await say(HELP);
  }
}

async function main() {
  let offset = 0;
  try { offset = JSON.parse(fs.readFileSync(OFFSET_PATH, 'utf8')).offset; } catch {}
  log(`дежурный запущен, offset ${offset}`);
  while (true) {
    let updates = [];
    try {
      updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
    } catch (e) {
      log(`getUpdates: ${e.message}`);
      await new Promise(r => setTimeout(r, 15000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      fs.writeFileSync(OFFSET_PATH, JSON.stringify({ offset }));
      const m = u.message;
      if (!m || !m.text || m.chat.id !== OWNER) continue;
      try { await handle(m.text); } catch (e) { log(`handle: ${e.message}`); }
    }
  }
}

main().catch(e => { log(`фатально: ${e.message}`); process.exit(1); });
