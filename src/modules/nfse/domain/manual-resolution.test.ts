import { describe, expect, it } from 'vitest';
import { blocksNotIssued, checkResolutionInput } from './manual-resolution.js';
import { DEFAULT_ESCALATION_POLICY, escalationLevel, nextEscalationAt } from './unknown-escalation.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('pedido de resolução manual (ADR-0034)', () => {
  const reason = 'Conferido no portal oficial pelo operador';

  it('AUTHORIZED exige o XML; NOT_ISSUED não aceita XML', () => {
    expect(checkResolutionInput({ outcome: 'AUTHORIZED', reason, nfseXml: '<NFSe/>' })).toEqual({ ok: true, value: 'AUTHORIZED' });
    expect(checkResolutionInput({ outcome: 'AUTHORIZED', reason, nfseXml: null })).toEqual({ ok: false, error: 'NFSE_XML_REQUIRED' });
    expect(checkResolutionInput({ outcome: 'AUTHORIZED', reason, nfseXml: '   ' })).toEqual({ ok: false, error: 'NFSE_XML_REQUIRED' });
    expect(checkResolutionInput({ outcome: 'NOT_ISSUED', reason, nfseXml: null })).toEqual({ ok: true, value: 'NOT_ISSUED' });
    expect(checkResolutionInput({ outcome: 'NOT_ISSUED', reason, nfseXml: '<NFSe/>' })).toEqual({ ok: false, error: 'NFSE_XML_NOT_ALLOWED' });
  });

  it('resultado fora do catálogo e justificativa curta ou longa são recusados', () => {
    expect(checkResolutionInput({ outcome: 'FAILED', reason, nfseXml: null })).toEqual({ ok: false, error: 'OUTCOME_INVALID' });
    expect(checkResolutionInput({ outcome: 'NOT_ISSUED', reason: '   curta   ', nfseXml: null })).toEqual({ ok: false, error: 'REASON_TOO_SHORT' });
    expect(checkResolutionInput({ outcome: 'NOT_ISSUED', reason: 'x'.repeat(2001), nfseXml: null })).toEqual({ ok: false, error: 'REASON_TOO_LONG' });
  });

  it('duplicidade informada pelo autorizador impede NOT_ISSUED', () => {
    expect(blocksNotIssued('ALREADY_EXISTS')).toBe(true);
    for (const outcome of ['UNKNOWN', 'RECOVERED_UNKNOWN', null]) expect(blocksNotIssued(outcome)).toBe(false);
  });
});

describe('escalonamento de UNKNOWN pela idade (doc 12 §6)', () => {
  const since = new Date('2026-11-12T10:00:00Z');
  const at = (ms: number) => new Date(since.getTime() + ms);

  it('níveis: nada antes de 15 min, WARNING, CRITICAL depois de 2 h, INCIDENT depois de 24 h', () => {
    expect(escalationLevel(15 * MIN - 1)).toBeUndefined();
    expect(escalationLevel(15 * MIN)).toBe('WARNING');
    expect(escalationLevel(2 * HOUR - 1)).toBe('WARNING');
    expect(escalationLevel(2 * HOUR)).toBe('CRITICAL');
    expect(escalationLevel(24 * HOUR)).toBe('INCIDENT');
    expect(escalationLevel(30 * 24 * HOUR)).toBe('INCIDENT');
  });

  it('próxima verificação: o próximo limite e, depois do incidente, a cada 24 h', () => {
    expect(nextEscalationAt(since, since)).toEqual(at(15 * MIN));
    expect(nextEscalationAt(since, at(15 * MIN))).toEqual(at(2 * HOUR));
    expect(nextEscalationAt(since, at(3 * HOUR))).toEqual(at(24 * HOUR));
    expect(nextEscalationAt(since, at(24 * HOUR))).toEqual(at(48 * HOUR));
    expect(nextEscalationAt(since, at(50 * HOUR))).toEqual(at(72 * HOUR));
    expect(DEFAULT_ESCALATION_POLICY.incidentRepeatMs).toBe(24 * HOUR);
  });
});
