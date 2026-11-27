import type { ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * `Prefer: wait=<segundos>` (RFC 7240, ADR-0026 A3), comum à NFS-e (ADR-0053) e à NFC-e (ADR-0077).
 *
 * O processamento continua assíncrono: o worker-fiscal transmite. A API só espera, consultando o
 * banco, até o recurso sair do andamento ou o prazo acabar. Nenhuma transação fica aberta durante
 * a espera.
 */
export const MAX_WAIT_SECONDS = 20;

/** Quando continuar esperando e quando o resultado é final (responde 201). */
export interface WaitPolicy<T> {
  /** Em andamento: a espera continua. UNKNOWN NÃO está aqui: a reconciliação leva mais tempo. */
  inFlight(value: T): boolean;
  final(value: T): boolean;
}

/**
 * Segundos pedidos, limitados a {@link MAX_WAIT_SECONDS}. `undefined` sem a preferência, com valor
 * inválido ou zero: preferência malformada é ignorada, como manda a RFC 7240 §2.
 */
export function preferredWait(header: string | readonly string[] | undefined): number | undefined {
  const values = header === undefined ? [] : typeof header === 'string' ? [header] : header;
  for (const value of values) {
    for (const preference of value.split(',')) {
      const match = /^\s*wait\s*=\s*"?(\d{1,6})"?\s*(?:;.*)?$/i.exec(preference);
      if (match?.[1] === undefined) continue;
      const seconds = Number(match[1]);
      return seconds === 0 ? undefined : Math.min(seconds, MAX_WAIT_SECONDS);
    }
  }
  return undefined;
}

export interface Settled<T> {
  readonly value: T;
  /** 200 repetição; 201 novo com resultado final dentro da espera; 202 novo ainda em andamento. */
  readonly status: 200 | 201 | 202;
  /** Valor para `Preference-Applied`, quando a espera foi aplicada. */
  readonly applied: string | undefined;
}

/**
 * Aplica a preferência a um recurso recém-aceito (ou repetido). A espera para se a conexão fechar
 * (`close` na resposta antes de enviada).
 */
export async function settle<T>(
  prefer: string | readonly string[] | undefined,
  response: Pick<ServerResponse, 'once' | 'off'>,
  accepted: { readonly value: T; readonly replayed: boolean },
  load: () => Promise<T>,
  policy: WaitPolicy<T>,
): Promise<Settled<T>> {
  const seconds = preferredWait(prefer);
  if (seconds === undefined) return { value: accepted.value, status: accepted.replayed ? 200 : 202, applied: undefined };
  const controller = new AbortController();
  const onClose = (): void => {
    controller.abort();
  };
  response.once('close', onClose);
  try {
    const value = await waitWhileInFlight(accepted.value, load, policy, seconds, controller.signal);
    return { value, status: accepted.replayed ? 200 : policy.final(value) ? 201 : 202, applied: `wait=${String(seconds)}` };
  } finally {
    response.off('close', onClose);
  }
}

/**
 * Consulta até o recurso sair do andamento, o prazo acabar ou o cliente desconectar. Intervalo
 * crescente (200 ms até 1 s) para não pesar no banco. Devolve a última leitura.
 */
export async function waitWhileInFlight<T>(
  first: T,
  load: () => Promise<T>,
  policy: WaitPolicy<T>,
  seconds: number,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<T> {
  const deadline = now() + seconds * 1000;
  let value = first;
  let interval = 200;
  while (policy.inFlight(value) && !signal.aborted) {
    const left = deadline - now();
    if (left <= 0) break;
    try {
      await sleep(Math.min(interval, left), undefined, { signal });
    } catch {
      break; // cliente desconectou: nada a responder
    }
    try {
      value = await load();
    } catch {
      // O pedido já foi aceito: uma falha só na consulta não pode virar erro dele. Responde o último estado.
      break;
    }
    interval = Math.min(Math.round(interval * 1.5), 1000);
  }
  return value;
}
