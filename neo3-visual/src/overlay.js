/**
 * Пост-обработка кадра: точная обрезка под формат + наложение текста КОДОМ.
 *
 * Зачем текст не отдаём модели: генераторы рисуют буквы неточно (кривые лигатуры,
 * выдуманные символы, каша в русском), а любая правка надписи = новая генерация
 * = новые деньги. Наложенный кодом текст правится бесплатно и сколько угодно раз,
 * шрифт при этом ровно тот, который просили.
 *
 * Рендер текста — через встроенный в sharp Pango (поддерживает переносы,
 * кернинг и явный файл шрифта), не через SVG: SVG-текст зависит от системного
 * fontconfig и кастомный .ttf там подхватывается непредсказуемо.
 */

import fs from "node:fs";
import path from "node:path";

import "./fontconfig.js"; // ВАЖНО: до импорта sharp — настраивает fontconfig для Pango
import sharp from "sharp";

import { PATHS } from "./config.js";

const GRAVITY = {
  top: "north",
  center: "center",
  bottom: "south",
};

/**
 * sharp не умеет писать в тот же файл, из которого читает («Cannot use same file
 * for input and output»), а обрабатывать кадр «на месте» удобно. Пишем в соседний
 * временный файл и переименовываем.
 */
async function writeTo(pipeline, inputPath, outputPath) {
  const same = path.resolve(inputPath) === path.resolve(outputPath);
  const dest = same ? `${outputPath}.tmp` : outputPath;
  await pipeline.toFile(dest);
  if (same) fs.renameSync(dest, outputPath);
  return outputPath;
}

/**
 * Обрезает изображение до точного соотношения сторон (кроп по центру, без растяжения).
 * Модель могла отдать ближайший поддерживаемый формат — здесь доводим до заданного.
 */
export async function cropToRatio(inputPath, outputPath, targetRatio) {
  const image = sharp(inputPath, { failOn: "none" });
  const { width, height } = await image.metadata();
  if (!width || !height) throw new Error(`не удалось прочитать размеры ${inputPath}`);

  const actual = width / height;
  let cropWidth = width;
  let cropHeight = height;
  if (Math.abs(actual - targetRatio) > 0.005) {
    if (actual > targetRatio) cropWidth = Math.round(height * targetRatio);
    else cropHeight = Math.round(width / targetRatio);
  }

  await writeTo(
    image.extract({
      left: Math.round((width - cropWidth) / 2),
      top: Math.round((height - cropHeight) / 2),
      width: cropWidth,
      height: cropHeight,
    }),
    inputPath,
    outputPath,
  );

  return { width: cropWidth, height: cropHeight, cropped: cropWidth !== width || cropHeight !== height };
}

/**
 * Ищет файл шрифта в fonts/ по имени семейства ("Unbounded" → fonts/Unbounded-Bold.ttf).
 * Не нашли — возвращаем null, и Pango возьмёт системный шрифт с таким именем.
 */
export function resolveFontFile(family, fontsDir = PATHS.fonts) {
  if (!family) return null;
  if (family.endsWith(".ttf") || family.endsWith(".otf")) {
    return fs.existsSync(family) ? path.resolve(family) : null;
  }
  let files;
  try {
    files = fs.readdirSync(fontsDir);
  } catch {
    return null;
  }
  const slug = family.toLowerCase().replace(/[^a-z0-9]/g, "");
  const candidates = files
    .filter((f) => /\.(ttf|otf)$/i.test(f))
    .filter((f) => f.toLowerCase().replace(/[^a-z0-9]/g, "").startsWith(slug));
  if (candidates.length === 0) return null;
  // приоритет жирным начертаниям — на креативах текст почти всегда крупный и жирный
  const weighted = candidates.sort((a, b) => {
    const score = (f) => (/black|extrabold|bold/i.test(f) ? 0 : /regular|variable|\[/i.test(f) ? 1 : 2);
    return score(a) - score(b);
  });
  return path.join(fontsDir, weighted[0]);
}

function escapeMarkup(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Полупрозрачная подложка под текст, чтобы буквы читались на любом фоне. */
function scrimSvg(width, height, position) {
  const stops = position === "top"
    ? '<stop offset="0%" stop-color="#000" stop-opacity="0.55"/><stop offset="100%" stop-color="#000" stop-opacity="0"/>'
    : '<stop offset="0%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.55"/>';
  return Buffer.from(
    `<svg width="${width}" height="${height}"><defs>`
      + `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient></defs>`
      + `<rect width="${width}" height="${height}" fill="url(#g)"/></svg>`,
  );
}

/**
 * Рендерит текст в отдельный прозрачный слой нужного размера.
 *
 * Рендерим крупно и БЕЗ ограничения по ширине: если задать width, Pango сам
 * переносит длинную строку, ломая заданную разбивку («в 2 строки» превращается
 * в 3). Поэтому масштабируем готовый слой под рамку сами.
 */
export async function textLayer(lines, { family, fontFile, weight, color, boxWidth, boxHeight }) {
  const raw = await sharp({
    text: {
      text: `<span foreground="${color}">${escapeMarkup(lines.join("\n"))}</span>`,
      font: `${family} ${weight} 160`.replace(/\s+/g, " ").trim(),
      ...(fontFile ? { fontfile: fontFile } : {}),
      rgba: true,
      align: "centre",
    },
  })
    .png()
    .toBuffer();

  const meta = await sharp(raw).metadata();
  const scale = Math.min(boxWidth / meta.width, boxHeight / meta.height);
  const w = Math.max(1, Math.round(meta.width * scale));
  const h = Math.max(1, Math.round(meta.height * scale));
  return { buffer: await sharp(raw).resize(w, h, { fit: "inside" }).png().toBuffer(), width: w, height: h };
}

const splitLines = (value) => String(value).split(/\\n|\n|\s*\|\s*/).map((l) => l.trim()).filter(Boolean);

/**
 * Накладывает текст на изображение.
 *
 * options:
 *   text      — заголовок; \n или | разделяют строки;
 *   subtext   — вторая строка помельче под заголовком (уточнение, дедлайн, CTA);
 *   font      — семейство ("Unbounded") или путь к .ttf;
 *   weight    — начертание для Pango (Bold по умолчанию);
 *   color     — цвет текста (#fff по умолчанию);
 *   position  — top | center | bottom (по умолчанию bottom);
 *   widthPct  — доля ширины кадра под текстовый блок (0.86);
 *   heightPct — доля высоты кадра на строку заголовка (авто по числу строк);
 *   subScale  — размер подстроки относительно высоты заголовка (0.34);
 *   scrim     — подложка под текст (по умолчанию true, для center — false).
 */
export async function overlayText(inputPath, outputPath, options = {}) {
  const {
    text,
    subtext = null,
    font = "Helvetica",
    weight = "Bold",
    color = "#ffffff",
    position = "bottom",
    widthPct = 0.86,
    heightPct = null,
    subScale = 0.34,
    scrim = null,
  } = options;

  if (!text || !String(text).trim()) {
    if (inputPath !== outputPath) fs.copyFileSync(inputPath, outputPath);
    return { text: null };
  }

  const base = sharp(inputPath, { failOn: "none" });
  const { width, height } = await base.metadata();
  const lines = splitLines(text);
  const gravity = GRAVITY[position] || "south";

  const fontFile = resolveFontFile(font);
  const family = fontFile ? familyFromFile(fontFile) : font;
  const boxWidth = Math.round(width * widthPct);
  const perLine = heightPct || Math.min(0.15, 0.4 / Math.max(lines.length, 1));

  const head = await textLayer(lines, {
    family, fontFile, weight, color, boxWidth,
    boxHeight: Math.round(height * perLine * lines.length),
  });

  // Подстрока — обычным начертанием и заметно мельче заголовка: без этой
  // разницы длинный текст читается как монолитная плита и продаёт хуже.
  const subLines = subtext && String(subtext).trim() ? splitLines(subtext) : [];
  const sub = subLines.length > 0
    ? await textLayer(subLines, {
      family,
      fontFile,
      weight: "Regular",
      color,
      boxWidth,
      boxHeight: Math.max(1, Math.round((head.height / lines.length) * subScale * subLines.length)),
    })
    : null;

  const gap = sub ? Math.round(height * 0.022) : 0;
  const blockHeight = head.height + gap + (sub ? sub.height : 0);
  const padding = Math.round(height * 0.055);
  const blockTop = position === "top"
    ? padding
    : position === "center"
      ? Math.round((height - blockHeight) / 2)
      : height - blockHeight - padding;

  const layers = [];
  const useScrim = scrim === null ? position !== "center" : scrim;
  if (useScrim) {
    const scrimHeight = Math.min(height, blockHeight + padding * 2 + Math.round(height * 0.06));
    layers.push({ input: scrimSvg(width, scrimHeight, position), gravity });
  }
  layers.push({
    input: head.buffer,
    left: Math.round((width - head.width) / 2),
    top: Math.max(0, blockTop),
  });
  if (sub) {
    layers.push({
      input: sub.buffer,
      left: Math.round((width - sub.width) / 2),
      top: Math.max(0, blockTop + head.height + gap),
    });
  }

  await writeTo(base.composite(layers), inputPath, outputPath);
  return {
    text: lines.join(" / "),
    subtext: subLines.length > 0 ? subLines.join(" / ") : null,
    font: family,
    weight,
    fontFile,
    position,
    textSize: `${head.width}x${blockHeight}`,
  };
}

/** "PlayfairDisplay-Bold.ttf" → "Playfair Display" (имя семейства для Pango). */
export function familyFromFile(fontFile) {
  return path.basename(fontFile)
    .replace(/\.(ttf|otf)$/i, "")
    .replace(/[-_](variable|regular|bold|black|extrabold|medium|light|italic).*$/i, "")
    .replace(/\[.*\]$/, "")
    .replace(/([a-zа-я])([A-ZА-Я])/g, "$1 $2")
    .trim();
}
