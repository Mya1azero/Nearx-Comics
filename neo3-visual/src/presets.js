/**
 * Форматы креативов и подгонка их под конкретную модель.
 *
 * Проблема, из-за которой этот файл существует: одно и то же соотношение сторон
 * каждый вендор называет по-своему и поддерживает свой набор. gpt-image-2 знает
 * "4:5", flux — нет (у него только "3:4"), ideogram вообще принимает не соотношение,
 * а имена ("portrait_4_3"), а imagen4 по умолчанию ставит 16:9 и молча отдаёт
 * горизонталь там, где просили вертикаль.
 *
 * Решение: берём enum поля формата из ЖИВОЙ схемы модели, переводим все варианты
 * в число (w/h), выбираем ближайший к нужному и после скачивания дорезаем кадр
 * до точного соотношения. Новая модель работает без правок кода.
 */

/** Именованные форматы под площадки. Значение — соотношение ширина/высота. */
export const FORMATS = {
  square: { ratio: 1, label: "1:1 — лента, универсально" },
  post: { ratio: 4 / 5, label: "4:5 — вертикальный пост, максимум места в ленте" },
  story: { ratio: 9 / 16, label: "9:16 — сторис, шортсы" },
  wide: { ratio: 16 / 9, label: "16:9 — обложка, ютуб, сайт" },
  landscape: { ratio: 3 / 2, label: "3:2 — горизонталь, фото" },
  portrait: { ratio: 2 / 3, label: "2:3 — вертикаль, постер" },
};

/** Поля, в которых модели держат формат кадра (по убыванию приоритета). */
const ASPECT_FIELDS = ["aspect_ratio", "image_size", "aspectRatio", "size", "image_aspect_ratio"];

/** Именованные значения enum → соотношение. */
const NAMED_RATIOS = {
  square: 1,
  square_hd: 1,
  portrait_4_3: 3 / 4,
  portrait_16_9: 9 / 16,
  landscape_4_3: 4 / 3,
  landscape_16_9: 16 / 9,
};

/**
 * Поля, которые влияют на цену, и порядок предпочтения по тирам.
 * ideogram берёт деньги за rendering_speed, gpt-image — за resolution,
 * seedream — за quality: одна и та же модель стоит от 3.5 до 22 кредитов
 * в зависимости от этих полей, поэтому тир обязан их задавать явно.
 */
const TIER_PREFERENCE = {
  cheap: {
    resolution: ["1K", "1k", "720p", "1024", "basic"],
    quality: ["basic", "medium", "low", "standard"],
    rendering_speed: ["TURBO", "BALANCED", "QUALITY"],
    output_format: ["jpg", "jpeg", "png"],
  },
  quality: {
    resolution: ["4K", "4k", "2K", "2k", "1K"],
    quality: ["ultra", "high", "medium", "basic"],
    rendering_speed: ["QUALITY", "BALANCED", "TURBO"],
    output_format: ["png", "jpg", "jpeg"],
  },
};

/** Поля, значения которых меняют тариф — их отдаём в оценку цены как подсказки. */
export const PRICED_FIELDS = ["resolution", "quality", "rendering_speed"];

/** "4:5" | "portrait_4_3" | "1024x1280" → число w/h, либо null. */
export function ratioOf(value) {
  const v = String(value).trim().toLowerCase();
  if (v === "auto" || v === "adaptive" || v === "match_input_image") return null;
  if (NAMED_RATIOS[v] !== undefined) return NAMED_RATIOS[v];
  const colon = /^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/.exec(v);
  if (colon) {
    const h = Number(colon[2]);
    return h > 0 ? Number(colon[1]) / h : null;
  }
  return null;
}

/** Разбор аргумента --format: имя пресета или "W:H". */
export function parseFormat(input) {
  const key = String(input || "square").trim().toLowerCase();
  if (FORMATS[key]) return { name: key, ratio: FORMATS[key].ratio };
  const ratio = ratioOf(key);
  if (ratio) return { name: key, ratio };
  throw new Error(
    `Неизвестный формат "${input}". Доступны: ${Object.keys(FORMATS).join(", ")} или "W:H" (например 4:5).`,
  );
}

/**
 * Ближайшее к targetRatio значение формата, которое понимает эта модель.
 * Возвращает { field, value, ratio, exact } или null, если поля формата нет
 * (тогда модель решает сама, а мы дорежем кадр после скачивания).
 */
export function chooseAspect(fields, targetRatio) {
  const byName = new Map((fields || []).map((f) => [f.name, f]));
  for (const name of ASPECT_FIELDS) {
    const field = byName.get(name);
    if (!field || !field.enum || field.enum.length === 0) continue;
    let best = null;
    for (const option of field.enum) {
      const ratio = ratioOf(option);
      if (!ratio) continue;
      // сравниваем в логарифме: 16:9 против 9:16 не должно перевешивать 4:5 против 3:4
      const distance = Math.abs(Math.log(ratio / targetRatio));
      if (!best || distance < best.distance) best = { value: option, ratio, distance };
    }
    if (best) {
      return {
        field: name,
        value: best.value,
        ratio: best.ratio,
        exact: Math.abs(best.ratio - targetRatio) < 0.005,
      };
    }
  }
  return null;
}

/**
 * Параметры модели под выбранный тир.
 * Заполняет то, без чего API ответит 422, и выставляет разрешение/качество/скорость
 * рендера по тиру. Возвращает { values, priceHints } — подсказки нужны, чтобы
 * найти в прайсе именно тот тариф, по которому пойдёт списание.
 */
export function tierDefaults(fields, { tier = "cheap", resolution = null } = {}) {
  const preference = TIER_PREFERENCE[tier] || TIER_PREFERENCE.cheap;
  const values = {};
  const priceHints = [];

  for (const field of fields || []) {
    const options = field.enum || [];
    if (options.length === 0) continue;

    let pick;
    if (field.name === "resolution" && resolution) {
      pick = options.find((o) => String(o).toLowerCase() === String(resolution).toLowerCase());
    }
    if (pick === undefined && preference[field.name]) {
      pick = preference[field.name]
        .map((p) => options.find((o) => String(o).toLowerCase() === p.toLowerCase()))
        .find((o) => o !== undefined);
    }
    if (pick === undefined && field.required && !ASPECT_FIELDS.includes(field.name)) {
      pick = options[0];
    }
    if (pick === undefined) continue;

    values[field.name] = pick;
    if (PRICED_FIELDS.includes(field.name)) priceHints.push(String(pick));
  }
  return { values, priceHints };
}
