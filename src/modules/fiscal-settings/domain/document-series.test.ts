import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { newDocumentSeries, type DocumentKind } from './document-series.js';

const base = { id: 's1', companyId: 't1', establishmentId: 'e1', environment: 'HOMOLOGATION' as const };

describe('newDocumentSeries', () => {
  it('padrão: próximo número 1 e limite da modalidade', () => {
    expect(newDocumentSeries({ ...base, kind: 'NFE', series: '1' })).toEqual({
      ok: true,
      value: { ...base, kind: 'NFE', series: '1', nextNumber: 1, maxNumber: 999_999_999, status: 'ACTIVE' },
    });
    const dps = newDocumentSeries({ ...base, kind: 'NFSE_DPS', series: '89999' });
    expect(dps.ok && dps.value.maxNumber).toBe(999_999_999_999_999);
  });

  it('continua a numeração de outro emissor', () => {
    const r = newDocumentSeries({ ...base, kind: 'NFCE', series: '0', nextNumber: 1520 });
    expect(r.ok && r.value.nextNumber).toBe(1520);
  });

  it.each<[DocumentKind, string]>([
    ['NFE', '1000'],
    ['NFE', '01'],
    ['NFE', '-1'],
    ['NFE', 'A'],
    ['NFCE', ''],
    ['NFSE_DPS', '123456'],
    ['NFSE_DPS', '90000'],
    ['NFSE_DPS', '00001'],
  ])('%s: série "%s" inválida', (kind, series) => {
    const r = newDocumentSeries({ ...base, kind, series });
    expect(r).toMatchObject({ ok: false, error: [{ code: 'INVALID_SERIES', field: 'series' }] });
  });

  it('SERIES-001/002 no ruleId', () => {
    const nfe = newDocumentSeries({ ...base, kind: 'NFE', series: 'x' });
    const dps = newDocumentSeries({ ...base, kind: 'NFSE_DPS', series: 'x' });
    expect(!nfe.ok && nfe.error[0]?.ruleId).toBe('SERIES-001');
    expect(!dps.ok && dps.error[0]?.ruleId).toBe('SERIES-002');
  });

  it.each([0, -1, 1.5, 1_000_000_000, Number.NaN])('NF-e: próximo número %s inválido', (nextNumber) => {
    const r = newDocumentSeries({ ...base, kind: 'NFE', series: '1', nextNumber });
    expect(r).toMatchObject({ ok: false, error: [{ code: 'INVALID_NEXT_NUMBER' }] });
  });

  it('propriedade: toda série NF-e de 0 a 999 sem zero à esquerda é aceita', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999 }), (n) => {
        expect(newDocumentSeries({ ...base, kind: 'NFE', series: String(n) }).ok).toBe(true);
      }),
    );
  });
});
