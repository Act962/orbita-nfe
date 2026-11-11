import { describe, expect, it } from 'vitest';
import { expiryNoticeThreshold, expiryNoticeTimes } from './certificate.js';

const DAY = 86_400_000;
const now = new Date('2026-11-11T12:00:00Z');
const inDays = (days: number): Date => new Date(now.getTime() + days * DAY);

describe('avisos de vencimento', () => {
  it('certificado com 1 ano: agenda 30, 15, 7, 1 dia antes e o vencimento', () => {
    const notAfter = inDays(365);
    expect(expiryNoticeTimes(notAfter, now).map((d) => (notAfter.getTime() - d.getTime()) / DAY)).toEqual([30, 15, 7, 1, 0]);
  });

  it('ativado com 10 dias de validade: aviso imediato e os limiares restantes', () => {
    const times = expiryNoticeTimes(inDays(10), now);
    expect(times[0]).toEqual(now);
    expect(times.slice(1).map((d) => (inDays(10).getTime() - d.getTime()) / DAY)).toEqual([7, 1, 0]);
  });

  it('limiar vigente: menor limiar alcançado, arredondando os dias para cima', () => {
    expect(expiryNoticeThreshold(inDays(45), now)).toBeNull();
    expect(expiryNoticeThreshold(inDays(30), now)).toEqual({ thresholdDays: 30, daysRemaining: 30 });
    expect(expiryNoticeThreshold(inDays(29.9), now)).toEqual({ thresholdDays: 30, daysRemaining: 30 });
    expect(expiryNoticeThreshold(inDays(10), now)).toEqual({ thresholdDays: 15, daysRemaining: 10 });
    expect(expiryNoticeThreshold(inDays(5), now)).toEqual({ thresholdDays: 7, daysRemaining: 5 });
    expect(expiryNoticeThreshold(inDays(0.5), now)).toEqual({ thresholdDays: 1, daysRemaining: 1 });
    expect(expiryNoticeThreshold(inDays(0), now)).toEqual({ thresholdDays: 0, daysRemaining: 0 });
    expect(expiryNoticeThreshold(inDays(-3), now)).toEqual({ thresholdDays: 0, daysRemaining: 0 });
  });
});
