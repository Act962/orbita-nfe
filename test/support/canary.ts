import { Writable } from 'node:stream';
import { expect } from 'vitest';

/**
 * Marcadores únicos usados como "segredos" nos testes. Se algum aparecer em log, span ou
 * resposta HTTP, o teste falha (docs/architecture/13 §7).
 */
export const CANARIES = {
  password: 'CANARY-PASSWORD-7f3a91c2',
  pfx: 'CANARY-PFX-BYTES-55e0d1aa',
  apiKey: 'CANARY-APIKEY-0b9c44de',
  csc: 'CANARY-CSC-a1b2c3d4',
  privateKey: 'CANARY-PRIVATEKEY-9e8d7c6b',
} as const;

export function expectNoCanary(output: string): void {
  for (const [name, marker] of Object.entries(CANARIES)) {
    expect(output, `segredo "${name}" vazou na saída`).not.toContain(marker);
  }
}

export function captureStream(): { stream: Writable; text: () => string; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const text = (): string => chunks.join('');
  const lines = (): Record<string, unknown>[] =>
    text()
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { stream, text, lines };
}
