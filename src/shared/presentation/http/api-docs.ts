import fastifySwagger from '@fastify/swagger';
import scalarApiReference from '@scalar/fastify-api-reference';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';
import { registerAgentDocs } from './agent-docs.js';
import type { HttpApp } from './http-app.js';

export interface ApiDocsOptions {
  readonly enabled: boolean;
  readonly version: string;
  /** Pasta dos guias em Markdown (docs/api). Padrão: `docs/api` a partir do diretório atual. */
  readonly guidesDir?: string;
}

export const API_DOCS_PREFIX = '/docs';

/**
 * Documentação da API gerada a partir dos schemas Zod das rotas (fonte única de verdade):
 * - OpenAPI 3.1 em /openapi.json (URL estável), /docs/openapi.json e /docs/openapi.yaml
 * - Interface Scalar em /docs/ (assets servidos pelo próprio processo, sem CDN)
 * - /llms.txt e guias em Markdown em /guides/ (agent-docs.ts)
 *
 * Deve ser registrada ANTES das rotas, para que o @fastify/swagger as colete.
 */
export async function registerApiDocs(app: HttpApp, options: ApiDocsOptions): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Motor Fiscal — API',
        version: options.version,
        description: [
          'API única de emissão e gestão de documentos fiscais eletrônicos (NFS-e, NFC-e, NF-e) para Orbita, NERP e demais sistemas.',
          '',
          '**Erros**: todas as respostas de erro seguem a RFC 9457 (`application/problem+json`) com o campo `code` estável. Trate erros pelo `code`, nunca pela mensagem.',
          '',
          '**Rejeição fiscal não é erro HTTP**: um documento rejeitado pelo autorizador existe com `status: REJECTED`.',
          '',
          '**Rastreio**: envie `X-Correlation-Id` para correlacionar logs; ele é sempre devolvido na resposta.',
          '',
          '**Ensaio**: os cadastros aceitam `dryRun=true`: validam tudo e não gravam nada (resposta 200 com `{ dryRun: true, result }`).',
          '',
          '**Versão e descontinuação**: mudanças incompatíveis só em nova versão de caminho (`/v2`). Rota descontinuada responde com `Deprecation`, `Sunset` (no mínimo 180 dias depois) e `Link` para o guia de migração. Política em `/guides/versionamento.md`; histórico em `/guides/changelog.md`.',
          '',
          '**Para agentes**: índice em `/llms.txt`; este contrato em `/openapi.json`.',
        ].join('\n'),
      },
      tags: [
        { name: 'Empresas', description: 'Empresas (raiz do CNPJ) e estabelecimentos (matriz e filiais).' },
        { name: 'Configurações fiscais', description: 'Séries e numeração por estabelecimento, modalidade e ambiente.' },
        { name: 'Certificados', description: 'Certificados e-CNPJ A1 por estabelecimento. A API cifra na chegada e devolve só metadados; chave privada e senha nunca saem do cofre.' },
        {
          name: 'Habilitação de produção',
          description: 'Liberação de cada modalidade para produção, por estabelecimento. Junto com a credencial `live`, é a segunda trava antes de qualquer emissão em produção.',
        },
        { name: 'Webhooks', description: 'Assinaturas de eventos, entregas assinadas (Standard Webhooks), reenvio e catálogo de eventos.' },
        { name: 'Operação', description: 'Saúde e prontidão do serviço.' },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'http',
            scheme: 'bearer',
            description:
              'API key da aplicação cliente (ADR-0012), no formato `fk_<live|test>_<keyId>_<segredo>`, emitida pelo operador. Rotas de empresa exigem também o header `X-Company-Id` de uma empresa com concessão para a aplicação.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  if (!options.enabled) return;

  registerAgentDocs(app, { guidesDir: options.guidesDir ?? 'docs/api' });

  await app.register(scalarApiReference, {
    routePrefix: API_DOCS_PREFIX,
    configuration: {
      pageTitle: 'Motor Fiscal — API',
      // API fiscal interna: nada de recursos que enviem o documento para a nuvem da Scalar
      // (barra de ferramentas com Share/Generate SDK/Deploy, chat "Ask AI", telemetria).
      showDeveloperTools: 'never',
      agent: { disabled: true },
      telemetry: false,
      hideClientButton: false,
    },
    logLevel: 'warn',
  });
}
