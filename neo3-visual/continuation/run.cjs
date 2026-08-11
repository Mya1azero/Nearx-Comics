#!/usr/bin/env node
// Генерация страниц 2–6 «Случайной встречи» на GPT Image 2 и отправка
// каждой готовой страницы владельцу в телеграм. Запускать из neo3-visual.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const TG = path.resolve(ROOT, '..', 'bot', 'tg.js');
const REF1 = 'out/2026-08-10_2158_лист-персонажей-комикса-двое-в-п/01_nano-banana-2.jpg';
const REF2 = 'out/2026-08-10_2211_целая-страница-комикса-вертикаль/04_gpt-image-2-image-to-image.jpg';
const MODEL = 'gpt-image-2-image-to-image';

function newestPage() {
  const dirs = fs.readdirSync(OUT)
    .map(d => path.join(OUT, d))
    .filter(d => fs.statSync(d).isDirectory())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const files = fs.readdirSync(dirs[0]).filter(f => f.endsWith('.jpg'));
  return files.length ? path.join(dirs[0], files[0]) : null;
}

const pages = [2, 3, 4, 5, 6];
const results = [];
for (const n of pages) {
  const prompt = fs.readFileSync(path.join(__dirname, `p${n}.txt`), 'utf8').trim();
  console.log(`\n=== Страница ${n} ===`);
  try {
    execFileSync('node', ['bin/vis.js', 'crea', prompt,
      '--ref', REF1, '--ref', REF2, '--models', MODEL, '--format', '2:3'],
      { cwd: ROOT, stdio: 'inherit' });
    const file = newestPage();
    if (!file) throw new Error('файл результата не найден');
    execFileSync('node', [TG, 'send', file, `«Случайная встреча», страница ${n} из 6 — GPT Image 2`],
      { stdio: 'inherit' });
    results.push({ page: n, file });
  } catch (e) {
    console.error(`Страница ${n} не вышла: ${e.message}`);
    results.push({ page: n, file: null });
  }
}
fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(results, null, 2));
const ok = results.filter(r => r.file).length;
console.log(`\nИтог: ${ok} из ${pages.length} страниц готовы и отправлены.`);
process.exit(ok === pages.length ? 0 : 1);
