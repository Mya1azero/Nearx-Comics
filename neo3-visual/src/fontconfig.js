/**
 * Конфиг fontconfig для Pango внутри sharp.
 *
 * Готовые бинарники sharp приходят без конфига fontconfig: при первом рендере
 * текста он ругается «Cannot load default config file» и молча подставляет
 * первый попавшийся шрифт вместо запрошенного. Поэтому генерируем минимальный
 * fonts.conf, где перечислены системные каталоги шрифтов и наш fonts/.
 *
 * Этот модуль должен импортироваться ДО sharp (порядок import в overlay.js):
 * переменная окружения читается при инициализации fontconfig.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PATHS } from "./config.js";

const CONF_DIR = path.join(os.homedir(), ".neo3-visual");
const CONF_FILE = path.join(CONF_DIR, "fonts.conf");

const FONT_DIRS = [
  PATHS.fonts,
  "/System/Library/Fonts",
  "/Library/Fonts",
  path.join(os.homedir(), "Library/Fonts"),
  "/usr/share/fonts",
  "/usr/local/share/fonts",
];

if (!process.env.FONTCONFIG_FILE) {
  try {
    fs.mkdirSync(CONF_DIR, { recursive: true });
    fs.mkdirSync(PATHS.fonts, { recursive: true });
    const dirs = FONT_DIRS.filter((d) => fs.existsSync(d)).map((d) => `  <dir>${d}</dir>`).join("\n");
    fs.writeFileSync(
      CONF_FILE,
      `<?xml version="1.0"?>\n<fontconfig>\n${dirs}\n  <cachedir>${path.join(CONF_DIR, "fc-cache")}</cachedir>\n</fontconfig>\n`,
    );
    process.env.FONTCONFIG_FILE = CONF_FILE;
    process.env.FONTCONFIG_PATH = CONF_DIR;
  } catch {
    // не смогли записать конфиг — текст отрисуется системным шрифтом
  }
}
