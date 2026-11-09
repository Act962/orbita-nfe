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
| 2b | NFS-e emissor municipal Teresina (demais regimes) | **4–8 semanas** (depende de obter o manual oficial da SEMF) | idem 2a no ambiente municipal |
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
| 4 | IAM (API keys, escopos, grants) + Taxpayer + Fiscal Settings (alocação concorrente de numeração) + matriz de isolamento da API |
| 5 | Certificate Vault (KEK assimétrica, validação no worker-fiscal, grants de coluna) + Audit log encadeado |
| 6 | Fila, outbox, write-ahead de tentativas, stuck-scan, reconciliador genérico, webhooks HMAC, endpoints `ops` |
| 7 | Folga + deploy no Coolify (api, worker-fiscal, worker-general, postgres), backup WAL, runbooks iniciais |

## Fase 2a — detalhamento (8–12 semanas)
1. Leitura integral do manual API v1.2, leiautes, NTs 004/007 e resoluções CGSN; registro em `fontes-oficiais.md`; catálogo de regras → **gate fiscal 1** (especialista).
2. Domínio `ServiceInvoice`/DPS, regras L2/L3 com testes, roteamento Teresina.
3. Geração XML, assinatura, XSD, adapter Sefin Nacional, simulador alimentado por capturas reais.
4. Emissão, consulta (API DPS), cancelamento, substituição (se aplicável), DANFSe conforme padrão.
5. Produção restrita com CNPJ/certificado reais e dados fictícios → **gate fiscal 2**.
6. Piloto em produção com um tenant, volume limitado, monitoramento diário.

## Dependências externas que podem atrasar
- Acesso à produção restrita da NFS-e (CNPJ + certificado reais).
- Manual oficial do webservice de Teresina (SEMF).
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
  Fase 2b Teresina  :f2b, after f2a, 8w
  section NFC-e
  Fase 3 central    :f3, after f2b, 14w
  Fase 3b local     :f3b, after f3, 10w
  section NF-e
  Fase 4            :f4, after f3, 16w
```
