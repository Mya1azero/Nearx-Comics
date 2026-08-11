#!/usr/bin/env node
// «Случайная встреча» v3 — вся история на 8 страницах: тонкие рамки, 6–7 кадров
// на страницу, единый шрифт. Каждая готовая страница выравнивается и сразу
// уходит владельцу в телеграм. Живёт сам по себе (nohup), лог — run4.log.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TG = path.resolve(ROOT, '..', 'bot', 'tg.js');
const REF1 = 'out/2026-08-10_2158_лист-персонажей-комикса-двое-в-п/01_nano-banana-2.jpg';
const REF2 = 'out/2026-08-10_2211_целая-страница-комикса-вертикаль/04_gpt-image-2-image-to-image.jpg';
const MODEL = 'gpt-image-2-image-to-image';

const log = m => console.log(`${new Date().toISOString()} ${m}`);

function vis(args, timeoutMin = 8) {
  return execFileSync('node', ['bin/vis.js', ...args],
    { cwd: ROOT, stdio: 'pipe', timeout: timeoutMin * 60 * 1000 }).toString();
}

function jpgIn(dir) {
  try {
    const f = fs.readdirSync(dir).filter(x => x.endsWith('.jpg') && !x.startsWith('framed'));
    return f.length ? path.join(dir, f[0]) : null;
  } catch { return null; }
}

function genPage(n) {
  const prompt = fs.readFileSync(path.join(__dirname, `q${n}.txt`), 'utf8').trim();
  const out = vis(['crea', prompt, '--ref', REF1, '--ref', REF2, '--models', MODEL, '--format', '2:3', '--resolution', '2K']);
  const m = out.match(/Папка:\s*(\S.*)/);
  if (!m) throw new Error('папка результата не найдена');
  const raw = jpgIn(m[1].trim());
  if (!raw) throw new Error('файл результата не найден');
  const framed = path.join(path.dirname(raw), 'framed.jpg');
  execFileSync('node', [path.join(__dirname, 'frame.cjs'), raw, framed],
    { stdio: 'pipe', timeout: 60000 });
  return fs.existsSync(framed) ? framed : raw;
}

(async () => {
  const done = [], failed = [];
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    let file = null;
    for (let attempt = 1; attempt <= 2 && !file; attempt++) {
      try { file = genPage(n); }
      catch (e) { log(`стр.${n} попытка ${attempt}: ${String(e.message).slice(0, 200)}`); }
    }
    if (file) {
      try {
        execFileSync('node', [TG, 'send', file, `«Случайная встреча» v3: страница ${n} из 8`],
          { stdio: 'pipe', timeout: 120000 });
        done.push(n); log(`стр.${n} отправлена`);
      } catch (e) { failed.push(n); log(`стр.${n} отправка: ${e.message}`); }
    } else failed.push(n);
  }
  try { log('reconcile: ' + vis(['reconcile'], 2).trim().split('\n').pop()); } catch {}
  const msg = failed.length === 0
    ? 'Вся история готова: 8 страниц, тонкие рамки, плавный сюжет, единый шрифт.'
    : `Готовы страницы ${done.join(', ')}. Не вышли: ${failed.join(', ')} — Клод разберётся.`;
  try { execFileSync('node', [TG, 'text', msg], { stdio: 'pipe', timeout: 60000 }); } catch {}
  log(`итог: ок ${done.join(',') || '—'}; сбой ${failed.join(',') || '—'}`);
  process.exit(failed.length ? 1 : 0);
})();
