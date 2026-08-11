#!/usr/bin/env node
// Проверка сайта от лица пользователя: проходит весь путь и говорит, что сломано.
// node tools/audit.cjs [базовый-адрес] [--paid]   (--paid включает платные шаги)

const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://localhost:3777';
const PAID = process.argv.includes('--paid');
const PHOTOS = [
  path.resolve(__dirname, '../../фото/vladelec-anfas.jpg'),
  path.resolve(__dirname, '../../фото/vladelec-profil.jpg')
];

let pass = 0, fail = 0;
const ok = (name, extra = '') => { pass++; console.log(`  ок    ${name}${extra ? ' — ' + extra : ''}`); };
const bad = (name, why) => { fail++; console.log(`  СБОЙ  ${name} — ${String(why).slice(0, 160)}`); };

async function req(method, url, body, isForm) {
  const opts = { method };
  if (isForm) opts.body = body;
  else if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + url, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

async function check(name, fn) {
  try {
    const extra = await fn();
    ok(name, extra || '');
  } catch (e) { bad(name, e.message); }
}

(async () => {
  console.log(`Проверяю ${BASE}\n`);
  let status, jobId;

  await check('главная страница отдаётся', async () => {
    const r = await fetch(BASE + '/');
    if (!r.ok) throw new Error('код ' + r.status);
    const html = await r.text();
    ['cta-burst', 'plate-title', 'resetJob', 'toTelegram', 'storyCount', 'pagesHint'].forEach(k => {
      if (!html.includes(k)) throw new Error('в разметке нет ' + k);
    });
    return 'все блоки на месте';
  });

  await check('стили и скрипт отдаются', async () => {
    for (const f of ['/styles.css', '/app.js']) {
      const r = await fetch(BASE + f);
      if (!r.ok) throw new Error(f + ': код ' + r.status);
    }
    return 'ok';
  });

  await check('статус сервиса', async () => {
    const r = await req('GET', '/api/status');
    if (r.status !== 200) throw new Error('код ' + r.status);
    status = r.data;
    if (!status.styles || !Object.keys(status.styles).length) throw new Error('нет стилей');
    return `мозг=${status.llm}, страница=${status.pageCents}¢, телеграм=${status.telegram ? 'есть' : 'нет'}`;
  });

  await check('заявка создаётся', async () => {
    const r = await req('POST', '/api/job');
    if (!r.data.id) throw new Error(JSON.stringify(r.data));
    jobId = r.data.id;
    return jobId.slice(0, 8);
  });

  await check('фото героя загружаются', async () => {
    const fd = new FormData();
    for (const p of PHOTOS) fd.append('photos', new Blob([fs.readFileSync(p)]), path.basename(p));
    const r = await req('POST', `/api/job/${jobId}/hero/0/photos`, fd, true);
    if (r.status !== 200 || (r.data.photos || []).length !== 2) throw new Error(JSON.stringify(r.data));
    return '2 шт.';
  });

  await check('фото открывается по ссылке', async () => {
    const job = (await req('GET', `/api/job/${jobId}`)).data;
    const url = job.heroes[0].photos[0];
    const r = await fetch(BASE + url);
    if (!r.ok) throw new Error('код ' + r.status);
    return url.split('/').pop();
  });

  await check('лишнее фото удаляется', async () => {
    const job = (await req('GET', `/api/job/${jobId}`)).data;
    const url = job.heroes[0].photos[1];
    const r = await req('POST', `/api/job/${jobId}/hero/0/photo/remove`, { url });
    if (r.status !== 200 || r.data.photos.length !== 1) throw new Error(JSON.stringify(r.data));
    const still = await fetch(BASE + url);
    if (still.ok) throw new Error('файл всё ещё доступен');
    return 'осталось 1';
  });

  await check('внешность считывается с фото', async () => {
    const r = await req('POST', `/api/job/${jobId}/hero/0/describe`);
    if (status.llm !== 'on') {
      if (r.status !== 503) throw new Error('без мозга должен быть честный отказ, а код ' + r.status);
      return 'мозг выключен — отказ понятный';
    }
    if (r.status !== 200 || !r.data.desc) throw new Error(JSON.stringify(r.data));
    if (r.data.desc.length < 20) throw new Error('описание слишком короткое: ' + r.data.desc);
    return '«' + r.data.desc.slice(0, 90) + '…»';
  });

  await check('имя героя сохраняется', async () => {
    await req('POST', `/api/job/${jobId}/hero/0`, { name: 'Макс' });
    const job = (await req('GET', `/api/job/${jobId}`)).data;
    if (job.heroes[0].name !== 'Макс') throw new Error('имя не сохранилось');
    return 'Макс';
  });

  await check('второй герой добавляется и удаляется', async () => {
    await req('POST', `/api/job/${jobId}/hero/1`, { name: 'Ника', desc: 'тёмно-рыжие волосы, джинсовка' });
    let job = (await req('GET', `/api/job/${jobId}`)).data;
    if (job.heroes.length !== 2) throw new Error('второй не добавился');
    await req('POST', `/api/job/${jobId}/hero/1/remove`);
    job = (await req('GET', `/api/job/${jobId}`)).data;
    if (job.heroes.length !== 1) throw new Error('не удалился');
    return 'ok';
  });

  await check('короткая история отклоняется', async () => {
    await req('POST', `/api/job/${jobId}/meta`, { story: 'привет' });
    const r = await req('POST', `/api/job/${jobId}/script`);
    if (r.status !== 400) throw new Error('принял огрызок, код ' + r.status);
    return 'просит рассказать подробнее';
  });

  await check('рисование без листа героя не стартует', async () => {
    const r = await req('POST', `/api/job/${jobId}/draw`);
    if (r.status === 200) throw new Error('запустил рисование без героя');
    return 'остановил и объяснил';
  });

  await check('сценарий пишется по истории', async () => {
    await req('POST', `/api/job/${jobId}/meta`, {
      story: 'Я забыл дома зонт, попал под ливень и спрятался в маленькой книжной лавке. Продавщица налила мне чай, мы проговорили про комиксы до самого закрытия. На следующий день я вернулся туда с двумя стаканами кофе.',
      tone: 'романтика', pagesCount: 3
    });
    const r = await req('POST', `/api/job/${jobId}/script`);
    if (r.status !== 200) throw new Error(JSON.stringify(r.data));
    const sc = r.data.scenario;
    if (!sc.pages || !sc.pages.length) throw new Error('нет страниц');
    const problems = [];
    sc.pages.forEach((p, i) => {
      const panels = p.rows.reduce((a, x) => a + x.panels.length, 0);
      if (panels < 4 || panels > 8) problems.push(`стр.${i + 1}: кадров ${panels}`);
      p.rows.forEach((row, ri) => {
        const sum = row.panels.reduce((a, x) => a + (x.cols || 0), 0);
        if (sum !== 3) problems.push(`стр.${i + 1} ряд ${ri + 1}: ширины ${sum}`);
        row.panels.forEach(pan => (pan.bubbles || []).forEach(b => {
          if (b.text.split(/\s+/).length > 9) problems.push(`длинная реплика «${b.text}»`);
        }));
      });
    });
    if (problems.length) throw new Error(problems.slice(0, 3).join('; '));
    const bubbles = sc.pages.reduce((a, p) => a + p.rows.reduce((s, r) => s + r.panels.reduce((k, x) => k + (x.bubbles || []).length, 0), 0), 0);
    return `${r.data.demo ? 'демо' : 'живой'}: «${sc.title}», страниц ${sc.pages.length}, реплик ${bubbles}`;
  });

  await check('правки сценария сохраняются', async () => {
    const job = (await req('GET', `/api/job/${jobId}`)).data;
    const sc = job.scenario;
    sc.title = 'Проверка правки';
    sc.pages[0].rows[0].panels[0].scene = 'проверочная сцена';
    await req('POST', `/api/job/${jobId}/meta`, { scenario: sc });
    const back = (await req('GET', `/api/job/${jobId}`)).data.scenario;
    if (back.title !== 'Проверка правки' || back.pages[0].rows[0].panels[0].scene !== 'проверочная сцена')
      throw new Error('правки не долетели до сервера');
    return 'ok';
  });

  await check('слишком длинная реплика не пускает в рисование', async () => {
    const job = (await req('GET', `/api/job/${jobId}`)).data;
    const sc = job.scenario;
    sc.pages[0].rows[0].panels[0].bubbles = [{ who: 'Макс', text: 'это очень длинная реплика которая точно никак не поместится в пузырь комикса', type: 'speech' }];
    await req('POST', `/api/job/${jobId}/meta`, { scenario: sc });
    const r = await req('POST', `/api/job/${jobId}/draw`);
    if (r.status === 200) throw new Error('пропустил длинную реплику в рисование');
    sc.pages[0].rows[0].panels[0].bubbles = [];
    await req('POST', `/api/job/${jobId}/meta`, { scenario: sc });
    return 'поймал и объяснил';
  });

  await check('перебор страниц отклоняется', async () => {
    const job = (await req('GET', `/api/job/${jobId}`)).data;
    const sc = job.scenario;
    const page = JSON.parse(JSON.stringify(sc.pages[0]));
    const many = { ...sc, pages: Array.from({ length: (status.maxPages || 12) + 2 }, () => JSON.parse(JSON.stringify(page))) };
    await req('POST', `/api/job/${jobId}/meta`, { scenario: many });
    const r = await req('POST', `/api/job/${jobId}/draw`);
    if (r.status === 200) throw new Error('пустил книжку сверх лимита');
    await req('POST', `/api/job/${jobId}/meta`, { scenario: sc });
    return `лимит ${status.maxPages} держится`;
  });

  await check('скачивание пустого альбома отклоняется', async () => {
    const r = await fetch(BASE + `/api/job/${jobId}/zip`);
    if (r.ok) throw new Error('отдал пустой архив');
    return 'честно говорит, что качать нечего';
  });

  await check('телеграм без страниц отклоняется', async () => {
    const r = await req('POST', `/api/job/${jobId}/telegram`);
    if (r.status === 200) throw new Error('отправил пустоту');
    return 'ok';
  });

  await check('чужая заявка не находится', async () => {
    const r = await req('GET', '/api/job/деаддеаддеаддеад');
    if (r.status !== 404) throw new Error('код ' + r.status);
    return 'ok';
  });

  if (PAID) {
    await check('лист героя рисуется (4¢)', async () => {
      const r = await req('POST', `/api/job/${jobId}/hero/0`, { name: 'Макс', generate: true });
      if (r.status !== 200 || !r.data.sheet) throw new Error(JSON.stringify(r.data));
      const img = await fetch(BASE + r.data.sheet);
      if (!img.ok) throw new Error('лист не отдаётся по ссылке');
      return r.data.sheet.split('/').pop();
    });
  }

  console.log(`\nИтог: ок ${pass}, сбоев ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('проверка упала:', e.message); process.exit(2); });
