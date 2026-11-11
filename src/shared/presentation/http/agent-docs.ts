import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { HttpApp } from './http-app.js';

/**
 * Documentação legível por agentes e por gente (ADR-0027 item 8; doc 17 B9/B10):
 * - `/openapi.json`: OpenAPI 3.1 em URL estável (o mesmo de /docs/openapi.json);
 * - `/llms.txt`: índice em Markdown no formato llms.txt;
 * - `/guides/<página>.md`: guias em Markdown (lista fechada, lida do disco na inicialização).
 *
 * Os guias ficam em `docs/api/` no repositório e são copiados para a imagem.
 */
export const API_GUIDES = [
  { page: 'guia-rapido', title: 'Guia rápido', summary: 'Credencial, empresa, primeiro cadastro, erros, ensaio (dryRun) e ambientes.' },
  { page: 'webhooks', title: 'Webhooks', summary: 'Catálogo de eventos, verificação da assinatura, calendário de reentrega e deduplicação.' },
  { page: 'versionamento', title: 'Versionamento e descontinuação', summary: 'O que é mudança compatível, prazos e os headers Deprecation e Sunset.' },
  { page: 'changelog', title: 'Changelog', summary: 'Mudanças da API por data, com o guia de migração de cada versão nova.' },
] as const;

const GuideParams = z.object({ page: z.enum(API_GUIDES.map((g) => `${g.page}.md`) as [string, ...string[]]) });

function llmsTxt(): string {
  return [
    '# Motor Fiscal — API',
    '',
    '> API única de emissão e gestão de documentos fiscais eletrônicos (NFS-e, NFC-e e NF-e) para Orbita, NERP e demais sistemas. ' +
      'REST/JSON sob /v1, autenticação por API key (Bearer) e empresa no header X-Company-Id. Erros em RFC 9457 com `code` estável.',
    '',
    'O contrato completo, sempre atualizado, é o OpenAPI. Os guias explicam o que o contrato sozinho não diz.',
    '',
    '## Contrato',
    '',
    '- [OpenAPI 3.1](/openapi.json): todas as rotas, schemas, códigos de erro e escopos exigidos',
    '- [Referência navegável](/docs/): a mesma especificação na interface Scalar',
    '',
    '## Guias',
    '',
    ...API_GUIDES.map((g) => `- [${g.title}](/guides/${g.page}.md): ${g.summary}`),
    '',
  ].join('\n');
}

export function registerAgentDocs(app: HttpApp, options: { guidesDir: string }): void {
  // Lidos uma vez: arquivo ausente impede a subida (falha cedo, não 404 em produção).
  const guides = new Map(API_GUIDES.map((g) => [`${g.page}.md`, readFileSync(join(options.guidesDir, `${g.page}.md`), 'utf8')]));
  const index = llmsTxt();

  app.get('/openapi.json', { logLevel: 'warn', schema: { hide: true } }, (_request, reply) =>
    reply.header('cache-control', 'public, max-age=300').send(app.swagger()),
  );

  app.get('/llms.txt', { logLevel: 'warn', schema: { hide: true } }, (_request, reply) =>
    reply.type('text/markdown; charset=utf-8').header('cache-control', 'public, max-age=300').send(index),
  );

  app.get('/guides/:page', { logLevel: 'warn', schema: { hide: true, params: GuideParams } }, (request, reply) =>
    reply
      .type('text/markdown; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .send(guides.get(request.params.page)),
  );
}
