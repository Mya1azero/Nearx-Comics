#!/usr/bin/env node
/**
 * vis — генерация рекламных креативов через kie.ai.
 *
 * Главная команда — `crea`: один промпт → N вариантов от разных моделей,
 * текст поверх накладывается кодом, стоимость известна до запуска.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CASCADE_ORDER, KieClient, TaskNotFound, downloadFile } from "../src/kie/client.js";
import { loadRegistry } from "../src/kie/registry.js";
import { loadPricing } from "../src/kie/pricing.js";
import { PATHS, requireApiKey } from "../src/config.js";
import { checkBudget, loadBudget } from "../src/budget.js";
import { FORMATS, parseFormat } from "../src/presets.js";
import { ROSTERS, buildPlan, estimateCredits, runFanout } from "../src/fanout.js";
import { assembleComic, buildComicPlan, comicExample, loadScenario, runComic } from "../src/comic.js";
import { buildGallery } from "../src/gallery.js";
import { appendLedger, readLedger, spentCredits, writeSidecar } from "../src/ledger.js";
import { cropToRatio, overlayText } from "../src/overlay.js";

const BOOLEANS = new Set(["--dry-run", "--refresh", "--json", "--no-scrim", "--help", "-h", "--example"]);
const REPEATED = new Set(["--ref", "--set", "--text", "--subtext"]);

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (BOOLEANS.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`У флага ${name} нет значения.`);
    if (REPEATED.has(name)) (flags[name] ||= []).push(value);
    else flags[name] = value;
  }
  return { flags, positionals };
}

/** --set ключ=значение → объект. Значение парсится как JSON, иначе строка. */
function parseSets(pairs = []) {
  const result = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) throw new Error(`--set ждёт ключ=значение, получено "${pair}"`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    try {
      result[key] = JSON.parse(raw);
    } catch {
      result[key] = raw;
    }
  }
  return result;
}

const HELP = `vis — рекламные креативы через kie.ai

  vis crea "промпт" [флаги]        главное: N вариантов от разных моделей
  vis comic сценарий.json [флаги]  комикс: кадры одной моделью + пузыри кодом + страница
  vis text ФАЙЛ --text "..."       переналожить текст на готовый кадр (0 кредитов)
  vis credits                      баланс на kie.ai
  vis spent                        сколько потрачено из бюджета проекта
  vis reconcile [--dry-run]        сверить журнал с реальным балансом kie.ai
  vis fetch TASK_ID                забрать результат уже оплаченной задачи (после обрыва связи)
  vis models [--search X]          живой каталог моделей картинок
  vis price МОДЕЛЬ [--resolution]  цена модели в кредитах и $
  vis gallery                      пересобрать gallery.html
  vis font "Family"                скачать шрифт Google Fonts в fonts/

Флаги crea:
  --models auto:6 | id,id   какие модели (по умолчанию auto:6 из тира)
  --tier cheap|quality      тир: 1K дёшево / максимальное качество
  --format post             ${Object.keys(FORMATS).join(", ")} или "W:H"
  --ref ФАЙЛ                референс (логотип, фото товара); можно несколько
  --text "СТРОКА | СТРОКА"  заголовок; | или \\n — перенос строки
  --subtext "уточнение"     вторая строка помельче под заголовком
  --font Unbounded          шрифт надписи (файл из fonts/ или системный)
  --position bottom         top | center | bottom
  --resolution 1K|2K|4K     переопределить разрешение тира
  --max-usd 0.50            поднять лимит одного запуска
  --set ключ=значение       любое поле модели напрямую
  --dry-run                 показать план и цену, НИЧЕГО не отправлять
  --json                    машинный вывод

Флаги comic:
  --example                 напечатать шаблон сценария (vis comic --example > сценарий.json)
  --dry-run                 план и цена комикса, ничего не отправлять
  --assemble ПАПКА          пересобрать пузыри и страницу по свежему сценарию (0 кредитов)
  --model id                модель (по умолчанию nano-banana-2 — держит героя по референсу)
  --tier cheap|quality      1K дёшево / 2K дорого
  --layout page|grid|strip|wide  журнальная вёрстка / 2 колонки / лента / один ряд

Примеры:
  vis crea "банка энергетика на бетоне, драматичный свет" --format post --dry-run
  vis crea "очки на подиуме, студийный свет" --ref ./logo.png --format 4:5 \\
      --text "СКОРОСТЬ|В КАЖДОМ ГЛОТКЕ" --font Unbounded
`;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

async function cmdCredits(flags) {
  const client = new KieClient(requireApiKey());
  const data = await client.credits();
  const credits = typeof data === "number" ? data : data && data.credits;
  if (flags["--json"]) console.log(JSON.stringify({ credits, usd: credits * 0.005 }, null, 2));
  else console.log(`Баланс: ${credits} кредитов ≈ $${(credits * 0.005).toFixed(2)}`);
}

function cmdSpent(flags) {
  const budget = loadBudget();
  const spent = spentCredits();
  const remaining = budget.totalCreditsCap - spent;
  if (flags["--json"]) {
    console.log(JSON.stringify({ spent, cap: budget.totalCreditsCap, remaining }, null, 2));
    return;
  }
  console.log(`Потрачено: ${spent} кр из ${budget.totalCreditsCap} (осталось ${Math.round(remaining * 100) / 100} кр ≈ $${(remaining * 0.005).toFixed(2)})`);
  console.log(`Лимит одного запуска: $${budget.perRunUsdCap} · правится в budget.json`);
}

/**
 * Сверяет журнал с реальным балансом kie.ai и дописывает поправку.
 *
 * Журнал может недосчитать: упавшая генерация всё равно списывает кредиты,
 * а сеть могла оборваться до записи. Точная истина — баланс на стороне kie.ai,
 * поэтому расхождение фиксируем отдельной записью, а не подгоняем цифры.
 */
async function cmdReconcile(flags) {
  const budget = loadBudget();
  if (!budget.startingBalance) {
    fail("В budget.json нет startingBalance — не с чем сверять. Впиши баланс на старте проекта.");
  }
  const client = new KieClient(requireApiKey());
  const data = await client.credits();
  const balance = typeof data === "number" ? data : data && data.credits;
  const real = Math.round((budget.startingBalance - balance) * 100) / 100;
  const logged = spentCredits();
  const delta = Math.round((real - logged) * 100) / 100;

  console.log(`Баланс сейчас:   ${balance} кр`);
  console.log(`Списано реально: ${real} кр (со старта ${budget.startingBalance})`);
  console.log(`В журнале:       ${logged} кр`);
  if (Math.abs(delta) < 0.01) {
    console.log("Расхождений нет.");
    return;
  }
  console.log(`Расхождение:     ${delta > 0 ? "+" : ""}${delta} кр`);
  if (flags["--dry-run"]) {
    console.log("--dry-run: поправка не записана.");
    return;
  }
  appendLedger({
    at: new Date().toISOString(),
    state: "reconciliation",
    model: "—",
    credits: delta,
    usd: Math.round(delta * budget.usdPerCredit * 1000) / 1000,
    note: "поправка по сверке с балансом kie.ai (упавшие генерации и обрывы сети)",
  });
  console.log(`Поправка ${delta} кр записана в журнал. Теперь потрачено: ${spentCredits()} кр`);
}

/**
 * Достаёт результат уже созданной (и, значит, оплаченной) задачи по её taskId.
 *
 * Нужно, когда генерация прошла, а мы потеряли ответ из-за обрыва связи: платить
 * второй раз за ту же картинку глупо, ссылки на результат живут ~24 часа.
 * Тип API определяется перебором — по taskId он не виден.
 */
async function cmdFetch(flags, positionals) {
  const taskId = positionals[0];
  if (!taskId) fail("Укажи taskId: vis fetch <taskId> (посмотреть можно в out/ledger.jsonl)");
  const client = new KieClient(requireApiKey());

  let status = null;
  for (const api of CASCADE_ORDER) {
    try {
      status = await client.status(api, taskId);
      break;
    } catch (exc) {
      if (!(exc instanceof TaskNotFound)) throw exc;
    }
  }
  if (!status) fail(`Задача ${taskId} не найдена ни в одном API kie.ai — возможно, ей больше 24 часов.`);
  if (status.state !== "success" || status.urls.length === 0) {
    fail(`Задача ${taskId}: состояние "${status.state}"${status.fail_msg ? ` (${status.fail_msg})` : ""} — забирать нечего.`);
  }

  const known = readLedger().find((e) => e.taskId === taskId) || {};
  const dir = flags["--out"] || path.join(PATHS.out, `recovered_${stamp()}`);
  fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
  const tag = `${(known.model || "task").replace(/[^a-z0-9]+/gi, "-")}_${taskId.slice(0, 8)}`;
  const raw = path.join(dir, "raw", `${tag}.jpg`);
  await downloadFile(status.urls[0], raw);

  const final = path.join(dir, `${tag}.jpg`);
  const fmt = parseFormat(flags["--format"] || known.format || "square");
  const cropped = await cropToRatio(raw, final, fmt.ratio);
  const applied = await overlayText(final, final, {
    text: flags["--text"] || known.text || null,
    subtext: flags["--subtext"] || known.subtext || null,
    font: flags["--font"] || known.font || "Helvetica",
    position: flags["--position"] || "bottom",
  });

  const entry = {
    ...known,
    at: new Date().toISOString(),
    state: "done",
    file: path.relative(PATHS.out, final),
    taskId,
    format: fmt.name,
    ratio: Number(fmt.ratio.toFixed(4)),
    size: `${cropped.width}x${cropped.height}`,
    text: applied.text,
    subtext: applied.subtext,
    font: applied.font,
    sourceUrl: status.urls[0],
    note: "результат забран командой vis fetch после обрыва связи",
  };
  writeSidecar(final, entry);
  appendLedger(entry);
  buildGallery();
  console.log(`Забрано: ${final} (${cropped.width}x${cropped.height})`);
  console.log("Повторно не оплачивалось — задача уже была списана. Галерея обновлена.");
}

async function cmdModels(flags) {
  const registry = await loadRegistry({ refresh: Boolean(flags["--refresh"]), allowFetch: true });
  const search = (flags["--search"] || "").toLowerCase();
  const rows = [...registry.models.entries()]
    .filter(([, m]) => m.category === "image")
    .filter(([id, m]) => !search || id.toLowerCase().includes(search) || (m.description || "").toLowerCase().includes(search))
    .map(([id, m]) => ({ id, stale: Boolean(m.stale), description: m.description || "" }));
  if (flags["--json"]) {
    console.log(JSON.stringify({ source: registry.source, count: rows.length, models: rows }, null, 2));
    return;
  }
  console.log(`Каталог: ${registry.source}, моделей картинок: ${rows.length}`);
  for (const r of rows) console.log(`  ${r.stale ? "[stale] " : ""}${r.id}`);
}

async function cmdPrice(flags, positionals) {
  const modelId = positionals[0];
  if (!modelId) fail("Укажи модель: vis price gpt-image-2-text-to-image");
  const pricing = await loadPricing({ refresh: Boolean(flags["--refresh"]), allowFetch: true });
  const price = estimateCredits(pricing.records, modelId, flags["--resolution"] ? [flags["--resolution"]] : []);
  if (!price) fail(`Цена для "${modelId}" не найдена в прайсе kie.ai.`);
  if (flags["--json"]) {
    console.log(JSON.stringify({ model: modelId, ...price }, null, 2));
    return;
  }
  console.log(`${modelId}: ${price.credits} кр ≈ $${price.usd.toFixed(3)} за ${price.unit || "генерацию"}`
    + `${price.approximate ? " (оценка по описанию — точного id в прайсе нет)" : ""}`);
  console.log(`  тариф: ${price.description}`);
}

function printPlan(plan) {
  console.log(`Промпт: ${plan.prompt}`);
  console.log(`Формат: ${plan.format.name} (${plan.format.ratio.toFixed(3)}) · тир ${plan.tier} · ${plan.resolution} · режим ${plan.mode}`);
  if (plan.refs.length) console.log(`Референсы: ${plan.refs.join(", ")}`);
  console.log("");
  for (const item of plan.items) {
    const aspect = item.aspect
      ? `${item.aspect.field}=${item.aspect.value}${item.aspect.exact ? "" : " → дорежем"}`
      : "формат не задаётся, дорежем после";
    console.log(`  ${item.modelId}`);
    console.log(`      ${item.price.credits} кр ≈ $${item.price.usd.toFixed(3)}${item.price.approximate ? " (оценка)" : ""} · ${aspect}`);
  }
  for (const s of plan.skipped) console.log(`  пропущена ${s.modelId}: ${s.reason}`);
  console.log("");
  console.log(`ИТОГО: ${plan.items.length} шт · ${plan.totalCredits} кр ≈ $${(plan.totalCredits * 0.005).toFixed(3)}`);
}

async function cmdCrea(flags, positionals) {
  const prompt = positionals.join(" ").trim();
  if (!prompt) fail('Укажи промпт: vis crea "банка энергетика на бетоне"');

  const modelsFlag = flags["--models"] || "auto:6";
  let models = null;
  let count = 6;
  if (/^auto:(\d+)$/.test(modelsFlag)) count = Number(RegExp.$1);
  else models = modelsFlag.split(",").map((s) => s.trim()).filter(Boolean);

  const plan = await buildPlan({
    prompt,
    refs: flags["--ref"] || [],
    format: flags["--format"] || "square",
    models,
    count,
    tier: flags["--tier"] || "cheap",
    resolution: flags["--resolution"] || null,
    sets: parseSets(flags["--set"]),
    refresh: Boolean(flags["--refresh"]),
    onWarning: (m) => console.error(`  ! ${m}`),
  });

  if (plan.items.length === 0) fail("Ни одной пригодной модели в плане — смотри причины выше.");

  if (flags["--dry-run"]) {
    const verdict = checkBudget({ plannedCredits: plan.totalCredits, overrideUsd: flags["--max-usd"] ?? null });
    if (flags["--json"]) {
      console.log(JSON.stringify({ plan, budget: verdict }, null, 2));
      return;
    }
    printPlan(plan);
    console.log(`Бюджет: потрачено ${verdict.spent} кр, осталось ${verdict.remaining} кр из ${verdict.budget.totalCreditsCap}`);
    for (const w of verdict.warnings) console.log(`  ! ${w}`);
    if (!verdict.ok) console.log(`  СТОП: ${verdict.blockers.join("; ")}`);
    console.log("--dry-run: ничего не отправлено, кредиты не списаны.");
    return;
  }

  if (!flags["--json"]) printPlan(plan);

  const result = await runFanout(plan, {
    apiKey: requireApiKey(),
    stamp: stamp(),
    text: flags["--text"] || null,
    subtext: flags["--subtext"] || null,
    font: flags["--font"] || "Helvetica",
    textPosition: flags["--position"] || "bottom",
    maxUsd: flags["--max-usd"] ?? null,
    timeout: Number(flags["--timeout"] ?? 420),
    onEvent: (e) => {
      if (flags["--json"]) return;
      if (e.type === "start") console.log(`  → ${e.modelId} (${e.credits} кр)`);
      if (e.type === "done") console.log(`  ✓ ${e.modelId} — ${path.basename(e.file)} (${e.seconds}s)`);
      if (e.type === "fail") console.log(`  ✗ ${e.modelId}: ${e.message}`);
      if (e.type === "upload") console.log(`  ↑ загружаю референс ${e.file}`);
      if (e.type === "warn") console.log(`  ! ${e.message}`);
    },
  });

  const gallery = buildGallery();
  const delivered = result.results.reduce((s, r) => s + r.credits, 0);
  const lost = Math.round((result.charged - delivered) * 100) / 100;

  if (flags["--json"]) {
    console.log(JSON.stringify({ dir: result.dir, results: result.results, failures: result.failures, gallery: gallery.path }, null, 2));
    return;
  }
  console.log("");
  console.log(`Готово: ${result.results.length} из ${plan.items.length} · списано ${result.charged} кр ≈ $${(result.charged * 0.005).toFixed(3)}`);
  if (lost > 0) {
    console.log(`  ВНИМАНИЕ: ${lost} кр списано за задачи, результат которых не дошёл.`);
    console.log("  Задачи созданы и оплачены — картинки можно вытащить: vis fetch <taskId> (ссылки живут ~24ч).");
  }
  console.log(`Папка:   ${result.dir}`);
  console.log(`Галерея: ${gallery.path} (открой в браузере)`);
  if (result.failures.length > 0) console.log(`Не вышло: ${result.failures.map((f) => f.modelId).join(", ")}`);
}

function printComicPlan(plan) {
  console.log(`Комикс: ${plan.scenario.title} · ${plan.items.length} кадров · раскладка ${plan.scenario.layout}`);
  console.log(`Модель: ${plan.modelId} · тир ${plan.tier} · ${plan.resolution} · формат кадра ${plan.format.name}`);
  if (plan.refs.length) console.log(`Референсы героев: ${plan.refs.map((c) => `${c.name} (${c.ref})`).join(", ")}`);
  console.log(`Кадр: ${plan.price.credits} кр ≈ $${plan.price.usd.toFixed(3)}${plan.price.approximate ? " (оценка)" : ""}`);
  console.log("");
  for (const item of plan.items) {
    const p = plan.scenario.panels[item.index];
    const talk = [
      p.format ? item.format.name : null,
      p.caption ? `подпись «${p.caption}»` : null,
      p.bubbles.length ? `реплик: ${p.bubbles.length}` : null,
    ].filter(Boolean).join(" · ");
    console.log(`  ${String(item.index + 1).padStart(2, "0")}. ${p.scene}${talk ? ` (${talk})` : ""}`);
  }
  console.log("");
  console.log(`ИТОГО: ${plan.items.length} кадров · ${plan.totalCredits} кр ≈ $${(plan.totalCredits * 0.005).toFixed(3)} · реплики и сборка бесплатны`);
}

/**
 * Комикс по сценарию. Генерация — деньги; пузыри и страница — бесплатно,
 * поэтому правка текста идёт через --assemble, а не перегенерацией.
 */
async function cmdComic(flags, positionals) {
  if (flags["--example"]) {
    console.log(comicExample());
    return;
  }
  const file = positionals[0];
  if (!file) fail("Укажи сценарий: vis comic сценарий.json (шаблон: vis comic --example > сценарий.json)");
  const scenario = loadScenario(file);
  if (flags["--layout"]) {
    if (!["page", "grid", "strip", "wide"].includes(flags["--layout"])) fail(`--layout: page, grid, strip или wide, не "${flags["--layout"]}"`);
    scenario.layout = flags["--layout"];
  }
  if (flags["--font"]) scenario.font = flags["--font"];

  if (flags["--assemble"]) {
    const result = await assembleComic(scenario, flags["--assemble"], {
      onEvent: (e) => { if (e.type === "bubbled" && !flags["--json"]) console.log(`  ✎ кадр ${e.panel}: слоёв текста ${e.count}`); },
    });
    if (flags["--json"]) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Пересобрано бесплатно: ${result.page} (${result.size})`);
    if (result.missing.length) {
      console.log(`  Нет кадров: ${result.missing.join(", ")} — на странице заглушки.`);
      console.log("  Добрать оплаченный кадр: vis fetch <taskId> (taskId в out/ledger.jsonl), файл положи в panels/NN.jpg и повтори --assemble.");
    }
    return;
  }

  const plan = await buildComicPlan(scenario, {
    model: flags["--model"] || null,
    tier: flags["--tier"] || "cheap",
    resolution: flags["--resolution"] || null,
    refresh: Boolean(flags["--refresh"]),
    onWarning: (m) => console.error(`  ! ${m}`),
  });

  if (flags["--dry-run"]) {
    const verdict = checkBudget({ plannedCredits: plan.totalCredits, overrideUsd: flags["--max-usd"] ?? null });
    if (flags["--json"]) {
      console.log(JSON.stringify({ plan: { ...plan, scenario: plan.scenario.title }, budget: verdict }, null, 2));
      return;
    }
    printComicPlan(plan);
    console.log(`Бюджет: потрачено ${verdict.spent} кр, осталось ${verdict.remaining} кр из ${verdict.budget.totalCreditsCap}`);
    for (const w of verdict.warnings) console.log(`  ! ${w}`);
    if (!verdict.ok) console.log(`  СТОП: ${verdict.blockers.join("; ")}`);
    console.log("--dry-run: ничего не отправлено, кредиты не списаны.");
    return;
  }

  if (!flags["--json"]) printComicPlan(plan);

  const result = await runComic(plan, {
    apiKey: requireApiKey(),
    stamp: stamp(),
    maxUsd: flags["--max-usd"] ?? null,
    timeout: Number(flags["--timeout"] ?? 420),
    onEvent: (e) => {
      if (flags["--json"]) return;
      if (e.type === "start") console.log(`  → кадр ${e.panel} (${e.credits} кр)`);
      if (e.type === "done") console.log(`  ✓ кадр ${e.panel} — ${path.basename(e.file)} (${e.seconds}s)`);
      if (e.type === "fail") console.log(`  ✗ кадр ${e.panel}: ${e.message}`);
      if (e.type === "upload") console.log(`  ↑ загружаю референс ${e.file}`);
      if (e.type === "bubbled") console.log(`  ✎ кадр ${e.panel}: слоёв текста ${e.count}`);
      if (e.type === "warn") console.log(`  ! ${e.message}`);
    },
  });

  const gallery = buildGallery();
  if (flags["--json"]) {
    console.log(JSON.stringify({ dir: result.dir, page: result.page, results: result.results, failures: result.failures }, null, 2));
    return;
  }
  console.log("");
  console.log(`Готово: ${result.results.length} из ${plan.items.length} кадров · списано ${result.charged} кр ≈ $${(result.charged * 0.005).toFixed(3)}`);
  console.log(`Страница: ${result.page}`);
  console.log(`Папка:    ${result.dir} (panels/ — чистые кадры, bubbled/ — с репликами)`);
  console.log(`Галерея:  ${gallery.path}`);
  if (result.failures.length > 0) {
    console.log(`Не вышло: кадры ${result.failures.map((f) => f.panel).join(", ")} — на странице заглушки.`);
    console.log("  Кадр мог быть оплачен: vis reconcile покажет, vis fetch <taskId> вытащит без повторной оплаты.");
  }
  console.log("Править реплики: правь сценарий и запускай с --assemble — это бесплатно.");
}

/** Переналожить текст на готовый файл — не тратит кредиты, можно сколько угодно. */
async function cmdText(flags, positionals) {
  const file = positionals[0];
  if (!file || !fs.existsSync(file)) fail("Укажи существующий файл: vis text out/.../01_model.jpg --text \"...\"");
  const out = flags["--out"] || file.replace(/(\.[^.]+)$/, "-text$1");
  let source = file;
  if (flags["--format"]) {
    const fmt = parseFormat(flags["--format"]);
    const tmp = `${out}.crop.jpg`;
    await cropToRatio(file, tmp, fmt.ratio);
    source = tmp;
  }
  const applied = await overlayText(source, out, {
    text: [flags["--text"]].flat()[0],
    subtext: [flags["--subtext"] || null].flat()[0],
    font: flags["--font"] || "Helvetica",
    position: flags["--position"] || "bottom",
    color: flags["--color"] || "#ffffff",
    scrim: flags["--no-scrim"] ? false : null,
  });
  if (source !== file) fs.rmSync(source, { force: true });
  console.log(`Готово: ${out}${applied.fontFile ? ` (шрифт ${applied.fontFile})` : ` (системный шрифт ${applied.font})`}`);
}

/**
 * Скачивает шрифт из репозитория Google Fonts в fonts/.
 *
 * Не через fonts.googleapis.com: CSS-API отдаёт woff2, а Pango (движок текста
 * в sharp) читает только ttf/otf. В репозитории лежат исходные ttf.
 */
async function cmdFont(flags, positionals) {
  const family = positionals.join(" ").trim();
  if (!family) fail('Укажи семейство: vis font "Unbounded"');
  const slug = family.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = (flags["--weight"] || "bold").toLowerCase();

  let files = null;
  for (const dir of ["ofl", "apache", "ufl"]) {
    const resp = await fetch(`https://api.github.com/repos/google/fonts/contents/${dir}/${slug}`);
    if (!resp.ok) continue;
    const listing = await resp.json();
    if (!Array.isArray(listing)) continue;
    files = listing.filter((f) => /\.(ttf|otf)$/i.test(f.name));
    if (files.length > 0) break;
  }
  if (!files || files.length === 0) {
    fail(`Шрифт "${family}" не найден в репозитории Google Fonts. Положи файл руками в ${PATHS.fonts}/`);
  }

  // приоритет: точное совпадение с запрошенным начертанием → жирные → переменный
  const rank = (name) => {
    const n = name.toLowerCase();
    if (n.includes(wanted)) return 0;
    if (/black|extrabold|bold/.test(n)) return 1;
    if (n.includes("[")) return 2;
    return 3;
  };
  const pick = files.sort((a, b) => rank(a.name) - rank(b.name))[0];
  fs.mkdirSync(PATHS.fonts, { recursive: true });
  const file = path.join(PATHS.fonts, pick.name.replace(/\[.*\]/, "-Variable"));
  const bin = Buffer.from(await (await fetch(pick.download_url)).arrayBuffer());
  fs.writeFileSync(file, bin);

  // Текст в sharp на macOS рисует CoreText, а он ищет шрифты только в системных
  // каталогах — папку проекта не сканирует и опцию fontfile игнорирует.
  // Поэтому ставим копию в ~/Library/Fonts, иначе шрифт молча подменится на
  // системный без единой ошибки в выводе.
  const userFonts = path.join(os.homedir(), "Library", "Fonts");
  let installed = null;
  if (fs.existsSync(path.dirname(userFonts))) {
    fs.mkdirSync(userFonts, { recursive: true });
    installed = path.join(userFonts, path.basename(file));
    fs.copyFileSync(file, installed);
  }

  console.log(`Шрифт сохранён: ${file} (${(bin.length / 1024).toFixed(0)} КБ)`);
  if (installed) console.log(`Установлен в систему: ${installed}`);
  console.log(`Использование: --font ${family.replace(/\s+/g, "")}`);
  console.log("Если первый рендер вышел системным шрифтом — подожди пару секунд, кэш шрифтов macOS обновляется не мгновенно.");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(HELP);
    return;
  }
  const { flags, positionals } = parseArgs(rest);
  if (flags["--help"] || flags["-h"]) {
    console.log(HELP);
    return;
  }
  switch (command) {
    case "credits": return cmdCredits(flags);
    case "spent": return cmdSpent(flags);
    case "reconcile": return cmdReconcile(flags);
    case "fetch": return cmdFetch(flags, positionals);
    case "models": return cmdModels(flags);
    case "price": return cmdPrice(flags, positionals);
    case "crea": return cmdCrea(flags, positionals);
    case "comic": return cmdComic(flags, positionals);
    case "text": return cmdText(flags, positionals);
    case "font": return cmdFont(flags, positionals);
    case "gallery": {
      const g = buildGallery();
      console.log(`Галерея: ${g.path} · ${g.count} генераций · ${g.totalCredits.toFixed(1)} кр ≈ $${g.totalUsd.toFixed(2)}`);
      return;
    }
    case "rosters": {
      for (const [key, list] of Object.entries(ROSTERS)) console.log(`${key}:\n  ${list.join("\n  ")}`);
      return;
    }
    default:
      fail(`Неизвестная команда "${command}". Смотри: vis --help`);
  }
}

main().catch((error) => {
  fail(error.message || String(error));
});
