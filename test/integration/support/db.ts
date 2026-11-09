import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { computeCnpjCheckDigits } from '../../../src/shared/domain/cnpj.js';
import { createDatabase, type DatabaseHandle } from '../../../src/shared/infrastructure/database/database.js';

export type Role = 'api' | 'worker' | 'general' | 'admin' | 'owner' | 'superuser';

export function databaseUrl(role: Role): string {
  const urls = inject('database');
  return { api: urls.apiUrl, worker: urls.workerUrl, general: urls.generalUrl, admin: urls.adminUrl, owner: urls.ownerUrl, superuser: urls.superuserUrl }[role];
}

export function connect(role: Role, overrides: { poolMax?: number; statementTimeoutMs?: number } = {}): DatabaseHandle {
  return createDatabase({
    url: databaseUrl(role),
    poolMax: overrides.poolMax ?? 5,
    statementTimeoutMs: overrides.statementTimeoutMs ?? 5000,
    applicationName: `test-${role}`,
  });
}

/** CNPJ numérico válido e único por chamada (dados fictícios). */
export function fakeCnpj(): string {
  const base = String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
  return base + computeCnpjCheckDigits(base);
}

export function newId(): string {
  return randomUUID();
}
