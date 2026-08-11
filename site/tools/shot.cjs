#!/usr/bin/env node
// Скриншот сайта для проверки дизайна глазами: node tools/shot.cjs <url> <out.png>
const puppeteer = require('puppeteer');

(async () => {
  const url = process.argv[2] || 'http://localhost:3777';
  const out = process.argv[3] || '/tmp/site.png';
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 1200));
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  console.log(out);
})().catch(e => { console.error(e.message); process.exit(1); });
