/**
 * Комиксы: сценарий → кадры ОДНОЙ моделью → пузыри кодом → сборка страницы.
 *
 * Чем отличается от fanout: там один промпт уходит в N разных моделей (поиск
 * стиля), здесь наоборот — N разных промптов уходят в одну модель, потому что
 * комикс живёт единым стилем, а герой не должен менять лицо от кадра к кадру.
 * Постоянство героя держится на референсе (characters[].ref — картинка героя,
 * загружается один раз и подкладывается в каждый кадр) и общем style-префиксе.
 *
 * Реплики и подписи НЕ отдаются модели: их рисует bubbles.js поверх готовых
 * кадров. Правка текста = пересборка бесплатно (--assemble), перегенерация
 * не нужна.
 */

import fs from "node:fs";
import path from "node:path";

import { KieClient, downloadFile } from "./kie/client.js";
import { loadRegistry } from "./kie/registry.js";
import { loadPricing } from "./kie/pricing.js";
import { PRICED_FIELDS, chooseAspect, parseFormat, tierDefaults } from "./presets.js";
import { estimateCredits, resolveModel, runDir } from "./fanout.js";
import { checkBudget } from "./budget.js";
import { appendLedger, writeSidecar } from "./ledger.js";
import { cropToRatio, familyFromFile, resolveFontFile, textLayer } from "./overlay.js";
import { addBubbles } from "./bubbles.js";
import { PATHS } from "./config.js";

import "./fontconfig.js"; // до sharp
import sharp from "sharp";

/**
 * Модель по умолчанию: nano-banana-2 лучше всех из дешёвых держит персонажа
 * по референсу и одинаково умеет text-to-image и image-to-image — комикс без
 * референса и с референсом идёт одной моделью, стиль не прыгает.
 */
export const DEFAULT_COMIC_MODEL = "nano-banana-2";

const LAYOUTS = new Set(["grid", "strip", "wide", "page"]);
const NN = (i) => String(i + 1).padStart(2, "0");

/** Читает и проверяет сценарий. Ошибки — списком и по-русски: сценарий пишут руками. */
export function loadScenario(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`Не нашёл сценарий "${file}". Шаблон: vis comic --example > сценарий.json`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (exc) {
    throw new Error(`Сценарий ${file} — битый JSON: ${exc.message}`);
  }
  return normalizeScenario(data);
}

export function normalizeScenario(data) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  need(typeof data.title === "string" && data.title.trim(), "title: название комикса обязательно");
  need(typeof data.style === "string" && data.style.trim(),
    'style: общий стиль обязателен (например "цветной комикс, чистые толстые линии, плоские цвета")');

  const layout = data.layout || "grid";
  need(LAYOUTS.has(layout), `layout: неизвестная раскладка "${layout}" (есть: grid, strip, wide)`);

  const characters = Array.isArray(data.characters) ? data.characters : [];
  const names = new Set();
  characters.forEach((c, i) => {
    need(c && typeof c.name === "string" && c.name.trim(), `characters[${i}]: нет name`);
    need(c && typeof c.desc === "string" && c.desc.trim(), `characters[${i}]: нет desc — без описания герой будет разным в каждом кадре`);
    if (c && c.name) names.add(c.name);
  });

  const panels = Array.isArray(data.panels) ? data.panels : [];
  need(panels.length >= 1, "panels: нужен хотя бы один кадр");
  need(panels.length <= 24, `panels: ${panels.length} кадров — слишком много для одной страницы (максимум 24)`);
  panels.forEach((p, i) => {
    need(p && typeof p.scene === "string" && p.scene.trim(), `panels[${i}]: нет scene — что в кадре?`);
    for (const name of p && Array.isArray(p.cast) ? p.cast : []) {
      need(names.has(name), `panels[${i}]: в cast есть "${name}", а в characters такого героя нет`);
    }
    (p && Array.isArray(p.bubbles) ? p.bubbles : []).forEach((b, j) => {
      need(b && typeof b.text === "string" && b.text.trim(), `panels[${i}].bubbles[${j}]: нет text`);
    });
  });

  if (errors.length > 0) {
    throw new Error(`Сценарий не годится:\n  - ${errors.join("\n  - ")}`);
  }

  return {
    title: data.title.trim(),
    showTitle: data.showTitle !== false, // у многостраничных историй титул — только на первой
    style: data.style.trim(),
    format: data.format || "square",
    layout,
    model: data.model || null,
    seed: data.seed ?? null,
    font: data.font || "Balsamiq Sans",
    characters: characters.map((c) => ({ name: c.name.trim(), desc: c.desc.trim(), ref: c.ref || null })),
    panels: panels.map((p) => ({
      scene: p.scene.trim(),
      format: p.format || null, // формат кадра, если отличается от общего (герой-кадр wide и т.п.)
      cast: Array.isArray(p.cast) ? p.cast : null, // null = все герои сценария
      caption: p.caption || null,
      captionAt: p.captionAt || "top-left",
      captionFill: p.captionFill || null,
      bubbles: Array.isArray(p.bubbles) ? p.bubbles : [],
    })),
  };
}

/** Герои кадра: явный cast или все герои сценария. */
const castOf = (scenario, panel) => (panel.cast
  ? scenario.characters.filter((c) => panel.cast.includes(c.name))
  : scenario.characters);

/**
 * Промпт кадра: стиль серии + сцена + описания героев кадра + запрет текста.
 * Запрет обязателен: иначе модель сама рисует кривые пузыри с выдуманными
 * буквами, а поверх них лягут наши — будет каша.
 */
function panelPrompt(scenario, panel) {
  const cast = castOf(scenario, panel)
    .map((c) => `${c.name} — ${c.desc}`)
    .join("; ");
  return `${scenario.style}. Сцена: ${panel.scene}.`
    + (cast ? ` Герои: ${cast}.` : "")
    + " Один кадр комикса, единый стиль серии, без текста, без надписей, без речевых пузырей в кадре.";
}

/**
 * План комикса: одна модель, кадр за кадром, цена = цена модели × число кадров.
 * Сеть трогает только каталог, прайс и документацию — кредиты не списываются.
 */
export async function buildComicPlan(scenario, {
  model = null,
  tier = "cheap",
  resolution = null,
  refresh = false,
  onWarning = () => {},
} = {}) {
  const fmt = parseFormat(scenario.format);
  const modelId = model || scenario.model || DEFAULT_COMIC_MODEL;
  const res = resolution || (tier === "quality" ? "2K" : "1K");

  const refs = scenario.characters.filter((c) => c.ref);
  for (const c of refs) {
    if (!/^https?:\/\//.test(c.ref) && !fs.existsSync(c.ref)) {
      throw new Error(`Референс героя "${c.name}" не найден: ${c.ref}`);
    }
  }

  const [registry, pricing] = await Promise.all([
    loadRegistry({ allowFetch: true, refresh, onWarning }),
    loadPricing({ allowFetch: true, refresh, onWarning }),
  ]);

  const resolved = await resolveModel(modelId, registry, { refresh });
  const { model: meta, fields } = resolved;
  if (refs.length > 0 && !meta.image_field) {
    throw new Error(resolved.schemaSource
      ? `Модель ${modelId} не принимает референсы героев. Возьми i2i-модель: vis models --search image`
      : `Не удалось прочитать схему ${modelId} (документация не ответила) — повтори с --refresh`);
  }

  const { values, priceHints } = tierDefaults(fields, { tier, resolution: res });

  // Один seed на все кадры (если модель его умеет): ещё один якорь стиля серии.
  const hasSeed = (fields || []).some((f) => f.name === "seed");
  const seed = hasSeed && scenario.seed !== null ? { seed: scenario.seed } : {};

  const hints = PRICED_FIELDS.map((f) => (values[f] !== undefined ? String(values[f]) : null)).filter(Boolean);
  const price = estimateCredits(pricing.records, modelId, hints.length > 0 ? hints : priceHints);
  if (!price) throw new Error(`Не удалось определить цену ${modelId} — запуск без цены запрещён.`);

  // У кадров может быть свой формат (в журнальной вёрстке герой-кадр — wide,
  // середина — square), поэтому соотношение подбирается на каждый кадр.
  const items = scenario.panels.map((panel, index) => {
    const panelFmt = panel.format ? parseFormat(panel.format) : fmt;
    const aspect = chooseAspect(fields, panelFmt.ratio);
    return {
      index,
      prompt: panelPrompt(scenario, panel),
      format: panelFmt,
      aspect,
      input: {
        [meta.prompt_field || "prompt"]: panelPrompt(scenario, panel),
        ...values,
        ...(meta.defaults || {}),
        ...(aspect ? { [aspect.field]: aspect.value } : {}),
        ...seed,
      },
      cast: castOf(scenario, panel),
    };
  });

  return {
    scenario,
    modelId,
    api: meta.api || "jobs",
    imageField: meta.image_field || null,
    imageList: Boolean(meta.image_list),
    required: meta.required || [],
    format: fmt,
    tier,
    resolution: res,
    price,
    refs,
    items,
    totalCredits: Math.round(price.credits * items.length * 100) / 100,
  };
}

/** Ждёт завершения задачи (свой поллер, чтобы не лезть в приватности fanout). */
async function poll(client, api, taskId, timeoutSec, intervalSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const status = await client.status(api, taskId);
    if (status.state !== "pending") return status;
    if (Date.now() > deadline) throw new Error(`таймаут ${timeoutSec}с (taskId ${taskId}) — задача ещё в работе`);
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

/**
 * Исполнение плана. ВНИМАНИЕ: тратит кредиты (kie.ai списывает при создании
 * задачи). Кадры идут параллельно; упавшие не откатывают остальных — страница
 * соберётся с заглушками, недостающее добирается через vis fetch + --assemble.
 */
export async function runComic(plan, {
  apiKey,
  stamp,
  maxUsd = null,
  timeout = 420,
  interval = 5,
  outRoot = PATHS.out,
  onEvent = () => {},
} = {}) {
  const { scenario } = plan;
  const client = new KieClient(apiKey);

  let balance = null;
  try {
    const credits = await client.credits();
    balance = typeof credits === "number" ? credits : credits && credits.credits;
  } catch {
    onEvent({ type: "warn", message: "не удалось прочитать баланс — проверка доли баланса пропущена" });
  }

  const verdict = checkBudget({
    plannedCredits: plan.totalCredits,
    balanceCredits: balance ?? null,
    overrideUsd: maxUsd,
  });
  for (const w of verdict.warnings) onEvent({ type: "warn", message: w });
  if (!verdict.ok) {
    const error = new Error(`Запуск заблокирован предохранителем:\n  - ${verdict.blockers.join("\n  - ")}`);
    error.budget = verdict;
    throw error;
  }

  const dir = runDir(scenario.title, stamp, outRoot);
  fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
  fs.mkdirSync(path.join(dir, "panels"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scenario.json"), JSON.stringify(scenario, null, 2));

  // Референсы героев загружаются ОДИН раз на весь комикс. Один файл может
  // быть референсом нескольких героев (пара на общем листе) — грузим по пути.
  const refUrl = new Map();
  const uploaded = new Map();
  for (const c of plan.refs) {
    if (/^https?:\/\//.test(c.ref)) refUrl.set(c.name, c.ref);
    else {
      const abs = path.resolve(c.ref);
      if (!uploaded.has(abs)) {
        onEvent({ type: "upload", file: c.ref });
        uploaded.set(abs, await client.upload(abs));
      }
      refUrl.set(c.name, uploaded.get(abs));
    }
  }

  let charged = 0;
  const tasks = plan.items.map((item) => async () => {
    const started = Date.now();
    const tag = NN(item.index);
    const input = { ...item.input };

    // один файл может быть референсом сразу двух героев (пара на общем листе) —
    // дубли ссылок не шлём
    const urls = [...new Set(item.cast.map((c) => refUrl.get(c.name)).filter(Boolean))];
    if (urls.length > 0 && plan.imageField) {
      input[plan.imageField] = plan.imageList ? urls : urls[0];
    }
    const missing = (plan.required || []).filter((f) => input[f] === undefined);
    if (missing.length > 0) throw new Error(`не заполнены обязательные поля: ${missing.join(", ")}`);

    onEvent({ type: "start", panel: item.index + 1, credits: plan.price.credits });
    const taskId = await client.create(plan.api, plan.modelId, input);

    // Кредиты списаны в момент создания — пишем расход сразу (см. fanout.js).
    appendLedger({
      at: new Date().toISOString(),
      state: "created",
      model: plan.modelId,
      api: plan.api,
      credits: plan.price.credits,
      usd: plan.price.usd,
      taskId,
      prompt: item.prompt,
      comic: scenario.title,
      panel: item.index + 1,
    });
    charged += plan.price.credits;

    const status = await poll(client, plan.api, taskId, timeout, interval);
    if (status.state !== "success" || status.urls.length === 0) {
      throw new Error(status.fail_msg || "генерация не удалась (пустой результат)");
    }

    const ext = (status.urls[0].split("?")[0].match(/\.(png|jpe?g|webp)$/i) || [".png"])[0];
    const rawPath = path.join(dir, "raw", `${tag}${ext.startsWith(".") ? ext : `.${ext}`}`);
    await downloadFile(status.urls[0], rawPath);

    const panelPath = path.join(dir, "panels", `${tag}.jpg`);
    const cropped = await cropToRatio(rawPath, panelPath, item.format.ratio);

    const entry = {
      at: new Date().toISOString(),
      state: "done",
      file: path.relative(outRoot, panelPath),
      model: plan.modelId,
      api: plan.api,
      prompt: item.prompt,
      input,
      comic: scenario.title,
      panel: item.index + 1,
      format: item.format.name,
      ratio: Number(item.format.ratio.toFixed(4)),
      size: `${cropped.width}x${cropped.height}`,
      cropped: cropped.cropped,
      requestedAspect: item.aspect ? item.aspect.value : null,
      resolution: plan.resolution,
      credits: plan.price.credits,
      usd: plan.price.usd,
      priceApproximate: plan.price.approximate,
      taskId,
      seconds: Math.round((Date.now() - started) / 1000),
      sourceUrl: status.urls[0],
    };
    writeSidecar(panelPath, entry);
    appendLedger(entry);
    onEvent({ type: "done", panel: item.index + 1, file: panelPath, seconds: entry.seconds });
    return entry;
  });

  const settled = await Promise.allSettled(tasks.map((t) => t()));
  const results = [];
  const failures = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") results.push(r.value);
    else {
      failures.push({ panel: i + 1, error: r.reason.message });
      onEvent({ type: "fail", panel: i + 1, message: r.reason.message });
    }
  });

  // Сборка идёт даже с дырами: заглушки покажут, чего не хватает,
  // а добрать кадр можно бесплатно: vis fetch <taskId> → vis comic ... --assemble
  const assembled = await assembleComic(scenario, dir, { onEvent });

  if (results.length > 0) {
    appendLedger({
      at: new Date().toISOString(),
      state: "done",
      file: path.relative(outRoot, assembled.page),
      model: "сборка страницы",
      prompt: scenario.title,
      comic: scenario.title,
      format: scenario.layout,
      size: assembled.size,
      credits: 0,
      usd: 0,
      seconds: 0,
    });
  }

  return { dir, page: assembled.page, results, failures, charged, budget: verdict, balanceBefore: balance };
}

/** Заглушка вместо несгенерированного кадра — страница собирается всегда. */
async function placeholderPanel(dest, w, h, label, font) {
  const fontFile = resolveFontFile(font);
  const text = await textLayer([label], {
    family: fontFile ? familyFromFile(fontFile) : font,
    fontFile,
    weight: "Regular",
    color: "#90a4ae",
    boxWidth: Math.round(w * 0.7),
    boxHeight: Math.round(h * 0.12),
  });
  await sharp({ create: { width: w, height: h, channels: 3, background: "#eceff1" } })
    .composite([{ input: text.buffer, left: Math.round((w - text.width) / 2), top: Math.round((h - text.height) / 2) }])
    .jpeg({ quality: 90 })
    .toFile(dest);
}

/**
 * Сборка без генерации: панели уже лежат в dir/panels/, поверх — пузыри по
 * СВЕЖЕМУ сценарию, потом страница. Кредитов не тратит: править реплики,
 * якоря и раскладку можно сколько угодно.
 */
export async function assembleComic(scenario, dir, { onEvent = () => {} } = {}) {
  if (!fs.existsSync(path.join(dir, "panels"))) {
    throw new Error(`В ${dir} нет папки panels/ — это не папка комикса (нужна папка из out/, созданная vis comic).`);
  }
  fs.mkdirSync(path.join(dir, "bubbled"), { recursive: true });

  const bubbledPaths = [];
  const missing = [];
  for (let i = 0; i < scenario.panels.length; i++) {
    const panel = scenario.panels[i];
    const src = path.join(dir, "panels", `${NN(i)}.jpg`);
    const dest = path.join(dir, "bubbled", `${NN(i)}.jpg`);

    if (!fs.existsSync(src)) {
      const ratio = parseFormat(panel.format || scenario.format).ratio;
      await placeholderPanel(dest, 900, Math.round(900 / ratio), `кадр ${i + 1} не сгенерирован`, scenario.font);
      missing.push(i + 1);
      bubbledPaths.push(dest);
      continue;
    }

    const list = [...panel.bubbles];
    if (panel.caption) {
      list.push({
        type: "caption",
        text: panel.caption,
        at: panel.captionAt,
        ...(panel.captionFill ? { fill: panel.captionFill } : {}),
      });
    }
    await addBubbles(src, dest, list, { font: scenario.font });
    onEvent({ type: "bubbled", panel: i + 1, count: list.length });
    bubbledPaths.push(dest);
  }

  const page = path.join(dir, "page.jpg");
  const size = await composePage(bubbledPaths, {
    layout: scenario.layout,
    title: scenario.showTitle ? scenario.title : null,
    outPath: page,
  });

  return { page, size: `${size.width}x${size.height}`, count: bubbledPaths.length, missing };
}

/**
 * Собирает кадры в страницу: белые поля, чёрные рамки, заголовок Unbounded.
 *
 * Раскладки: grid — 2 колонки; strip — лента в 1 колонку (Telegram);
 * wide — все кадры в ряд; page — журнальная вёрстка, как в настоящих
 * комиксах: широкий кадр-крючок сверху, середина рядами по 2–3, широкий
 * финал внизу. Размер каждой ячейки берётся из реального соотношения кадра,
 * поэтому в одной странице живут кадры разных форматов; высота ряда — по
 * самому высокому кадру ряда, остальные докрываются кропом.
 */
export async function composePage(panelPaths, { layout = "grid", title = null, outPath }) {
  const n = panelPaths.length;
  const base = { strip: 1080, grid: 1024, page: 1360, wide: 840 }[layout] || 1024;
  const gutter = Math.round(base * 0.04);
  const margin = Math.round(base * 0.055);
  const frame = Math.max(4, Math.round(base * 0.006));

  const contentW = layout === "grid" ? base * 2 + gutter
    : layout === "wide" ? base * n + gutter * (n - 1)
      : base; // strip и page

  // Разбивка кадров на ряды.
  let rows;
  if (layout === "strip") rows = panelPaths.map((_, i) => [i]);
  else if (layout === "wide") rows = [panelPaths.map((_, i) => i)];
  else if (layout === "page" && n >= 3) {
    const middle = Array.from({ length: n - 2 }, (_, i) => i + 1);
    rows = [[0]];
    for (let i = 0; i < middle.length;) {
      const take = middle.length - i === 3 ? 3 : Math.min(2, middle.length - i);
      rows.push(middle.slice(i, i + take));
      i += take;
    }
    rows.push([n - 1]);
  } else {
    rows = Array.from({ length: Math.ceil(n / 2) }, (_, r) => [r * 2, r * 2 + 1].filter((i) => i < n));
  }

  const metas = await Promise.all(panelPaths.map((p) => sharp(p, { failOn: "none" }).metadata()));
  const ratioAt = (i) => (metas[i].width && metas[i].height ? metas[i].width / metas[i].height : 1);

  let header = null;
  if (title) {
    const fontFile = resolveFontFile("Unbounded");
    header = await textLayer([title.toUpperCase()], {
      family: fontFile ? familyFromFile(fontFile) : "Unbounded",
      fontFile,
      weight: "Bold",
      color: "#111111",
      boxWidth: contentW,
      boxHeight: Math.round(base * 0.07),
    });
  }
  const headerH = header ? header.height + gutter : 0;
  const pageW = margin * 2 + contentW;

  const layers = [];
  let framesSvg = "";
  let y = margin + headerH;
  for (const row of rows) {
    const cellW = Math.round((contentW - gutter * (row.length - 1)) / row.length);
    const rowH = Math.round(Math.max(...row.map((i) => cellW / ratioAt(i))));
    let x = margin;
    for (const i of row) {
      layers.push({
        input: await sharp(panelPaths[i], { failOn: "none" })
          .resize(cellW, rowH, { fit: "cover" })
          .toBuffer(),
        left: x,
        top: y,
      });
      framesSvg += `<rect x="${x - frame / 2}" y="${y - frame / 2}" width="${cellW + frame}" height="${rowH + frame}" fill="none" stroke="#111" stroke-width="${frame}"/>`;
      x += cellW + gutter;
    }
    y += rowH + gutter;
  }
  const pageH = y - gutter + margin;

  if (header) {
    layers.unshift({ input: header.buffer, left: Math.round((pageW - header.width) / 2), top: margin });
  }
  layers.push({
    input: Buffer.from(`<svg width="${pageW}" height="${pageH}" xmlns="http://www.w3.org/2000/svg">${framesSvg}</svg>`),
    left: 0,
    top: 0,
  });

  await sharp({ create: { width: pageW, height: pageH, channels: 3, background: "#ffffff" } })
    .composite(layers)
    .jpeg({ quality: 92 })
    .toFile(outPath);

  return { width: pageW, height: pageH };
}

/** Шаблон сценария для vis comic --example (заодно — живая документация формата). */
export function comicExample() {
  return JSON.stringify({
    title: "Кот и дедлайн",
    style: "цветной комикс, чистые толстые контуры, плоские цвета, мягкий дневной свет",
    format: "square",
    layout: "grid",
    seed: 7,
    characters: [
      { name: "Кот", desc: "упитанный рыжий кот в синем галстуке, выразительные глаза", ref: null },
    ],
    panels: [
      {
        scene: "Кот сидит за столом с ноутбуком, вокруг разбросаны бумаги",
        caption: "Понедельник, 9:00",
        bubbles: [{ who: "Кот", text: "Успею. Времени вагон.", at: "top-right", tail: "down-left" }],
      },
      {
        scene: "Кот спит на клавиатуре ноутбука, на экране мигает курсор",
        caption: "13:00",
        bubbles: [{ who: "Кот", text: "хррр", type: "thought", at: "top-left", tail: "down-right" }],
      },
      {
        scene: "Кот в панике бежит по офису, бумаги летят во все стороны",
        caption: "17:45",
        bubbles: [{ who: "Кот", text: "ДЕДЛАЙН!", type: "shout", at: "top", tail: "down" }],
      },
      {
        scene: "Кот довольный лежит в кресле, ноутбук закрыт, за окном ночь",
        bubbles: [{ who: "Кот", text: "Как всегда — в последнюю минуту.", at: "top-left", tail: "down-right" }],
      },
    ],
  }, null, 2);
}
