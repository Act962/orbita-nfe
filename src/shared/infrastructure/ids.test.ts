import { describe, expect, it } from 'vitest';
import { uuidv7 } from './ids.js';

describe('uuidv7', () => {
  it('tem versão 7 e variante RFC', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('carrega o timestamp e ordena pelo tempo', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(parseInt(a.replaceAll('-', '').slice(0, 12), 16)).toBe(1_700_000_000_000);
  });

  it('não repete', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(1)));
    expect(ids.size).toBe(1000);
  });
});
