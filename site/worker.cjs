#!/usr/bin/env node
// Рисовальщик одной заявки: страница за страницей, статус в jobs/<id>/job.json.
// Запускается детачем из server.cjs: node worker.cjs <jobId>

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SITE = __dirname;
const ENGINE = path.resolve(SITE, '..', 'neo3-visual');
const TG = path.resolve(SITE, '..', 'bot', 'tg.js');
const FRAME = path.join(ENGINE, 'continuation', 'frame.cjs');
const { buildPagePrompt, buildCoverPrompt } = require('./prompt.cjs');

const jobId = process.argv[2];
if (!jobId) { console.error('нужен jobId'); process.exit(1); }
const pageArgIdx = process.argv.indexOf('--page');
const ONLY_PAGE = pageArgIdx > -1 ? parseInt(process.argv[pageArgIdx + 1], 10) : null; // 1-based
const wishIdx = process.argv.indexOf('--wish');
const WISH = wishIdx > -1 ? (process.argv[wishIdx + 1] || '') : '';
const COVER = process.argv.includes('--cover');
const JOB_DIR = path.join(SITE, 'jobs', jobId);
const JOB_PATH = path.join(JOB_DIR, 'job.json');

const readJob = () => JSON.parse(fs.readFileSync(JOB_PATH, 'utf8'));
function writeJob(job) {
  const tmp = JOB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, JOB_PATH);
}
const log = m => fs.appendFileSync(path.join(JOB_DIR, 'worker.log'), `${new Date().toISOString()} ${m}\n`);

fs.writeFileSync(path.join(JOB_DIR, 'worker.pid'), String(process.pid));

function vis(args, timeoutMin = 8) {
  return execFileSync('node', [path.join(ENGINE, 'bin', 'vis.js'), ...args],
    { cwd: ENGINE, stdio: 'pipe', timeout: timeoutMin * 60 * 1000 }).toString();
}

function jpgIn(dir) {
  try {
    const f = fs.readdirSync(dir).filter(x => x.endsWith('.jpg') && !x.startsWith('framed'));
    return f.length ? path.join(dir, f[0]) : null;
  } catch { return null; }
}

function genPage(job, i, wish) {
  const scenario = job.scenario;
  const prompt = buildPagePrompt({
    page: scenario.pages[i],
    pageNo: i + 1,
    total: scenario.pages.length,
    heroes: job.heroes.map(h => ({ name: h.name, desc: h.desc })),
    styleKey: job.styleKey,
    title: scenario.title,
    wish
  });
  const refs = [];
  job.heroes.forEach(h => { if (h.sheet) refs.push(h.sheet); });
  if (i > 0 && job.pages[0] && job.pages[0].raw) refs.push(job.pages[0].raw); // якорь стиля — страница 1
  return generate(prompt, refs);
}

function generate(prompt, refs) {
  const args = ['crea', prompt];
  refs.forEach(r => args.push('--ref', r));
  args.push('--models', 'gpt-image-2-image-to-image', '--format', '2:3', '--resolution', '2K');
  const out = vis(args);
  const m = out.match(/Папка:\s*(\S.*)/);
  if (!m) throw new Error('папка результата не найдена');
  const raw = jpgIn(m[1].trim());
  if (!raw) throw new Error('файл результата не найден');
  const framed = path.join(path.dirname(raw), 'framed.jpg');
  try { execFileSync('node', [FRAME, raw, framed], { stdio: 'pipe', timeout: 60000 }); } catch {}
  const creditM = out.match(/списано\s+([\d.]+)\s*кр/);
  return { raw, framed: fs.existsSync(framed) ? framed : raw, credits: creditM ? parseFloat(creditM[1]) : 10 };
}

function pagesStatus(job) {
  const total = job.scenario.pages.length;
  const ok = (job.pages || []).filter(p => p && p.status === 'done').length;
  return ok === total ? 'done' : (ok ? 'partial' : 'ready');
}

(async () => {
  let job = readJob();

  if (COVER) {
    job.status = 'drawing';
    job.cover = { status: 'drawing' };
    writeJob(job);
    log('обложка: старт');
    const refs = [];
    job.heroes.forEach(h => { if (h.sheet) refs.push(h.sheet); });
    if (job.pages[0] && job.pages[0].raw) refs.push(job.pages[0].raw);
    const prompt = buildCoverPrompt({
      title: job.scenario.title,
      logline: job.scenario.logline || job.story.slice(0, 200),
      heroes: job.heroes.map(h => ({ name: h.name, desc: h.desc })),
      styleKey: job.styleKey
    });
    let result = null, err = '';
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      try { result = generate(prompt, refs); }
      catch (e) { err = String(e.message).slice(0, 200); log(`обложка попытка ${attempt}: ${err}`); }
    }
    job = readJob();
    job.cover = result
      ? { status: 'done', raw: result.raw, framed: result.framed }
      : { status: 'failed', error: err };
    if (result) job.spentCredits = (job.spentCredits || 0) + result.credits;
    job.status = pagesStatus(job);
    writeJob(job);
    try { vis(['reconcile'], 2); } catch {}
    log(`обложка: ${job.cover.status}`);
    return;
  }

  job.status = 'drawing';
  job.startedAt = job.startedAt || new Date().toISOString();
  writeJob(job);
  log(ONLY_PAGE ? `перерисовка стр.${ONLY_PAGE}${WISH ? ` («${WISH}»)` : ''}` : `старт, страниц: ${job.scenario.pages.length}`);

  const total = job.scenario.pages.length;
  for (let i = 0; i < total; i++) {
    if (ONLY_PAGE !== null && i !== ONLY_PAGE - 1) continue;
    job = readJob();
    if (ONLY_PAGE === null && job.pages[i] && job.pages[i].status === 'done') continue; // resume
    job.pages[i] = { n: i + 1, status: 'drawing' };
    writeJob(job);
    let result = null, err = '';
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      try { result = genPage(job, i, ONLY_PAGE !== null ? WISH : ''); }
      catch (e) { err = String(e.message).slice(0, 200); log(`стр.${i + 1} попытка ${attempt}: ${err}`); }
    }
    job = readJob();
    if (result) {
      job.pages[i] = { n: i + 1, status: 'done', raw: result.raw, framed: result.framed };
      job.spentCredits = (job.spentCredits || 0) + result.credits;
      log(`стр.${i + 1} готова`);
    } else {
      job.pages[i] = { n: i + 1, status: 'failed', error: err };
      log(`стр.${i + 1} сбой`);
    }
    writeJob(job);
  }

  job = readJob();
  const ok = job.pages.filter(p => p && p.status === 'done').length;
  job.status = ok === total ? 'done' : 'partial';
  job.finishedAt = new Date().toISOString();
  writeJob(job);
  try { vis(['reconcile'], 2); } catch {}
  try {
    execFileSync('node', [TG, 'text',
      `Сайт: комикс «${job.scenario.title}» (${jobId.slice(0, 6)}) — готово ${ok}/${total} страниц, ~${Math.round((job.spentCredits || 0) * 0.5)} центов.`],
      { stdio: 'pipe', timeout: 60000 });
  } catch {}
  log(`финиш: ${ok}/${total}`);
})().catch(e => {
  log('фатально: ' + e.message);
  try { const j = readJob(); j.status = 'error'; j.error = e.message; writeJob(j); } catch {}
  process.exit(1);
});
