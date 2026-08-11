# Переезд NearX Comics на боевой сервер и домен (вечерний план)

Владелец покупает: VPS (Ubuntu 22+, 2 ГБ RAM хватит) и домен. Дальше делаю я:

1. **Перенос**: rsync папки «NearX Comics» целиком (site/, neo3-visual/, bot/, фото/) на VPS.
   Движку нужен только Node 22+ (`nvm install 22`), `npm i` в site/ и neo3-visual/.
2. **Секреты** (руками, не в git): `neo3-visual/.env` (KIE_API_KEY), `site/.env`
   (OPENROUTER_API_KEY — владелец пришлёт вечером), `bot/.env` (TG_BOT_TOKEN).
3. **Запуск как служба**: systemd-юнит `nearx-site.service` (ExecStart=node server.cjs,
   Restart=always, WorkingDirectory=site). Никаких nohup на бою.
4. **Домен**: A-запись домена → IP VPS. nginx reverse proxy 80/443 → 127.0.0.1:3777,
   HTTPS через certbot (`certbot --nginx`). Диктовка в браузере ТРЕБУЕТ https — на голом
   http микрофон не даст (важно!).
5. **Проверка боем**: tools/smoke.cjs --draw с VPS, страница с телефона владельца,
   диктовка, полный цикл — потом только показывать.
6. **Бюджет**: budget.json едет вместе с движком (потолок $10); дневной лимит сайта $2
   в server.cjs (DAILY_SITE_CAP_CREDITS).
7. Телеграм-бот (bot/) можно оставить здесь или перевезти — токен один, вебхуков нет,
   конфликтов не будет, но getUpdates должен крутиться только в ОДНОМ месте.

Примечание: на текущей машине сайт слушает 0.0.0.0:3777 (server.pid рядом). Если у этой
машины есть белый IP — можно показать владельцу ссылку ещё до переезда.
