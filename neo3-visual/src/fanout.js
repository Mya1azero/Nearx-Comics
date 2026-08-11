/**
 * Fan-out: один промпт → N вариантов от РАЗНЫХ моделей за один запуск.
 *
 * Смысл: на этапе поиска идеи неизвестно, какая модель лучше поймёт именно этот
 * продукт. Дешевле прогнать шесть моделей по 1K (≈32 кредита ≈ $0.16) и выбрать
 * победителя глазами, чем угадывать и переделывать на дорогой.
 *
 * Порядок работы: план (что, сколько стоит) → проверка бюджета → загрузка
 * референсов ОДИН раз на все модели → параллельные задачи → скачивание →
 * обрезка под формат → наложение текста → паспорт + журнал.
 */

import fs from "node:fs";
import path from "node:path";

import { KieClient, downloadFile } from "./kie/client.js";
import { loadRegistry } from "./kie/registry.js";
import { loadModelSchema, mergeModelMeta } from "./kie/schema-cache.js";
import { loadPricing, tokenize } from "./kie/pricing.js";
import { PRICED_FIELDS, chooseAspect, parseFormat, tierDefaults } from "./presets.js";
import { checkBudget } from "./budget.js";
import { appendLedger, writeSidecar } from "./ledger.js";
import { cropToRatio, overlayText } from "./overlay.js";
import { PATHS } from "./config.js";

/**
 * Состав пачки по тирам. Порядок = приоритет: первые N берутся при `--models auto:N`.
 * Отсортировано по «качество за цену» для рекламных креативов, а не просто по цене.
 * Не зашито намертво: список можно переопределить через --models id,id,id.
 */
export const ROSTERS = {
  "cheap:t2i": [
    "gpt-image-2-text-to-image",
    "nano-banana-2",
    "seedream/5-lite-text-to-image",
    "flux-2/pro-text-to-image",
    "ideogram/v3-text-to-image",
    "google/imagen4-fast",
    "qwen3/text-to-image",
    "z-image",
  ],
  "quality:t2i": [
    "gpt-image-2-text-to-image",
    "nano-banana-2",
    "seedream/5-pro-text-to-image",
    "flux-2/flex-text-to-image",
    "google/imagen4-ultra",
    "ideogram/v3-text-to-image",
  ],
  "cheap:i2i": [
    "gpt-image-2-image-to-image",
    "nano-banana-2",
    "google/nano-banana-edit",
    "seedream/5-lite-image-to-image",
    "flux-2/pro-image-to-image",
    "qwen3/image-to-image",
    // ideogram/v3-remix убран: стабильно отдаёт 500 на стороне kie.ai
  ],
  "quality:i2i": [
    "gpt-image-2-image-to-image",
    "nano-banana-pro",
    "seedream/5-pro-image-to-image",
    "flux-2/flex-image-to-image",
    "ideogram/character-remix",
    "qwen3/pro-image-to-image",
  ],
};

const DOC_URL = (id) => `https://docs.kie.ai/market/${id}.md`;

/**
 * Оценка стоимости одной генерации в кредитах.
 *
 * У части моделей в прайсе kie.ai нет машинного id (в ссылке записи нет ?model=),
 * например у nano banana 2 — для них работает нечёткое сопоставление по описанию,
 * и такая цена помечается approximate. Записи «input image» отбрасываются: это
 * тариф за входную картинку, а не за генерацию.
 */
export function estimateCredits(records, modelId, hints = []) {
  const exact = records.filter((r) => r.id === modelId);
  let pool = exact;
  let approximate = false;
  if (pool.length === 0) {
    const tokens = tokenize(modelId);
    if (tokens.length === 0) return null;
    pool = records.filter((r) => {
      const haystack = new Set(tokenize(r.description));
      return tokens.every((t) => haystack.has(t));
    });
    approximate = true;
  }
  if (pool.length === 0) return null;

  const generative = pool.filter((r) => !/\binput\b/i.test(r.description));
  if (generative.length > 0) pool = generative;

  // Сужаем по тем параметрам, от которых зависит тариф (1K/4K, TURBO/QUALITY,
  // basic/ultra). Подсказка применяется только если что-то нашла: в описаниях
  // прайса упомянуты не все параметры.
  for (const hint of [hints].flat().filter(Boolean)) {
    const needle = tokenize(hint).join(" ");
    if (!needle) continue;
    const narrowed = pool.filter((r) => tokenize(r.description).join(" ").includes(needle));
    if (narrowed.length > 0) pool = narrowed;
  }

  // Нечёткое совпадение цепляет соседей по имени: "nano-banana-2" находит и
  // "nano-banana-2-lite". Сначала оставляем записи с наименьшим числом лишних
  // слов в описании, а при равенстве берём ДОРОГУЮ — предохранителю положено
  // переоценивать расход, а не недооценивать его.
  const modelTokens = new Set(tokenize(modelId));
  const extraWords = (r) => tokenize(r.description)
    .filter((t) => !modelTokens.has(t) && /[a-z]/.test(t)).length;
  const minExtra = Math.min(...pool.map(extraWords));
  pool = pool.filter((r) => extraWords(r) === minExtra);

  const best = pool.reduce((max, r) => (r.credits > max.credits ? r : max), pool[0]);
  return {
    credits: best.credits,
    usd: best.usd,
    unit: best.unit,
    description: best.description,
    approximate,
  };
}

/** Метаданные модели: реестр + живая схема с её страницы документации. */
export async function resolveModel(modelId, registry, { refresh = false } = {}) {
  const entry = registry.models.get(modelId);
  const docUrl = (entry && entry.docUrl) || DOC_URL(modelId);
  const schema = await loadModelSchema(docUrl, { refresh });
  const base = entry || { category: "image", api: "jobs", prompt_field: "prompt", dynamic: true };
  return {
    model: mergeModelMeta(base, schema ? schema.meta : null),
    fields: schema ? schema.fields : [],
    schemaSource: schema ? schema.source : null,
    inRegistry: Boolean(entry),
    docUrl,
  };
}

/**
 * План запуска: что отправим, во что это встанет. Сеть трогает только каталог,
 * прайс и страницы документации — кредиты не списываются.
 */
export async function buildPlan({
  prompt,
  refs = [],
  format = "square",
  models = null,
  tier = "cheap",
  count = 6,
  resolution = null,
  sets = {},
  refresh = false,
  onWarning = () => {},
}) {
  if (!prompt || !String(prompt).trim()) throw new Error("Пустой промпт — нечего генерировать.");
  const fmt = parseFormat(format);
  const mode = refs.length > 0 ? "i2i" : "t2i";
  const res = resolution || (tier === "quality" ? "4K" : "1K");

  const [registry, pricing] = await Promise.all([
    loadRegistry({ allowFetch: true, refresh, onWarning }),
    loadPricing({ allowFetch: true, refresh, onWarning }),
  ]);

  const rosterKey = `${tier}:${mode}`;
  const roster = ROSTERS[rosterKey];
  if (!roster) throw new Error(`Неизвестный тир "${tier}". Доступны: cheap, quality.`);
  const ids = models && models.length > 0 ? models : roster.slice(0, count);

  const items = [];
  const skipped = [];
  for (const modelId of ids) {
    const resolved = await resolveModel(modelId, registry, { refresh });
    const { model, fields } = resolved;

    if (mode === "i2i" && !model.image_field) {
      // Без схемы поле для картинки определить нельзя — и это НЕ то же самое,
      // что «модель не умеет i2i». Раньше обе ситуации давали одну причину, и
      // пропавшая страница документации выглядела как отсутствие возможности.
      skipped.push({
        modelId,
        reason: resolved.schemaSource
          ? "модель не принимает входные изображения"
          : "не удалось прочитать схему (страница документации не ответила) — повтори с --refresh",
      });
      continue;
    }

    const aspect = chooseAspect(fields, fmt.ratio);
    const { values, priceHints } = tierDefaults(fields, { tier, resolution: res });
    const input = {
      [model.prompt_field || "prompt"]: prompt,
      ...values,
      ...(model.defaults || {}),
      ...(aspect ? { [aspect.field]: aspect.value } : {}),
      ...sets,
    };

    // подсказки для прайса берём из того, что реально уйдёт в запрос, а не из тира:
    // --set мог перебить значение, и тогда цена будет другой
    const hints = PRICED_FIELDS.map((f) => (input[f] !== undefined ? String(input[f]) : null))
      .filter(Boolean);
    const price = estimateCredits(pricing.records, modelId, hints.length > 0 ? hints : priceHints);
    if (!price) skipped.push({ modelId, reason: "не удалось определить цену — запуск без цены запрещён" });
    else {
      items.push({
        modelId,
        api: model.api || "jobs",
        input,
        imageField: model.image_field || null,
        imageList: Boolean(model.image_list),
        required: model.required || [],
        aspect,
        resolution: res,
        price,
        docUrl: resolved.docUrl,
        schemaSource: resolved.schemaSource,
      });
    }
  }

  const totalCredits = items.reduce((s, i) => s + i.price.credits, 0);
  return {
    prompt,
    refs,
    format: fmt,
    mode,
    tier,
    resolution: res,
    items,
    skipped,
    totalCredits,
    sources: { registry: registry.source, pricing: pricing.source },
  };
}

/** Ждёт завершения задачи, опрашивая статус. */
async function poll(client, api, taskId, timeoutSec, intervalSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const status = await client.status(api, taskId);
    if (status.state !== "pending") return status;
    if (Date.now() > deadline) {
      throw new Error(`таймаут ${timeoutSec}с (taskId ${taskId}) — задача ещё в работе`);
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

function slugify(value, max = 40) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "run";
}

/** Каталог запуска: out/2026-08-10_1049_promo-ochki/ */
export function runDir(prompt, stamp, outRoot = PATHS.out) {
  return path.join(outRoot, `${stamp}_${slugify(prompt, 32)}`);
}

/**
 * Исполнение плана. ВНИМАНИЕ: тратит кредиты.
 * Бюджет проверяется здесь же — обойти проверку нельзя.
 */
export async function runFanout(plan, {
  apiKey,
  stamp,
  text = null,
  subtext = null,
  font = "Helvetica",
  textPosition = "bottom",
  timeout = 420,
  interval = 5,
  maxUsd = null,
  outRoot = PATHS.out,
  onEvent = () => {},
} = {}) {
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

  let charged = 0; // сумма по СОЗДАННЫМ задачам: столько списано, чем бы всё ни кончилось
  const dir = runDir(plan.prompt, stamp, outRoot);
  const rawDir = path.join(dir, "raw");
  fs.mkdirSync(rawDir, { recursive: true });

  // Референсы загружаем ОДИН раз и переиспользуем во всех моделях пачки.
  const refUrls = [];
  for (const ref of plan.refs) {
    if (/^https?:\/\//.test(ref)) refUrls.push(ref);
    else {
      onEvent({ type: "upload", file: ref });
      refUrls.push(await client.upload(path.resolve(ref)));
    }
  }

  // Надписей может быть несколько: тогда они раздаются по креативам по кругу —
  // за один прогон видно, какой текст лучше сидит на какой картинке. Наложение
  // бесплатное, поэтому вариативность текста ничего не стоит.
  const texts = [text].flat().filter(Boolean);
  const subtexts = [subtext].flat().filter(Boolean);

  const tasks = plan.items.map((item, index) => async () => {
    const started = Date.now();
    const number = String(index + 1).padStart(2, "0");
    const tag = `${number}_${slugify(item.modelId, 28)}`;
    const input = { ...item.input };
    if (refUrls.length > 0 && item.imageField) {
      input[item.imageField] = item.imageList ? refUrls : refUrls[0];
    }

    const missing = (item.required || []).filter((f) => input[f] === undefined);
    if (missing.length > 0) throw new Error(`не заполнены обязательные поля: ${missing.join(", ")}`);

    onEvent({ type: "start", modelId: item.modelId, credits: item.price.credits });
    const taskId = await client.create(item.api, item.modelId, input);

    // Кредиты kie.ai списывает при создании задачи — даже если генерация потом
    // провалится или отвалится сеть. Пишем расход в журнал СРАЗУ, иначе упавшие
    // задачи не попадут в учёт и предохранитель начнёт занижать траты.
    appendLedger({
      at: new Date().toISOString(),
      state: "created",
      model: item.modelId,
      api: item.api,
      credits: item.price.credits,
      usd: item.price.usd,
      taskId,
      prompt: plan.prompt,
    });
    charged += item.price.credits;
    const status = await poll(client, item.api, taskId, timeout, interval);
    if (status.state !== "success" || status.urls.length === 0) {
      throw new Error(status.fail_msg || "генерация не удалась (пустой результат)");
    }

    const ext = (status.urls[0].split("?")[0].match(/\.(png|jpe?g|webp)$/i) || [".png"])[0];
    const rawPath = path.join(rawDir, `${tag}${ext.startsWith(".") ? ext : `.${ext}`}`);
    await downloadFile(status.urls[0], rawPath);

    // Кредиты списаны уже в момент генерации, поэтому пост-обработка не имеет
    // права уронить запись в журнал: иначе бюджет «потеряет» потраченное
    // и предохранитель начнёт занижать расход.
    let finalPath = path.join(dir, `${tag}.jpg`);
    let cropped = { width: null, height: null, cropped: false };
    let applied = { text: null };
    let postError = null;
    try {
      cropped = await cropToRatio(rawPath, finalPath, plan.format.ratio);
      applied = await overlayText(finalPath, finalPath, {
        text: texts.length > 0 ? texts[index % texts.length] : null,
        subtext: subtexts.length > 0 ? subtexts[index % subtexts.length] : null,
        font,
        position: textPosition,
      });
    } catch (exc) {
      postError = exc.message;
      finalPath = rawPath;
      onEvent({
        type: "warn",
        message: `${item.modelId}: кадр скачан, но пост-обработка не удалась (${postError})`,
      });
    }

    const entry = {
      at: new Date().toISOString(),
      state: "done",
      file: path.relative(outRoot, finalPath),
      model: item.modelId,
      api: item.api,
      prompt: plan.prompt,
      input,
      refs: plan.refs,
      format: plan.format.name,
      ratio: Number(plan.format.ratio.toFixed(4)),
      size: cropped.width ? `${cropped.width}x${cropped.height}` : null,
      cropped: cropped.cropped,
      postprocessError: postError,
      requestedAspect: item.aspect ? item.aspect.value : null,
      resolution: item.resolution,
      credits: item.price.credits,
      usd: item.price.usd,
      priceApproximate: item.price.approximate,
      text: applied.text,
      subtext: applied.subtext || null,
      font: applied.font || null,
      taskId,
      seconds: Math.round((Date.now() - started) / 1000),
      sourceUrl: status.urls[0],
    };
    writeSidecar(finalPath, entry);
    appendLedger(entry);
    onEvent({ type: "done", modelId: item.modelId, file: finalPath, seconds: entry.seconds });
    return entry;
  });

  const settled = await Promise.allSettled(tasks.map((t) => t()));
  const results = [];
  const failures = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") results.push(r.value);
    else {
      failures.push({ modelId: plan.items[i].modelId, error: r.reason.message });
      onEvent({ type: "fail", modelId: plan.items[i].modelId, message: r.reason.message });
    }
  });

  return { dir, results, failures, charged, budget: verdict, balanceBefore: balance };
}
