#!/usr/bin/env node
// Самостоятельная доставка «Случайной встречи»: страница 2 — забрать оплаченную,
// страницы 3–6 — сгенерить на GPT Image 2; каждую сразу в телеграм владельцу.
// Живёт сам по себе (nohup), лог — continuation/run2.log.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const TG = path.resolve(ROOT, '..', 'bot', 'tg.js');
const REF1 = 'out/2026-08-10_2158_лист-персонажей-комикса-двое-в-п/01_nano-banana-2.jpg';
const REF2 = 'out/2026-08-10_2211_целая-страница-комикса-вертикаль/04_gpt-image-2-image-to-image.jpg';
const MODEL = 'gpt-image-2-image-to-image';
const PAGE2_TASKS = [
  'a0bc4b678e88458c2cc01903b9230e1a',
  '941607447ede9cf19a94a2e176bbda04',
  'c25260a2d128f356015f983664ed8c0d'
];

const log = m => console.log(`${new Date().toISOString()} ${m}`);

function vis(args, timeoutMin = 8) {
  return execFileSync('node', ['bin/vis.js', ...args],
    { cwd: ROOT, stdio: 'pipe', timeout: timeoutMin * 60 * 1000 }).toString();
}

function tgSend(file, caption) {
  execFileSync('node', [TG, 'send', file, caption], { stdio: 'pipe', timeout: 120000 });
}

function tgText(text) {
  try { execFileSync('node', [TG, 'text', text], { stdio: 'pipe', timeout: 60000 }); } catch {}
}

function jpgIn(dir) {
  try {
    const f = fs.readdirSync(dir).filter(x => x.endsWith('.jpg'));
    return f.length ? path.join(dir, f[0]) : null;
  } catch { return null; }
}

function page2Dirs() {
  return fs.readdirSync(OUT)
    .filter(d => d.includes('страница-2-той-же-истории'))
    .map(d => path.join(OUT, d))
    .sort()
    .reverse();
}

function getPage2() {
  for (const dir of page2Dirs()) {
    const f = jpgIn(dir);
    if (f) return f;
  }
  for (const t of PAGE2_TASKS) {
    try { log('fetch ' + t + ': ' + vis(['fetch', t], 3).trim().split('\n').pop()); }
    catch (e) { log('fetch ' + t + ' не вышел'); }
    for (const dir of page2Dirs()) {
      const f = jpgIn(dir);
      if (f) return f;
    }
  }
  return null;
}

function genPage(n) {
  const prompt = fs.readFileSync(path.join(__dirname, `p${n}.txt`), 'utf8').trim();
  const out = vis(['crea', prompt, '--ref', REF1, '--ref', REF2, '--models', MODEL, '--format', '2:3']);
  const m = out.match(/Папка:\s*(\S.*)/);
  if (m) {
    const f = jpgIn(m[1].trim());
    if (f) return f;
  }
  throw new Error('результат не найден');
}

(async () => {
  const done = [];
  const failed = [];

  let p2 = null;
  try { p2 = getPage2(); } catch (e) { log('стр.2: ' + e.message); }
  if (!p2) {
    log('оплаченная стр.2 не досталась, рисую заново');
    try { p2 = genPage(2); } catch (e) { log('стр.2 заново не вышла: ' + e.message); }
  }
  if (p2) {
    try { tgSend(p2, '«Случайная встреча», страница 2 из 6 — GPT Image 2'); done.push(2); log('стр.2 отправлена'); }
    catch (e) { failed.push(2); log('стр.2 отправка: ' + e.message); }
  } else failed.push(2);

  for (const n of [3, 4, 5, 6]) {
    let file = null;
    for (let attempt = 1; attempt <= 2 && !file; attempt++) {
      try { file = genPage(n); }
      catch (e) { log(`стр.${n} попытка ${attempt}: ${e.message}`); }
    }
    if (file) {
      try { tgSend(file, `«Случайная встреча», страница ${n} из 6 — GPT Image 2`); done.push(n); log(`стр.${n} отправлена`); }
      catch (e) { failed.push(n); log(`стр.${n} отправка: ${e.message}`); }
    } else failed.push(n);
  }

  try { log('reconcile: ' + vis(['reconcile'], 2).trim().split('\n').pop()); } catch {}

  if (failed.length === 0) {
    tgText('Все 5 страниц продолжения у тебя. История целиком: страница 1 из сравнения (подпись «4 из 5 — GPT Image 2») плюс эти пять.');
  } else {
    tgText(`Готовы страницы: ${done.join(', ')}. Не вышли: ${failed.join(', ')} — Клод разберётся.`);
  }
  log(`итог: ок ${done.join(',') || '—'}; сбой ${failed.join(',') || '—'}`);
  process.exit(failed.length ? 1 : 0);
})();
