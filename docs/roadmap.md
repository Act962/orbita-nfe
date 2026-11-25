# Roadmap de implementação (revisado em 2026-11-09)

**Premissas**: 1 desenvolvedor principal + agente de código; especialista fiscal pontual
(revisões nos *gates* fiscais). Semanas de trabalho efetivo. A maior incerteza é
fiscal/externa (documentação, acesso à produção restrita, resposta da SEMF, comportamento
real dos autorizadores), por isso cada fase tem folga explícita.

| Fase | Escopo | Estimativa | Gate de saída |
|---|---|---|---|
| 0 | Arquitetura (esta entrega) | concluída | aprovação do responsável |
| 1 | Fundação | **5–7 semanas** | fluxo completo com documento fake + testes de isolamento, idempotência, concorrência e falhas passando no CI; spikes aprovados |
| 2a | NFS-e Nacional — ME/EPP Simples, Teresina | **8–12 semanas** | suíte de contrato aprovada em produção restrita; revisão do especialista fiscal; piloto controlado |
| 2b | NFS-e emissor municipal Teresina (DSF; Lucro Presumido/Real e competências < 11/2026) | **2–4 semanas** (contrato oficial já publicado no Guia API THE V7; reaproveita o cliente do padrão nacional, ADR-0029). Prioridade conforme o perfil de regime dos clientes | idem 2a na homologação municipal |
| 3 | NFC-e Piauí — motor central | **10–14 semanas** | homologação SEFAZ-PI; integração NERP online; contingência central conforme MOC |
| 3b | Contingência local NERP/Tauri | **6–10 semanas** (somente após 3 validada em produção) | ADR de segurança do desktop aprovado; testes offline → sincronização |
| 4 | NF-e modelo 55 | **12–16 semanas** | homologação; eventos, inutilização, contingência SVC/EPEC conforme MOC |
| 5 | Robustez e expansão | contínuo | — |

**Total até NF-e em produção**: ~45–67 semanas (≈ 11–16 meses), sem contar 3b em paralelo.
Comparado à versão anterior, aumentou por: equipe de uma pessoa, NFS-e em dois caminhos
(nacional + municipal), Fase 3b separada e mais testes de isolamento/recuperação na fundação.

## Fase 1 — detalhamento (5–7 semanas)
| Semana | Entregas |
|---|---|
| 1 | Repositório, TS strict, lint, regras de dependência, Vitest, Docker Compose (Postgres + S3 local), CI. **Spikes**: XMLDSig verificado por `xmlsec1`; PKCS#12 + mTLS com undici e classificação de fase de falha; validação XSD; pg-boss transacional |
| 2 | Config, logger com redaction + teste canário, correlation id, erros RFC 9457, health/readiness |
| 3 | Drizzle + migrations + papéis de banco + RLS + meta-teste de schema + UnitOfWork + Testcontainers |
| 4 | IAM (API keys, escopos, grants) + Company + Fiscal Settings (alocação concorrente de numeração) + matriz de isolamento da API |
| 5 | Certificate Vault (KEK assimétrica, validação no worker-fiscal, grants de coluna) + Audit log encadeado; API de certificados só com metadados (thumbprint, validade, status, troca com sobreposição — ADR-0027) |
| 6 | Fila, outbox, write-ahead de tentativas, stuck-scan, reconciliador genérico, webhooks HMAC (com calendário de retentativas publicado e reenvio por documento), endpoints `ops`, **rate limit por credencial** (429 + `Retry-After`), catálogo de eventos e filtros por assinatura de webhook (ADR-0027) |
| 7 | Folga + deploy no Coolify (api, worker-fiscal, worker-general, postgres), backup WAL, runbooks iniciais, **changelog e política de descontinuação da API**, `dryRun` nos cadastros, habilitação de produção por estabelecimento e modalidade, OpenAPI em URL estável + `llms.txt` (ADR-0027) — **código concluído em 2026-11-11** (mais avisos de vencimento e âncora externa da auditoria, ADR-0031); deploy real aguardando VPS, domínio e buckets |
| 8 (encerramento) | Spikes 01–03 promovidos a código definitivo (XSD oficial, assinatura, mTLS) e apagados; pg-boss removido — **concluído em 2026-11-11**. O "fluxo completo com documento fake" do gate foi reescopado para a Fase 2a, junto com o write-ahead e o reconciliador (semana 6) |

## Fase 2a — detalhamento (8–12 semanas)
Diagnóstico de base: [nfse-teresina-api-municipal-x-nacional.md](fiscal/nfse-teresina-api-municipal-x-nacional.md). Decisões: ADR-0017 (revisado), ADR-0028 (roteamento por competência) e ADR-0029 (transmissão e reconciliação). XSD de produção e de produção restrita já versionados em `resources/fiscal/schemas/nfse-nacional/`.

0. Pré-requisitos do responsável: CNPJ e A1 reais (leitura do Swagger da SEFIN); enquadramento da empresa-piloto confirmado pelo contador (`opSimpNac`, `regApTribSN`, `cTribNac`/NBS, alíquota); perguntas à SEMF (§10 do diagnóstico).
1. ~~Leitura do manual API v1.2, leiautes e resoluções CGSN~~ (feita em 2026-11-10). Falta: Swagger, aba de regras do Anexo II (prazo de cancelamento), catálogo de regras → **gate fiscal 1** (especialista).
2. ~~Núcleo da emissão: `ServiceInvoice`, máquina de estados, Id da DPS, aceite idempotente, write-ahead, reconciliação e simulador ([ADR-0032](adr/0032-nucleo-emissao-nfse.md))~~: **concluído em 2026-11-12**. ~~Contrato da DPS na API e preparador real ([ADR-0033](adr/0033-contrato-dps-v1.md))~~: **concluído em 2026-11-12**. ~~Resolução manual de `UNKNOWN` e alertas por idade ([ADR-0034](adr/0034-resolucao-manual-unknown.md))~~: **concluído em 2026-11-12**. ~~Roteamento Teresina (ADR-0028)~~: **concluído em 2026-11-12**. ~~Cancelamento (e101101, [ADR-0035](adr/0035-cancelamento-nfse.md))~~: **concluído em 2026-11-12**. ~~Substituição ([ADR-0036](adr/0036-substituicao-nfse.md))~~: **concluído em 2026-11-13**. ~~Regras do Anexo I que dependem só da DPS ([ADR-0037](adr/0037-regras-anexo-i-no-aceite.md))~~: **concluído em 2026-11-13**. ~~Adapter da SEFIN Nacional, produção restrita ([ADR-0038](adr/0038-adapter-sefin-nacional.md))~~: **concluído em 2026-11-13**; o primeiro envio real parou na E0037 (R-43). ~~Adapter do emissor municipal de Teresina, homologação ([ADR-0039](adr/0039-adapter-emissor-municipal-teresina.md), adiantado da Fase 2b)~~: **concluído em 2026-11-13**; falta o primeiro envio. ~~Contrato v2 da DPS: endereço do tomador, intermediário e `tpImunidade` ([ADR-0040](adr/0040-contrato-dps-v2.md))~~: **concluído em 2026-11-16**. ~~Descontos e tributos federais ([ADR-0041](adr/0041-descontos-tributos-federais.md))~~: **concluído em 2026-11-16**. ~~Dedução da base do ISSQN por percentual ou valor ([ADR-0042](adr/0042-deducao-base-issqn.md))~~: **concluído em 2026-11-16**. ~~Exigibilidade suspensa e benefício municipal ([ADR-0043](adr/0043-exigibilidade-suspensa-beneficio-municipal.md))~~: **concluído em 2026-11-23**. ~~Tomador no exterior e exportação ([ADR-0044](adr/0044-tomador-exterior-exportacao.md))~~: **concluído em 2026-11-23**. ~~Prestação no exterior ([ADR-0045](adr/0045-prestacao-exterior.md))~~: **concluído em 2026-11-23**. ~~Consulta pela referência externa e validação sem efeitos ([ADR-0047](adr/0047-consulta-por-referencia-e-validacao.md))~~: **concluído em 2026-11-23**. ~~Arquivamento do XML autorizado com Object Lock ([ADR-0048](adr/0048-arquivamento-xml-autorizado.md))~~: **concluído em 2026-11-23**; faltam o prazo de retenção e o provedor. ~~Arquivamento do XML do evento de cancelamento ([ADR-0049](adr/0049-arquivamento-xml-evento-cancelamento.md))~~: **concluído em 2026-11-24**. ~~Download do XML pela API ([ADR-0050](adr/0050-download-xml-pela-api.md))~~: **concluído em 2026-11-24**. ~~Conferência periódica dos XML arquivados ([ADR-0051](adr/0051-conferencia-periodica-xml-arquivado.md))~~: **concluído em 2026-11-24**. ~~`links` no corpo da nota ([ADR-0052](adr/0052-links-no-corpo-da-nota.md))~~: **concluído em 2026-11-24**. ~~`Prefer: wait` na emissão ([ADR-0053](adr/0053-prefer-wait-na-emissao.md))~~: **concluído em 2026-11-24**. ~~`authorizerStatus` ([ADR-0054](adr/0054-situacao-do-autorizador-na-nota.md))~~: **concluído em 2026-11-24**. ~~Diagnóstico da nota ([ADR-0055](adr/0055-diagnostico-da-nota.md))~~: **concluído em 2026-11-24**. ~~Reenvio de webhook por documento ([ADR-0056](adr/0056-reenvio-de-webhook-por-documento.md))~~: **concluído em 2026-11-24**. ~~DANFSe ([ADR-0057](adr/0057-danfse.md))~~: **concluído em 2026-11-25**. Falta: dedução por documentos e IBS/CBS; regras L3 que dependem de cadastro ou parametrização ficam com o autorizador, contrato v2 (endereço, intermediário, deduções, IBS/CBS). Contrato da API com as convenções do [ADR-0026](adr/0026-convencoes-api-referencia-mercado.md) que faltam: 201 × 202 com `Prefer: wait`, `authorizerStatus`, `hint` nas rejeições, `include=`, tabela oficial de municípios do IBGE. Inscrição municipal como recurso do estabelecimento e download do XML de rejeição (ADR-0027).
3. Geração XML, assinatura, XSD, adapter Sefin Nacional, simulador alimentado por capturas reais.
4. Emissão, consulta (API DPS), cancelamento, substituição (se aplicável), DANFSe conforme padrão.
5. Produção restrita com CNPJ/certificado reais e dados fictícios → **gate fiscal 2**.
6. Piloto em produção com uma empresa, volume limitado, monitoramento diário.

## Fase 3 — itens vindos da análise da NFE.io ([doc 17](architecture/17-referencia-nfe-io.md), ADR-0027)
- Inscrição estadual por estabelecimento e modelo, com CSC da NFC-e no cofre.
- Estratégia de contingência configurável (`MANUAL`/`AUTOMATIC`), só após a leitura do MOC.
- Inutilização por faixa com comprovante; downloads de XML de eventos (cancelamento, CC-e, inutilização).

## Fase 5 — itens vindos da análise de mercado ([doc 16](architecture/16-referencia-focus-nfe.md))
- Exportação mensal de XMLs por estabelecimento para o contador (ZIP por link pré-assinado).
- Documentos recebidos (distribuição DF-e e manifestação do destinatário).
- Credenciais restritas a empresas específicas.
- SDK TypeScript gerado do OpenAPI para Orbita e NERP (avaliar após a Fase 2a).

## Dependências externas que podem atrasar
- Acesso à produção restrita da NFS-e (CNPJ + certificado reais).
- ~~Manual oficial do webservice de Teresina (SEMF)~~: publicado (Guia API THE V7). Ainda faltam as respostas da SEMF às perguntas do diagnóstico.
- Disponibilidade do especialista fiscal nos gates.
- NTs novas da Reforma Tributária durante o desenvolvimento.

```mermaid
gantt
  dateFormat YYYY-MM-DD
  title Roadmap indicativo (início após aprovação; limites superiores)
  section Fundação
  Fase 1            :f1, 2026-11-16, 7w
  section NFS-e
  Fase 2a Nacional  :f2a, after f1, 12w
  Fase 2b Teresina  :f2b, after f2a, 4w
  section NFC-e
  Fase 3 central    :f3, after f2b, 14w
  Fase 3b local     :f3b, after f3, 10w
  section NF-e
  Fase 4            :f4, after f3, 16w
```
