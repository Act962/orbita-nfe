import { describe, expect, it } from 'vitest';
import { nextDailyRun, runDay } from './daily-schedule.js';

describe('agenda diária', () => {
  it('antes das 06:00 UTC: hoje; às 06:00 ou depois: amanhã', () => {
    expect(nextDailyRun(new Date('2026-11-11T05:59:59Z'))).toEqual(new Date('2026-11-11T06:00:00Z'));
    expect(nextDailyRun(new Date('2026-11-11T06:00:00Z'))).toEqual(new Date('2026-11-12T06:00:00Z'));
    expect(nextDailyRun(new Date('2026-12-31T23:00:00Z'))).toEqual(new Date('2027-01-01T06:00:00Z'));
  });

  it('dia da execução em UTC', () => {
    expect(runDay(new Date('2026-11-12T06:00:00Z'))).toBe('2026-11-12');
  });
});
