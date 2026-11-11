import { z } from 'zod';

/**
 * Ensaio de cadastro (`?dryRun=true`, ADR-0026 item 4).
 *
 * A requisição passa pelas mesmas validações, restrições do banco e regras de negócio do
 * cadastro real, e a transação é desfeita no fim: nada é gravado, nenhum evento ou job sai, e
 * nenhuma linha de auditoria fica. Os erros são os mesmos do cadastro real (400, 404, 409, 422).
 *
 * A resposta de sucesso é 200 com `{ dryRun: true, result }`, nunca 201: o `id` em `result` é
 * provisório e não existe no sistema.
 */
export const DryRunQuery = z.object({
  dryRun: z
    .enum(['true', 'false'])
    .optional()
    .meta({ description: 'Com `true`, valida e simula o cadastro sem gravar nada. A resposta vem com 200 e `{ dryRun: true, result }`.' }),
});

export const isDryRun = (query: { dryRun?: 'true' | 'false' | undefined }): boolean => query.dryRun === 'true';

/** Envelope da resposta de ensaio para o recurso `resource` (id do componente no OpenAPI: `<id>DryRun`). */
export function dryRunResponse<T extends z.ZodType>(resource: T, id: string): z.ZodObject<{ dryRun: z.ZodLiteral<true>; result: T }> {
  return z
    .object({
      dryRun: z.literal(true),
      result: resource,
    })
    .meta({
      id: `${id}DryRun`,
      description: 'Resultado do ensaio: nada foi gravado. O `id` dentro de `result` é provisório e não existe no sistema.',
    });
}
