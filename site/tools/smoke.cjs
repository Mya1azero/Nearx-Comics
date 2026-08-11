#!/usr/bin/env node
// Боевой прогон сайта от лица клиента: фото → лист героя → история → сценарий → книжка.
// Использование: node smoke.cjs [--draw]

const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3777';
const PHOTOS = [
  '/home/cloudcli/workspace/NearX Comics/фото/vladelec-anfas.jpg',
  '/home/cloudcli/workspace/NearX Comics/фото/vladelec-profil.jpg'
];

async function j(url, opts) {
  const res = await fetch(BASE + url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url}: ${data.error || res.status}`);
  return data;
}
const post = (url, body) => j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

(async () => {
  const status = await j('/api/status');
  console.log(`status: мозг=${status.llm}, страница=${status.pageCents}¢, лист=${status.heroCents}¢, осталось кр=${status.remainingCredits}`);

  const { id } = await post('/api/job');
  console.log('job:', id);

  const fd = new FormData();
  for (const p of PHOTOS) fd.append('photos', new Blob([fs.readFileSync(p)]), path.basename(p));
  const up = await j(`/api/job/${id}/hero/0/photos`, { method: 'POST', body: fd });
  console.log('фото загружено:', up.photos.length);

  console.log('рисую лист героя (~минута)…');
  const hero = await post(`/api/job/${id}/hero/0`, {
    name: 'Макс',
    desc: 'парень с короткой тёмной стрижкой и аккуратной бородой, серо-голубые глаза, красная футболка, тонкая цепочка',
    generate: true
  });
  console.log('лист героя:', hero.sheet);

  await post(`/api/job/${id}/meta`, {
    story: 'Мы познакомились под дождём: у неё ветром вырвало красный зонт, я его поймал. Она написала номер на моём пакете с продуктами, но дождь смыл цифры. Я нашёл её через кофейню, и она написала номер маркером мне на руке со словами «этот не смоется».',
    pagesCount: 3,
    tone: 'романтика'
  });
  const sc = await post(`/api/job/${id}/script`);
  console.log(`сценарий: «${sc.scenario.title}», страниц: ${sc.scenario.pages.length}, демо=${!!sc.demo}`);

  if (process.argv.includes('--draw')) {
    const d = await post(`/api/job/${id}/draw`);
    console.log(`рисование пошло, цена ${d.priceCents}¢`);
    const t0 = Date.now();
    while (Date.now() - t0 < 20 * 60 * 1000) {
      await new Promise(r => setTimeout(r, 15000));
      const job = await j('/api/job/' + id);
      const done = (job.pages || []).filter(p => p && p.status === 'done').length;
      console.log(`…статус ${job.status}, готово ${done}/${job.scenario.pages.length}`);
      if (job.status === 'done' || job.status === 'partial' || job.status === 'error') {
        (job.pages || []).forEach(p => p && console.log(`  стр.${p.n}: ${p.status} ${p.url || p.error || ''}`));
        break;
      }
    }
  }
  console.log('SMOKE_DONE job=' + id);
})().catch(e => { console.error('SMOKE_FAIL: ' + e.message); process.exit(1); });
