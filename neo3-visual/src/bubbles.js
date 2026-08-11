/**
 * Речевые пузыри, мысли, крики и авторские подписи — рисуются КОДОМ поверх кадра.
 *
 * Зачем не промптом: генераторы рисуют буквы криво (русские — особенно), а любая
 * правка реплики = новая генерация = новые деньги. Пузырь, нарисованный кодом,
 * правится бесплатно сколько угодно раз — та же философия, что в overlay.js,
 * только геометрия сложнее: эллипс с хвостом к говорящему, облако мысли с
 * пузырьками, звезда крика, прямоугольник подписи.
 *
 * Все координаты — доли кадра (0..1), не пиксели: один сценарий одинаково
 * работает с панелью любого разрешения.
 */

import fs from "node:fs";

import "./fontconfig.js"; // ВАЖНО: до импорта sharp (см. комментарий в overlay.js)
import sharp from "sharp";

import { familyFromFile, resolveFontFile, textLayer } from "./overlay.js";

/** Куда ставить пузырь: имя якоря → центр в долях кадра. */
const ANCHORS = {
  "top-left": [0.27, 0.18],
  top: [0.5, 0.16],
  "top-right": [0.73, 0.18],
  left: [0.24, 0.5],
  center: [0.5, 0.5],
  right: [0.76, 0.5],
  "bottom-left": [0.27, 0.8],
  bottom: [0.5, 0.82],
  "bottom-right": [0.73, 0.8],
};

/** Куда смотрит хвост (к говорящему): имя → угол в экранных координатах (y вниз). */
const TAILS = {
  right: 0,
  "down-right": 55,
  down: 90,
  "down-left": 125,
  left: 180,
  "up-left": 235,
  up: 270,
  "up-right": 305,
  none: null,
};

/**
 * Разбивка реплики на строки. Автор может задать переносы сам (| или \n) —
 * тогда верим ему. Без переносов ломаем сами, стремясь к «кирпичику»
 * 2–4 слова в строке: длинная строка в эллипсе раздувает пузырь на полкадра.
 */
export function wrapBubbleText(text, target = 14) {
  const manual = String(text).split(/\\n|\n|\s*\|\s*/).map((l) => l.trim()).filter(Boolean);
  if (manual.length > 1) return manual;

  const words = manual[0] ? manual[0].split(/\s+/) : [];
  if (words.length === 0) return [];
  const total = words.join(" ").length;
  const perLine = Math.max(target, Math.ceil(total / Math.ceil(total / target)));

  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > perLine) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Точка на эллипсе в параметре t (радианы, y вниз). */
const onEllipse = (cx, cy, rx, ry, t) => [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];

/** Хвост обычной реплики: клин из двух точек на эллипсе к точке-вершине у рта героя. */
function speechTail(cx, cy, rx, ry, angleDeg, stroke, sw) {
  const a = (angleDeg * Math.PI) / 180;
  const [x1, y1] = onEllipse(cx, cy, rx, ry, a - 0.38);
  const [x2, y2] = onEllipse(cx, cy, rx, ry, a + 0.38);
  const apexX = cx + rx * 1.75 * Math.cos(a);
  const apexY = cy + ry * 2.05 * Math.sin(a);
  return `<path d="M ${x1} ${y1} L ${apexX} ${apexY} L ${x2} ${y2} Z" fill="#fff" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;
}

/** Хвост мысли: цепочка тающих пузырьков к голове героя. */
function thoughtTail(cx, cy, rx, ry, angleDeg, stroke, sw) {
  const a = (angleDeg * Math.PI) / 180;
  const base = Math.min(rx, ry);
  return [1.35, 1.75, 2.1]
    .map((k, i) => {
      const r = base * [0.22, 0.14, 0.09][i];
      const x = cx + rx * k * Math.cos(a);
      const y = cy + ry * k * Math.sin(a);
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" stroke="${stroke}" stroke-width="${sw}"/>`;
    })
    .join("");
}

/** Звезда крика: полигон с чередованием внешнего и внутреннего радиуса. */
function starPath(cx, cy, rOuter, rInner, spikes = 12) {
  const points = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = (Math.PI * i) / spikes - Math.PI / 2;
    // лёгкая неравномерность лучей, чтобы звезда не выглядела штампованной;
    // детерминированная (по индексу), иначе пересборка меняла бы картинку
    const jitter = 1 + 0.08 * Math.sin(i * 2.7);
    points.push(`${cx + r * jitter * Math.cos(a)},${cy + r * jitter * Math.sin(a)}`);
  }
  return points.join(" ");
}

/**
 * Собирает SVG-слой пузыря (без текста) размером с панель.
 * Хвост рисуется ПЕРВЫМ: эллипс сверху прячет его основание — классический приём.
 */
function bubbleSvg(type, { W, H, cx, cy, rx, ry, tailDeg, fill, stroke, sw }) {
  let body = "";
  if (type === "caption") {
    body = `<rect x="${cx - rx}" y="${cy - ry}" width="${rx * 2}" height="${ry * 2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
  } else if (type === "shout") {
    const tail = tailDeg === null ? "" : speechTail(cx, cy, rx * 1.05, ry * 1.15, tailDeg, stroke, sw);
    body = `${tail}<polygon points="${starPath(cx, cy, Math.max(rx, ry) * 1.3, Math.max(rx, ry) * 0.98)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;
  } else {
    const tailFn = type === "thought" ? thoughtTail : speechTail;
    const tail = tailDeg === null ? "" : tailFn(cx, cy, rx, ry, tailDeg, stroke, sw);
    body = `${tail}<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
  }
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`);
}

/**
 * Накладывает пузыри на кадр. bubbles — массив объектов сценария:
 *   text — реплика (| или \n — свои переносы);
 *   type — speech | thought | shout | caption (по умолчанию speech);
 *   at   — якорь (top-left, top, …) или {x, y} в долях кадра;
 *   tail — right | down-right | down | … | none (по умолчанию down);
 *   fill — цвет пузыря (по умолчанию #fff; подписи обычно #fff8c4);
 *   width — доля ширины кадра под текст (по умолчанию 0.34).
 *
 * Кредитов не тратит. Пузыри кладутся в порядке массива: первый говорящий —
 * первым в списке и левее/выше по кадру, так читается порядок реплик.
 */
export async function addBubbles(inputPath, outputPath, bubbles, { font = "Balsamiq Sans" } = {}) {
  const base = sharp(inputPath, { failOn: "none" });
  const { width: W, height: H } = await base.metadata();
  if (!W || !H) throw new Error(`не удалось прочитать размеры ${inputPath}`);

  const fontFile = resolveFontFile(font);
  const family = fontFile ? familyFromFile(fontFile) : font;
  const sw = Math.max(3, Math.round(W * 0.005));
  const layers = [];

  for (const bubble of bubbles || []) {
    const type = bubble.type || "speech";
    const lines = wrapBubbleText(bubble.text);
    if (lines.length === 0) continue;

    // Высота строки — доля кадра, а не «заполни коробку»: иначе короткая
    // подпись («13:00») раздувается на полкадра и накрывает пузыри соседей.
    const lineH = { speech: 0.05, thought: 0.05, shout: 0.075, caption: 0.042 }[type] || 0.05;
    const widthPct = bubble.width || (type === "caption" ? 0.5 : 0.34);
    const text = await textLayer(lines, {
      family,
      fontFile,
      weight: type === "shout" ? "Bold" : "Regular",
      color: bubble.color || "#111111",
      boxWidth: Math.round(W * widthPct),
      boxHeight: Math.min(Math.round(H * 0.28), Math.round(H * lineH * lines.length)),
    });

    // Эллипс должен накрыть углы текстового блока: (w/2rx)² + (h/2ry)² ≤ 1.
    let rx;
    let ry;
    if (type === "caption") {
      rx = text.width / 2 + W * 0.018;
      ry = text.height / 2 + W * 0.014;
    } else if (type === "shout") {
      rx = text.width * 0.62 + W * 0.01;
      ry = text.height * 0.72 + W * 0.01;
    } else {
      rx = Math.max(text.width * 0.66, text.width / 2 + W * 0.03);
      ry = text.height * 0.85 + W * 0.012;
    }

    // Позиция: имя якоря или свои доли; подпись по умолчанию — в левый верхний угол.
    let cx;
    let cy;
    const at = bubble.at || (type === "caption" ? "top-left" : "top");
    if (typeof at === "object") {
      cx = W * at.x;
      cy = H * at.y;
    } else {
      const anchor = ANCHORS[at];
      if (!anchor) {
        throw new Error(`пузырь "${lines[0]}": неизвестный якорь "${at}" (есть: ${Object.keys(ANCHORS).join(", ")})`);
      }
      [cx, cy] = [W * anchor[0], H * anchor[1]];
    }
    if (type === "caption" && typeof at === "string") {
      // подписи прижимаются к краю кадра, а не центрируются по якорю
      const m = W * 0.035;
      if (at.includes("left")) cx = m + rx;
      if (at.includes("right")) cx = W - m - rx;
      if (at.includes("top")) cy = m + ry;
      if (at.includes("bottom")) cy = H - m - ry;
    }

    // Пузырь не должен вылезать за кадр — двигаем внутрь, хвосту оставляем
    // место. У крика прижимаем по внешнему радиусу лучей, не по эллипсу.
    const pad = sw * 2;
    const spread = type === "shout" ? 1.42 : 1;
    cx = clamp(cx, rx * spread + pad, W - rx * spread - pad);
    cy = clamp(cy, ry * spread + pad, H - ry * spread - pad);

    const tailName = bubble.tail || "down";
    if (!(tailName in TAILS)) {
      throw new Error(`пузырь "${lines[0]}": неизвестный хвост "${tailName}" (есть: ${Object.keys(TAILS).join(", ")})`);
    }
    const tailDeg = type === "caption" ? null : TAILS[tailName];

    layers.push({
      input: bubbleSvg(type, {
        W, H, cx, cy, rx, ry, tailDeg,
        fill: bubble.fill || (type === "caption" ? "#fff8c4" : "#ffffff"),
        stroke: "#111111",
        sw,
      }),
      left: 0,
      top: 0,
    });
    layers.push({
      input: text.buffer,
      left: Math.round(cx - text.width / 2),
      top: Math.round(cy - text.height / 2),
    });
  }

  if (layers.length === 0) {
    if (inputPath !== outputPath) await sharp(inputPath).toFile(outputPath);
    return { bubbles: 0 };
  }

  // sharp не пишет в файл, из которого читает — через временный (как в overlay.js)
  const tmp = inputPath === outputPath ? `${outputPath}.tmp` : outputPath;
  await base.composite(layers).toFile(tmp);
  if (tmp !== outputPath) fs.renameSync(tmp, outputPath);
  return { bubbles: bubbles.length };
}
