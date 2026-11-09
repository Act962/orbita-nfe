# Arquitetura Consolidada — Motor Fiscal (para aprovação)

Versão 2 · 2026-11-09 · Status: **aguardando aprovação final para iniciar a Fase 1**

## 1. Visão em uma página

```mermaid
flowchart LR
  Orbita & NERP -->|HTTPS · API key + escopos · Idempotency-Key| API
  subgraph VPS Hostinger · Coolify
    API[api<br/>autentica, resolve tenant, valida L1–L3,<br/>reserva número, grava + enfileira]
    WF[worker-fiscal<br/>KEK privada · XML · assinatura · mTLS ·<br/>write-ahead · reconciliação]
    WG[worker-general<br/>webhooks · outbox · alertas · stuck-scan · integridade]
    PG[(PostgreSQL<br/>dados + fila + outbox + auditoria · RLS)]
    API --> PG
    WF --> PG
    WG --> PG
  end
  WF -->|mTLS| NAC[NFS-e Nacional · Sefin/ADN]
  WF -->|mTLS| MUN[Emissor municipal Teresina · Fase 2b]
  WF -->|mTLS SOAP| SEFAZ[SEFAZ-PI / autorizadores NF-e]
  WF & API --> S3[(S3 externo · Object Lock)]
  PG -->|WAL| BKP[(Bucket de backup)]
  WG -->|HMAC| Hooks[Webhooks dos clientes]
```

## 2. Decisões consolidadas

| Tema | Decisão | Referência |
|---|---|---|
| Estilo | Monólito modular, Hexagonal + DDD, um contexto por modalidade fiscal | ADR-0001/0002, doc 02 |
| Processos | `api`, `worker-fiscal`, `worker-general` (mesma imagem, privilégios diferentes) | ADR-0021 |
| Persistência | PostgreSQL + **Drizzle ORM/Kit somente na infraestrutura**; mappers explícitos; SQL explícito onde dá controle | ADR-0004, doc 08 |
| Fila | Persistente no PostgreSQL, enfileirada na mesma transação do estado; prioridade, cotas por tenant, DLQ, operação manual auditada | ADR-0005, doc 07 |
| Duplicidade | Idempotency-Key + UNIQUE fiscais + numeração transacional + `UNKNOWN` + write-ahead de tentativas | ADR-0006/0007/0008/0022, doc 12 |
| Multi-tenant | RLS `ENABLE`+`FORCE`, fail-closed, papéis sem BYPASSRLS, 12 classes de teste de isolamento como gate de CI | ADR-0011, doc 14 |
| Certificados | Envelope AES-256-GCM + KEK assimétrica (API só cifra), só worker-fiscal decifra, grants de coluna, teste canário de logs | ADR-0009, doc 13 |
| Escopo fiscal | Não decide política tributária; valida dados, obrigatoriedade, consistência, matemática e leiaute (L1–L6) com regras de fonte oficial | ADR-0018, doc 14 |
| Versionamento | XSDs, regras e tabelas oficiais versionados; documento congela versões na aceitação | ADR-0013 |
| NFS-e | Teresina: API Nacional para ME/EPP Simples (2a), emissor municipal para demais regimes (2b), roteamento versionado | ADR-0017, fiscal/nfse-teresina.md |
| NFC-e | Piauí; motor central primeiro; domínio portável para contingência local NERP/Tauri (3b) | ADR-0019 |
| Infra | VPS Hostinger + Coolify; Redis adiado; S3 externo (recomendado Backblaze B2); backup WAL; RPO ≤ 5 min, RTO ≤ 4 h | ADR-0010/0020, doc 15 |
| Observabilidade | pino com redaction, OTel, Prometheus, métricas de `UNKNOWN`/fila/certificados | ADR-0016 |
| XML/assinatura | Decisão final após spike verificado por `xmlsec1` e homologação | ADR-0014 |

## 3. Os três pontos aprofundados

### 3.1 Recuperação de `UNKNOWN` ([doc 12](architecture/12-recuperacao-unknown.md))
- Cada tentativa grava `PREPARED` e depois `SENDING` **antes** de qualquer byte sair; após uma queda o sistema sabe exatamente se pode ter enviado.
- Falha classificada pela fase do transporte; na dúvida é `UNKNOWN`.
- Sai de `UNKNOWN` só por consulta (NFS-e Nacional: id da DPS → chave); retransmite somente após duas respostas "não encontrado" espaçadas, com o **mesmo** XML.
- Nunca vira `FAILED` automaticamente; escalonamento 15 min / 2 h / 24 h; resolução manual com evidência e auditoria.
- Contrato com Orbita/NERP: `UNKNOWN` = "em verificação, não reemita".

### 3.2 Certificados A1 ([doc 13](architecture/13-seguranca-certificados.md))
- A `api` recebe o PFX e o cifra na hora com a KEK **pública** — ela própria não consegue decifrar.
- Só o `worker-fiscal` tem a KEK privada (secret em arquivo, só nesse container); `worker-general` (que chama URLs externas) nunca vê certificados.
- Grants de coluna: nenhum outro papel de banco lê o ciphertext.
- Chave privada só em memória (`KeyObject`), cache curto; redaction + teste canário que falha o CI se a senha/PFX de teste aparecer em qualquer log.
- Porta `KeyManagementService` pronta para KMS gerenciado; backup offline e rotação da KEK por re-wrap.

### 3.3 Integridade fiscal e isolamento ([doc 14](architecture/14-integridade-isolamento.md))
- Validação em seis camadas, regras com fonte oficial, ID, vigência e teste; gates com o especialista fiscal.
- Documento imutável após aceitação (agregado + trigger), XML autorizado guardado byte a byte com hash, Object Lock, verificação periódica, auditoria com hash encadeado ancorado diariamente fora do banco.
- Isolamento em camadas (credencial → grant → contexto → RLS forçada → FKs compostas → storage → jobs → cache) com meta-teste de schema e matriz de API gerada automaticamente, ambos bloqueando o CI.

## 4. Roadmap revisado ([roadmap.md](roadmap.md))
| Fase | Estimativa |
|---|---|
| 1 Fundação | 5–7 semanas |
| 2a NFS-e Nacional (Teresina, Simples) | 8–12 semanas |
| 2b NFS-e municipal Teresina | 4–8 semanas |
| 3 NFC-e Piauí (central) | 10–14 semanas |
| 3b Contingência local NERP/Tauri | 6–10 semanas |
| 4 NF-e | 12–16 semanas |

≈ 11–16 meses até NF-e em produção, com 1 dev + agente + especialista pontual.

## 5. Limitações declaradas
1. Nenhuma regra fiscal foi implementada; as fontes oficiais da NFS-e foram **localizadas**, mas a leitura integral é o primeiro passo da Fase 2a.
2. Informações sobre o emissor municipal de Teresina vêm de fontes secundárias; a Fase 2b depende do manual oficial da SEMF.
3. Produção restrita exige CNPJ e certificado reais; "dados fictícios" se aplicam ao conteúdo das notas e aos testes automatizados.
4. Até KMS gerenciado, o administrador da VPS/Coolify é a raiz de confiança dos certificados.
5. VPS única: RPO/RTO definidos e aceitos para a fase inicial.
6. Empresas ME/EPP do Simples já estão obrigadas desde 01/11/2026: precisam de solução de emissão provisória até o go-live.

## 6. Checklist de aprovação
- [ ] Arquitetura consolidada (este documento)
- [ ] Desenhos de `UNKNOWN`, certificados e isolamento (docs 12–14)
- [ ] Roadmap revisado
- [ ] Provedor S3 (B2 recomendado / AWS S3 sa-east-1 / nacional)
- [ ] Disponibilidade de CNPJ + certificado A1 para produção restrita (necessário a partir da Fase 2a)

Com a aprovação, a Fase 1 começa por `git init`, estrutura do repositório e os quatro spikes técnicos.
