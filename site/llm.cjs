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
  let sc = await callOpenRouter(CHEAP_MODEL, CRAFT, user);
  let errs = validateScenario(sc, pagesCount);
  if (errs.length) {
    const fixUser = `${user}\n\nТвой прошлый JSON имел ошибки, исправь их все и верни полный JSON заново:\n${errs.join('\n')}`;
    sc = await callOpenRouter(CHEAP_MODEL, CRAFT, fixUser);
    errs = validateScenario(sc, pagesCount);
    if (errs.length) throw new Error('сценарий не прошёл проверку: ' + errs.slice(0, 3).join('; '));
  }
  return { scenario: sc, demo: false };
}

async function rewritePage({ scenario, pageIndex, wish, mode, heroes, tone }) {
  const page = scenario.pages[pageIndex];
  const heroLines = heroes.map(h => `- ${h.name}: ${h.desc}`).join('\n');
  const model = mode === 'dialogs' ? SMART_MODEL : CHEAP_MODEL;
  const task = mode === 'dialogs'
    ? 'Перепиши ТОЛЬКО реплики этой страницы: живее, острее, естественнее, с характером. Структуру кадров не меняй.'
    : `Перепиши эту страницу целиком с учётом пожелания: «${wish || 'сделай интереснее'}».`;
  const user = `Герои:\n${heroLines}\nТон: ${tone}\nЛоглайн: ${scenario.logline}\n\n${task}\n\nСтраница сейчас (JSON):\n${JSON.stringify(page)}\n\nВерни СТРОГО JSON одной страницы того же формата {"n":…,"beat":…,"rows":[…]}.`;
  const p = await callOpenRouter(model, CRAFT, user, 4000);
  const test = { ...scenario, pages: scenario.pages.map((x, i) => i === pageIndex ? p : x) };
  const errs = validateScenario(test, scenario.pages.length);
  if (errs.some(e => e.startsWith(`стр.${pageIndex + 1}`))) throw new Error('переписанная страница кривая, попробуй ещё раз');
  return p;
}

module.exports = { makeScenario, rewritePage, hasKey: () => !!readKey() };
