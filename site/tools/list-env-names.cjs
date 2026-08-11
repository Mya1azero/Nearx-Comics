#!/usr/bin/env node
// Печатает ТОЛЬКО имена переменных из .env WABA (значения не выводятся).
const fs = require('fs');
const candidates = [
  '/home/cloudcli/workspace/WABA_manager/WABA_manager/.env',
  '/home/cloudcli/workspace/WABA_manager/WABA_manager/.env.local',
  '/home/cloudcli/workspace/WABA_manager/.env'
];
for (const f of candidates) {
  try {
    const names = fs.readFileSync(f, 'utf8')
      .split('\n')
      .map(l => (l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/) || [])[1])
      .filter(Boolean);
    console.log(`${f}: ${names.join(', ') || '(пусто)'}`);
  } catch (e) {
    console.log(`${f}: нет (${e.code})`);
  }
}
