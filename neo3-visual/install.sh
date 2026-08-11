#!/usr/bin/env bash
#
# Установка Neo³ Visual одной командой: ./install.sh
# Ставит зависимости, команду `vis`, ключ, шрифт и скилл для Claude Code.
# Запускать можно повторно — ничего не сломает.

set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

# --- 1. Node -----------------------------------------------------------------
say "1/5  Проверяю Node.js"
command -v node >/dev/null 2>&1 || die "Node.js не установлен.
  macOS:  brew install node        (нет brew — https://brew.sh)
  Linux:  sudo apt install nodejs npm
Поставь и запусти ./install.sh снова."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Нужен Node 18 или новее, а стоит $(node -v). Обнови: brew upgrade node"
ok "Node $(node -v)"

# --- 2. Зависимости и команда vis --------------------------------------------
say "2/5  Ставлю зависимости (пара минут — качается sharp)"
npm install --no-audit --no-fund >/dev/null 2>&1 || die "npm install упал. Запусти вручную: npm install"
ok "зависимости на месте"

if npm link >/dev/null 2>&1; then
  ok "команда vis доступна из любой папки"
  VIS="vis"
else
  warn "npm link не прошёл без прав администратора."
  warn "Выполни отдельно:  sudo npm link"
  warn "Пока команды будут работать так: node $ROOT/bin/vis.js ..."
  VIS="node $ROOT/bin/vis.js"
fi

# --- 3. Ключ kie.ai ----------------------------------------------------------
say "3/5  Ключ kie.ai"
if [ -f .env ] && grep -q '^KIE_API_KEY=.\+' .env; then
  ok "ключ уже записан в .env (чтобы сменить — удали файл .env и запусти снова)"
else
  echo "  Ключ берётся тут: https://kie.ai → регистрация → API Key."
  echo "  Он останется только на твоём компьютере, в файле .env (в git не попадёт)."
  printf '  Вставь ключ и нажми Enter: '
  read -r KEY
  [ -n "$KEY" ] || die "Пустой ключ. Запусти ./install.sh ещё раз, когда получишь его на kie.ai."
  printf 'KIE_API_KEY=%s\n' "$KEY" > .env
  chmod 600 .env
  ok "ключ записан в .env"
fi

# --- 4. Шрифт для надписей ---------------------------------------------------
say "4/5  Шрифт для надписей на креативах"
if $VIS font "Unbounded" >/dev/null 2>&1; then
  ok "Unbounded установлен (использовать: --font Unbounded)"
else
  warn "шрифт не скачался — не страшно, надписи будут системным шрифтом."
  warn "Повторить позже: $VIS font \"Unbounded\""
fi

# --- 5. Скилл для Claude Code ------------------------------------------------
say "5/5  Скилл для Claude Code"
SKILLS_DIR="$HOME/.claude/skills"
if [ -d "$HOME/.claude" ]; then
  mkdir -p "$SKILLS_DIR"
  if [ -e "$SKILLS_DIR/visual" ] && [ ! -L "$SKILLS_DIR/visual" ]; then
    warn "в $SKILLS_DIR/visual уже лежит своя папка — не трогаю её."
  else
    ln -sfn "$ROOT/skills/visual" "$SKILLS_DIR/visual"
    ok "скилл visual подключён (перезапусти Claude Code, чтобы он его увидел)"
  fi
else
  warn "Claude Code не найден — пропускаю. CLI это не мешает."
  warn "Поставишь Claude Code — подключить скилл: ln -sfn \"$ROOT/skills/visual\" ~/.claude/skills/visual"
fi

# --- Проверка живьём ---------------------------------------------------------
say "Проверяю, что ключ рабочий"
if $VIS credits; then
  say "Готово. Первый запуск (кредиты НЕ тратятся):"
  echo "  vis crea \"банка энергетика на мокром бетоне\" --format post --dry-run"
  echo
  echo "  Когда план понравится — убери --dry-run. Галерея с результатами: open gallery.html"
  echo "  Все команды: vis --help"
else
  die "Ключ не принят сервером kie.ai. Проверь, что скопировал его целиком, удали .env и запусти ./install.sh снова."
fi
