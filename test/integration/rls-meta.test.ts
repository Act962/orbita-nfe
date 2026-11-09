import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { databaseUrl } from './support/db.js';
import { auditTenantIsolation } from './support/rls-audit.js';

/**
 * Meta-teste de schema (docs/architecture/14 §B4, testes 1 e 11).
 * Gate bloqueante: uma tabela nova sem RLS forçado e política de tenant quebra o build.
 */
let owner: pg.Client;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: databaseUrl('owner') });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
});

describe('Meta-teste de isolamento multi-tenant', () => {
  it('todas as tabelas do schema public estão isoladas por tenant e nenhum papel contorna o RLS', async () => {
    expect(await auditTenantIsolation(owner)).toEqual([]);
  });

  it('teste do teste: uma tabela com tenant_id sem RLS é detectada', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query('CREATE TABLE tmp_sem_rls (id uuid primary key, tenant_id uuid not null)');
      const problems = await auditTenantIsolation(owner);
      expect(problems).toContain('tmp_sem_rls: RLS não habilitado');
      expect(problems).toContain('tmp_sem_rls: RLS não forçado (FORCE ROW LEVEL SECURITY)');
      expect(problems.some((p) => p.startsWith('tmp_sem_rls: sem política ALL'))).toBe(true);
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('teste do teste: RLS sem FORCE, política sem WITH CHECK e política permissiva extra são detectados', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query('CREATE TABLE tmp_parcial (id uuid primary key, tenant_id uuid not null)');
      await owner.query('ALTER TABLE tmp_parcial ENABLE ROW LEVEL SECURITY');
      await owner.query('CREATE POLICY so_using ON tmp_parcial USING (tenant_id = app_current_tenant())');
      await owner.query('CREATE POLICY aberta ON tmp_parcial FOR SELECT USING (true)');
      const problems = await auditTenantIsolation(owner);
      expect(problems).toContain('tmp_parcial: RLS não forçado (FORCE ROW LEVEL SECURITY)');
      expect(problems.some((p) => p.startsWith('tmp_parcial: sem política ALL'))).toBe(true);
      expect(problems.some((p) => p.includes('política permissiva adicional "aberta"'))).toBe(true);
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('teste do teste: tabela sem tenant_id fora da allowlist é detectada', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query('CREATE TABLE tmp_global (id uuid primary key)');
      expect(await auditTenantIsolation(owner)).toContain('tmp_global: tabela sem tenant_id e fora da allowlist NON_TENANT_TABLES');
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('migrations são idempotentes (segunda execução não altera nada)', async () => {
    await expect(runMigrations(databaseUrl('owner'))).resolves.toBeUndefined();
    expect(await auditTenantIsolation(owner)).toEqual([]);
  });
});
