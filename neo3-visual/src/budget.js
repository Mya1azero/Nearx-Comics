/**
 * Предохранитель расходов. ЖИВЁТ В КОДЕ, а не в тексте инструкции для агента.
 *
 * Причина: правило «сначала посчитай цену» в скилле — это просьба, которую модель
 * может проигнорировать или неверно посчитать. Здесь это проверка, которая
 * возвращает отказ и ненулевой код выхода. Продавить её нельзя ни промптом,
 * ни уговорами — только правкой budget.json руками.
 *
 * Три рубежа:
 *   1) perRunUsdCap      — сколько максимум стоит один запуск;
 *   2) totalCreditsCap   — сколько всего кредитов разрешено потратить (по журналу);
 *   3) warnBalancePercent — предупреждение, если пачка съедает большую долю баланса.
 */

import fs from "node:fs";

import { PATHS } from "./config.js";
import { spentCredits } from "./ledger.js";

const FALLBACK = {
  totalCreditsCap: 200,
  perRunUsdCap: 0.3,
  warnBalancePercent: 10,
  usdPerCredit: 0.005,
};

export function loadBudget(budgetPath = PATHS.budget) {
  try {
    return { ...FALLBACK, ...JSON.parse(fs.readFileSync(budgetPath, "utf8")) };
  } catch {
    return { ...FALLBACK };
  }
}

/**
 * Проверка плана запуска до любых сетевых вызовов.
 *
 * plannedCredits — сумма оценок по всем задачам пачки;
 * balanceCredits — текущий баланс (или null, если неизвестен);
 * overrideUsd    — значение --max-usd, поднимающее лимит одного запуска.
 *
 * Возвращает { ok, blockers: [], warnings: [], spent, remaining, plannedUsd }.
 * ok === false — запускать нельзя.
 */
export function checkBudget({
  plannedCredits,
  balanceCredits = null,
  overrideUsd = null,
  budget = loadBudget(),
  ledgerPath = PATHS.ledger,
}) {
  const spent = spentCredits(ledgerPath);
  const remaining = budget.totalCreditsCap - spent;
  const perRunUsd = overrideUsd !== null ? Number(overrideUsd) : budget.perRunUsdCap;
  const plannedUsd = plannedCredits * budget.usdPerCredit;

  const blockers = [];
  const warnings = [];

  if (!Number.isFinite(plannedCredits)) {
    blockers.push("не удалось оценить стоимость запуска — цена модели неизвестна");
  } else {
    if (plannedUsd > perRunUsd + 1e-9) {
      blockers.push(
        `запуск стоит $${plannedUsd.toFixed(3)} (${plannedCredits} кр), лимит на один запуск `
          + `$${perRunUsd.toFixed(2)}. Поднять: --max-usd ${(Math.ceil(plannedUsd * 100) / 100).toFixed(2)}`,
      );
    }
    if (plannedCredits > remaining) {
      blockers.push(
        `бюджет проекта исчерпан: потолок ${budget.totalCreditsCap} кр, потрачено ${spent} кр, `
          + `осталось ${remaining} кр, нужно ${plannedCredits} кр. Поднять потолок — в budget.json`,
      );
    }
    if (balanceCredits !== null && plannedCredits > balanceCredits) {
      blockers.push(`на балансе kie.ai всего ${balanceCredits} кр, нужно ${plannedCredits} кр`);
    }
    if (
      balanceCredits !== null
      && balanceCredits > 0
      && (plannedCredits / balanceCredits) * 100 > budget.warnBalancePercent
    ) {
      warnings.push(
        `запуск съест ${((plannedCredits / balanceCredits) * 100).toFixed(1)}% баланса `
          + `(${plannedCredits} из ${balanceCredits} кр)`,
      );
    }
  }

  return { ok: blockers.length === 0, blockers, warnings, spent, remaining, plannedUsd, budget };
}
