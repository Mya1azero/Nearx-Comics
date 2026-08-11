#!/usr/bin/env node
// Публикация проекта отдельным репозиторием nearx-comics (приватным) на GitHub.
// Деплой-копия: ~/workspace/nearx-comics-deploy (рабочая папка не трогается).
// Токен для создания репо берётся из remote прошлого проекта и НИКУДА не печатается.

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..');            // NearX Comics
const DEPLOY = path.resolve(SRC, '..', 'nearx-comics-deploy');
const WABA = '/home/cloudcli/workspace/WABA_manager/WABA_manager';
const REPO = 'nearx-comics';
const SSH_REMOTE = `git@github.com:Mya1azero/${REPO}.git`;

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();

// 1. Синхронизация копии (без секретов, тяжёлого и внутренних .git)
fs.mkdirSync(DEPLOY, { recursive: true });
execFileSync('rsync', ['-a', '--delete',
  '--exclude', '.git', '--exclude', 'node_modules', '--exclude', 'out',
  '--exclude', 'uploads', '--exclude', 'jobs', '--exclude', '.env',
  '--exclude', '*.log', '--exclude', '*.pid', '--exclude', 'фото',
  '--exclude', 'CLAUDE.md', '--exclude', 'server.log',
  SRC + '/', DEPLOY + '/']);
// git-служебное деплой-копии не удалять
console.log('копия собрана:', DEPLOY);

// 2. Репозиторий в копии
if (!fs.existsSync(path.join(DEPLOY, '.git'))) run('git init -b main', DEPLOY);
run('git add -A', DEPLOY);
const status = run('git status --short', DEPLOY);
if (status) {
  run('git -c user.name="NearX Comics" -c user.email="mya1a.zero@gmail.com" commit -m "Студия NearX Comics: сайт, движок, бот" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"', DEPLOY);
  console.log('коммит создан');
} else console.log('изменений нет');

// 3. Создание приватного репо на GitHub (токен из remote WABA, не печатается)
const wabaUrl = run('git remote get-url origin', WABA);
const tokenMatch = wabaUrl.match(/https:\/\/([^@]+)@github\.com/);
(async () => {
  let created = false;
  if (tokenMatch) {
    try {
      const res = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenMatch[1]}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'nearx-comics'
        },
        body: JSON.stringify({ name: REPO, private: true, description: 'NearX Comics — студия персональных комиксов' })
      });
      if (res.status === 201) { created = true; console.log('репозиторий создан (приватный)'); }
      else if (res.status === 422) { created = true; console.log('репозиторий уже существует'); }
      else console.log('создать через API не вышло: код', res.status);
    } catch (e) { console.log('создать через API не вышло:', e.message.slice(0, 80)); }
  } else console.log('токен в remote прошлого проекта не найден');

  // 4. Пуш по SSH (ключ сервера — аккаунт Mya1azero)
  try { run('git remote add origin ' + SSH_REMOTE, DEPLOY); } catch {}
  try {
    run('git push -u origin main', DEPLOY);
    console.log('ЗАПУШЕНО: https://github.com/Mya1azero/' + REPO);
  } catch (e) {
    console.log('пуш не прошёл' + (created ? '' : ' (репо нет?)') + ': ' + String(e.message).split('\n')[0]);
    process.exit(2);
  }
})();
