#!/usr/bin/env node
// Выравнивание полей страницы: срезать неровные белые края и надеть
// одинаковую белую рамку. Бесплатно, генерация не нужна.
// Использование: node frame.cjs <вход.jpg> <выход.jpg>

const sharp = require('sharp');

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) {
  console.error('node frame.cjs <вход.jpg> <выход.jpg>');
  process.exit(1);
}

(async () => {
  const M = 16; // белое поле со всех сторон (узкое — заказ владельца)
  const trimmed = await sharp(inFile)
    .trim({ background: '#ffffff', threshold: 60 })
    .toBuffer();
  await sharp(trimmed)
    .extend({ top: M, bottom: M, left: M, right: M, background: '#ffffff' })
    .jpeg({ quality: 92 })
    .toFile(outFile);
  console.log(outFile);
})().catch(e => { console.error(e.message); process.exit(1); });
