#!/usr/bin/env node
// Дежурный первого контакта: ждёт, пока владелец нажмёт Start у бота,
// потом сохраняет chat_id и отправляет всё из queue.txt (строки «путь|подпись»).
// Запуск: node first-contact.js  (крутится до контакта, максимум 12 часов)

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const ENV_PATH = path.join(DIR, '.env');
const CFG_PATH = path.join(DIR, 'config.json');
const QUEUE_PATH = path.join(DIR, 'queue.txt');
const LOG_PATH = path.join(DIR, 'first-contact.log');

const token = fs.readFileSync(ENV_PATH, 'utf8').match(/TG_BOT_TOKEN\s*=\s*(\S+)/)[1];

function log(msg) {
  fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
}

async function api(method, payload, isForm = false) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const opts = isForm
    ? { method: 'POST', body: payload }
    : payload
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      : {};
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

async function sendPhoto(chatId, file, caption) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (caption) fd.append('caption', caption);
  fd.append('photo', new Blob([fs.readFileSync(file)]), path.basename(file));
  return api('sendPhoto', fd, true);
}

async function main() {
  const deadline = Date.now() + 12 * 60 * 60 * 1000;
  log('дежурство начато');
  while (Date.now() < deadline) {
    let updates = [];
    try {
      updates = await api('getUpdates');
    } catch (e) {
      log(`getUpdates: ${e.message}`);
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }
    const msgs = updates.map(u => u.message).filter(m => m && m.chat && m.chat.type === 'private');
    if (msgs.length) {
      const last = msgs[msgs.length - 1];
      const cfg = {
        chat_id: last.chat.id,
        name: [last.chat.first_name, last.chat.last_name].filter(Boolean).join(' '),
        username: last.chat.username || ''
      };
      fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
      log(`контакт: ${cfg.name} (chat_id ${cfg.chat_id})`);
      await api('sendMessage', { chat_id: cfg.chat_id, text: 'NearX Comics на связи. Сюда будут прилетать готовые страницы. Лови первую партию.' });
      const lines = fs.existsSync(QUEUE_PATH)
        ? fs.readFileSync(QUEUE_PATH, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
        : [];
      for (const line of lines) {
        const [file, caption] = line.split('|');
        try {
          await sendPhoto(cfg.chat_id, file, caption || '');
          log(`отправлено: ${file}`);
        } catch (e) {
          log(`ошибка отправки ${file}: ${e.message}`);
        }
      }
      fs.writeFileSync(QUEUE_PATH, '');
      console.log(`Контакт установлен: ${cfg.name}. Очередь отправлена (${lines.length} шт.).`);
      return;
    }
    await new Promise(r => setTimeout(r, 20000));
  }
  console.error('12 часов прошло, владелец так и не нажал Start.');
  process.exit(3);
}

main().catch(e => { log(`фатально: ${e.message}`); console.error(e.message); process.exit(1); });
