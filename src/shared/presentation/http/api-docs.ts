import fastifySwagger from '@fastify/swagger';
import scalarApiReference from '@scalar/fastify-api-reference';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';
import type { HttpApp } from './http-app.js';

export interface ApiDocsOptions {
  readonly enabled: boolean;
  readonly version: string;
}

export const API_DOCS_PREFIX = '/docs';

/**
 * Documentação da API gerada a partir dos schemas Zod das rotas (fonte única de verdade):
 * - OpenAPI 3.1 em /docs/openapi.json e /docs/openapi.yaml
 * - Interface Scalar em /docs/ (assets servidos pelo próprio processo, sem CDN)
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
        ].join('\n'),
      },
      tags: [
        { name: 'Empresas', description: 'Empresas (raiz do CNPJ) e estabelecimentos (matriz e filiais).' },
        { name: 'Configurações fiscais', description: 'Séries e numeração por estabelecimento, modalidade e ambiente.' },
        { name: 'Certificados', description: 'Certificados e-CNPJ A1 por estabelecimento. A API cifra na chegada e devolve só metadados; chave privada e senha nunca saem do cofre.' },
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
