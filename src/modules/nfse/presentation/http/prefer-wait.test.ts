import { describe, expect, it } from 'vitest';
import type { ServiceInvoice, ServiceInvoiceCancellation } from '../../application/ports.js';
import { CANCELLATION_WAIT, INVOICE_WAIT, MAX_WAIT_SECONDS, preferredWait, waitWhileInFlight } from './prefer-wait.js';

describe('Prefer: wait (RFC 7240, ADR-0053)', () => {
  it('lê wait entre outras preferências e limita ao máximo', () => {
    expect(preferredWait('wait=5')).toBe(5);
    expect(preferredWait('respond-async, wait=3')).toBe(3);
    expect(preferredWait('return=minimal, WAIT = "7"')).toBe(7);
    expect(preferredWait(['return=minimal', 'wait=2'])).toBe(2);
    expect(preferredWait('wait=999')).toBe(MAX_WAIT_SECONDS);
  });

  it('ausente, zero ou malformado: sem espera (preferência inválida é ignorada)', () => {
    expect(preferredWait(undefined)).toBeUndefined();
    expect(preferredWait('wait=0')).toBeUndefined();
    expect(preferredWait('wait=-1')).toBeUndefined();
    expect(preferredWait('wait=abc')).toBeUndefined();
    expect(preferredWait('wait=1.5')).toBeUndefined();
    expect(preferredWait('respond-async')).toBeUndefined();
  });

  const invoice = (status: ServiceInvoice['status']): ServiceInvoice => ({ status }) as ServiceInvoice;

  it('consulta até sair do andamento; UNKNOWN encerra a espera', async () => {
    const statuses: ServiceInvoice['status'][] = ['PROCESSING', 'UNKNOWN', 'AUTHORIZED'];
    let loads = 0;
    const result = await waitWhileInFlight(invoice('PENDING'), () => Promise.resolve(invoice(statuses[loads++] ?? 'AUTHORIZED')), INVOICE_WAIT, 5, new AbortController().signal);
    expect(result.status).toBe('UNKNOWN');
    expect(loads).toBe(2);
  });

  it('erro na consulta durante a espera: devolve o último estado, sem falhar', async () => {
    const result = await waitWhileInFlight(invoice('PENDING'), () => Promise.reject(new Error('banco fora')), INVOICE_WAIT, 5, new AbortController().signal);
    expect(result.status).toBe('PENDING');
  });

  it('cliente desconectado: para sem consultar de novo', async () => {
    const controller = new AbortController();
    let loads = 0;
    const waiting = waitWhileInFlight(
      invoice('PENDING'),
      () => {
        loads += 1;
        return Promise.resolve(invoice('PENDING'));
      },
      INVOICE_WAIT,
      5,
      controller.signal,
    );
    controller.abort();
    expect((await waiting).status).toBe('PENDING');
    expect(loads).toBe(0);
  });

  it('cancelamento (ADR-0053): REGISTERED, REJECTED e FAILED são finais; UNKNOWN encerra a espera sem ser final', () => {
    const cancellation = (state: ServiceInvoiceCancellation['state']) => ({ state }) as ServiceInvoiceCancellation;
    for (const state of ['REGISTERED', 'REJECTED', 'FAILED'] as const) expect([CANCELLATION_WAIT.inFlight(cancellation(state)), CANCELLATION_WAIT.final(cancellation(state))]).toEqual([false, true]);
    expect([CANCELLATION_WAIT.inFlight(cancellation('UNKNOWN')), CANCELLATION_WAIT.final(cancellation('UNKNOWN'))]).toEqual([false, false]);
    expect(CANCELLATION_WAIT.inFlight(cancellation('PROCESSING'))).toBe(true);
  });
});
