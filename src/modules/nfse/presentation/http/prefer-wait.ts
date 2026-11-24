import type { ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ServiceInvoice } from '../../application/ports.js';

/**
 * `Prefer: wait=<segundos>` na emissão e na substituição (RFC 7240, ADR-0026 A3, ADR-0053).
 *
 * A emissão continua assíncrona: o worker-fiscal transmite. A API só espera, consultando o banco,
 * até a nota sair do andamento ou o prazo acabar. Nenhuma transação fica aberta durante a espera.
 */
export const MAX_WAIT_SECONDS = 20;

/** Em andamento: a espera continua. UNKNOWN encerra a espera (a reconciliação leva mais tempo). */
const IN_FLIGHT: ReadonlySet<ServiceInvoice['status']> = new Set(['PENDING', 'PROCESSING']);
/** Resultado final de uma nota recém-aceita: responde 201. */
const FINAL: ReadonlySet<ServiceInvoice['status']> = new Set(['AUTHORIZED', 'REJECTED', 'FAILED', 'CANCELLED', 'SUBSTITUTED']);

export const isFinal = (invoice: ServiceInvoice): boolean => FINAL.has(invoice.status);

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

export interface Settled {
  readonly invoice: ServiceInvoice;
  /** 200 repetição; 201 nova com resultado final dentro da espera; 202 nova ainda em andamento. */
  readonly status: 200 | 201 | 202;
  /** Valor para `Preference-Applied`, quando a espera foi aplicada. */
  readonly applied: string | undefined;
}

/**
 * Aplica a preferência a uma nota recém-aceita (ou repetida). A espera para se a conexão fechar
 * (`close` na resposta antes de enviada).
 */
export async function settle(
  prefer: string | readonly string[] | undefined,
  response: Pick<ServerResponse, 'once' | 'off'>,
  accepted: { readonly invoice: ServiceInvoice; readonly replayed: boolean },
  load: () => Promise<ServiceInvoice>,
): Promise<Settled> {
  const seconds = preferredWait(prefer);
  if (seconds === undefined) return { invoice: accepted.invoice, status: accepted.replayed ? 200 : 202, applied: undefined };
  const controller = new AbortController();
  const onClose = (): void => {
    controller.abort();
  };
  response.once('close', onClose);
  try {
    const invoice = await waitWhileInFlight(accepted.invoice, load, seconds, controller.signal);
    return { invoice, status: accepted.replayed ? 200 : isFinal(invoice) ? 201 : 202, applied: `wait=${String(seconds)}` };
  } finally {
    response.off('close', onClose);
  }
}

/**
 * Consulta a nota até ela sair do andamento, o prazo acabar ou o cliente desconectar. Intervalo
 * crescente (200 ms até 1 s) para não pesar no banco. Devolve a última leitura.
 */
export async function waitWhileInFlight(
  first: ServiceInvoice,
  load: () => Promise<ServiceInvoice>,
  seconds: number,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<ServiceInvoice> {
  const deadline = now() + seconds * 1000;
  let invoice = first;
  let interval = 200;
  while (IN_FLIGHT.has(invoice.status) && !signal.aborted) {
    const left = deadline - now();
    if (left <= 0) break;
    try {
      await sleep(Math.min(interval, left), undefined, { signal });
    } catch {
      break; // cliente desconectou: nada a responder
    }
    try {
      invoice = await load();
    } catch {
      // A nota já foi aceita: uma falha só na consulta não pode virar erro da emissão. Responde o último estado.
      break;
    }
    interval = Math.min(Math.round(interval * 1.5), 1000);
  }
  return invoice;
}
