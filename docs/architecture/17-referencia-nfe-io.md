# 17 — NFE.io como referência de mercado

Análise feita em 2026-11-10 a pedido do responsável. Fonte: documentação pública em [nfe.io/docs](https://nfe.io/docs/documentacao/). Complementa o [doc 16](16-referencia-focus-nfe.md) (Focus NFe).

Páginas lidas: portal e documentação geral, REST API (convenções), chaves de autenticação, NFS-e (primeiros passos, consulta por `externalId`), NF-e (primeiros passos, emissão, índice da referência v2, estratégia de contingência), NFC-e (primeiros passos), API de certificados, webhooks (conceitos e cadastro), release note 2026.1 (unificação da API de Contribuintes) e documentação para agentes. As páginas de dúvidas sobre webhooks retornaram 404. Os arquivos OpenAPI publicados por eles não foram lidos.

> **Escopo do uso**: referência de **desenho de API e de produto**, como no doc 16. A NFE.io é serviço comercial e fonte **secundária** para regras fiscais. Nenhum texto ou código deles é copiado; valores fiscais vistos lá só entram após confirmação oficial (ADR-0018, ADR-0023).

## 1. Como a NFE.io funciona (resumo)
| Tema | NFE.io |
|---|---|
| Hosts | Vários: `api.nfe.io` (NFS-e v1), `api.nfse.io` (empresas, NF-e, NFC-e, webhooks v2) e hosts próprios para consultas (CNPJ, CPF, CEP, NF-e por chave) |
| Autenticação | Chave no header `Authorization` **sem** `Bearer`; duas chaves por conta: "dados" (consultas) e "nota fiscal" (emissão e cadastro); JWT Bearer citado sem detalhes |
| Cadastro fiscal | Empresa → certificado → **inscrições** como recursos próprios: municipal (`municipaltaxes`, várias cidades por empresa) e estadual (`stateTaxes`, por UF e por modelo NF-e/NFC-e), com série, número inicial, CSC da NFC-e e estratégia de contingência |
| Ambiente | Atributo da **inscrição** (`Environment` na IM, `environmentType` na IE, padrão `Test`); enviar ambiente na nota não tem efeito |
| Certificado | `POST /v2/companies/{id}/certificates` (multipart, arquivo + senha); identificado pelo **thumbprint**; status `Pending`, `Active`, `Overdue`, `Inactive`; só e-CNPJ A1 (sem e-CPF e A3); CNPJ do certificado deve bater com a empresa; novo envio substitui o anterior |
| Emissão | Assíncrona em todos os modelos: sucesso = enfileirado ("não significa que a nota já foi emitida"); NFC-e também pode ser emitida amarrada a uma IE específica |
| Identificação | `id` próprio + consulta por `externalId` (`/serviceinvoices/external/{id}`); `Idempotency-Key` aparece só em exemplo, sem contrato |
| Status | Nomes e fluxo de estados **não documentados** nas páginas lidas |
| Contingência NF-e | `SwitchAuthorizerStrategy` na IE: automática (a NFE.io troca para EPEC quando a SEFAZ da UF cai) ou manual (`PUT` com `authorizer: EPEC/Normal` + motivo); notas já em processamento ficam represadas; ao voltar, as notas EPEC seguem para a SEFAZ de origem |
| Eventos NF-e | Cancelamento, carta de correção, inutilização (por nota e por faixa, com comprovante), eventos de autoridade da RTC; XML de rejeição e XML EPEC como downloads |
| Webhooks | Assinaturas em `/v2/webhooks` com `filters` (lista de tipos de evento) e catálogo `GET /v2/webhooks/eventTypes`; opção `insecureSsl`; entrega "pelo menos uma vez"; **retentativa, assinatura e payload não documentados** |
| Erros | `{ error: { code, message, details[{field, message}], requestId } }` na convenção geral, mas a API de certificados usa outro formato (`Errors[{Code, Message}]`, códigos numéricos) |
| Limites | 429 + `Retry-After`; valor do limite não publicado |
| Paginação | v2 por cursor com `hasMore` (v1 por página) |
| Versão | Por caminho (`/v1`, `/v2`) com **v1 e v2 convivendo**; camada de compatibilidade v1→v2 e data de desligamento "a comunicar"; contrato da NF-e v2 **congelado para CNPJ numérico** (notas com CNPJ alfanumérico não aparecem nessa versão) |
| Docs para agentes | Markdown por página (`/index.md` ou `Accept: text/markdown`), frontmatter com `last_updated`/`status`/`superseded_by`, `llms.txt` por produto e OpenAPI publicado por API |
| Extras | Cálculo automático de tributos (serviço pago, preenche o grupo `tax`), consultas de CNPJ/CPF/CEP, distribuição DF-e/CT-e, SDKs Node/Python/PHP/Ruby, coleções Postman |

## 2. Onde o nosso desenho já é mais rigoroso (manter)
Além dos pontos do doc 16 (UNKNOWN, Idempotency-Key com hash do corpo, webhooks assinados, problem+json em tudo):
1. **Um formato de erro só** (ADR-0024). A NFE.io tem dois formatos e mistura PascalCase e camelCase.
2. **Um host e um contrato por versão**: a NFE.io espalha o produto em vários hosts e mantém v1 e v2 lado a lado para o mesmo recurso.
3. **CNPJ alfanumérico desde o início** ([CNPJ-001](../fiscal/regras/CNPJ-001.md)): não precisaremos congelar um contrato numérico como a NF-e v2 deles.
4. **Bearer padrão** (RFC 6750) e escopos por credencial, em vez de chave crua no `Authorization` e chaves separadas por produto.
5. **O motor não calcula tributo** (ADR-0018): valida dados, consistência e matemática; a política tributária fica com o sistema de origem.
6. **Webhook sem `insecureSsl`**: entrega só por HTTPS com certificado válido.

## 3. O que vamos adotar (aprimoramentos)
Decisão aceita em [ADR-0027](../adr/0027-convencoes-cadastro-fiscal-referencia-nfe-io.md).

| # | Aprimoramento | Inspiração | Onde entra |
|---|---|---|---|
| B1 | **Habilitação de produção por estabelecimento e modalidade**: o ambiente continua vindo da credencial (ADR-0026), mas uma chave `live` só emite se o estabelecimento tiver a modalidade habilitada para produção (registro auditado, feito por escopo próprio). Estabelecimento novo nasce só com homologação | ambiente na inscrição, padrão `Test` | Fase 1 sem. 7 (modelo) e Fase 2a (uso) |
| B2 | **Inscrições fiscais como recurso do estabelecimento**: inscrição municipal (município IBGE, IM) e estadual (UF, IE), cada uma ligada às séries e à modalidade que habilita | `municipaltaxes`, `stateTaxes` | Fase 2a (municipal) e Fase 3 (estadual) |
| B3 | **API de certificados com metadados públicos**: upload multipart, identificação pelo **thumbprint SHA-256** (e SHA-1 informativo), status `PENDING_VALIDATION`/`ACTIVE`/`EXPIRING`/`EXPIRED`/`REVOKED`, validade, titular; só e-CNPJ A1; raiz do CNPJ do certificado igual à da empresa; **sobreposição** (novo certificado validado antes de desativar o anterior, sem janela sem certificado); nunca devolve chave privada nem senha | API de certificados | Fase 1 sem. 5 (Certificate Vault) |
| B4 | **CSC da NFC-e como segredo do cofre** (mesmo envelope do certificado, ADR-0009), nunca em coluna comum nem em log | `securityCredential` | Fase 3 |
| B5 | **Estratégia de contingência configurável** por inscrição estadual: `MANUAL` (padrão) ou `AUTOMATIC`, com troca registrada em auditoria e motivo obrigatório; documento já enviado nunca muda de autorizador | `SwitchAuthorizerStrategy` | Fase 3 (modalidades e regras só após o MOC, ver §6) |
| B6 | **Catálogo de eventos de webhook** (`GET /v1/webhooks/event-types`) e **filtros por assinatura** | `eventTypes`, `filters` | Fase 1 sem. 6 |
| B7 | **Downloads de XML de rejeição e de eventos** (cancelamento, carta de correção, inutilização) pelos mesmos links 302 do A11 | XML de rejeição/EPEC/CC-e | Fases 2a e 3 |
| B8 | **Inutilização por faixa com comprovante** como operação própria, ligada à série e ao controle de numeração | inutilização | Fase 3 (fonte: MOC; risco R-26) |
| B9 | **Documentação legível por agentes**: OpenAPI publicado em URL estável (`/openapi.json`), `llms.txt` com o índice da documentação e páginas em Markdown | docs para agentes | Fase 1 sem. 7 |
| B10 | **Guia de migração junto de cada versão nova** (mapa de campos antigo→novo), complementando o changelog do A14 | release note 2026.1 | Fase 1 sem. 7 (modelo do changelog) |

## 4. O que não vamos adotar
- Ambiente **só** na inscrição: mantemos a derivação pela credencial (ADR-0026) e somamos a habilitação (B1); as duas travas precisam concordar.
- Duas chaves por produto (dados × nota): os escopos já fazem essa separação.
- Vários hosts, v1 e v2 do mesmo recurso ao mesmo tempo, casing misto, dois formatos de erro.
- `insecureSsl` em webhooks, webhook sem assinatura.
- Cálculo automático de tributos pelo motor (contraria o ADR-0018). Se um dia existir, é produto separado e com fonte oficial por regra.
- Contingência **automática decidida por nós para todas as empresas**: a troca pode ser automática por configuração da empresa (B5), nunca uma chave global silenciosa.

## 5. Para o roadmap futuro (fora do escopo atual)
- SDK oficial em TypeScript gerado do OpenAPI (para Orbita e NERP) e coleção de exemplos — avaliar após a Fase 2a.
- Consultas de CNPJ/CEP e distribuição DF-e/CT-e — mesma posição do doc 16 (Fase 5, só com fonte oficial).
- Eventos de autoridade da RTC na NF-e — entram com a NT correspondente (risco R-03).

## 6. A confirmar em fonte oficial (não implementar a partir da NFE.io)
| Item visto na NFE.io | Fonte oficial a consultar |
|---|---|
| EPEC como contingência da NF-e e o envio posterior à SEFAZ de origem | MOC NF-e (contingências) e NTs do EPEC |
| Contingência da NFC-e (offline) e uso do CSC | MOC NFC-e e NTs; legislação do PI (ADR-0019) |
| Inutilização de numeração por faixa e prazos | MOC NF-e (risco R-26) |
| Tipos de certificado aceitos por autorizador (e-CNPJ × e-CPF, A1 × A3) | Manuais da SEFAZ-PI e da NFS-e Nacional |
| Eventos de autoridade da RTC | NT 2025.002-RTC (Portal NF-e) |
| Código de município IBGE com 7 dígitos | Tabela oficial do IBGE (A15) |
