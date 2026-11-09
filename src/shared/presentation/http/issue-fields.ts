import { ApplicationError } from '../../application/errors.js';

/**
 * Executa um caso de uso e prefixa o caminho dos campos dos erros com a origem da entrada
 * (`body`, `params`...), para que erros do domínio e do Zod usem a mesma convenção.
 */
export async function withIssueFields<T>(prefix: 'body' | 'params' | 'querystring', work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApplicationError) throw error.withIssueFieldPrefix(prefix);
    throw error;
  }
}
