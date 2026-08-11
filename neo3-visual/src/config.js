/**
 * Ключ и пути. Ключ НИКОГДА не лежит в коде и не пишется в вывод.
 *
 * Порядок поиска KIE_API_KEY:
 *   1) переменная окружения;
 *   2) файл .env в корне проекта (создаётся установщиком install.sh);
 *   3) файл из переменной NEO3_SECRETS — для тех, у кого ключи лежат в общем
 *      хранилище: читается ТОЛЬКО строка KIE_API_KEY, остальные ключи процессу
 *      не показываются.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LOCAL_ENV = path.join(PROJECT_ROOT, ".env");

/** Значение одной переменной из .env-файла (без загрузки остальных). */
export function readSecret(name, secretsPath) {
  let text;
  try {
    text = fs.readFileSync(secretsPath, "utf8");
  } catch {
    return null;
  }
  const line = text.split("\n").find((l) => l.trimStart().startsWith(`${name}=`));
  if (!line) return null;
  return line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "") || null;
}

/** Ключ kie.ai или понятная ошибка. */
export function requireApiKey() {
  const key = process.env.KIE_API_KEY
    || readSecret("KIE_API_KEY", LOCAL_ENV)
    || (process.env.NEO3_SECRETS ? readSecret("KIE_API_KEY", process.env.NEO3_SECRETS) : null);
  if (!key) {
    throw new Error(
      `Нет KIE_API_KEY. Положи его в ${LOCAL_ENV} строкой KIE_API_KEY=...\n`
        + "Взять ключ: https://kie.ai → API Key. Или запусти ./install.sh — он спросит и запишет сам.",
    );
  }
  return key;
}

export const PATHS = {
  out: path.join(PROJECT_ROOT, "out"),
  fonts: path.join(PROJECT_ROOT, "fonts"),
  ledger: path.join(PROJECT_ROOT, "out", "ledger.jsonl"),
  budget: path.join(PROJECT_ROOT, "budget.json"),
  gallery: path.join(PROJECT_ROOT, "gallery.html"),
};
