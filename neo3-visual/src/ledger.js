/**
 * Журнал генераций: паспорт рядом с каждым файлом + общий ledger.jsonl.
 *
 * Зачем паспорт: через месяц глядя на удачный креатив нужно знать, какая модель
 * и какой промпт его сделали, иначе повторить результат невозможно.
 * Зачем общий журнал: по нему считается израсходованный бюджет (см. budget.js)
 * и строится галерея.
 */

import fs from "node:fs";
import path from "node:path";

import { PATHS } from "./config.js";

/** Дописывает запись в общий журнал (jsonl — устойчив к параллельной записи). */
export function appendLedger(entry, ledgerPath = PATHS.ledger) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
  return entry;
}

/** Все записи журнала. Битые строки пропускаются, а не роняют чтение. */
export function readLedger(ledgerPath = PATHS.ledger) {
  let text;
  try {
    text = fs.readFileSync(ledgerPath, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // строка недописана (процесс убили посреди записи) — пропускаем
    }
  }
  return entries;
}

/**
 * Сумма списанных кредитов по журналу.
 *
 * Одна задача пишется в журнал дважды: сразу после создания (кредиты kie.ai
 * списывает именно в этот момент, даже если генерация потом провалится) и после
 * успешного завершения. Поэтому считаем каждый taskId ОДИН раз — иначе расход
 * удвоится, а без первой записи упавшие генерации потерялись бы и предохранитель
 * занижал бы траты.
 */
export function spentCredits(ledgerPath = PATHS.ledger) {
  const byTask = new Map();
  let untracked = 0;
  for (const entry of readLedger(ledgerPath)) {
    const credits = Number(entry.credits) || 0;
    if (entry.taskId) byTask.set(entry.taskId, credits);
    else untracked += credits; // старые записи без taskId
  }
  const total = [...byTask.values()].reduce((sum, c) => sum + c, 0) + untracked;
  // цены дробные (3.5, 5.5, 0.8) — без округления сумма даёт 31.700000000000003
  return Math.round(total * 100) / 100;
}

/** Паспорт рядом с картинкой: file.png → file.json. */
export function writeSidecar(filePath, entry) {
  const sidecar = `${filePath.replace(/\.[^.]+$/, "")}.json`;
  fs.writeFileSync(sidecar, JSON.stringify(entry, null, 2));
  return sidecar;
}
