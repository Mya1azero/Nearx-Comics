/**
 * Галерея всех генераций одним HTML-файлом (открывается двойным кликом).
 *
 * Зачем: выбирать креатив, тыкая по папкам в терминале, невозможно — нужно видеть
 * все варианты рядом и сразу знать, какая модель и за сколько это сделала.
 * Данные берутся из журнала, картинки — по относительным путям, никакого сервера.
 */

import fs from "node:fs";
import path from "node:path";

import { PATHS } from "./config.js";
import { readLedger } from "./ledger.js";

const esc = (v) => String(v ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

function card(entry) {
  const src = `out/${entry.file.split(path.sep).join("/")}`;
  const price = entry.usd !== undefined
    ? `${entry.credits} кр · $${Number(entry.usd).toFixed(3)}${entry.priceApproximate ? "≈" : ""}`
    : "";
  return `<figure class="card">
  <a href="${esc(src)}" target="_blank"><img src="${esc(src)}" loading="lazy" alt="${esc(entry.model)}"></a>
  <figcaption>
    <div class="row"><b>${esc(entry.model)}</b><span class="price">${esc(price)}</span></div>
    <div class="meta">${esc(entry.format)} · ${esc(entry.size)} · ${esc(entry.resolution || "")} · ${entry.seconds}s</div>
    <p class="prompt" title="${esc(entry.prompt)}">${esc(entry.prompt)}</p>
    ${entry.text ? `<div class="text">текст: ${esc(entry.text)}</div>` : ""}
  </figcaption>
</figure>`;
}

/** Пересобирает gallery.html по журналу. Возвращает путь и число карточек. */
export function buildGallery({ ledgerPath = PATHS.ledger, outPath = PATHS.gallery } = {}) {
  // Технические прогоны (test: true) в галерею не идут — она нужна для выбора
  // креатива, а не для истории отладки. В расходе бюджета они при этом остаются:
  // кредиты за них списаны по-настоящему.
  const all = readLedger(ledgerPath).reverse();
  const entries = all.filter((e) => e.file && e.test !== true);
  const hidden = all.length - entries.length;
  const totalCredits = entries.reduce((s, e) => s + (Number(e.credits) || 0), 0);
  const totalUsd = entries.reduce((s, e) => s + (Number(e.usd) || 0), 0);
  const models = new Set(entries.map((e) => e.model));

  const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Neo³ Visual — галерея</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; background: #0b0b0d; color: #e8e8ea;
         font: 15px/1.5 -apple-system, "SF Pro Text", Inter, system-ui, sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: baseline; margin-bottom: 24px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.02em; }
  .stats { color: #8a8a92; font-size: 13px; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
  .card { margin: 0; background: #15151a; border: 1px solid #23232b; border-radius: 14px; overflow: hidden;
          transition: border-color .15s, transform .15s; }
  .card:hover { border-color: #3a3a46; transform: translateY(-2px); }
  .card img { display: block; width: 100%; height: auto; background: #000; }
  figcaption { padding: 12px 14px 14px; }
  .row { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
  .row b { font-size: 13px; font-weight: 600; }
  .price { color: #7ee2a8; font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .meta { color: #6e6e78; font-size: 11px; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .prompt { color: #a0a0aa; font-size: 12px; margin: 8px 0 0;
            display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .text { color: #d8d8e0; font-size: 12px; margin-top: 6px; }
  .empty { color: #6e6e78; }
</style></head><body>
<header>
  <h1>Neo³ Visual</h1>
  <span class="stats">${entries.length} генераций · ${models.size} моделей · ${totalCredits.toFixed(1)} кредитов · $${totalUsd.toFixed(2)}${hidden > 0 ? ` · скрыто тестовых: ${hidden}` : ""}</span>
</header>
${entries.length === 0 ? '<p class="empty">Пока пусто. Запусти: <code>vis crea "промпт"</code></p>' : `<div class="grid">${entries.map(card).join("\n")}</div>`}
</body></html>`;

  fs.writeFileSync(outPath, html);
  return { path: outPath, count: entries.length, totalCredits, totalUsd };
}
