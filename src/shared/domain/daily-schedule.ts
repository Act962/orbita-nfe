/**
 * Agenda diária dos jobs recorrentes (âncora da auditoria, ADR-0031): uma execução por dia às
 * 06:00 UTC (03:00 em Brasília), fora do horário comercial.
 */
export const DAILY_RUN_HOUR_UTC = 6;

/** Próxima execução estritamente depois de `now`. */
export function nextDailyRun(now: Date): Date {
  const run = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DAILY_RUN_HOUR_UTC));
  if (run.getTime() <= now.getTime()) run.setUTCDate(run.getUTCDate() + 1);
  return run;
}

/** Dia (UTC) de uma execução: compõe a chave singleton, para haver no máximo um job por dia. */
export const runDay = (at: Date): string => at.toISOString().slice(0, 10);
