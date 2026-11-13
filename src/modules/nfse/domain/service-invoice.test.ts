import { describe, expect, it } from 'vitest';
import { buildDpsId } from './dps-id.js';
import { afterLookup, DEFAULT_RECONCILIATION_POLICY, nextStep, type ReconciliationState } from './reconciliation.js';
import { canTransition, isFinal, recoverStuck, releasesExternalReference, SERVICE_INVOICE_STATUSES, transition } from './service-invoice.js';

describe('máquina de estados da NFS-e', () => {
  it.each([
    ['PENDING', 'PROCESSING'],
    ['PENDING', 'FAILED'],
    ['PROCESSING', 'AUTHORIZED'],
    ['PROCESSING', 'REJECTED'],
    ['PROCESSING', 'UNKNOWN'],
    ['PROCESSING', 'PENDING'],
    ['UNKNOWN', 'AUTHORIZED'],
    ['UNKNOWN', 'PENDING'],
    ['AUTHORIZED', 'CANCELLED'],
    ['AUTHORIZED', 'SUBSTITUTED'],
  ] as const)('%s → %s é permitida', (from, to) => {
    expect(transition(from, to)).toEqual({ ok: true, value: to });
  });

  it.each([
    ['UNKNOWN', 'FAILED'],
    ['UNKNOWN', 'REJECTED'],
    ['PENDING', 'AUTHORIZED'],
    ['AUTHORIZED', 'PENDING'],
    ['REJECTED', 'PENDING'],
    ['FAILED', 'PENDING'],
    ['UNKNOWN', 'CANCELLED'],
    ['CANCELLED', 'AUTHORIZED'],
    ['UNKNOWN', 'SUBSTITUTED'],
    ['SUBSTITUTED', 'AUTHORIZED'],
    ['CANCELLED', 'SUBSTITUTED'],
    ['SUBSTITUTED', 'CANCELLED'],
  ] as const)('%s → %s é proibida', (from, to) => {
    expect(transition(from, to)).toEqual({ ok: false, error: { code: 'INVALID_TRANSITION', from, to } });
  });

  it('nenhum caminho automático leva UNKNOWN a FAILED', () => {
    expect(canTransition('UNKNOWN', 'FAILED')).toBe(false);
  });

  it('estados finais e reutilização da referência externa', () => {
    expect(SERVICE_INVOICE_STATUSES.filter(isFinal)).toEqual(['REJECTED', 'FAILED', 'CANCELLED', 'SUBSTITUTED']);
    expect(SERVICE_INVOICE_STATUSES.filter(releasesExternalReference)).toEqual(['REJECTED', 'FAILED']);
  });

  it('recuperação de queda: SENDING → UNKNOWN; PREPARED ou nada → PENDING', () => {
    expect(recoverStuck('SENDING')).toEqual({ kind: 'TO_UNKNOWN' });
    expect(recoverStuck('PREPARED')).toEqual({ kind: 'BACK_TO_PENDING' });
    expect(recoverStuck(null)).toEqual({ kind: 'BACK_TO_PENDING' });
  });
});

describe('Id da DPS (TSIdDPS)', () => {
  it('CNPJ: "DPS" + município + 2 + CNPJ + série(5) + número(15), 45 posições', () => {
    const id = buildDpsId({ municipalityCode: '2211001', registration: { kind: 'CNPJ', value: '11222333000181' }, series: '1', number: 42 });
    expect(id).toEqual({ ok: true, value: 'DPS2211001211222333000181' + '00001' + '000000000000042' });
    expect(id.ok && id.value.length).toBe(45);
  });

  it('CNPJ alfanumérico e CPF com zeros à esquerda', () => {
    expect(buildDpsId({ municipalityCode: '2211001', registration: { kind: 'CNPJ', value: '12ABC34501DE35' }, series: '900', number: 1 })).toEqual({
      ok: true,
      value: 'DPS2211001212ABC34501DE3500900000000000000001',
    });
    expect(buildDpsId({ municipalityCode: '2211001', registration: { kind: 'CPF', value: '12345678909' }, series: '1', number: 1 })).toEqual({
      ok: true,
      value: 'DPS22110011000123456789090000100000000000000' + '1',
    });
  });

  it.each([
    [{ municipalityCode: '221100', registration: { kind: 'CNPJ', value: '11222333000181' }, series: '1', number: 1 }, 'MUNICIPALITY_INVALID'],
    [{ municipalityCode: '2211001', registration: { kind: 'CNPJ', value: '1122233300018' }, series: '1', number: 1 }, 'REGISTRATION_INVALID'],
    [{ municipalityCode: '2211001', registration: { kind: 'CPF', value: '1234567890A' }, series: '1', number: 1 }, 'REGISTRATION_INVALID'],
    [{ municipalityCode: '2211001', registration: { kind: 'CNPJ', value: '11222333000181' }, series: '123456', number: 1 }, 'SERIES_INVALID'],
    [{ municipalityCode: '2211001', registration: { kind: 'CNPJ', value: '11222333000181' }, series: '1', number: 0 }, 'NUMBER_INVALID'],
    [{ municipalityCode: '2211001', registration: { kind: 'CNPJ', value: '11222333000181' }, series: '1', number: 1e15 }, 'NUMBER_INVALID'],
  ] as const)('recusa entrada inválida (%#)', (input, error) => {
    expect(buildDpsId(input)).toEqual({ ok: false, error });
  });
});

describe('reconciliação (doc 12 §3)', () => {
  const MIN = 60_000;
  const t0 = new Date('2026-11-12T10:00:00Z');
  const at = (minutes: number) => new Date(t0.getTime() + minutes * MIN);
  const fresh: ReconciliationState = { sendingAt: t0, firstNotFoundAt: null, consecutiveLookupErrors: 0 };

  it('respeita a espera mínima depois do SENDING', () => {
    expect(nextStep(fresh, at(1))).toEqual({ kind: 'WAIT_UNTIL', at: at(2) });
    expect(nextStep(fresh, at(2))).toEqual({ kind: 'LOOKUP' });
  });

  it('encontrado → AUTHORIZED, em qualquer momento', () => {
    expect(afterLookup(fresh, { kind: 'FOUND' }, at(3))).toEqual({ kind: 'AUTHORIZED' });
  });

  it('um "não encontrado" nunca basta: só a 2ª resposta espaçada autoriza retransmitir', () => {
    const first = afterLookup(fresh, { kind: 'NOT_FOUND' }, at(3));
    expect(first).toEqual({ kind: 'CONSULT_AGAIN_AT', at: at(8), state: { ...fresh, firstNotFoundAt: at(3) } });
    if (first.kind !== 'CONSULT_AGAIN_AT') throw new Error();
    // Cedo demais: não conta, reagenda para o tempo certo.
    expect(afterLookup(first.state, { kind: 'NOT_FOUND' }, at(6))).toEqual({ kind: 'CONSULT_AGAIN_AT', at: at(8), state: first.state });
    expect(afterLookup(first.state, { kind: 'NOT_FOUND' }, at(8))).toEqual({ kind: 'RETRANSMIT' });
  });

  it('consistência eventual: "não encontrado" e depois "encontrado" → AUTHORIZED, sem retransmitir', () => {
    const first = afterLookup(fresh, { kind: 'NOT_FOUND' }, at(3));
    if (first.kind !== 'CONSULT_AGAIN_AT') throw new Error();
    expect(afterLookup(first.state, { kind: 'FOUND' }, at(9))).toEqual({ kind: 'AUTHORIZED' });
  });

  it('erro na consulta: 1, 2, 5, 10, 30 e 60 min, depois 60 min sempre; nunca desiste', () => {
    let state = fresh;
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      const decision = afterLookup(state, { kind: 'ERROR' }, at(100));
      if (decision.kind !== 'CONSULT_AGAIN_AT') throw new Error();
      waits.push((decision.at.getTime() - at(100).getTime()) / MIN);
      state = decision.state;
    }
    expect(waits).toEqual([1, 2, 5, 10, 30, 60, 60, 60]);
    expect(DEFAULT_RECONCILIATION_POLICY.errorBackoffMs.length).toBe(6);
  });

  it('uma resposta depois de erros zera o contador de erros', () => {
    const decision = afterLookup({ ...fresh, consecutiveLookupErrors: 4 }, { kind: 'NOT_FOUND' }, at(50));
    expect(decision.kind === 'CONSULT_AGAIN_AT' && decision.state.consecutiveLookupErrors).toBe(0);
  });
});
