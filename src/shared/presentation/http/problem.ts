/**
 * Erros HTTP no formato RFC 9457 (application/problem+json) com `code` estável
 * (docs/architecture/11). Rejeição fiscal NÃO é erro HTTP: o documento existe com status REJECTED.
 */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

export interface ProblemIssue {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly ruleId?: string;
}

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly instance?: string;
  readonly correlationId?: string;
  readonly issues?: readonly ProblemIssue[];
}

/** Erro de aplicação que a borda HTTP converte em Problem. */
export class HttpProblemError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly issues?: readonly ProblemIssue[],
  ) {
    super(detail ?? title);
    this.name = 'HttpProblemError';
  }
}

export function problemType(code: string): string {
  return `urn:orbita-nfe:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}
