import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../../src/main/app.js';
import { composeApi, composeIamAdmin, type ApiModules } from '../../../src/main/compose.js';
import type { IamAdmin, Scope } from '../../../src/modules/iam/public.js';
import { computeCnpjCheckDigits } from '../../../src/shared/domain/cnpj.js';
import type { DatabaseHandle } from '../../../src/shared/infrastructure/database/database.js';
import { createLogger } from '../../../src/shared/infrastructure/logging/logger.js';
import type { HttpApp } from '../../../src/shared/presentation/http/http-app.js';
import { captureStream } from '../../support/canary.js';
import { connect } from './db.js';

/** Pepper fixo, só para testes. */
export const TEST_PEPPER = Buffer.from('test-only-pepper-0123456789abcdef-xyz');

export interface TestApi {
  readonly app: HttpApp;
  readonly modules: ApiModules;
  readonly admin: IamAdmin;
  readonly api: DatabaseHandle;
  readonly adminDb: DatabaseHandle;
  readonly logs: ReturnType<typeof captureStream>;
  close(): Promise<void>;
}

/** API completa, com a mesma composição de produção, sobre o PostgreSQL de teste. */
export async function startTestApi(): Promise<TestApi> {
  const api = connect('api', { poolMax: 10 });
  const adminDb = connect('admin', { poolMax: 2 });
  const logs = captureStream();
  const modules = composeApi({ db: api.db, apiKeyPepper: TEST_PEPPER });
  const app = await buildApp({
    logger: createLogger({ level: 'trace', service: 'test', destination: logs.stream }),
    bodyLimit: 1024 * 1024,
    readinessChecks: [],
    apiDocs: { enabled: false, version: 'test' },
    registerRoutes: modules.registerRoutes,
  });
  const admin = composeIamAdmin({ db: adminDb.db, apiKeyPepper: TEST_PEPPER });
  return {
    app,
    modules,
    admin,
    api,
    adminDb,
    logs,
    async close() {
      await app.close();
      await api.close();
      await adminDb.close();
    },
  };
}

let sequence = 0;
/** Nome único por execução (o nome da aplicação é único no banco). */
export const uniqueName = (prefix: string): string => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;

/** Raiz de CNPJ fictícia e única. */
export function fakeRoot(): string {
  return String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
}

export function cnpjOf(root: string, branch = '0001'): string {
  const base = root + branch;
  return base + computeCnpjCheckDigits(base);
}

export interface ClientApp {
  readonly id: string;
  key(scopes: readonly Scope[], environment?: 'live' | 'test'): Promise<string>;
}

export async function createClientApp(admin: IamAdmin, prefix = 'app'): Promise<ClientApp> {
  const id = await admin.createClientApplication(uniqueName(prefix));
  return {
    id,
    key: async (scopes, environment = 'test') => (await admin.issueCredential({ clientApplicationId: id, environment, scopes })).token,
  };
}

export const bearer = (token: string, companyId?: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  ...(companyId === undefined ? {} : { 'x-company-id': companyId }),
});

/** Empresa criada pela API (a aplicação criadora recebe a concessão). */
export async function createCompany(app: HttpApp, token: string, root = fakeRoot()): Promise<{ id: string; root: string }> {
  const res = await app.inject({ method: 'POST', url: '/v1/companies', headers: bearer(token), payload: { legalName: 'EMPRESA FICTICIA LTDA', rootCnpj: root } });
  if (res.statusCode !== 201) throw new Error(`criação de empresa falhou: ${res.statusCode} ${res.body}`);
  return { id: (res.json<{ id: string }>()).id, root };
}

export async function createEstablishment(app: HttpApp, token: string, companyId: string, cnpj: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/establishments',
    headers: bearer(token, companyId),
    payload: { cnpj, tradeName: 'Matriz', municipalityCode: '2211001' },
  });
  if (res.statusCode !== 201) throw new Error(`criação de estabelecimento falhou: ${res.statusCode} ${res.body}`);
  return res.json<{ id: string }>().id;
}

export const problemCode = (res: LightMyRequestResponse): unknown => res.json<{ code?: unknown }>().code;
