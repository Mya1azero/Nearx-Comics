/* NearX Comics — студия. Без сборщиков, чистый JS. */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
let JOB = null;          // текущая заявка (вид с сервера)
let STATUS = {};         // /api/status
let pollTimer = null;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 3500);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('ошибка ' + res.status));
  return data;
}
const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

/* ---------- шаги ---------- */
function showStep(n) {
  $$('.step').forEach(s => s.classList.remove('active'));
  $('#step' + n).classList.add('active');
  $$('#steps button').forEach(b => b.classList.toggle('active', b.dataset.step == n));
  window.scrollTo({ top: 0 });
}
$$('#steps button').forEach(b => b.onclick = () => showStep(b.dataset.step));
$$('[data-back]').forEach(b => b.onclick = () => showStep(b.dataset.back));

/* ---------- заявка ---------- */
async function ensureJob() {
  const saved = localStorage.getItem('nearx_job');
  if (saved) {
    try {
      JOB = await api('/api/job/' + saved);
      return;
    } catch { localStorage.removeItem('nearx_job'); }
  }
  const { id } = await post('/api/job');
  localStorage.setItem('nearx_job', id);
  JOB = await api('/api/job/' + id);
}
const saveMeta = body => post(`/api/job/${JOB.id}/meta`, body);

/* ---------- шаг 1: герои ---------- */
function heroCard(i) {
  const h = JOB.heroes[i] || { name: '', desc: '', photos: [] };
  const card = document.createElement('div');
  card.className = 'hero-card';
  card.innerHTML = `
    <div class="grid">
      <input placeholder="Имя героя" value="${h.name || ''}" data-f="name">
      <input placeholder="Пара слов: кто это" value="${h.desc || ''}" data-f="descShort">
      <textarea rows="2" placeholder="Внешность и характер: стрижка, борода, одежда, вайб" data-f="desc">${h.desc || ''}</textarea>
    </div>
    <div class="photos"></div>
    <div class="sheet-wrap">
      <button class="primary" data-gen>Создать лист героя (${STATUS.heroCents || 4}¢)</button>
    </div>`;
  const photosBox = card.querySelector('.photos');
  (h.photos || []).forEach(u => { const im = document.createElement('img'); im.src = u; photosBox.appendChild(im); });
  const add = document.createElement('button');
  add.className = 'add'; add.textContent = '+'; add.title = 'Загрузить фото';
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.multiple = true; fileInput.style.display = 'none';
  add.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const fd = new FormData();
    Array.from(fileInput.files).slice(0, 3).forEach(f => fd.append('photos', f));
    try {
      const r = await api(`/api/job/${JOB.id}/hero/${i}/photos`, { method: 'POST', body: fd });
      photosBox.querySelectorAll('img').forEach(x => x.remove());
      r.photos.forEach(u => { const im = document.createElement('img'); im.src = u; photosBox.insertBefore(im, add); });
      toast('Фото загружены');
    } catch (e) { toast(e.message); }
  };
  photosBox.appendChild(add); photosBox.appendChild(fileInput);

  if (h.sheet) {
    const im = document.createElement('img'); im.src = h.sheet;
    card.querySelector('.sheet-wrap').prepend(im);
    card.querySelector('[data-gen]').textContent = `Перерисовать лист (${STATUS.heroCents || 4}¢)`;
  }
  card.querySelector('[data-gen]').onclick = async ev => {
    const btn = ev.target;
    const name = card.querySelector('[data-f=name]').value.trim();
    const desc = (card.querySelector('[data-f=desc]').value || card.querySelector('[data-f=descShort]').value).trim();
    if (!name) return toast('Дай герою имя');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Рисую лист (~минута)…';
    try {
      await post(`/api/job/${JOB.id}/hero/${i}`, { name, desc, generate: true });
      JOB = await api('/api/job/' + JOB.id);
      renderHeroes();
      toast('Лист героя готов');
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Создать лист героя'; }
  };
  ['name', 'desc'].forEach(f => {
    card.querySelector(`[data-f=${f}]`).onchange = ev =>
      post(`/api/job/${JOB.id}/hero/${i}`, { [f]: ev.target.value }).catch(() => {});
  });
  return card;
}

function renderHeroes() {
  const box = $('#heroes'); box.innerHTML = '';
  const count = Math.max(1, JOB.heroes.length);
  for (let i = 0; i < count; i++) box.appendChild(heroCard(i));
  $('#addHero').style.display = count >= 2 ? 'none' : '';
}
$('#addHero').onclick = () => { JOB.heroes.push({ name: '', desc: '', photos: [] }); renderHeroes(); };

function renderStyles() {
  const box = $('#styleChips'); box.innerHTML = '';
  Object.entries(STATUS.styles || {}).forEach(([k, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.classList.toggle('sel', (JOB.styleKey || 'kino') === k);
    b.onclick = () => { JOB.styleKey = k; saveMeta({ styleKey: k }); renderStyles(); };
    box.appendChild(b);
  });
}
$('#to2').onclick = () => {
  if (!JOB.heroes.length || !$('#heroes input[data-f=name]').value.trim()) return toast('Сначала заполни героя');
  showStep(2);
};

/* ---------- шаг 2: история ---------- */
const TONES = ['романтика', 'комедия', 'приключение', 'драма'];
function renderTones() {
  const box = $('#toneChips'); box.innerHTML = '';
  TONES.forEach(t => {
    const b = document.createElement('button');
    b.textContent = t;
    b.classList.toggle('sel', (JOB.tone || 'романтика') === t);
    b.onclick = () => { JOB.tone = t; saveMeta({ tone: t }); renderTones(); };
    box.appendChild(b);
  });
}
$('#pages').oninput = ev => { $('#pagesOut').value = ev.target.value; };
$('#pages').onchange = ev => saveMeta({ pagesCount: parseInt(ev.target.value, 10) });
$('#story').onchange = ev => saveMeta({ story: ev.target.value });

/* Диктовка (Chrome/Android). В браузерах без поддержки кнопка прячется. */
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $('#mic');
  if (!SR) { mic.style.display = 'none'; return; }
  let rec = null, active = false, base = '';
  mic.onclick = () => {
    if (active) { active = false; rec && rec.stop(); mic.classList.remove('rec'); mic.textContent = 'Голосом'; return; }
    rec = new SR();
    rec.lang = 'ru-RU'; rec.continuous = true; rec.interimResults = true;
    base = $('#story').value ? $('#story').value.trim() + ' ' : '';
    rec.onresult = e => {
      let fin = '', interim = '';
      for (let i = 0; i < e.results.length; i++)
        (e.results[i].isFinal ? fin += e.results[i][0].transcript : interim += e.results[i][0].transcript);
      $('#story').value = (base + fin + interim).trim();
    };
    rec.onend = () => { if (active) try { rec.start(); } catch {} };
    rec.onerror = ev2 => { if (ev2.error === 'not-allowed') { toast('Разреши микрофон или открой сайт в Chrome'); active = false; mic.classList.remove('rec'); mic.textContent = 'Голосом'; } };
    active = true; mic.classList.add('rec'); mic.textContent = 'Стоп';
    try { rec.start(); } catch {}
  };
})();

$('#to3').onclick = async ev => {
  const story = $('#story').value.trim();
  if (story.length < 10) return toast('Расскажи историю хотя бы парой предложений');
  await saveMeta({ story, pagesCount: parseInt($('#pages').value, 10) });
  const btn = ev.target; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Пишу сценарий…';
  try {
    const r = await post(`/api/job/${JOB.id}/script`);
    JOB.scenario = r.scenario;
    if (r.demo) toast('Демо-сценарий: мозг ещё не подключён, покажу на примере');
    renderScenario();
    showStep(3);
  } catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = 'Развернуть в сценарий';
};

/* ---------- шаг 3: редактор сценария ---------- */
const wordCount = s => (s || '').trim().split(/\s+/).filter(Boolean).length;

function renderScenario() {
  const sc = JOB.scenario; const box = $('#scenario'); box.innerHTML = '';
  if (!sc) { box.textContent = 'Сценария пока нет'; return; }
  const head = document.createElement('p');
  head.className = 'hint';
  head.textContent = `«${sc.title}» — ${sc.logline}`;
  box.appendChild(head);

  sc.pages.forEach((p, pi) => {
    const card = document.createElement('div'); card.className = 'page-card';
    card.innerHTML = `<h3>Страница ${pi + 1}</h3><div class="beat">${p.beat || ''}</div>`;
    p.rows.forEach(r => {
      const rowEl = document.createElement('div'); rowEl.className = 'panel-row';
      r.panels.forEach(pan => {
        const it = document.createElement('div'); it.className = 'panel-item';
        const ta = document.createElement('textarea'); ta.rows = 2; ta.value = pan.scene;
        ta.onchange = () => { pan.scene = ta.value; pushScenario(); };
        it.appendChild(ta);
        (pan.bubbles || []).forEach(b => {
          const line = document.createElement('div'); line.className = 'bubble-line';
          const who = document.createElement('select');
          JOB.heroes.filter(h => h.name).forEach(h => {
            const o = document.createElement('option'); o.value = o.textContent = h.name; who.appendChild(o);
          });
          const extra = document.createElement('option'); extra.value = extra.textContent = b.who || 'Голос'; who.appendChild(extra);
          who.value = b.who || 'Голос';
          who.onchange = () => { b.who = who.value; pushScenario(); };
          const inp = document.createElement('input'); inp.value = b.text;
          const check = () => inp.classList.toggle('too-long', wordCount(inp.value) > 8);
          check();
          inp.oninput = check;
          inp.onchange = () => { b.text = inp.value; pushScenario(); };
          line.appendChild(who); line.appendChild(inp); it.appendChild(line);
        });
        rowEl.appendChild(it);
      });
      card.appendChild(rowEl);
    });
    const actions = document.createElement('div'); actions.className = 'page-actions';
    const wish = document.createElement('input'); wish.placeholder = 'Пожелание: что поменять на странице';
    wish.style.cssText = 'flex:1;background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:8px';
    const rew = document.createElement('button'); rew.className = 'ghost'; rew.textContent = 'Переписать';
    rew.onclick = () => rewrite(pi, wish.value, 'rewrite', rew);
    const dia = document.createElement('button'); dia.className = 'ghost'; dia.textContent = 'Диалоги живее';
    dia.onclick = () => rewrite(pi, '', 'dialogs', dia);
    actions.appendChild(wish); actions.appendChild(rew); actions.appendChild(dia);
    card.appendChild(actions);
    box.appendChild(card);
  });
}

let pushT = null;
function pushScenario() {
  clearTimeout(pushT);
  pushT = setTimeout(() => saveMeta({ scenario: JOB.scenario }).catch(() => {}), 600);
}
async function rewrite(pageIndex, wish, mode, btn) {
  btn.disabled = true; const was = btn.textContent; btn.innerHTML = '<span class="spin"></span>…';
  try {
    const r = await post(`/api/job/${JOB.id}/rewrite`, { pageIndex, wish, mode });
    JOB.scenario.pages[pageIndex] = r.page;
    renderScenario();
    toast('Страница переписана');
  } catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = was;
}
$('#to4').onclick = () => {
  const bad = $$('#scenario input.too-long').length;
  if (bad) return toast(`Сократи ${bad} длинных реплик (подсвечены красным)`);
  updateDrawHint();
  showStep(4);
};

/* ---------- шаг 4: рисование и альбом ---------- */
function updateDrawHint() {
  const n = JOB.scenario ? JOB.scenario.pages.length : 0;
  const cents = n * (STATUS.pageCents || 5);
  $('#drawHint').textContent = `${n} страниц в двойной чёткости — ${cents}¢. Примерно ${Math.round(n * 3)} минут. Страницы появляются по мере готовности.`;
}
$('#draw').onclick = async ev => {
  const btn = ev.target;
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Ставлю в очередь…';
  try {
    await post(`/api/job/${JOB.id}/draw`);
    toast('Рисую! Страницы будут появляться ниже');
    startPolling();
  } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Нарисовать комикс'; }
};

function renderAlbum() {
  const box = $('#album'); box.innerHTML = '';
  const total = JOB.scenario ? JOB.scenario.pages.length : 0;
  const doneCnt = (JOB.pages || []).filter(p => p && p.status === 'done').length;
  if (doneCnt) {
    const c = JOB.cover;
    const el = document.createElement('div'); el.className = 'album-page cover-box';
    if (c && c.status === 'done' && c.url) {
      el.innerHTML = `<a href="${c.url}" target="_blank"><img src="${c.url}" loading="lazy"></a><div class="st">обложка — готова</div>`;
      const b = document.createElement('button'); b.className = 'ghost';
      b.textContent = `Переделать обложку (${STATUS.pageCents || 5}¢)`;
      b.onclick = () => makeCover(b);
      el.appendChild(b);
    } else if (c && c.status === 'drawing') {
      el.innerHTML = `<div class="skel"></div><div class="st"><span class="spin"></span>обложка — рисуется…</div>`;
    } else {
      el.innerHTML = `<div class="st">У книжки может быть обложка: название крупно + герои, как у настоящего выпуска.</div>`;
      const b = document.createElement('button'); b.className = 'ghost';
      b.textContent = `Сделать обложку (${STATUS.pageCents || 5}¢)`;
      b.onclick = () => makeCover(b);
      el.appendChild(b);
    }
    box.appendChild(el);
  }
  for (let i = 0; i < total; i++) {
    const p = (JOB.pages || [])[i];
    const el = document.createElement('div'); el.className = 'album-page';
    if (p && p.status === 'done' && p.url) {
      el.innerHTML = `<a href="${p.url}" target="_blank"><img src="${p.url}" loading="lazy"></a><div class="st">страница ${i + 1} — готова</div>`;
      const rd = document.createElement('div'); rd.className = 'redraw';
      const inp = document.createElement('input'); inp.placeholder = 'Что не так? (для перерисовки)';
      const b = document.createElement('button'); b.className = 'ghost'; b.textContent = `Перерисовать (${STATUS.pageCents || 5}¢)`;
      b.onclick = async () => {
        b.disabled = true;
        try {
          await post(`/api/job/${JOB.id}/redraw`, { pageIndex: i, wish: inp.value });
          toast('Перерисовываю страницу — пара минут');
          startPolling();
        } catch (e) { toast(e.message); b.disabled = false; }
      };
      rd.appendChild(inp); rd.appendChild(b); el.appendChild(rd);
    } else if (p && p.status === 'failed') {
      el.innerHTML = `<div class="skel" style="animation:none;display:flex;align-items:center;justify-content:center;color:var(--accent)">не вышла</div><div class="st">страница ${i + 1} — сбой, попробуем ещё</div>`;
    } else if (p && p.status === 'drawing') {
      el.innerHTML = `<div class="skel"></div><div class="st"><span class="spin"></span>страница ${i + 1} — рисуется…</div>`;
    } else {
      el.innerHTML = `<div class="skel" style="animation:none"></div><div class="st">страница ${i + 1} — в очереди</div>`;
    }
    box.appendChild(el);
  }
  const done = (JOB.pages || []).filter(p => p && p.status === 'done').length;
  $('#zip').style.display = done ? '' : 'none';
  $('#zip').href = `/api/job/${JOB.id}/zip`;
  if (JOB.status === 'drawing') {
    $('#draw').disabled = true;
    const left = total - done;
    $('#draw').innerHTML = `<span class="spin"></span>Рисуется… осталось ~${left * 3} мин`;
  } else if (JOB.status === 'done') {
    $('#draw').disabled = false; $('#draw').textContent = 'Готово! Нарисовать ещё раз';
  } else {
    $('#draw').disabled = false; $('#draw').textContent = 'Нарисовать комикс';
  }
}

async function makeCover(btn) {
  btn.disabled = true;
  try {
    await post(`/api/job/${JOB.id}/cover`);
    toast('Рисую обложку — пара минут');
    startPolling();
  } catch (e) { toast(e.message); btn.disabled = false; }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      JOB = await api('/api/job/' + JOB.id);
      renderAlbum();
      if (JOB.status === 'done' || JOB.status === 'partial') { clearInterval(pollTimer); toast('Комикс готов'); }
    } catch {}
  }, 4000);
}

/* ---------- пример на главной ---------- */
const EXAMPLE_STORY = 'Мы познакомились под дождём: у неё ветром вырвало красный зонт, я его поймал. Она написала номер на моём пакете с продуктами, но дождь смыл цифры. Я нашёл её через кофейню — бариста подсказал, что она приходит по средам. Она написала номер маркером мне на руке со словами «этот не смоется». Теперь у нас один зонт на двоих.';
function renderExample() {
  const strip = $('#exStrip');
  if (!strip) return;
  strip.innerHTML = Array.from({ length: 8 }, (_, i) =>
    `<a href="example/${i + 1}.jpg" target="_blank"><img src="example/${i + 1}.jpg" loading="lazy" alt="страница ${i + 1}"></a>`).join('');
  const fill = $('#fillExample');
  if (fill) fill.onclick = () => {
    $('#story').value = EXAMPLE_STORY;
    $('#pages').value = 8; $('#pagesOut').value = 8;
    toast('Пример подставлен — можешь править или сразу разворачивать');
  };
}

/* ---------- старт ---------- */
(async function init() {
  renderExample();
  const cta = $('#ctaStart');
  if (cta) cta.onclick = () => document.getElementById('steps').scrollIntoView({ behavior: 'smooth' });
  try {
    STATUS = await api('/api/status');
    const rem = STATUS.remainingCredits;
    $('#wallet').textContent = rem != null ? `хватит на ~${Math.floor(rem / (STATUS.pageCents * 2))} стр.` : '';
    await ensureJob();
    renderStyles(); renderHeroes(); renderTones();
    if (JOB.story) $('#story').value = JOB.story;
    if (JOB.pagesCount) { $('#pages').value = JOB.pagesCount; $('#pagesOut').value = JOB.pagesCount; }
    if (JOB.scenario) renderScenario();
    if (JOB.status === 'drawing' || (JOB.pages || []).length) { renderAlbum(); showStep(4); if (JOB.status === 'drawing') startPolling(); }
  } catch (e) {
    toast('Сервер недоступен: ' + e.message);
  }
})();
