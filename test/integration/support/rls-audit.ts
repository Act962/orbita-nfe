import type pg from 'pg';

/**
 * Auditoria do isolamento multi-tenant direto no catálogo do PostgreSQL
 * (docs/architecture/14 §B4, teste 1). Retorna a lista de problemas; vazia = ok.
 */

/** Tabelas cujo próprio `id` é o tenant (política usa `id`, não `tenant_id`). */
export const TENANT_ROOT_TABLES = ['tenants'] as const;

/**
 * Tabelas sem dados de tenant, revisadas uma a uma. Incluir aqui exige justificativa no PR.
 * (Vazia hoje: toda tabela do schema public pertence a um tenant.)
 */
export const NON_TENANT_TABLES: readonly string[] = [];

export const APPLICATION_ROLES = ['fiscal_api', 'fiscal_worker', 'fiscal_general', 'fiscal_system'] as const;

interface TableRow {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  has_tenant_id: boolean;
}

interface PolicyRow {
  tablename: string;
  policyname: string;
  cmd: string;
  permissive: string;
  qual: string | null;
  with_check: string | null;
}

export async function auditTenantIsolation(client: pg.ClientBase): Promise<string[]> {
  const problems: string[] = [];

  const tables = await client.query<TableRow>(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant_id
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     ORDER BY c.relname`);
  const policies = await client.query<PolicyRow>(`
    SELECT tablename, policyname, cmd, permissive, qual, with_check FROM pg_policies WHERE schemaname = 'public'`);

  for (const table of tables.rows) {
    const isRoot = (TENANT_ROOT_TABLES as readonly string[]).includes(table.relname);
    const tenantScoped = isRoot || table.has_tenant_id;

    if (!tenantScoped) {
      if (!NON_TENANT_TABLES.includes(table.relname)) {
        problems.push(`${table.relname}: tabela sem tenant_id e fora da allowlist NON_TENANT_TABLES`);
      }
      continue;
    }
    if (!table.relrowsecurity) problems.push(`${table.relname}: RLS não habilitado`);
    if (!table.relforcerowsecurity) problems.push(`${table.relname}: RLS não forçado (FORCE ROW LEVEL SECURITY)`);

    const own = policies.rows.filter((p) => p.tablename === table.relname);
    const column = isRoot ? 'id' : 'tenant_id';
    const isolating = own.filter(
      (p) =>
        p.cmd === 'ALL' &&
        p.permissive === 'PERMISSIVE' &&
        (p.qual ?? '').replace(/\s+/g, '').includes(`(${column}=app_current_tenant())`) &&
        (p.with_check ?? '').replace(/\s+/g, '').includes(`(${column}=app_current_tenant())`),
    );
    if (isolating.length === 0) {
      problems.push(`${table.relname}: sem política ALL com USING e WITH CHECK por ${column} = app_current_tenant()`);
    }
    // Uma política permissiva extra seria somada (OR) à de isolamento e poderia abri-la.
    for (const extra of own.filter((p) => p.permissive === 'PERMISSIVE' && !isolating.includes(p))) {
      problems.push(`${table.relname}: política permissiva adicional "${extra.policyname}" (revisar: pode anular o isolamento)`);
    }
  }

  const roles = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1)`,
    [APPLICATION_ROLES],
  );
  for (const expected of APPLICATION_ROLES) {
    const role = roles.rows.find((r) => r.rolname === expected);
    if (!role) problems.push(`papel ${expected} não existe`);
    else if (role.rolsuper || role.rolbypassrls) problems.push(`papel ${expected} tem SUPERUSER ou BYPASSRLS`);
  }

  // Membros (usuários de login) dos papéis de aplicação também não podem contornar o RLS.
  const members = await client.query<{ rolname: string }>(
    `SELECT DISTINCT m.rolname FROM pg_auth_members am
       JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
      WHERE g.rolname = ANY($1) AND (m.rolsuper OR m.rolbypassrls)`,
    [APPLICATION_ROLES],
  );
  for (const member of members.rows) problems.push(`usuário ${member.rolname} (membro de papel de aplicação) tem SUPERUSER ou BYPASSRLS`);

  return problems;
}
