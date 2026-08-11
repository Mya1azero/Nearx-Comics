#!/usr/bin/env node
// NearX Comics — сервер студии. Порт 3777.

const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SITE = __dirname;
const ENGINE = path.resolve(SITE, '..', 'neo3-visual');
const JOBS = path.join(SITE, 'jobs');
const UPLOADS = path.join(SITE, 'uploads');
fs.mkdirSync(JOBS, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const { makeScenario, rewritePage, hasKey } = require('./llm.cjs');
const { STYLES, buildHeroSheetPrompt } = require('./prompt.cjs');

const PAGE_CREDITS = 10;      // страница 2K gpt-image-2
const HERO_CREDITS = 8;       // лист героя nano-banana-2 1K
const CENTS_PER_CREDIT = 0.5; // 1 кр = полцента
const MAX_PAGES = 12;
const DAILY_SITE_CAP_CREDITS = 400; // дневной потолок сайта ≈ $2

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(SITE, 'public')));
app.use('/out', express.static(path.join(ENGINE, 'out')));
app.use('/uploads', express.static(UPLOADS));

const jobPath = id => path.join(JOBS, id, 'job.json');
function readJob(id) {
  try { return JSON.parse(fs.readFileSync(jobPath(id), 'utf8')); } catch { return null; }
}
function writeJob(job) {
  fs.mkdirSync(path.join(JOBS, job.id), { recursive: true });
  const tmp = jobPath(job.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, jobPath(job.id));
}
const publicUrl = abs => {
  if (!abs) return null;
  if (abs.startsWith(path.join(ENGINE, 'out'))) return '/out' + abs.slice(path.join(ENGINE, 'out').length).split(path.sep).join('/');
  if (abs.startsWith(UPLOADS)) return '/uploads' + abs.slice(UPLOADS.length).split(path.sep).join('/');
  return null;
};

function engineRemainingCredits() {
  try {
    const out = execFileSync('node', [path.join(ENGINE, 'bin', 'vis.js'), 'spent'],
      { cwd: ENGINE, stdio: 'pipe', timeout: 30000 }).toString();
    const m = out.match(/осталось\s+([\d.]+)\s*кр/);
    return m ? parseFloat(m[1]) : null;
  } catch { return null; }
}

function siteSpentTodayCredits() {
  const today = new Date().toISOString().slice(0, 10);
  let sum = 0;
  for (const id of fs.readdirSync(JOBS)) {
    const j = readJob(id);
    if (j && j.createdAt && j.createdAt.slice(0, 10) === today) sum += j.spentCredits || 0;
  }
  return sum;
}

// --- Загрузка фото героев ---
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOADS, req.params.jobId, `hero${req.params.heroIndex}`);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '_' + Math.round(Math.random() * 1e6) + path.extname(file.originalname || '.jpg'))
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 3 }
});

// --- API ---

app.post('/api/job', (req, res) => {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id, createdAt: new Date().toISOString(), status: 'new',
    heroes: [], story: '', tone: 'романтика', pagesCount: 6, styleKey: 'kino',
    scenario: null, pages: [], spentCredits: 0
  };
  writeJob(job);
  res.json({ id });
});

app.get('/api/job/:id', (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'нет такой заявки' });
  const view = {
    ...job,
    heroes: job.heroes.map(h => ({ ...h, photos: (h.photos || []).map(publicUrl), sheet: publicUrl(h.sheet) })),
    pages: (job.pages || []).map(p => p && ({ ...p, url: publicUrl(p.framed || p.raw), raw: undefined, framed: undefined })),
    cover: job.cover ? { ...job.cover, url: publicUrl(job.cover.framed || job.cover.raw), raw: undefined, framed: undefined } : null
  };
  res.json(view);
});

app.post('/api/job/:id/meta', (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'нет заявки' });
  const { story, tone, pagesCount, styleKey, scenario } = req.body || {};
  if (typeof story === 'string') job.story = story.slice(0, 8000);
  if (typeof tone === 'string') job.tone = tone.slice(0, 40);
  if (Number.isInteger(pagesCount)) job.pagesCount = Math.max(1, Math.min(MAX_PAGES, pagesCount));
  if (styleKey && STYLES[styleKey]) job.styleKey = styleKey;
  if (scenario && scenario.pages) job.scenario = scenario; // правки из редактора
  writeJob(job);
  res.json({ ok: true });
});

app.post('/api/job/:jobId/hero/:heroIndex/photos', (req, res, next) => {
  const job = readJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'нет заявки' });
  next();
}, upload.array('photos', 3), (req, res) => {
  const job = readJob(req.params.jobId);
  const i = parseInt(req.params.heroIndex, 10);
  if (!(i >= 0 && i < 2)) return res.status(400).json({ error: 'героев максимум два' });
  job.heroes[i] = job.heroes[i] || { name: '', desc: '', photos: [] };
  job.heroes[i].photos = (job.heroes[i].photos || []).concat((req.files || []).map(f => f.path)).slice(0, 3);
  writeJob(job);
  res.json({ ok: true, photos: job.heroes[i].photos.map(publicUrl) });
});

app.post('/api/job/:jobId/hero/:heroIndex', async (req, res) => {
  const job = readJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'нет заявки' });
  const i = parseInt(req.params.heroIndex, 10);
  const { name, desc, generate } = req.body || {};
  job.heroes[i] = job.heroes[i] || { photos: [] };
  if (typeof name === 'string') job.heroes[i].name = name.slice(0, 40);
  if (typeof desc === 'string') job.heroes[i].desc = desc.slice(0, 300);
  writeJob(job);
  if (!generate) return res.json({ ok: true });

  if (!job.heroes[i].photos || !job.heroes[i].photos.length)
    return res.status(400).json({ error: 'сначала загрузи 1–3 фото героя' });
  const remaining = engineRemainingCredits();
  if (remaining !== null && remaining < HERO_CREDITS)
    return res.status(402).json({ error: 'копилка сайта пуста — скажи владельцу' });
  try {
    const prompt = buildHeroSheetPrompt({ name: job.heroes[i].name || 'герой', desc: job.heroes[i].desc || 'обычный человек', styleKey: job.styleKey });
    const args = ['crea', prompt];
    job.heroes[i].photos.forEach(p => args.push('--ref', p));
    args.push('--models', 'nano-banana-2', '--format', 'square');
    const out = execFileSync('node', [path.join(ENGINE, 'bin', 'vis.js'), ...args],
      { cwd: ENGINE, stdio: 'pipe', timeout: 4 * 60 * 1000 }).toString();
    const m = out.match(/Папка:\s*(\S.*)/);
    if (!m) throw new Error('движок не вернул папку');
    const dir = m[1].trim();
    const jpg = fs.readdirSync(dir).find(f => f.endsWith('.jpg'));
    if (!jpg) throw new Error('лист не найден');
    const jobFresh = readJob(req.params.jobId);
    jobFresh.heroes[i] = { ...job.heroes[i], sheet: path.join(dir, jpg) };
    jobFresh.spentCredits = (jobFresh.spentCredits || 0) + HERO_CREDITS;
    writeJob(jobFresh);
    res.json({ ok: true, sheet: publicUrl(path.join(dir, jpg)) });
  } catch (e) {
    res.status(500).json({ error: 'лист героя не вышел: ' + String(e.message).slice(0, 150) });
  }
});

app.post('/api/job/:id/script', async (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'нет заявки' });
  if (!job.story || job.story.trim().length < 10) return res.status(400).json({ error: 'расскажи историю хотя бы парой предложений' });
  if (!job.heroes.length || !job.heroes[0].name) return res.status(400).json({ error: 'заполни героев на шаге 1' });
  try {
    const { scenario, demo } = await makeScenario({
      story: job.story, pagesCount: job.pagesCount, tone: job.tone,
      heroes: job.heroes.map(h => ({ name: h.name, desc: h.desc }))
    });
    job.scenario = scenario;
    job.scenarioDemo = !!demo;
    writeJob(job);
    res.json({ ok: true, scenario, demo });
  } catch (e) {
    res.status(500).json({ error: 'сценарист споткнулся: ' + String(e.message).slice(0, 150) });
  }
});

app.post('/api/job/:id/rewrite', async (req, res) => {
  const job = readJob(req.params.id);
  if (!job || !job.scenario) return res.status(400).json({ error: 'сначала сценарий' });
  const { pageIndex, wish, mode } = req.body || {};
  if (!(pageIndex >= 0 && pageIndex < job.scenario.pages.length)) return res.status(400).json({ error: 'нет такой страницы' });
  try {
    const page = await rewritePage({
      scenario: job.scenario, pageIndex, wish: (wish || '').slice(0, 300), mode,
      heroes: job.heroes.map(h => ({ name: h.name, desc: h.desc })), tone: job.tone
    });
    job.scenario.pages[pageIndex] = page;
    writeJob(job);
    res.json({ ok: true, page });
  } catch (e) {
    res.status(500).json({ error: String(e.message).slice(0, 150) });
  }
});

const activeByIp = new Map();
app.post('/api/job/:id/draw', (req, res) => {
  const job = readJob(req.params.id);
  if (!job || !job.scenario) return res.status(400).json({ error: 'сначала сценарий' });
  if (job.status === 'drawing') return res.status(400).json({ error: 'уже рисуется' });
  if (!job.heroes.some(h => h.sheet)) return res.status(400).json({ error: 'сначала создай лист героя (шаг 1)' });

  // Пузыри не длиннее 8 слов — та же проверка, что в редакторе.
  for (const p of job.scenario.pages)
    for (const r of p.rows) for (const pan of r.panels) for (const b of (pan.bubbles || []))
      if (b.text.split(/\s+/).length > 9)
        return res.status(400).json({ error: `реплика «${b.text.slice(0, 30)}…» длиннее 8 слов — сократи в редакторе` });

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
  const act = activeByIp.get(ip);
  if (act && readJob(act) && readJob(act).status === 'drawing')
    return res.status(429).json({ error: 'у тебя уже рисуется комикс — дождись его' });

  const need = job.scenario.pages.length * PAGE_CREDITS;
  const remaining = engineRemainingCredits();
  if (remaining !== null && remaining < need)
    return res.status(402).json({ error: 'копилка сайта почти пуста — скажи владельцу пополнить' });
  if (siteSpentTodayCredits() + need > DAILY_SITE_CAP_CREDITS)
    return res.status(402).json({ error: 'дневной лимит сайта исчерпан, приходи завтра' });

  job.status = 'drawing';
  job.pages = job.pages && job.pages.length === job.scenario.pages.length ? job.pages : [];
  writeJob(job);
  const logFd = fs.openSync(path.join(JOBS, job.id, 'worker.out'), 'a');
  const child = spawn('node', [path.join(SITE, 'worker.cjs'), job.id],
    { detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  activeByIp.set(ip, job.id);
  res.json({ ok: true, priceCents: Math.round(need * CENTS_PER_CREDIT) });
});

app.post('/api/job/:id/redraw', (req, res) => {
  const job = readJob(req.params.id);
  if (!job || !job.scenario) return res.status(400).json({ error: 'сначала сценарий' });
  if (job.status === 'drawing') return res.status(400).json({ error: 'подожди — уже рисуется' });
  const { pageIndex, wish } = req.body || {};
  if (!(pageIndex >= 0 && pageIndex < job.scenario.pages.length)) return res.status(400).json({ error: 'нет такой страницы' });
  const remaining = engineRemainingCredits();
  if (remaining !== null && remaining < PAGE_CREDITS)
    return res.status(402).json({ error: 'копилка сайта пуста — скажи владельцу' });
  if (siteSpentTodayCredits() + PAGE_CREDITS > DAILY_SITE_CAP_CREDITS)
    return res.status(402).json({ error: 'дневной лимит сайта исчерпан, приходи завтра' });
  job.status = 'drawing';
  job.pages[pageIndex] = { n: pageIndex + 1, status: 'drawing' };
  writeJob(job);
  const logFd = fs.openSync(path.join(JOBS, job.id, 'worker.out'), 'a');
  const child = spawn('node', [path.join(SITE, 'worker.cjs'), job.id, '--page', String(pageIndex + 1), '--wish', String(wish || '').slice(0, 300)],
    { detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  res.json({ ok: true, priceCents: Math.round(PAGE_CREDITS * CENTS_PER_CREDIT) });
});

app.post('/api/job/:id/cover', (req, res) => {
  const job = readJob(req.params.id);
  if (!job || !job.scenario) return res.status(400).json({ error: 'сначала сценарий' });
  if (job.status === 'drawing') return res.status(400).json({ error: 'подожди — уже рисуется' });
  const remaining = engineRemainingCredits();
  if (remaining !== null && remaining < PAGE_CREDITS)
    return res.status(402).json({ error: 'копилка сайта пуста — скажи владельцу' });
  if (siteSpentTodayCredits() + PAGE_CREDITS > DAILY_SITE_CAP_CREDITS)
    return res.status(402).json({ error: 'дневной лимит сайта исчерпан, приходи завтра' });
  job.status = 'drawing';
  job.cover = { status: 'drawing' };
  writeJob(job);
  const logFd = fs.openSync(path.join(JOBS, job.id, 'worker.out'), 'a');
  const child = spawn('node', [path.join(SITE, 'worker.cjs'), job.id, '--cover'],
    { detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  res.json({ ok: true, priceCents: Math.round(PAGE_CREDITS * CENTS_PER_CREDIT) });
});

app.get('/api/job/:id/zip', (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).end();
  const files = (job.pages || []).filter(p => p && p.status === 'done').map(p => p.framed || p.raw);
  if (!files.length) return res.status(400).json({ error: 'ещё нечего скачивать' });
  res.attachment(`nearx-comics-${job.id.slice(0, 6)}.zip`);
  const arc = archiver('zip');
  arc.pipe(res);
  if (job.cover && job.cover.status === 'done')
    arc.file(job.cover.framed || job.cover.raw, { name: '00-обложка.jpg' });
  files.forEach((f, i) => arc.file(f, { name: `страница-${String(i + 1).padStart(2, '0')}.jpg` }));
  arc.finalize();
});

app.get('/api/status', (req, res) => {
  res.json({
    name: 'NearX Comics',
    llm: hasKey() ? 'on' : 'demo',
    pageCents: PAGE_CREDITS * CENTS_PER_CREDIT,
    heroCents: HERO_CREDITS * CENTS_PER_CREDIT,
    maxPages: MAX_PAGES,
    remainingCredits: engineRemainingCredits(),
    styles: Object.fromEntries(Object.entries(STYLES).map(([k, v]) => [k, v.label]))
  });
});

const PORT = process.env.PORT || 3777;
app.listen(PORT, '0.0.0.0', () => console.log(`NearX Comics на порту ${PORT}`));
