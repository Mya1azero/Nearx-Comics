#!/usr/bin/env node
// Переносит ключ OpenRouter из WABA_manager/.env в site/.env, не показывая значение.
const fs = require('fs');
const path = require('path');

const SRC = '/home/cloudcli/workspace/WABA_manager/WABA_manager/.env';
const DST = path.resolve(__dirname, '..', '.env');

try {
  const src = fs.readFileSync(SRC, 'utf8');
  const m = src.match(/^OPENAI_API_KEY\s*=\s*(\S+)\s*$/m);
  if (!m) {
    console.log('НЕ НАЙДЕН: в WABA .env нет OPENAI_API_KEY');
    process.exit(2);
  }
  const key = m[1];
  let dst = '';
  try { dst = fs.readFileSync(DST, 'utf8'); } catch {}
  if (!/^OPENROUTER_API_KEY=/m.test(dst)) {
    dst += (dst && !dst.endsWith('\n') ? '\n' : '') + `OPENROUTER_API_KEY=${key}\n`;
    fs.writeFileSync(DST, dst, { mode: 0o600 });
  }
  console.log(`OK: ключ перенесён (sk-or: ${key.startsWith('sk-or-') ? 'да' : 'нет'}, длина ${key.length})`);
} catch (e) {
  console.log('ОШИБКА: ' + e.message);
  process.exit(1);
}
