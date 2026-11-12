import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ROUTING_CHANNELS, type RoutingTable } from '../../domain/routing.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const rowSchema = z
  .object({
    id: z.string().regex(/^[A-Z0-9-]{3,60}$/),
    municipality: z.string().regex(/^(\*|\d{7})$/),
    simplesNacionalOption: z.array(z.string().regex(/^\d$/)).min(1).nullable(),
    simplesNacionalRegime: z.array(z.string().regex(/^\d$/)).min(1).nullable(),
    competenceFrom: z.string().regex(DATE).nullable(),
    competenceBefore: z.string().regex(DATE).nullable(),
    channel: z.enum(ROUTING_CHANNELS),
    // Toda linha tem a origem documentada (regra do projeto).
    source: z.string().min(10),
  })
  .strict()
  .refine((r) => r.competenceFrom === null || r.competenceBefore === null || r.competenceFrom < r.competenceBefore, 'faixa de competência vazia');

const tableSchema = z
  .object({
    version: z.string().regex(/^nfse-routing\/\d{4}-\d{2}-\d{2}$/),
    decision: z.string().min(1),
    approvedOn: z.string().regex(DATE),
    notes: z.array(z.string()),
    rows: z.array(rowSchema).min(1),
  })
  .strict()
  .refine((t) => new Set(t.rows.map((r) => r.id)).size === t.rows.length, 'id de linha repetido');

export class RoutingTableError extends Error {
  constructor(readonly code: 'ROUTING_TABLE_INVALID') {
    super(code);
    this.name = 'RoutingTableError';
  }
}

/** Carrega e valida a tabela de roteamento (ADR-0028). Falha na subida se o arquivo for inválido. */
export function loadRoutingTable(path: string): RoutingTable {
  const parsed = tableSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new RoutingTableError('ROUTING_TABLE_INVALID');
  return { version: parsed.data.version, rows: parsed.data.rows };
}
