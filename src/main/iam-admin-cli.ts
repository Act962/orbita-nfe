import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadPepperFile, SCOPES, type CredentialEnvironment } from '../modules/iam/public.js';
import { ApplicationError } from '../shared/application/errors.js';
import { createDatabase } from '../shared/infrastructure/database/database.js';
import { composeIamAdmin } from './compose.js';

/**
 * CLI do operador para aplicações cliente, credenciais e concessões (ADR-0012).
 *
 * Conecta com o papel fiscal_admin (ADMIN_DATABASE_URL), nunca com o da API. A API key é
 * impressa UMA vez no stdout e não é gravada em lugar nenhum: entregue-a pelo cofre de
 * segredos da aplicação cliente.
 *
 *   npm run iam -- create-app --name Orbita
 *   npm run iam -- issue-key --app <uuid> --env live --scopes companies:create,companies:read [--expires-days 365]
 *   npm run iam -- revoke-key --key-id <16 hex>
 *   npm run iam -- grant --app <uuid> --company <uuid>
 *   npm run iam -- revoke-grant --app <uuid> --company <uuid>
 */
const EnvSchema = z.object({
  ADMIN_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'deve ser uma URL postgres://'),
  API_KEY_PEPPER_FILE: z.string().min(1),
});

const USAGE = `uso: iam <comando> [opções]
  create-app   --name <nome>
  issue-key    --app <uuid> --env <live|test> --scopes <a,b,...> [--expires-days <n>]
  revoke-key   --key-id <16 hex>
  grant        --app <uuid> --company <uuid>
  revoke-grant --app <uuid> --company <uuid>
escopos: ${SCOPES.join(', ')}
`;

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

function required(values: Record<string, string | undefined>, name: string): string {
  const value = values[name];
  if (value === undefined || value === '') throw new UsageError(`--${name} é obrigatório`);
  return value;
}

class UsageError extends Error {}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      name: { type: 'string' },
      app: { type: 'string' },
      env: { type: 'string' },
      scopes: { type: 'string' },
      'expires-days': { type: 'string' },
      'key-id': { type: 'string' },
      company: { type: 'string' },
    },
    strict: true,
  });

  const env = EnvSchema.safeParse(process.env);
  if (!env.success) throw new UsageError(env.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));

  const database = createDatabase({ url: env.data.ADMIN_DATABASE_URL, poolMax: 1, statementTimeoutMs: 10_000, applicationName: 'orbita-nfe-iam-cli' });
  const admin = composeIamAdmin({ db: database.db, apiKeyPepper: loadPepperFile(env.data.API_KEY_PEPPER_FILE) });
  try {
    switch (command) {
      case 'create-app':
        out(`aplicação criada: ${await admin.createClientApplication(required(values, 'name'))}`);
        return;
      case 'issue-key': {
        const environment = required(values, 'env');
        if (environment !== 'live' && environment !== 'test') throw new UsageError('--env deve ser live ou test');
        const days = values['expires-days'];
        const expiresAt = days === undefined ? undefined : new Date(Date.now() + Number(days) * 86_400_000);
        if (expiresAt !== undefined && Number.isNaN(expiresAt.getTime())) throw new UsageError('--expires-days inválido');
        const issued = await admin.issueCredential({
          clientApplicationId: required(values, 'app'),
          environment: environment satisfies CredentialEnvironment,
          scopes: required(values, 'scopes').split(',').map((s) => s.trim()).filter((s) => s !== ''),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        });
        out(`credencial ${issued.id} (keyId ${issued.keyId})`);
        out('API key (exibida somente agora; guarde no cofre de segredos da aplicação):');
        out(issued.token);
        return;
      }
      case 'revoke-key':
        await admin.revokeCredential(required(values, 'key-id'));
        out('credencial revogada');
        return;
      case 'grant':
        await admin.grantCompany(required(values, 'app'), required(values, 'company'));
        out('concessão ativa');
        return;
      case 'revoke-grant':
        await admin.revokeCompanyGrant(required(values, 'app'), required(values, 'company'));
        out('concessão revogada');
        return;
      default:
        throw new UsageError(command === undefined ? 'informe o comando' : `comando desconhecido: ${command}`);
    }
  } finally {
    await database.close();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
  } else if (error instanceof ApplicationError && error.category !== 'INTERNAL') {
    const issues = error.issues.map((i) => `\n  - ${i.field ?? ''}: ${i.message}`).join('');
    process.stderr.write(`erro ${error.code}: ${error.message}${issues}\n`);
  } else {
    // Nunca a mensagem bruta: pode conter dados do banco.
    const code = error instanceof ApplicationError ? error.code : 'UNEXPECTED';
    process.stderr.write(`falha (${code})\n`);
  }
  process.exit(1);
});
