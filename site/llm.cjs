#!/usr/bin/env node
// Мозг сценариев: OpenRouter (ключ в site/.env → OPENROUTER_API_KEY).
// Без ключа работает деморежим: готовый сценарий-образец, чтобы конвейер жил.

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '.env');

function readKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  try {
    const m = fs.readFileSync(ENV_PATH, 'utf8').match(/^OPENROUTER_API_KEY\s*=\s*(\S+)/m);
    return m ? m[1] : null;
  } catch { return null; }
}

const CHEAP_MODEL = 'openai/gpt-5.4-mini';
const SMART_MODEL = 'openai/gpt-5.4';

// Парс JSON от модели, даже если она завернула его в ```json-заборы (боевой паттерн WABA).
function parseLlmJson(raw) {
  const text = (raw || '').trim();
  try { return JSON.parse(text); } catch {}
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(fenced); } catch {}
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
  throw new Error('модель вернула не-JSON');
}

const CRAFT = `Ты — сценарист персональных комиксов и мастер вёрстки. Правила ремесла (нарушать нельзя):
- Страница = 2–3 РЯДА кадров на скрытой сетке 3×3. В ряду 1–3 кадра, ширина кадра в колонках (cols: 1, 2 или 3); сумма cols в ряду ровно 3 (один кадр cols:3 занимает весь ряд).
- Всего 5–7 кадров на страницу. Крупный кадр = важный медленный момент, узкие = быстрые биты.
- Реплика ≤ 8 слов, максимум 2 пузыря на кадр. type: speech | thought | shout.
- Подписи-плашки (caption) — только время/место («Вторник. 20:47»), на сменах сцены.
- scene — описание картинки БЕЗ слов персонажей: кто где, что делает, свет, ракурс, эмоция. Пиши кинематографично и конкретно.
- Любой персонаж, который появляется больше чем в одном кадре, обязан иметь ПОСТОЯННОЕ описание внешности (волосы, одежда, приметы) — задай его при первом появлении в scene и повторяй теми же словами в каждом кадре с ним, иначе художник нарисует разных людей.
- Первый говорящий в кадре — левее и выше. Страница заканчивается крючком, чтобы хотелось следующую.
- История тёплая, живая, с юмором и деталями быта; диалоги естественные, как говорят люди.
- Драматургия: завязка → развитие с препятствием → пик → развязка-пэйофф на последней странице.
Отвечай СТРОГО одним JSON без пояснений:
{"title":"…","logline":"…","pages":[{"n":1,"beat":"суть страницы","rows":[{"panels":[{"cols":2,"scene":"…","caption":"…или пропусти","bubbles":[{"who":"Имя","text":"…","type":"speech"}]}]}]}]}`;

async function callOpenRouter(model, system, user, maxTokens) {
  const key = readKey();
  if (!key) throw Object.assign(new Error('нет ключа'), { code: 'NO_KEY' });
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      max_tokens: maxTokens || 8000,
      temperature: 0.9
    })
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('пустой ответ модели');
  return parseLlmJson(content);
}

// Модель часто путает ширины кадров и лепит ряды из 3 кадров по cols=2.
// Чинить это дешевле, чем гонять её заново: ширины восстанавливаются по числу
// кадров в ряду, слишком длинные ряды разбиваются, лишние пузыри срезаются.
const COLS_BY_COUNT = { 1: [3], 2: [2, 1], 3: [1, 1, 1] };

function repairScenario(sc) {
  if (!sc || !Array.isArray(sc.pages)) return sc;
  sc.pages.forEach((p, pi) => {
    p.n = pi + 1;
    const rows = [];
    (p.rows || []).forEach(r => {
      let panels = (r.panels || []).filter(x => x && x.scene);
      while (panels.length > 3) rows.push({ panels: panels.splice(0, 3) });
      if (panels.length) rows.push({ panels });
    });
    rows.forEach(r => {
      const widths = COLS_BY_COUNT[r.panels.length] || [1, 1, 1];
      // сохраняем задумку: самый «широкий» по замыслу кадр получает больше колонок
      const order = r.panels.map((pan, i) => ({ i, w: pan.cols || 1 }))
        .sort((a, b) => b.w - a.w || a.i - b.i);
      order.forEach((o, k) => { r.panels[o.i].cols = widths[k]; });
      r.panels.forEach(pan => {
        if (Array.isArray(pan.bubbles) && pan.bubbles.length > 2) pan.bubbles = pan.bubbles.slice(0, 2);
      });
    });
    p.rows = rows;
  });
  return sc;
}

function validateScenario(sc, wantPages) {
  const errs = [];
  if (!sc || !Array.isArray(sc.pages)) return ['нет pages'];
  if (sc.pages.length !== wantPages) errs.push(`страниц ${sc.pages.length}, нужно ${wantPages}`);
  sc.pages.forEach((p, pi) => {
    if (!Array.isArray(p.rows) || p.rows.length < 2 || p.rows.length > 3)
      errs.push(`стр.${pi + 1}: рядов должно быть 2–3`);
    let panels = 0;
    (p.rows || []).forEach((r, ri) => {
      const sum = (r.panels || []).reduce((s, x) => s + (x.cols || 0), 0);
      if (sum !== 3) errs.push(`стр.${pi + 1} ряд ${ri + 1}: сумма cols=${sum}, нужно 3`);
      panels += (r.panels || []).length;
      (r.panels || []).forEach((pan, ni) => {
        (pan.bubbles || []).forEach(b => {
          if ((b.text || '').split(/\s+/).length > 9)
            errs.push(`стр.${pi + 1} кадр ${ni + 1}: реплика длиннее 8 слов`);
        });
        if ((pan.bubbles || []).length > 2) errs.push(`стр.${pi + 1} кадр ${ni + 1}: больше 2 пузырей`);
      });
    });
    if (panels < 4 || panels > 8) errs.push(`стр.${pi + 1}: кадров ${panels}, нужно 5–7`);
  });
  return errs;
}

async function makeScenario({ story, pagesCount, tone, heroes }) {
  const key = readKey();
  if (!key) {
    const mock = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-scenario.json'), 'utf8'));
    return { scenario: mock, demo: true };
  }
  const heroLines = heroes.map(h => `- ${h.name}: ${h.desc}`).join('\n');
  const user = `Герои:\n${heroLines}\n\nТон: ${tone}\nСтраниц: ровно ${pagesCount}.\n\nИстория от заказчика (разверни её в подробный сюжет с деталями и живыми диалогами):\n${story}`;
  let sc = repairScenario(await callOpenRouter(CHEAP_MODEL, CRAFT, user));
  let errs = validateScenario(sc, pagesCount);
  if (errs.length) {
    const fixUser = `${user}\n\nТвой прошлый JSON имел ошибки, исправь их все и верни полный JSON заново:\n${errs.join('\n')}`;
    const second = repairScenario(await callOpenRouter(CHEAP_MODEL, CRAFT, fixUser));
    const errs2 = validateScenario(second, pagesCount);
    // берём вариант с меньшим числом огрехов
    if (errs2.length <= errs.length) { sc = second; errs = errs2; }
  }
  // Жёстко валим только то, что не починить: пустой или бессвязный сценарий.
  if (!sc || !Array.isArray(sc.pages) || !sc.pages.length)
    throw new Error('сценарист вернул пустой сценарий, попробуй ещё раз');

  // Человек заплатил за N страниц — значит их должно быть ровно N.
  // Лишнее срезаем, недостающее дописываем продолжением (модели любят
  // «сжать» историю в меньшее число страниц).
  if (sc.pages.length > pagesCount) sc.pages = sc.pages.slice(0, pagesCount);
  let guard = 0;
  while (sc.pages.length < pagesCount && guard++ < 3) {
    const need = pagesCount - sc.pages.length;
    const contUser = `${user}\n\nУже написаны первые ${sc.pages.length} страниц этой же истории:\n${JSON.stringify({ title: sc.title, pages: sc.pages })}\n\n` +
      `Напиши ПРОДОЛЖЕНИЕ: ровно ${need} следующих страниц (номера с ${sc.pages.length + 1}), не повторяя уже показанное, ` +
      `доводя историю до развязки на последней. Верни строго JSON вида {"pages":[…]} только с новыми страницами.`;
    let more;
    try { more = repairScenario(await callOpenRouter(CHEAP_MODEL, CRAFT, contUser)); }
    catch { break; }
    const add = (more && Array.isArray(more.pages) ? more.pages : []).slice(0, need);
    if (!add.length) break;
    sc.pages = sc.pages.concat(add);
  }
  sc.pages.forEach((p, i) => { p.n = i + 1; });
  if (sc.pages.length !== pagesCount) errs.push(`страниц ${sc.pages.length} вместо ${pagesCount}`);
  return { scenario: sc, demo: false, warnings: errs };
}

async function rewritePage({ scenario, pageIndex, wish, mode, heroes, tone }) {
  const page = scenario.pages[pageIndex];
  const heroLines = heroes.map(h => `- ${h.name}: ${h.desc}`).join('\n');
  const model = mode === 'dialogs' ? SMART_MODEL : CHEAP_MODEL;
  const task = mode === 'dialogs'
    ? 'Перепиши ТОЛЬКО реплики этой страницы: живее, острее, естественнее, с характером. Структуру кадров не меняй.'
    : `Перепиши эту страницу целиком с учётом пожелания: «${wish || 'сделай интереснее'}».`;
  const user = `Герои:\n${heroLines}\nТон: ${tone}\nЛоглайн: ${scenario.logline}\n\n${task}\n\nСтраница сейчас (JSON):\n${JSON.stringify(page)}\n\nВерни СТРОГО JSON одной страницы того же формата {"n":…,"beat":…,"rows":[…]}.`;
  const raw = await callOpenRouter(model, CRAFT, user, 4000);
  const p = repairScenario({ pages: [raw] }).pages[0];
  p.n = pageIndex + 1;
  const test = { ...scenario, pages: scenario.pages.map((x, i) => i === pageIndex ? p : x) };
  const errs = validateScenario(test, scenario.pages.length);
  if (errs.some(e => e.startsWith(`стр.${pageIndex + 1}`))) throw new Error('переписанная страница кривая, попробуй ещё раз');
  return p;
}

/* --- Карточка героя по фото: человек ничего не описывает руками --- */

const VISION_TASK = `Ты — художник-постановщик комикса. На фото — реальный человек, будущий герой книжки.
Опиши ТОЛЬКО его внешность так, как пишут в листе персонажа, чтобы художник рисовал одного и того же человека на всех страницах.
Пиши по-русски, одной строкой, 15–30 слов, через запятую: пол и примерный возраст, причёска и цвет волос, растительность на лице, цвет глаз, телосложение, одежда с фото, заметные приметы (очки, серьги, цепочка, татуировки).
Никаких оценок внешности, диагнозов, национальности и имён. Если деталь не видно — не выдумывай, пропусти.
Также придумай короткое «кто это по вайбу» — 2–4 слова (например «спокойный улыбчивый парень»).
Ответ строго JSON: {"appearance":"…","vibe":"…"}`;

async function callVision(model, imagePaths) {
  const key = readKey();
  if (!key) throw Object.assign(new Error('нет ключа'), { code: 'NO_KEY' });
  const images = imagePaths.slice(0, 3).map(p => {
    const ext = (path.extname(p) || '.jpg').slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${fs.readFileSync(p).toString('base64')}` } };
  });
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: VISION_TASK }, ...images] }],
      response_format: { type: 'json_object' },
      max_tokens: 700,
      temperature: 0.4
    })
  });
  if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('пустой ответ модели');
  return parseLlmJson(content);
}

async function describePerson(photoPaths) {
  if (!photoPaths || !photoPaths.length) throw new Error('нет фото');
  let last;
  for (const model of [CHEAP_MODEL, SMART_MODEL]) {
    try {
      const r = await callVision(model, photoPaths);
      const appearance = String(r.appearance || '').trim().slice(0, 300);
      if (appearance.length > 15) return { appearance, vibe: String(r.vibe || '').trim().slice(0, 60) };
      last = new Error('модель описала слишком коротко');
    } catch (e) { last = e; if (e.code === 'NO_KEY') break; }
  }
  throw last || new Error('не вышло разобрать фото');
}

module.exports = { makeScenario, rewritePage, describePerson, hasKey: () => !!readKey() };
