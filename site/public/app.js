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
// По шагам можно ходить свободно назад, но вперёд — только если шаг готов:
// иначе человек попадает на пустой экран и не понимает, что от него хотят.
function canGo(n) {
  if (n >= 2 && !JOB.heroes.some(h => h.sheet)) return 'Сначала сделай героя: фото и кнопка «Создать лист героя»';
  if (n >= 3 && !JOB.scenario) return 'Сначала расскажи историю и разверни её в сценарий';
  return null;
}
$$('#steps button').forEach(b => b.onclick = () => {
  const n = parseInt(b.dataset.step, 10);
  const stop = canGo(n);
  if (stop) return toast(stop);
  if (n === 3) renderScenario();
  if (n === 4) { updateDrawHint(); renderAlbum(); }
  showStep(n);
});
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
const reload = async () => { JOB = await api('/api/job/' + JOB.id); };

function heroCard(i) {
  const h = JOB.heroes[i] || { name: '', desc: '', photos: [] };
  const photos = h.photos || [];
  const card = document.createElement('div');
  card.className = 'hero-card';
  card.innerHTML = `
    <div class="hero-head">
      <span class="hero-num">ГЕРОЙ ${i + 1}</span>
      <button class="link-del" data-del title="Убрать героя">убрать</button>
    </div>
    <div class="drop" data-drop>
      <div class="photos"></div>
      <div class="drop-hint">Перетащи фото сюда или нажми, чтобы выбрать. 1–3 штуки, лучше анфас и вполоборота.</div>
    </div>
    <div class="card-fields"></div>
    <div class="sheet-wrap"></div>`;

  /* --- фото --- */
  const photosBox = card.querySelector('.photos');
  const drop = card.querySelector('[data-drop]');
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.multiple = true; fileInput.style.display = 'none';
  card.appendChild(fileInput);

  photos.forEach(u => {
    const cell = document.createElement('div'); cell.className = 'photo-cell';
    const im = document.createElement('img'); im.src = u;
    const del = document.createElement('button'); del.className = 'photo-del'; del.textContent = '×'; del.title = 'Удалить фото';
    del.onclick = async ev => {
      ev.stopPropagation();
      try {
        await post(`/api/job/${JOB.id}/hero/${i}/photo/remove`, { url: u });
        await reload(); renderHeroes(); toast('Фото удалено');
      } catch (e) { toast(e.message); }
    };
    cell.appendChild(im); cell.appendChild(del); photosBox.appendChild(cell);
  });
  if (photos.length < 3) {
    const add = document.createElement('button');
    add.className = 'add'; add.textContent = '+'; add.title = 'Загрузить фото';
    add.onclick = ev => { ev.stopPropagation(); fileInput.click(); };
    photosBox.appendChild(add);
  }

  async function upload(files) {
    const list = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, 3 - photos.length);
    if (!list.length) return toast(photos.length >= 3 ? 'Больше трёх фото не нужно' : 'Нужен файл с картинкой');
    const fd = new FormData(); list.forEach(f => fd.append('photos', f));
    drop.classList.add('busy');
    try {
      await api(`/api/job/${JOB.id}/hero/${i}/photos`, { method: 'POST', body: fd });
      await reload(); renderHeroes();
      toast('Фото загружены, читаю внешность…');
      describe(i);                       // карточка заполняется сама
    } catch (e) { toast(e.message); drop.classList.remove('busy'); }
  }
  fileInput.onchange = () => upload(fileInput.files);
  drop.onclick = () => { if (photos.length < 3) fileInput.click(); };
  drop.ondragover = ev => { ev.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = ev => { ev.preventDefault(); drop.classList.remove('over'); upload(ev.dataTransfer.files); };

  /* --- карточка персонажа --- */
  const fields = card.querySelector('.card-fields');
  const nameInp = document.createElement('input');
  nameInp.className = 'hero-name';
  nameInp.placeholder = 'Имя героя — как его зовут в репликах';
  nameInp.value = h.name || '';
  nameInp.onchange = () => post(`/api/job/${JOB.id}/hero/${i}`, { name: nameInp.value }).then(reload).catch(() => {});
  fields.appendChild(nameInp);

  if (h.desc) {
    const box = document.createElement('div'); box.className = 'desc-box';
    box.innerHTML = `<div class="desc-label">${h.descAuto ? 'ВНЕШНОСТЬ — СЧИТАНА С ФОТО' : 'ВНЕШНОСТЬ ГЕРОЯ'}</div>`;
    const text = document.createElement('div'); text.className = 'desc-text'; text.textContent = h.desc;
    box.appendChild(text);
    const row = document.createElement('div'); row.className = 'desc-actions';
    const edit = document.createElement('button'); edit.className = 'ghost small'; edit.textContent = 'Поправить';
    edit.onclick = () => {
      const ta = document.createElement('textarea'); ta.rows = 3; ta.value = h.desc; ta.className = 'desc-edit';
      text.replaceWith(ta); row.remove(); ta.focus();
      ta.onblur = async () => {
        try { await post(`/api/job/${JOB.id}/hero/${i}`, { desc: ta.value }); await reload(); renderHeroes(); }
        catch (e) { toast(e.message); }
      };
    };
    row.appendChild(edit);
    if (photos.length) {
      const again = document.createElement('button'); again.className = 'ghost small'; again.textContent = 'Прочитать фото заново';
      again.onclick = () => describe(i);
      row.appendChild(again);
    }
    box.appendChild(row);
    fields.appendChild(box);
  } else if (!photos.length) {
    const ta = document.createElement('textarea');
    ta.rows = 2; ta.className = 'desc-edit';
    ta.placeholder = 'Героя без фото опиши словами: волосы, одежда, возраст, вайб';
    ta.onchange = () => post(`/api/job/${JOB.id}/hero/${i}`, { desc: ta.value }).then(reload).catch(() => {});
    fields.appendChild(ta);
  }

  /* --- лист героя --- */
  const sheetWrap = card.querySelector('.sheet-wrap');
  if (h.sheet) { const im = document.createElement('img'); im.src = h.sheet; sheetWrap.appendChild(im); }
  const gen = document.createElement('button');
  gen.className = 'primary';
  gen.textContent = (h.sheet ? 'Перерисовать лист' : 'Создать лист героя') + ` (${STATUS.heroCents || 4}¢)`;
  gen.onclick = async () => {
    if (!nameInp.value.trim()) { nameInp.focus(); return toast('Дай герою имя — оно нужно для реплик'); }
    if (!photos.length && !h.desc) return toast('Загрузи фото или опиши героя словами');
    gen.disabled = true; gen.innerHTML = '<span class="spin"></span>Рисую лист (~минута)…';
    try {
      await post(`/api/job/${JOB.id}/hero/${i}`, { name: nameInp.value.trim(), generate: true });
      await reload(); renderHeroes(); toast('Лист героя готов');
    } catch (e) { toast(e.message); gen.disabled = false; gen.textContent = 'Создать лист героя'; }
  };
  sheetWrap.appendChild(gen);

  card.querySelector('[data-del]').onclick = async () => {
    if (JOB.heroes.length <= 1 && !photos.length && !h.name) return;
    if (!confirm('Убрать этого героя?')) return;
    try { await post(`/api/job/${JOB.id}/hero/${i}/remove`); await reload(); renderHeroes(); }
    catch (e) { toast(e.message); }
  };
  return card;
}

async function describe(i) {
  const card = $$('#heroes .hero-card')[i];
  if (card) card.classList.add('reading');
  try {
    await post(`/api/job/${JOB.id}/hero/${i}/describe`);
    await reload(); renderHeroes();
    toast('Внешность считана с фото — можешь поправить');
  } catch (e) {
    await reload(); renderHeroes();
    toast(e.message);
  }
}

function renderHeroes() {
  const box = $('#heroes'); box.innerHTML = '';
  if (!JOB.heroes.length) JOB.heroes.push({ name: '', desc: '', photos: [] });
  JOB.heroes.forEach((_, i) => box.appendChild(heroCard(i)));
  $('#addHero').style.display = JOB.heroes.length >= 2 ? 'none' : '';
}
$('#addHero').onclick = () => { JOB.heroes.push({ name: '', desc: '', photos: [] }); renderHeroes(); };

function renderStyles() {
  const box = $('#styleChips'); box.innerHTML = '';
  Object.entries(STATUS.styles || {}).forEach(([k, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.classList.toggle('sel', (JOB.styleKey || 'kino') === k);
    b.onclick = () => {
      const drawn = JOB.heroes.some(h => h.sheet);
      // Стиль вшит в лист героя: сменил стиль — лист надо перерисовать, иначе
      // книжка выйдет в одном стиле, а герой в другом.
      if (drawn && k !== JOB.styleKey && !confirm('Листы героев нарисованы в прежнем стиле. Их нужно будет перерисовать, иначе стиль книжки не сойдётся. Сменить стиль?')) return;
      JOB.styleKey = k; saveMeta({ styleKey: k }); renderStyles();
      if (drawn) toast('Стиль сменён — перерисуй листы героев');
    };
    box.appendChild(b);
  });
}
$('#to2').onclick = () => {
  const ready = JOB.heroes.filter(h => h.name && h.sheet);
  if (!ready.length) {
    const named = JOB.heroes.some(h => h.name);
    return toast(named ? 'Создай лист героя — по нему рисуется вся книжка' : 'Загрузи фото и дай герою имя');
  }
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
function updatePagesHint() {
  const n = parseInt($('#pages').value, 10);
  $('#pagesOut').value = n;
  const el = $('#pagesHint');
  if (el) el.textContent = `${n * (STATUS.pageCents || 5)}¢ · примерно ${Math.round(n * 2.5)} мин рисования`;
}
$('#pages').oninput = updatePagesHint;
$('#pages').onchange = ev => { updatePagesHint(); saveMeta({ pagesCount: parseInt(ev.target.value, 10) }); };

function updateStoryHint() {
  const len = $('#story').value.trim().length;
  const el = $('#storyCount');
  if (!el) return;
  el.textContent = len < 40
    ? `${len} символов — расскажи чуть подробнее, хотя бы пару предложений`
    : `${len} символов — этого хватит, чем больше деталей, тем живее книжка`;
  el.classList.toggle('warn', len < 40);
}
let storyT = null;
$('#story').oninput = () => {
  updateStoryHint();
  clearTimeout(storyT);
  storyT = setTimeout(() => { setSaved('сохраняю…'); saveMeta({ story: $('#story').value }).then(() => setSaved('сохранено')).catch(() => {}); }, 800);
};

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
  if (story.length < 20) return toast('Расскажи историю хотя бы парой предложений');
  if (JOB.scenario && !confirm('Сценарий будет написан заново, твои правки в нём пропадут. Продолжить?')) return;
  const btn = ev.target.closest('button');
  const was = btn.textContent;
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Пишу сценарий (~полминуты)…';
  try {
    await saveMeta({ story, pagesCount: parseInt($('#pages').value, 10) });
    const r = await post(`/api/job/${JOB.id}/script`);
    JOB.scenario = r.scenario;
    if (r.demo) toast('Показываю сценарий-образец: мозг сценариста пока не подключён');
    else if (r.warnings && r.warnings.length) toast('Сценарий готов, пару мест я подровнял сам');
    renderScenario();
    updateDrawHint();
    showStep(3);
  } catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = was;
};

/* ---------- шаг 3: редактор сценария ---------- */
const wordCount = s => (s || '').trim().split(/\s+/).filter(Boolean).length;
const COLS_BY_COUNT = { 1: [3], 2: [2, 1], 3: [1, 1, 1] };

// Ширины кадров в ряду обязаны складываться в 3 колонки — держим это сами,
// чтобы человек мог свободно добавлять и удалять кадры.
function fixRow(row) {
  const w = COLS_BY_COUNT[row.panels.length] || [1, 1, 1];
  row.panels.forEach((pan, k) => { pan.cols = w[k]; });
}
function panelCount(p) { return p.rows.reduce((a, r) => a + r.panels.length, 0); }

function renderScenario() {
  const sc = JOB.scenario; const box = $('#scenario'); box.innerHTML = '';
  if (!sc) { box.textContent = 'Сценария пока нет'; return; }

  const head = document.createElement('div'); head.className = 'sc-head';
  const title = document.createElement('input');
  title.className = 'sc-title'; title.value = sc.title || 'Без названия';
  title.onchange = () => { sc.title = title.value.trim() || 'Без названия'; pushScenario(); };
  const log = document.createElement('div'); log.className = 'sc-logline'; log.textContent = sc.logline || '';
  head.appendChild(title); head.appendChild(log);
  box.appendChild(head);

  sc.pages.forEach((p, pi) => {
    const card = document.createElement('div'); card.className = 'page-card';

    const top = document.createElement('div'); top.className = 'page-top';
    const h = document.createElement('h3'); h.textContent = `Страница ${pi + 1} из ${sc.pages.length}`;
    const cnt = document.createElement('span');
    const n = panelCount(p);
    cnt.className = 'panel-count' + (n < 4 || n > 7 ? ' warn' : '');
    cnt.textContent = `${n} ${n === 1 ? 'кадр' : n < 5 ? 'кадра' : 'кадров'}`;
    const del = document.createElement('button'); del.className = 'link-del'; del.textContent = 'удалить страницу';
    del.onclick = () => {
      if (sc.pages.length <= 1) return toast('Должна остаться хотя бы одна страница');
      if (!confirm(`Удалить страницу ${pi + 1}?`)) return;
      sc.pages.splice(pi, 1); sc.pages.forEach((x, k) => { x.n = k + 1; });
      pushScenario(); renderScenario(); updateDrawHint();
    };
    top.appendChild(h); top.appendChild(cnt); top.appendChild(del);
    card.appendChild(top);

    const beat = document.createElement('input');
    beat.className = 'beat-input'; beat.value = p.beat || ''; beat.placeholder = 'Суть страницы одной фразой';
    beat.onchange = () => { p.beat = beat.value; pushScenario(); };
    card.appendChild(beat);

    p.rows.forEach((r, ri) => {
      const rowEl = document.createElement('div'); rowEl.className = 'panel-row';
      r.panels.forEach((pan, ni) => {
        const it = document.createElement('div'); it.className = 'panel-item';

        const hdr = document.createElement('div'); hdr.className = 'panel-hdr';
        const label = document.createElement('span');
        label.className = 'panel-label';
        label.textContent = `Кадр ${ri + 1}.${ni + 1} · ширина ${pan.cols || 1} из 3`;
        const pdel = document.createElement('button'); pdel.className = 'link-del'; pdel.textContent = 'убрать кадр';
        pdel.onclick = () => {
          r.panels.splice(ni, 1);
          if (!r.panels.length) p.rows.splice(ri, 1); else fixRow(r);
          if (!p.rows.length) { toast('На странице не осталось кадров'); sc.pages.splice(pi, 1); }
          pushScenario(); renderScenario();
        };
        hdr.appendChild(label); hdr.appendChild(pdel);
        it.appendChild(hdr);

        const ta = document.createElement('textarea'); ta.rows = 2; ta.value = pan.scene;
        ta.placeholder = 'Что видно в кадре: кто где, что делает, свет, ракурс';
        ta.onchange = () => { pan.scene = ta.value; pushScenario(); };
        it.appendChild(ta);

        const cap = document.createElement('input');
        cap.className = 'cap-input'; cap.value = pan.caption || '';
        cap.placeholder = 'Плашка времени или места — например «Вторник. 20:47» (можно пусто)';
        cap.onchange = () => { pan.caption = cap.value.trim() || undefined; pushScenario(); };
        it.appendChild(cap);

        const bubbles = document.createElement('div');
        const drawBubbles = () => {
          bubbles.innerHTML = '';
          (pan.bubbles || []).forEach((b, bi) => {
            const line = document.createElement('div'); line.className = 'bubble-line';
            const who = document.createElement('select');
            const names = JOB.heroes.filter(h => h.name).map(h => h.name);
            if (b.who && !names.includes(b.who)) names.push(b.who);
            if (!names.includes('Голос')) names.push('Голос');
            names.forEach(nm => { const o = document.createElement('option'); o.value = o.textContent = nm; who.appendChild(o); });
            who.value = b.who || names[0];
            who.onchange = () => { b.who = who.value; pushScenario(); };

            const type = document.createElement('select');
            [['speech', 'реплика'], ['thought', 'мысль'], ['shout', 'крик']].forEach(([v, t]) => {
              const o = document.createElement('option'); o.value = v; o.textContent = t; type.appendChild(o);
            });
            type.value = b.type || 'speech';
            type.onchange = () => { b.type = type.value; pushScenario(); };

            const inp = document.createElement('input'); inp.value = b.text;
            const check = () => inp.classList.toggle('too-long', wordCount(inp.value) > 8);
            check(); inp.oninput = check;
            inp.onchange = () => { b.text = inp.value; pushScenario(); };

            const bdel = document.createElement('button'); bdel.className = 'x-btn'; bdel.textContent = '×'; bdel.title = 'Убрать реплику';
            bdel.onclick = () => { pan.bubbles.splice(bi, 1); pushScenario(); drawBubbles(); };

            line.append(who, type, inp, bdel);
            bubbles.appendChild(line);
          });
          if ((pan.bubbles || []).length < 2) {
            const addB = document.createElement('button');
            addB.className = 'ghost small'; addB.textContent = '+ реплика';
            addB.onclick = () => {
              pan.bubbles = pan.bubbles || [];
              const first = (JOB.heroes.find(h => h.name) || {}).name || 'Голос';
              pan.bubbles.push({ who: first, text: '', type: 'speech' });
              pushScenario(); drawBubbles();
            };
            bubbles.appendChild(addB);
          }
        };
        drawBubbles();
        it.appendChild(bubbles);
        rowEl.appendChild(it);
      });

      if (r.panels.length < 3) {
        const addP = document.createElement('button');
        addP.className = 'ghost small add-panel'; addP.textContent = '+ кадр в этот ряд';
        addP.onclick = () => {
          r.panels.push({ cols: 1, scene: '', bubbles: [] });
          fixRow(r); pushScenario(); renderScenario();
        };
        rowEl.appendChild(addP);
      }
      card.appendChild(rowEl);
    });

    if (p.rows.length < 3) {
      const addR = document.createElement('button');
      addR.className = 'ghost small'; addR.textContent = '+ ряд кадров';
      addR.onclick = () => {
        p.rows.push({ panels: [{ cols: 3, scene: '', bubbles: [] }] });
        pushScenario(); renderScenario();
      };
      card.appendChild(addR);
    }

    const actions = document.createElement('div'); actions.className = 'page-actions';
    const wish = document.createElement('input');
    wish.className = 'wish-input'; wish.placeholder = 'Пожелание: что поменять на странице';
    const rew = document.createElement('button'); rew.className = 'ghost'; rew.textContent = 'Переписать';
    rew.onclick = () => rewrite(pi, wish.value, 'rewrite', rew);
    const dia = document.createElement('button'); dia.className = 'ghost'; dia.textContent = 'Диалоги живее';
    dia.onclick = () => rewrite(pi, '', 'dialogs', dia);
    actions.append(wish, rew, dia);
    card.appendChild(actions);
    box.appendChild(card);
  });

  const foot = document.createElement('div'); foot.className = 'sc-foot';
  const addPage = document.createElement('button');
  addPage.className = 'ghost'; addPage.textContent = '+ Добавить страницу';
  addPage.onclick = () => {
    if (sc.pages.length >= (STATUS.maxPages || 12)) return toast(`Больше ${STATUS.maxPages || 12} страниц пока нельзя`);
    sc.pages.push({
      n: sc.pages.length + 1, beat: '',
      rows: [{ panels: [{ cols: 3, scene: '', bubbles: [] }] }, { panels: [{ cols: 2, scene: '', bubbles: [] }, { cols: 1, scene: '', bubbles: [] }] }]
    });
    pushScenario(); renderScenario(); updateDrawHint();
  };
  const again = document.createElement('button');
  again.className = 'ghost'; again.textContent = 'Написать сценарий заново';
  again.onclick = async () => {
    if (!confirm('Переписать весь сценарий с нуля? Твои правки пропадут.')) return;
    again.disabled = true; again.innerHTML = '<span class="spin"></span>Пишу…';
    try {
      const r = await post(`/api/job/${JOB.id}/script`);
      JOB.scenario = r.scenario; renderScenario(); updateDrawHint(); toast('Готов новый сценарий');
    } catch (e) { toast(e.message); }
    again.disabled = false; again.textContent = 'Написать сценарий заново';
  };
  const price = document.createElement('div'); price.className = 'sc-price';
  price.textContent = `${sc.pages.length} стр. — ${sc.pages.length * (STATUS.pageCents || 5)}¢`;
  foot.append(addPage, again, price);
  box.appendChild(foot);
}

let pushT = null;
function pushScenario() {
  clearTimeout(pushT);
  setSaved('сохраняю…');
  pushT = setTimeout(() => saveMeta({ scenario: JOB.scenario })
    .then(() => setSaved('сохранено'))
    .catch(() => setSaved('не сохранилось')), 600);
}
function setSaved(text) {
  const el = $('#saved');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._h);
  el._h = setTimeout(() => el.classList.remove('show'), 2000);
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
  if (!JOB.scenario) return toast('Сначала разверни историю в сценарий');
  const bad = $$('#scenario input.too-long').length;
  if (bad) return toast(`Сократи ${bad} длинных реплик (подсвечены красным)`);
  const empty = JOB.scenario.pages.some(p => p.rows.some(r => r.panels.some(x => !(x.scene || '').trim())));
  if (empty) return toast('Есть пустые кадры — опиши их или убери');
  updateDrawHint();
  showStep(4);
};

/* ---------- шаг 4: рисование и альбом ---------- */
const plural = (n, a, b, c) => n % 10 === 1 && n % 100 !== 11 ? a : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);

function updateDrawHint() {
  const n = JOB.scenario ? JOB.scenario.pages.length : 0;
  const cents = n * (STATUS.pageCents || 5);
  const el = $('#drawHint');
  if (!el) return;
  el.textContent = `${n} ${plural(n, 'страница', 'страницы', 'страниц')} в двойной чёткости — ${cents}¢, примерно ${Math.round(n * 2.5)} мин. Страницы появляются по мере готовности, каждую можно перерисовать.`;
}
$('#draw').onclick = async ev => {
  const btn = ev.target.closest('button');
  const was = btn.textContent;
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Ставлю в очередь…';
  try {
    await post(`/api/job/${JOB.id}/draw`);
    JOB = await api('/api/job/' + JOB.id);
    renderAlbum();
    toast('Рисую! Страницы будут появляться ниже');
    startPolling();
  } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = was; }
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
      el.innerHTML = `<div class="skel failed">не вышла</div><div class="st">страница ${i + 1} — сбой рисования</div>`;
      const again = document.createElement('button'); again.className = 'ghost';
      again.textContent = `Попробовать ещё раз (${STATUS.pageCents || 5}¢)`;
      again.onclick = async () => {
        again.disabled = true;
        try { await post(`/api/job/${JOB.id}/redraw`, { pageIndex: i, wish: '' }); toast('Рисую заново'); startPolling(); }
        catch (e) { toast(e.message); again.disabled = false; }
      };
      el.appendChild(again);
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
  const tg = $('#toTelegram');
  if (tg) tg.style.display = done && STATUS.telegram ? '' : 'none';

  const btn = $('#draw');
  if (JOB.status === 'drawing') {
    btn.disabled = true;
    const left = Math.max(1, total - done);
    btn.innerHTML = `<span class="spin"></span>Рисуется… осталось ~${Math.round(left * 2.5)} мин`;
  } else if (JOB.status === 'stalled') {
    btn.disabled = false;
    btn.textContent = 'Продолжить рисование';
    if (!$('#stalledNote')) {
      const note = document.createElement('p');
      note.id = 'stalledNote'; note.className = 'hint warn-hint';
      note.textContent = 'Рисование прервалось (облако усыпило сервер). Готовые страницы целы — жми «Продолжить», дорисуем остальные.';
      $('#drawHint').after(note);
    }
  } else if (JOB.status === 'done' || (done && done === total)) {
    btn.disabled = false; btn.textContent = 'Нарисовать заново';
    const note = $('#stalledNote'); if (note) note.remove();
  } else {
    btn.disabled = false; btn.textContent = done ? 'Дорисовать остальные' : 'Нарисовать комикс';
    const note = $('#stalledNote'); if (note) note.remove();
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
      if (JOB.status !== 'drawing') {
        clearInterval(pollTimer);
        if (JOB.status === 'done') toast('Комикс готов');
        else if (JOB.status === 'stalled') toast('Рисование прервалось — жми «Продолжить»');
        else if (JOB.status === 'partial') toast('Часть страниц не вышла — перерисуй их');
      }
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

/* ---------- общие кнопки ---------- */
function bindGlobal() {
  const cta = $('#ctaStart');
  if (cta) cta.onclick = () => { showStep(1); document.querySelector('#steps').scrollIntoView({ behavior: 'smooth' }); };

  const tg = $('#toTelegram');
  if (tg) tg.onclick = async () => {
    tg.disabled = true;
    try { const r = await post(`/api/job/${JOB.id}/telegram`); toast(`Отправляю в телеграм: ${r.count} шт.`); }
    catch (e) { toast(e.message); }
    tg.disabled = false;
  };

  const reset = $('#resetJob');
  if (reset) reset.onclick = async () => {
    if (!confirm('Начать новый комикс? Текущий останется по ссылке, но с экрана уйдёт.')) return;
    localStorage.removeItem('nearx_job');
    location.reload();
  };
}

/* ---------- старт ---------- */
(async function init() {
  renderExample();
  bindGlobal();
  try {
    STATUS = await api('/api/status');
    const rem = STATUS.remainingCredits;
    const left = rem != null ? Math.floor(rem / (STATUS.pageCents * 2)) : null;
    $('#wallet').textContent = left == null ? '' : (left > 0 ? `хватит на ~${left} стр.` : 'краски кончились');
    if (STATUS.llm === 'demo') toast('Сценарист сейчас показывает образец: мозг ещё не подключён');
    await ensureJob();
    renderStyles(); renderHeroes(); renderTones();
    if (JOB.story) $('#story').value = JOB.story;
    if (JOB.pagesCount) $('#pages').value = JOB.pagesCount;
    updatePagesHint(); updateStoryHint();
    if (JOB.scenario) { renderScenario(); updateDrawHint(); }
    // Возвращаем человека туда, где он остановился.
    if (JOB.status === 'drawing' || JOB.status === 'stalled' || (JOB.pages || []).some(Boolean)) {
      renderAlbum(); showStep(4);
      if (JOB.status === 'drawing') startPolling();
    } else if (JOB.scenario) showStep(3);
    else if (JOB.heroes.some(h => h.sheet)) showStep(2);
  } catch (e) {
    toast('Сервер недоступен: ' + e.message);
  }
})();
