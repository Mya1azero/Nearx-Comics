#!/usr/bin/env node
// Отправка готовых страниц комиксов владельцу в личку Телеграма.
// Использование:
//   node tg.js setup                    — найти chat_id владельца (он должен нажать Start у бота)
//   node tg.js send <файл|url> [подпись]— отправить картинку в личку
//   node tg.js text <сообщение>         — отправить текст
// Токен лежит в bot/.env (TG_BOT_TOKEN=...), chat_id сохраняется в bot/config.json.

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const ENV_PATH = path.join(DIR, '.env');
const CFG_PATH = path.join(DIR, 'config.json');

function readEnv() {
  if (process.env.TG_BOT_TOKEN) return process.env.TG_BOT_TOKEN.trim();
  if (!fs.existsSync(ENV_PATH)) {
    console.error('Нет токена: ни переменной TG_BOT_TOKEN, ни файла bot/.env.');
    process.exit(1);
  }
  const m = fs.readFileSync(ENV_PATH, 'utf8').match(/TG_BOT_TOKEN\s*=\s*(\S+)/);
  if (!m) {
    console.error('В bot/.env не найдена строка TG_BOT_TOKEN=...');
    process.exit(1);
  }
  return m[1];
}

function readCfg() {
  return fs.existsSync(CFG_PATH) ? JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) : {};
}

async function api(token, method, payload, isForm = false) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const opts = isForm
    ? { method: 'POST', body: payload }
    : payload
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      : {};
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || JSON.stringify(data)}`);
  return data.result;
}

async function setup(token) {
  const me = await api(token, 'getMe');
  console.log(`Бот: @${me.username}`);
  const updates = await api(token, 'getUpdates');
  const msgs = updates.map(u => u.message).filter(m => m && m.chat && m.chat.type === 'private');
  if (!msgs.length) {
    console.error('Пока нет сообщений боту. Нужно открыть бота в Телеграме и нажать Start, потом повторить setup.');
    process.exit(2);
  }
  const last = msgs[msgs.length - 1];
  const cfg = { chat_id: last.chat.id, name: [last.chat.first_name, last.chat.last_name].filter(Boolean).join(' '), username: last.chat.username || '', bot: me.username };
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
  console.log(`Нашёл владельца: ${cfg.name}${cfg.username ? ' (@' + cfg.username + ')' : ''}, chat_id сохранён.`);
}

async function send(token, file, caption) {
  const cfg = readCfg();
  if (!cfg.chat_id) {
    console.error('Сначала: node tg.js setup (владелец должен нажать Start у бота).');
    process.exit(2);
  }
  let result;
  if (/^https?:\/\//.test(file)) {
    result = await api(token, 'sendPhoto', { chat_id: cfg.chat_id, photo: file, caption: caption || '' });
  } else {
    if (!fs.existsSync(file)) {
      console.error(`Файл не найден: ${file}`);
      process.exit(1);
    }
    const fd = new FormData();
    fd.append('chat_id', String(cfg.chat_id));
    if (caption) fd.append('caption', caption);
    fd.append('photo', new Blob([fs.readFileSync(file)]), path.basename(file));
    result = await api(token, 'sendPhoto', fd, true);
  }
  console.log(`Отправлено (message_id ${result.message_id}).`);
}

async function text(token, message) {
  const cfg = readCfg();
  if (!cfg.chat_id) {
    console.error('Сначала: node tg.js setup.');
    process.exit(2);
  }
  await api(token, 'sendMessage', { chat_id: cfg.chat_id, text: message });
  console.log('Отправлено.');
}

(async () => {
  const [cmd, a, ...rest] = process.argv.slice(2);
  const token = readEnv();
  if (cmd === 'setup') return setup(token);
  if (cmd === 'send' && a) return send(token, a, rest.join(' '));
  if (cmd === 'text' && a) return text(token, [a, ...rest].join(' '));
  console.error('Использование: node tg.js setup | send <файл|url> [подпись] | text <сообщение>');
  process.exit(1);
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
