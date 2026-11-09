import { z } from 'zod';

/**
 * Erros HTTP no formato RFC 9457 (application/problem+json) com `code` estável
 * (docs/architecture/11). Rejeição fiscal NÃO é erro HTTP: o documento existe com status REJECTED.
 */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

export const ProblemIssueSchema = z
  .object({
    code: z.string().meta({ description: 'Código estável do problema neste campo.', example: 'INVALID_TYPE' }),
    message: z.string().meta({ description: 'Mensagem em português, segura para exibição.' }),
    field: z.string().optional().meta({ description: 'Caminho do campo (ex.: body.values.serviceAmount).' }),
    ruleId: z.string().optional().meta({ description: 'Regra fiscal de origem (docs/fiscal/regras/<ruleId>.md).' }),
  })
  .meta({ id: 'ProblemIssue' });

export const ProblemSchema = z
  .object({
    type: z.string().meta({ example: 'urn:orbita-nfe:problem:validation-failed' }),
    title: z.string().meta({ example: 'Requisição inválida' }),
    status: z.number().int().meta({ example: 400 }),
    code: z.string().meta({ description: 'Código estável. Use este campo para tratar o erro.', example: 'VALIDATION_FAILED' }),
    detail: z.string().optional(),
    instance: z.string().optional().meta({ description: 'Caminho da requisição, sem query string.' }),
    correlationId: z.string().optional().meta({ description: 'Identificador para suporte e rastreio (header X-Correlation-Id).' }),
    issues: z.array(ProblemIssueSchema).optional(),
  })
  .meta({ id: 'Problem', description: 'Erro no formato RFC 9457 (application/problem+json).' });

export type Problem = z.infer<typeof ProblemSchema>;
export type ProblemIssue = z.infer<typeof ProblemIssueSchema>;

export function problemType(code: string): string {
  return `urn:orbita-nfe:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}

/**
 * Respostas de erro comuns a toda rota, para documentar no OpenAPI.
 * Cada rota acrescenta as específicas (401, 404, 409, 422...).
 */
export const commonErrorResponses = {
  400: ProblemSchema,
  500: ProblemSchema,
} as const;
