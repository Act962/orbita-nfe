# 16 — Focus NFe como referência de mercado

Análise feita em 2026-11-09 a pedido do responsável. Fonte: documentação pública em [doc.focusnfe.com.br](https://doc.focusnfe.com.br/reference/introducao). Ver também a segunda referência, [doc 17 — NFE.io](17-referencia-nfe-io.md). Páginas lidas: introdução, ambiente, autenticação, referência, webhooks, empresas, NF-e (emitir, consultar, cancelar), NFC-e, NFS-e Nacional (consultar), guias de rate limit e de documentos assíncronos.

> **Escopo do uso**: referência de **desenho de API e de produto**. A Focus é um serviço comercial e uma fonte **secundária** para regras fiscais: prazos, tamanhos e códigos vistos lá só entram no motor depois de confirmados no MOC, nas NTs ou nos manuais oficiais (ADR-0018, ADR-0023). Nenhum texto ou código deles é copiado.

## 1. Como a Focus funciona (resumo)
| Tema | Focus NFe |
|---|---|
| Ambientes | Dois hosts: `api.focusnfe.com.br` (produção) e `homologacao.focusnfe.com.br`; mesmo contrato |
| Autenticação | HTTP Basic com token **por empresa** como usuário; 401 com corpo em texto/HTML |
| Identificação do documento | `ref` escolhido pelo cliente, único por token, usado na emissão (`?ref=`), consulta e cancelamento (`/nfe/{ref}`) |
| Reenvio | Mesmo `ref` após rejeição é permitido (corrigindo o payload); após autorizado, o `ref` fica preso ao documento; reenvio → 422 `already_processed` / `pending_operation` |
| Modelo de emissão | NF-e e NFS-e assíncronas (202 `processando_autorizacao`); NFC-e síncrona; NF-e síncrona (201) quando o estado e a conta permitem |
| Status | `processando_autorizacao`, `autorizado`, `cancelado`, `erro_autorizacao`, `negado` (NFS-e), `erro_cancelamento`; expõe `status_sefaz` e `mensagem_sefaz` |
| Erros | `codigo` + `mensagem` + `erros[{campo, mensagem}]`; NFS-e Nacional traz também `correcao` (como corrigir) |
| Arquivos | Consulta devolve caminhos de XML e DANFE; download por 302 para URL pré-assinada; ZIPs mensais de XML por CNPJ (backup) |
| Webhooks | POST por mudança de estado; retentativas em 1 min, 30 min, 1 h, 3 h e 24 h; reenvio manual por documento; **sem assinatura documentada** |
| Limites | 100 requisições/min por token; 429 |
| Cadastro | API de Empresas com `dry_run=1` (valida sem gravar), paginação de 50 |
| Extras | Documentos recebidos (manifestação do destinatário), consultas auxiliares (CNPJ, CEP, NCM, CFOP, municípios), contingência NFC-e por comunicador local |
| Versão | Prefixo `/v2`; sem changelog nem política de descontinuação publicados |

## 2. Onde o nosso desenho já é mais rigoroso (manter)
1. **UNKNOWN e write-ahead** (ADR-0006, ADR-0022): a Focus não documenta o que acontece quando a comunicação cai depois do envio; nós tratamos explicitamente.
2. **Idempotency-Key com hash do corpo** (ADR-0007): reenvio após timeout devolve o **mesmo** resultado em vez de 422.
3. **Webhooks assinados** com HMAC, `Webhook-Id` para deduplicação e proteção de replay (ADR-0015).
4. **Erros sempre em problem+json**, inclusive 401 (a Focus devolve HTML no 401).
5. **Credencial por aplicação + concessões por empresa** (ADR-0012): uma plataforma como o Orbita, com muitas empresas, usa uma credencial só, com revogação por empresa.
6. **Rejeição fiscal não é erro HTTP**: o documento existe com status próprio (mesma ideia da Focus, já prevista no doc 11).

## 3. O que vamos adotar (aprimoramentos)
Decisão aceita em [ADR-0026](../adr/0026-convencoes-api-referencia-mercado.md).

| # | Aprimoramento | Inspiração | Onde entra |
|---|---|---|---|
| A1 | **Referência externa (`externalReference`) como chave de negócio permanente**: única por (empresa, aplicação, modalidade); consulta `GET /v1/service-invoices/by-reference/{ref}`. Complementa o `Idempotency-Key`, que expira em 30 dias | `ref` | Fase 2a (já prevista no exemplo do doc 11; agora com UNIQUE e rota de consulta) |
| A2 | **Reuso da referência só após falha definitiva**: rejeitado sem número consumido no autorizador → pode reenviar; `UNKNOWN`/processando → 409 `DOCUMENT_IN_PROGRESS`; autorizado/cancelado → 409 `DOCUMENT_ALREADY_AUTHORIZED` com link do documento existente | `pending_operation`, `already_processed` | Fase 2a |
| A3 | **201 × 202 explícitos**: 201 quando o resultado final saiu dentro do tempo (`Prefer: wait=<s>`); 202 + `Location` quando ainda processa. NFC-e com espera curta por padrão (PDV) | NFC-e síncrona / NF-e 201 | Fases 2a e 3 |
| A4 | **Ambiente vem da credencial**: chave `test` só opera homologação; `live` só produção (o prefixo já existe). Domínio opcional `homologacao.<host>` como apelido no Coolify | dois hosts | Fase 2a (regra), Fase 1 sem. 7 (DNS) |
| A5 | **`dryRun=true`** em cadastros e um **`POST /v1/service-invoices/validations`** que roda L1–L3 sem reservar número nem gravar | `dry_run=1` | Fase 1 (cadastros) e 2a (documentos) |
| A6 | **Dica de correção** no erro: campo opcional `hint` em `issues[]` e em `rejection` (vem do catálogo de regras e de rejeições), sem nunca inventar regra | `correcao` | Fase 1 (schema) e 2a (catálogo) |
| A7 | **Código e mensagem do autorizador** sempre na resposta do documento: `authorizerStatus: { code, message, source }` (ex.: `cStat` 100, `xMotivo`) | `status_sefaz`, `mensagem_sefaz` | Fase 2a |
| A8 | **Vocabulário de status publicado** e estável por modalidade, incluindo status de eventos (cancelamento negado ≠ documento negado) e `UNKNOWN` exposto como `PROCESSING` com `reconciling: true` | lista de status | Fase 2a (doc 04 + OpenAPI) |
| A9 | **Rate limit por credencial** com 429 problem+json, `Retry-After` e cabeçalhos `RateLimit-*`; limite padrão configurável e maior para lotes acordados | 100/min por token | Fase 1 sem. 6 |
| A10 | **Política de webhooks publicada**: calendário de retentativas (1 min, 5 min, 30 min, 2 h, 6 h, 24 h), reenvio manual por documento (`POST /v1/service-invoices/{id}/notifications`), além do reenvio por entrega já previsto | retentativas e reenvio | Fase 1 sem. 6 |
| A11 | **Links de arquivos** no corpo (`links.xml`, `links.pdf`) que respondem 302 para URL pré-assinada de curta duração | `caminho_*` + 302 | Fase 2a (já previsto; padronizar) |
| A12 | **Exportação para o contador**: ZIP mensal de XMLs por estabelecimento, gerado em job e entregue por link pré-assinado | backups mensais | Fase 5 (ou antes, se o piloto pedir) |
| A13 | **`include=`** na consulta (`attempts`, `events`, `protocol`) para depuração, só com escopo próprio | `completa=1` | Fase 2a |
| A14 | **Changelog e política de descontinuação** da API (`Deprecation`/`Sunset` nos headers), versão em `/v1` | ausência na Focus | Fase 1 sem. 7 (docs) |
| A15 | **Dados de referência oficiais**: tabela de municípios do IBGE para validar `municipalityCode` (hoje só o formato) | API de municípios | Fase 2a (fonte: IBGE, com versão registrada) |

## 4. O que não vamos adotar
- Token por empresa como única forma de autenticação: dificulta plataformas com muitas empresas; mantemos credencial por aplicação (podemos oferecer credenciais restritas a empresas específicas no futuro).
- `DELETE` com corpo para cancelar: proxies e clientes HTTP tratam mal; mantemos `POST .../cancellation`.
- 401 em HTML, webhook sem assinatura, reenvio de `ref` autorizado respondendo só erro.

## 5. Para o roadmap futuro (fora do escopo atual)
- Documentos recebidos (distribuição DF-e e manifestação do destinatário) — Fase 5.
- Consultas auxiliares (CNPJ, CEP, NCM, CFOP) — avaliar demanda do Orbita/NERP; nunca como fonte fiscal sem origem oficial.
- Contingência NFC-e por comunicador local: confirma a direção do ADR-0019 (NERP/Tauri, Fase 3b): fila local de pendentes + efetivação posterior.

## 6. A confirmar em fonte oficial (não implementar a partir da Focus)
| Item visto na Focus | Fonte oficial a consultar |
|---|---|
| Justificativa de cancelamento da NF-e com 15 a 255 caracteres | MOC NF-e / leiaute do evento de cancelamento |
| Prazo de cancelamento NF-e de 24 h (com exceções por UF) e NFC-e de 30 min | MOC, NTs e legislação da UF (PI) |
| Código de erro `E0014` da NFS-e Nacional (DPS já usada) | Anexo de mensagens da NFS-e Nacional |
| Faixas e controle de numeração/inutilização | MOC (risco R-26) |
