# Acompanhamento do projeto

Última atualização: 2026-11-12

## Status geral
Painel resumido para acompanhamento: [status.html](status.html) (abrir no navegador; atualizado a cada etapa).

**Fase 1 — Fundação concluída no código** (deploy real adiado por decisão do responsável). **Fase 2a — NFS-e Nacional em andamento** desde 2026-11-12, começando pela parte técnica que não depende de decisão fiscal.

## Fase 1 — progresso
### Concluído (semana 1–2 do plano)
- [x] Repositório git, Node 24, TypeScript strict (ESM/NodeNext), scripts `npm run check`.
- [x] ESLint (type-checked) com `no-console` e bloqueio de imports de infraestrutura no domínio.
- [x] dependency-cruiser: domínio puro, application sem camadas externas, módulos só via `public.ts`, composition root exclusivo, sem ciclos. **Testado com violações propositais** (as três foram detectadas).
- [x] Vitest + fast-check + cobertura com meta de 90% de branches no domínio.
- [x] Shared domain: `Result`, `ValidationIssue`, `Cnpj` (numérico e alfanumérico, regra [CNPJ-001](fiscal/regras/CNPJ-001.md), exemplo da RFB validado), `Decimal` (sem `number`, arredondamento sempre explícito).
- [x] Config validada com Zod (fail fast, sem ecoar valores).
- [x] Logger pino com sanitização profunda + **teste canário**. O teste encontrou um vazamento real: o pino não aplica `formatters.bindings` em loggers filhos; corrigido com sanitização final em `hooks.streamWrite`.
- [x] API Fastify: correlation id (validado), erros RFC 9457 com código estável, 404, 500 sem vazar detalhe, `/health/live` e `/health/ready` (com timeout e sem expor erro).
- [x] Dockerfile multi-stage (usuário não-root), testado localmente: imagem sobe e responde ao health check.
- [x] Docker Compose dev (PostgreSQL 17, SeaweedFS 4.50) e CI no GitHub Actions (typecheck, lint, camadas, testes com cobertura, `npm audit`, build da imagem).

Resultado atual: 48 testes passando; cobertura geral 94,7% de linhas.

### Spikes obrigatórios — concluídos (2026-11-09)
Os quatro foram aprovados, com 41 testes ([resultados](spikes/resultados-fase1.md)):
- [x] **01** PKCS#12 em memória (inclusive legado RC2) + XMLDSig **verificado pelo xmlsec1**.
- [x] **02** mTLS com classificação da fase de falha; nenhum envio duplicado; achado do TLS 1.3 registrado no ADR-0022.
- [x] **03** XSD com include/import via libxml2/wasm (cerca de 88 ms/doc) + parser seguro contra XXE.
- [x] **04** pg-boss com enqueue na transação (COMMIT/ROLLBACK), `exclusive` + `singletonKey` e DLQ.

ADRs atualizados: 0005 (pg-boss confirmado), 0009, 0014 (aceito), 0022.

### Persistência, isolamento e padrão de erros da API — concluído (2026-11-09)
- [x] Drizzle ORM + Drizzle Kit somente na infraestrutura; migrations versionadas (`0000_company_tables` gerada e revisada; `0001_security_roles_rls` em SQL explícito).
- [x] Papéis `fiscal_owner` (sem superuser), `fiscal_api/worker/general/system` (sem BYPASSRLS), RLS `ENABLE` + `FORCE`, política *fail-closed* via `app_current_company()`, sem `DELETE` para a aplicação.
- [x] `CompanyTransactions`: contexto de empresa por transação (`set_config(..., true)`), sem vazamento no pool.
- [x] Testcontainers (PostgreSQL 17) com a topologia de produção; **meta-teste de RLS** + "teste do teste" (4 cenários de falha detectados).
- [x] Testes de isolamento com o papel real da aplicação: leitura, INSERT/UPDATE cruzados, DELETE negado, pool, concorrência, FORCE sobre o dono.
- [x] **Erros da API sem genéricos nem erros do Drizzle** (ADR-0024): validação Fastify + Zod (body, params, query, headers e **resposta**), mensagens em pt-BR, hierarquia de erros de aplicação com códigos estáveis, tradução de SQLSTATE, constraint não mapeada = bug.
- [x] **Teste canário encontrou o 2º vazamento real**: erro bruto do Drizzle gravava query e parâmetros no log. Corrigido na sanitização dos logs.
- [x] **Documentação da API com Scalar** em `/docs/` + OpenAPI 3.1 em `/docs/openapi.json`, gerada dos schemas Zod, sem CDN, sem recursos de nuvem da Scalar. Conferida no navegador.
- [x] Runbook [bootstrap-banco.md](runbooks/bootstrap-banco.md); imagem Docker leva as migrations; ambiente local com a mesma topologia.

Resultado: 108+ testes (unitários + integração com PostgreSQL real), cobertura geral ≈ 96% de linhas.

### IAM, Company, Fiscal Settings e matriz de isolamento — concluído (2026-11-09)
- [x] **IAM** (ADR-0012): API keys `fk_<live|test>_<keyId>_<segredo>` com HMAC-SHA256 + pepper em arquivo, comparação em tempo constante, escopos em catálogo fechado (`:manage` implica `:read`), concessões por empresa sem cache, mesma resposta para empresa inexistente e sem concessão.
- [x] **Padrão fechado**: rota `/v1` sem `config.auth` ou com escopo fora do catálogo impede a API de subir; autenticação antes da validação (401 antes de 400).
- [x] CLI do operador (`npm run iam`) com papel de banco próprio `fiscal_admin` (a API só lê credenciais). Runbook [credenciais-api.md](runbooks/credenciais-api.md).
- [x] **Company**: `POST /v1/companies` (concede a empresa ao criador na mesma transação), `GET /v1/company`, estabelecimentos com regra [COMPANY-001](fiscal/regras/COMPANY-001.md).
- [x] **Fiscal Settings**: séries por estabelecimento/modalidade/ambiente; alocação transacional (50 concorrentes → 50 números consecutivos; rollback devolve o número); trigger impede o número de voltar; grants por coluna. Regras [SERIES-001](fiscal/regras/SERIES-001.md) e [SERIES-002](fiscal/regras/SERIES-002.md) (**provisória**, R-26).
- [x] **Matriz de isolamento da API** gerada do catálogo de rotas: 401 sem credencial, 403 sem concessão, 404/sem dados na própria empresa, CNPJ spoofing, concessão revogada; rota de empresa nova sem caso quebra o teste.
- [x] UUID v7 para ids gerados pelo servidor.
- [x] Teste de fumaça local: CLI → chave → empresa → estabelecimento → série, Scalar com as novas rotas, chave ausente do log.

Resultado: 215+ testes (unitários + integração com PostgreSQL real).

### Vocabulário "empresa" — concluído (2026-11-09, [ADR-0025](adr/0025-vocabulario-empresa.md))
- [x] "tenant" trocado por **empresa/company** em API (`/v1/companies`, `X-Company-Id`, escopos `companies:*`, códigos `COMPANY_*`), código (módulo `company`), banco (`companies`, `company_id`, `app_current_company()`), testes, CLI e documentação.
- [x] Migrations reescritas antes do primeiro deploy: `0000_initial_schema` + `0001_security_roles_rls`.

### Análise da Focus NFe como referência — concluída (2026-11-09)
- [x] Documentação pública lida e comparada ([doc 16](architecture/16-referencia-focus-nfe.md)): 15 aprimoramentos (A1–A15) distribuídos no roadmap; ADR-0026 **aceito** em 2026-11-09.
- Pontos em que o nosso desenho já é mais rigoroso foram mantidos (UNKNOWN, Idempotency-Key, webhooks assinados, credencial por aplicação).
- Prazos e tamanhos fiscais vistos na Focus ficaram na lista "a confirmar em fonte oficial".

### Análise da NFE.io como referência — concluída (2026-11-10)
- [x] Documentação pública lida e comparada ([doc 17](architecture/17-referencia-nfe-io.md)): 10 aprimoramentos (B1–B10) distribuídos no roadmap; [ADR-0027](adr/0027-convencoes-cadastro-fiscal-referencia-nfe-io.md) **aceito** em 2026-11-10.
- Destaques: habilitação de produção por estabelecimento, inscrições fiscais como recurso, API de certificados só com metadados, contingência configurável, documentação para agentes.
- EPEC, contingência, inutilização e tipos de certificado vistos lá ficaram na lista "a confirmar em fonte oficial".

### Fase 2a, etapa 6 — substituição de NFS-e (2026-11-13)
Decisão: [ADR-0036](adr/0036-substituicao-nfse.md).
- [x] **API:**
  - `POST /v1/service-invoices/{id}/substitution` (`nfse:issue`, `Idempotency-Key`), com o contrato v1 da DPS e o motivo do cliente (TSCodJustSubst e TSMotivo);
  - status `SUBSTITUTED` e os campos `substitution` e `substitutedById` na nota;
  - webhook `status_changed` liga as duas notas.
- [x] **A substituta é uma NFS-e comum** com o grupo `subst` (depois de `cLocEmi`, nos dois pacotes): número próprio, mesmo write-ahead, `UNKNOWN` e reconciliação. A original só vira `SUBSTITUTED` na transação que autoriza a substituta, nos três caminhos (envio, consulta e resolução manual).
- [x] **Nunca duas substitutas:**
  - uma substituta viva por original (índice único);
  - substituição e cancelamento da mesma nota são exclusivos, serializados por trava consultiva;
  - uma substituta em `UNKNOWN` não libera outra.
- [x] **Regras do Anexo I com fonte:**
  - E0078 (motivo 99 com texto);
  - campos travados pela opção pelo Simples (E0059–E0064 da produção restrita, E0060/E0061 da produção), campo a campo;
  - E0042, E0046 e E0065 pelo estabelecimento, pelo status e pelo canal.
  - O resto (prazo do município, eventos de terceiros) é do autorizador.
- [x] **Achado:** o Anexo I da produção restrita reescreveu as regras de campos travados como uma matriz original → substituta. Ela confirma a leitura das regras de produção e diz que "subitem" é o `cTribNac` (R-41).
- [x] **Banco:** migrations 0019 e 0020 (colunas imutáveis, CHECK, FK pela empresa, trigger no INSERT da substituta e do cancelamento, `SUBSTITUTED` só com substituta autorizada, grants mínimos).
- [x] **Simulador:** recusa substituta de chave desconhecida (E0044) ou de nota cancelada/substituída (E0046) e registra o e105102 na original.
- [x] **Testes:**
  - domínio: a matriz inteira nos dois pacotes;
  - XML com `subst` nos dois XSD, e o código de 1 posição recusado;
  - integração: caminho feliz, repetição, exclusão com o cancelamento, rejeição, "processa e derruba", resolução manual, recusas, concorrência (20 substituições e 1 cancelamento, um vence) e travas do banco;
  - ponta a ponta HTTP e matriz de isolamento com a rota nova.
- [ ] Próximas etapas:
  - regras L2/L3 com fonte;
  - contrato v2;
  - adapter da SEFIN (com o A1).

### Fase 2a, etapa 5 — cancelamento de NFS-e (2026-11-12)
Decisão: [ADR-0035](adr/0035-cancelamento-nfse.md).
- [x] **API:**
  - `POST /v1/service-invoices/{id}/cancellation` (`nfse:cancel`), com o motivo do cliente (TSCodJustCanc e TSMotivo);
  - `GET` do pedido;
  - status `CANCELLED` na nota;
  - webhook `service_invoice.cancellation_changed`.
- [x] **Pedido real `pedRegEvento`/`e101101`:** montado, assinado em `infPedReg` e validado no XSD do ambiente, nos dois pacotes.
- [x] **Mesma disciplina da emissão:**
  - write-ahead (`sending_at` com commit antes da rede);
  - queda com envio vai para `UNKNOWN`;
  - consulta do evento antes de retransmitir **os mesmos bytes**;
  - `FAILED` só sem nenhum envio (trigger);
  - nota `AUTHORIZED → CANCELLED` na mesma transação do registro.
- [x] **Achado (R-40):** os dois pacotes divergem no formato da chave e do Id do pedido, e a produção restrita é inconsistente consigo mesma (CNPJ alfanumérico). O motor não escolhe: o XSD do pacote decide e, se falhar, a falha é local, antes do envio.
- [x] **Simulador:** eventos com os mesmos modos de falha; a chave fictícia passa nos padrões dos dois pacotes.
- [x] **Testes:**
  - XML nos dois XSD, escape, assinatura e a divergência entre pacotes;
  - integração: caminho feliz, repetição, rejeição, "processa e derruba", retransmissão byte a byte, queda, `NOT_SENT` e privilégios;
  - ponta a ponta HTTP;
  - matriz de isolamento com as 2 rotas novas.
- [ ] Próximas etapas:
  - substituição (DPS com `subst`, restrições da E0061);
  - regras L2/L3 com fonte;
  - contrato v2;
  - adapter da SEFIN (com o A1).

### Fase 2a, etapa 4 — roteamento da NFS-e pela competência (2026-11-12)
Decisão: ADR-0028 (aprovado em 2026-11-10), seção "Implementação".
- [x] **Tabela versionada como dado:** `resources/fiscal/routing/nfse-routing-2026-11-10.json`.
  - As 5 linhas do ADR, cada uma com a fonte.
  - Validada na subida: fonte obrigatória, canais do catálogo, ids únicos.
- [x] **Aplicada no aceite, antes de numerar:**
  - entradas: município do estabelecimento, `opSimpNac`, `regApTribSN` e competência;
  - o canal e a versão da tabela ficam gravados na nota, imutáveis por trigger (migrations 0015 e 0016).
- [x] **Sem canal padrão nem precedência:** sem linha, linha "a confirmar", linhas conflitantes ou canal municipal (ainda sem adapter) dão `422 NFSE_CHANNEL_NOT_AVAILABLE`, com o motivo.
- [x] **Achado (R-39):** MEI em Teresina com competência anterior a 11/2026 casa duas linhas de canais diferentes. O motor recusa com `ROUTE_AMBIGUOUS`; **precisa de confirmação** da SEMF ou do contador.
- [x] **Contrato:** `regApTribSN` passa a ser exigido para ME/EPP (sem ele, `ROUTE_REGIME_REQUIRED`).
- [x] **Testes:**
  - cada linha da tabela;
  - conflito, ausência de regime e carga inválida;
  - ponta a ponta HTTP com os 5 motivos de recusa, sem numerar;
  - canal gravado imutável.
- [ ] Próximas etapas:
  - regras L2/L3 catalogadas com fonte;
  - consulta, cancelamento e substituição;
  - contrato v2;
  - adapter da SEFIN (com o A1).

### Fase 2a, etapa 3 — resolução manual de UNKNOWN e alertas (2026-11-12)
Decisões: [ADR-0034](adr/0034-resolucao-manual-unknown.md). Runbook: [nfse-unknown](runbooks/nfse-unknown.md).
- [x] **O operador pede; o worker-fiscal decide.**
  - `ops nfse-resolve` grava o pedido (só se acrescenta), audita e enfileira `nfse.resolve`.
  - O `fiscal_admin` não tem `UPDATE` na nota e não lê o XML nem o pedido do cliente.
  - O operador informa a empresa (`--company`), e tudo roda no contexto dela. Nenhuma política extra de RLS: o meta-teste barrou a primeira versão, que tinha uma.
- [x] **`AUTHORIZED`:** o XML oficial do portal é conferido antes de aplicar:
  - XSD `NFSe_v1.01.xsd` do mesmo pacote da DPS;
  - Id da DPS e ambiente;
  - assinatura da nossa DPS.

  A chave vem de `infNFSe/@Id` (TSIdNFSe). O webhook sai com `resolvedBy: MANUAL`.
- [x] **`NOT_ISSUED`:** volta a `PENDING` e retransmite o **mesmo XML**, com o mesmo número.
  - É recusado se o autorizador já respondeu duplicidade.
  - Nunca `FAILED`, nunca outro número.
- [x] **Recusa:** código estável no pedido, a nota segue `UNKNOWN` e a reconciliação continua. Um pedido aberto por nota; a decisão é gravada uma vez (trigger).
- [x] **Alertas por idade** (`nfse.escalate`): 15 min `WARNING`, 2 h `CRITICAL`, 24 h `INCIDENT`, repetido a cada 24 h. São log estruturado, só com identificadores. O painel é `ops nfse-unknown`.
- [x] **Migration 0014:**
  - integridade, guarda de só-acréscimo, RLS;
  - grants mínimos: o operador só enfileira `nfse.resolve`.
- [x] **Testes:**
  - verificador contra os XSD oficiais, com NFS-e sintética montada do TCNFSe;
  - domínio;
  - integração: aplicar, recusar, `NOT_ISSUED` byte a byte, duplicidade, corrida com a consulta, quedas, alertas e privilégios no banco.
- [ ] Próximas etapas:
  - regras L2/L3 catalogadas com fonte;
  - roteamento Teresina (ADR-0028);
  - contrato v2;
  - adapter da SEFIN (com o A1), que também deve verificar a assinatura da SEFIN.

### Fase 2a, etapa 2 — emissão pela API com o XML real (2026-11-12)
Decisões: [ADR-0033](adr/0033-contrato-dps-v1.md). Contrato: [contrato-dps-v1](fiscal/contrato-dps-v1.md).
- [x] **Contrato v1 da DPS:**
  - um campo por elemento do XSD, com enumerações e padrões copiados dos tipos oficiais;
  - os valores fiscais vêm do cliente; o motor não escolhe nenhum.
- [x] **Achado:** os dois pacotes oficiais têm **estrutura diferente**:
  - `finNFSe` existe só na produção restrita;
  - a ordem dentro de `cServ` muda;
  - `toma/xNome` deixa de ser obrigatório.

  O montador usa um perfil de leiaute por pacote.
- [x] **Montador do XML:** determinístico. Texto do cliente é sempre escapado, e o teste de injeção de XML passa.
- [x] **Preparador real:** monta, assina (perfil `nfse-nacional-dps`) e valida no XSD do ambiente. A assinatura confere.
- [x] **Pré-validação no aceite:** XSD com identificadores provisórios, fora da transação. Dá 400 `DPS_SCHEMA_INVALID` antes de numerar.
- [x] **Rotas:**
  - `POST /v1/service-invoices`: `Idempotency-Key` obrigatório, 202 ou 200 na repetição;
  - `GET /v1/service-invoices/{id}`: 404 para outra aplicação **ou outro ambiente**.
- [x] **Worker-fiscal:** `NFSE_GATEWAY=none|simulator` (simulador recusado em produção). A imagem leva `resources/fiscal`.
- [x] **Testes:**
  - montador nos dois XSD (todos os campos e os 4 tipos de totais), injeção, fuso;
  - preparador e validador;
  - ponta a ponta HTTP → worker → simulador → GET, com o XML transmitido válido no XSD e a assinatura conferida;
  - matriz de isolamento com as 2 rotas novas;
  - configuração.
  - Total do projeto: **535 testes**; typecheck, lint, camadas e build verdes.
- [ ] Próximas etapas:
  - resolução manual de `UNKNOWN` e alertas por idade (R-37);
  - regras L2/L3 catalogadas com fonte;
  - roteamento Teresina (ADR-0028);
  - contrato v2;
  - adapter da SEFIN (com o A1).

### Fase 2a, etapa 1 — núcleo da emissão de NFS-e (2026-11-12)
Decisões: [ADR-0032](adr/0032-nucleo-emissao-nfse.md). Fecha o "fluxo completo com documento fake" que faltava no gate da Fase 1.
- [x] **Módulo `nfse`:**
  - máquina de estados (`PENDING`, `PROCESSING`, `AUTHORIZED`, `REJECTED`, `FAILED`, `UNKNOWN`), conferida no domínio **e** por trigger no banco;
  - Id da DPS pela regra escrita no XSD oficial (`TSIdDPS`).
- [x] **Aceite idempotente** (`ServiceInvoiceService.accept`):
  - `Idempotency-Key` com hash do pedido, mais a restrição UNIQUE e a releitura na corrida;
  - `externalReference` ocupada até falha definitiva;
  - série do ambiente da credencial e trava de produção (PROD-001);
  - número e job `nfse.process` no mesmo commit.
- [x] **Envio com write-ahead** (`SubmissionProcessor`):
  - `PREPARED` → `SENDING`, com commit antes da rede, e depois o resultado;
  - a DPS assinada é gravada uma vez e reenviada byte a byte;
  - `NOT_SENT` volta a `PENDING` com backoff;
  - `UNKNOWN` e duplicidade agendam a reconciliação.
- [x] **Recuperação de queda sem varredura entre empresas:** o job volta quando a concessão vence; `PREPARED` volta a `PENDING`, `SENDING` vai para `UNKNOWN`.
- [x] **Reconciliação** (`Reconciler`):
  - espera mínima de 2 min;
  - retransmissão só depois da 2ª resposta "não encontrado" espaçada (5 min);
  - erro de consulta: backoff de 1, 2, 5, 10, 30 e 60 min, para sempre. Nunca `FAILED`.
- [x] **Simulador do autorizador** (`SimulatedNfseGateway`): autoriza, rejeita, não envia, processa e derruba, perde antes de processar, consulta atrasada e erro de consulta; conta as recepções.
- [x] **Banco** (migrations 0011 e 0012):
  - `service_invoices` e `service_invoice_attempts` com RLS e FKs compostas;
  - grants por coluna: a API só insere o pedido; o worker-fiscal só mexe no processamento;
  - triggers: transições, imutabilidade, DPS assinada gravada uma vez, `FAILED` proibido depois de envio, ninguém apaga.
- [x] Fila `nfse.process` e `nfse.reconcile` (lane fiscal); evento `service_invoice.status_changed`; 6 ações de auditoria novas.
- [x] Testes (total do projeto: **515**): 31 unitários (estados, Id da DPS, reconciliação) + 20 de integração com os testes obrigatórios do doc 12 §9:
  - queda em cada ponto;
  - "processa e derruba" resolvido por consulta, com uma única recepção;
  - consistência eventual;
  - retransmissão byte a byte;
  - autorizador fora do ar por horas sem nunca chegar a `FAILED`;
  - 50 requisições paralelas com a mesma chave geram um único documento.
- [x] **Correção de teste com data fixa:** o teste da âncora da auditoria prendia o relógio em 11/11/2026 com retenção de 1 dia. A partir de 12/11 o "reter até" ficou no passado e o S3 recusou, o que derrubou o CI do commit `27e5c88`. As datas agora são relativas ao dia real. O código da âncora não tinha defeito.
- [ ] Próxima etapa:
  - contrato da DPS na API (`POST /v1/service-invoices`) e preparador real (XML a partir do contrato, XSD oficial e assinatura);
  - resolução manual de `UNKNOWN` (doc 12 §7, R-37).

### Encerramento da Fase 1 — código concluído (2026-11-11)
- [x] **Spikes 01 a 03 promovidos a código definitivo** em `src/shared/infrastructure/` (ADR-0014, seção "Implementação definitiva"):
  - `xml/untrusted-xml.ts`: parser de XML não confiável;
  - `xml/fiscal-schema-catalog.ts`: XSD oficiais com hash conferido na carga, seleção por ambiente e erratas;
  - `xml/xml-signer.ts`: XMLDSig com o perfil `nfse-nacional-dps`; a verificação só aceita os algoritmos do perfil;
  - `transport/mtls-transport.ts`: mTLS com a fase da falha (ADR-0022).
- [x] **Validação contra os XSD oficiais da NFS-e Nacional:** uma DPS mínima fictícia valida nos pacotes de produção e de produção restrita, e o XML assinado também valida. O xmlsec1 confirmou a assinatura.
- [x] **Achado no XSD oficial de produção** (`1.01-20260209`):
  - `TSSerieDPS` usa `^0{0,4}\d{1,5}$`, e a libxml2 recusa **qualquer** série com esse padrão;
  - tratado com a errata explícita XSD-ERRATA-001 (ADR-0013, complemento de 2026-11-11; risco R-36). O arquivo oficial continua intocado;
  - SERIES-002 foi corrigida: ela dizia que o motor não dependia desse padrão.
- [x] **Correção no transporte:** o spike classificava como `NOT_SENT` uma requisição sem correlação com o trace. O correto, e o que agora está no código, é `UNKNOWN`.
- [x] Removidos `spikes/`, o job `spikes` do CI, `vitest.spikes.config.ts` e o pg-boss.
- [x] Testes: 58 novos (XSD oficial, errata, integridade, parser, assinatura, mTLS, xmlsec1, PFX legado do OpenSSL). Total: **464 testes**; typecheck, lint, regras de camadas e build verdes.
- [ ] Gate de saída da Fase 1:
  - o "fluxo completo com documento fake" foi para a Fase 2a, junto com o write-ahead e o reconciliador (reescopo da semana 6);
  - o deploy real continua aguardando VPS, domínio e buckets.

### Semana 7 — concluída no código (2026-11-11); deploy real pendente de infraestrutura
- [x] **Ensaio `?dryRun=true`** (ADR-0026 item 4):
  - em empresa, estabelecimento, série, assinatura de webhook e habilitação de produção;
  - a transação roda inteira (restrições, triggers, auditoria) e é desfeita no fim (`TransactionOptions.dryRun`);
  - resposta `200 { dryRun: true, result }`; o ensaio de webhook não devolve segredo.
- [x] **Habilitação de produção por estabelecimento e modalidade** (ADR-0027 item 1, regra [PROD-001](fiscal/regras/PROD-001.md)):
  - tabela `production_enablements` (migrations 0006 e 0007): RLS, FK composta, só `ACTIVE → REVOKED`, ninguém apaga;
  - escopos `production:read` e `production:manage`; alterar exige credencial `live`;
  - pré-requisitos: confirmação do CNPJ, estabelecimento ativo, certificado válido e série de produção da modalidade;
  - `isEnabled` pronto para a trava L5 da Fase 2a (o worker-fiscal só lê).
- [x] **Avisos de vencimento** `certificate.expiring` (30, 15, 7 e 1 dia) e `certificate.expired` (migrations 0008 e 0009):
  - sem varredura entre empresas: a ativação agenda um job por limiar, e o worker-general decide na hora e registra para não repetir;
  - certificado revogado ou substituído não gera aviso.
- [x] **Âncora externa da auditoria** ([ADR-0031](adr/0031-ancora-externa-auditoria.md), migration 0010):
  - cabeça de cada cadeia, por dia, num bucket S3 com Object Lock COMPLIANCE (adapter `S3AnchorStore`, AWS SDK 3.1157.0 fixado);
  - o cadastro da empresa inicia a corrente diária, e o worker-general garante a da plataforma;
  - `npm run audit -- verify --anchor`.
  - O teste reproduz o ataque: um superusuário reescreve a cadeia com hashes recalculados; a verificação interna passa e a âncora acusa `ANCHOR_MISMATCH`.
- [x] **Documentação para agentes e versionamento** (ADR-0027 item 8, ADR-0026 item 9):
  - `/openapi.json` (URL estável), `/llms.txt` e guias em Markdown em `/guides/` (fonte em `docs/api/`: guia rápido, webhooks, versionamento, changelog);
  - mecanismo de descontinuação com `Deprecation` (RFC 9745), `Sunset` (RFC 8594, mínimo de 180 dias) e `Link`, conferido na subida.
- [x] **Deploy, imagens e backup** (ADR-0020 revisado):
  - imagem do banco com WAL-G v3.0.9 (checksum conferido), cifra libsodium e credenciais em arquivo;
  - compose de produção `docker/coolify/docker-compose.yml`: segredos por serviço, rootfs somente leitura, `migrate` antes da API;
  - CI publica as duas imagens no GHCR com a tag `sha-<commit>`;
  - runbooks [deploy-coolify](runbooks/deploy-coolify.md) e [backup-restauracao](runbooks/backup-restauracao.md).
- [x] **Exercício de backup** `npm run drill:backup` (2026-11-11): o banco foi destruído e restaurado num volume vazio, voltando 1000 linhas do backup base e 250 que só existiam no WAL.
- [x] **Teste de fumaça das imagens em modo produção** (containers locais, rootfs somente leitura): API pronta, `/llms.txt` e `/openapi.json`, `dryRun`, cadastro → âncora gravada pelo worker-general → `audit verify --anchor` íntegro; nenhum segredo nos logs.
- [x] Testes:
  - novos: habilitação e `dryRun` (11), vencimento (4 de integração + 3 unitários), âncora (6 de integração + 4 unitários), docs e descontinuação (6), agenda diária, configuração da âncora e matriz de isolamento com as 3 rotas novas;
  - o SeaweedFS sobe por Testcontainers nos testes de integração (também no CI);
  - Total: **406 testes**; typecheck, lint, regras de camadas e build verdes.
- [ ] **Deploy real no Coolify:** depende da VPS, do domínio e dos buckets (provedor S3, decisão pendente 2). Runbook pronto, com os passos de painel marcados "(conferir no Coolify)".

### Fila, outbox, webhooks e rate limit — concluído (2026-11-10, semana 6)
- [x] **Fila própria** (ADR-0030; migrations 0004 e 0005):
  - tabela `jobs` com `SKIP LOCKED`, concessão (lease), backoff com jitter, mortos, singleton e retenção;
  - lanes `fiscal` e `general` isoladas por RLS por papel; a API só insere;
  - imutabilidade por grant de coluna e trigger;
  - o pg-boss saiu da produção e fica só no spike 04.
- [x] **Outbox transacional:** `outbox_events` (RLS, append-only) e job `webhooks.fanout` gravados no mesmo commit da mudança.
- [x] **Certificado pela fila:**
  - o upload enfileira `certificates.validate`, e o worker-fiscal valida e publica `certificate.activated` ou `certificate.rejected`;
  - a revogação publica `certificate.revoked`.
- [x] **Webhooks** (`src/modules/webhooks`):
  - catálogo de eventos, assinaturas por aplicação com filtro por tipo e limite de 10;
  - segredo `whsec_` exibido uma vez e cifrado com RSA-OAEP (só o worker-general decifra), com rotação;
  - assinatura Standard Webhooks (confere com o vetor oficial);
  - calendário publicado de 8 tentativas em cerca de 22 h, reenvio, evento de teste e consulta de entregas;
  - proteção contra SSRF no cadastro e na resolução de DNS.
- [x] **Rate limit** por credencial e por endereço (429, `Retry-After`, `RateLimit-*`).
- [x] **Processos novos** `worker-fiscal` e `worker-general` (`npm run dev:worker-*`). Cada um recusa, em produção, o segredo do outro.
- [x] **CLI de operação** `npm run ops` (queues, pause, resume, dead, retry, discard), auditada na cadeia da plataforma.
- [x] Escopo `webhooks:read`. Novas ações de auditoria de webhooks e de filas.
- [x] Testes:
  - unitários: backoff, token bucket, política SSRF IPv4/IPv6, calendário, cripto dos segredos, assinatura e config;
  - integração: atomicidade, SKIP LOCKED, mortos, concessão vencida, lanes, pausa e auditoria, fluxo certificado → webhook assinado, filtros, reentrega, esgotamento, rotação, outra aplicação, concessão revogada, append-only e rate limit;
  - matriz de isolamento com as 9 rotas novas.
  - Total: **369 testes**. O projeto de integração passou a rodar os arquivos em sequência.
- [x] Teste de fumaça local com os 3 processos reais: upload → `ACTIVE` → webhook entregue com assinatura válida; segredo e senha ausentes dos logs; `ops` e cadeia da plataforma íntegra.
- [x] Docs: ADR-0030, revisões dos ADR-0005 e 0015, docs 07, 09 e 11, runbook [filas-e-webhooks](runbooks/filas-e-webhooks.md).
- **Reescopo:** o write-ahead de tentativas (ADR-0022) e o reconciliador de `UNKNOWN` passam para a Fase 2a, junto com o primeiro transmissor (adapter SEFIN). Sem consumidor, seriam abstração sem uso. A fila já tem o que eles precisam: concessão, reaproveitamento de job e jobs agendados.

### Diagnóstico NFS-e Teresina × Nacional — concluído e aprovado (2026-11-10)
- [x] Diagnóstico: [nfse-teresina-api-municipal-x-nacional.md](fiscal/nfse-teresina-api-municipal-x-nacional.md). Lidos o portal e a Carta de Serviços da SEMF, o Guia API THE V7 (DSF), as Portarias SEMF 20/25, a documentação técnica nacional, os Anexos I/II, a Res. CGSN 191/2026 e a notícia de 29/10/2026.
- [x] Conclusão aprovada:
  - a ME/EPP do Simples em Teresina emite pela **SEFIN Nacional** quando a competência é a partir de 11/2026;
  - a API municipal (DSF) segue o mesmo padrão nacional e fica para a Fase 2b, conforme o regime dos clientes.
- [x] ADR-0017 revisado; novos ADR-0028 (roteamento por competência) e ADR-0029 (transmissão e reconciliação); complementos nos ADR-0013 (schemas por ambiente) e ADR-0014 (perfil de assinatura).
- [x] XSD oficiais de produção (1.01-20260209) e de produção restrita (1.01-20261020) em `resources/fiscal/schemas/nfse-nacional/`, com `MANIFEST.json` e teste de integridade de hash. No git, marcados `-text`, porque têm CRLF.
- [x] SERIES-002 conferida contra o XSD oficial. Fontes oficiais e riscos R-24 e R-30 a R-33 atualizados.

### Certificate Vault e Audit log encadeado — concluído (2026-11-10, semana 5)
- [x] **Audit** (`src/modules/audit`, migration 0003):
  - uma cadeia por empresa e uma da plataforma, com `hash = SHA-256(prev ‖ JSON canônico)`, gravadas na mesma transação da mudança;
  - append-only por trigger para todos os papéis, e o trigger de inserção confere o encadeamento com a cabeça;
  - a aplicação só faz INSERT; o verificador `npm run audit -- verify` detecta alteração, remoção e corte do fim;
  - empresas, estabelecimentos, séries, concessões, certificados, aplicações e credenciais são auditados.
- [x] **Certificate Vault** (`src/modules/certificates`):
  - envelope com DEK AES-256-GCM e KEK RSA-OAEP 4096, AAD por empresa e certificado; a API só tem a KEK pública e não sobe com a privada;
  - upload 202 `PENDING_VALIDATION`, listagem, consulta e revogação com destruição criptográfica;
  - validação no papel do worker-fiscal pela regra [CERT-001](fiscal/regras/CERT-001.md): CNPJ pelo OID 2.16.76.1.3.3 do DOC-ICP-04, cadeia, validade e keyUsage;
  - troca com sobreposição; `withCertificate` entrega um KeyObject.
- [x] Banco: grants por coluna (a API não lê o envelope; o worker-general lê só id, vencimento e status) e trigger `certificates_guard` (transições e imutabilidade do conteúdo cifrado, inclusive para o dono).
- [x] Escopo `certificates:read`. A CLI do operador registra o operador (`--operator`) na auditoria. Novas CLIs: `npm run certificates -- validate`, `npm run audit -- verify`.
- [x] Testes:
  - unitários: envelope (AAD, adulteração, rotação), PKCS#12 com PKI ICP de teste, cadeia, regra CERT-001, JSON canônico e verificador;
  - integração: fluxo API → worker, rejeições, grants, triggers, matriz de isolamento com as 4 rotas novas, canário de logs e adulteração da trilha detectada.
  - Total: **283 testes**.
- [x] Teste de fumaça no ambiente local: upload → validação → `ACTIVE` → cadeia íntegra, e a senha não aparece no log do servidor.
- [x] Documentação: CERT-001, implementação nos ADR-0009 e 0012, docs 09, 11 e 13, runbook [kek-certificados](runbooks/kek-certificados.md), fontes oficiais e riscos R-28 e R-29.

### Atividades permanentes (valem para todo endpoint novo)
- [ ] Toda rota declara schemas Zod para body/params/querystring/headers **e** para cada status de resposta, inclusive erros (`ProblemSchema`).
- [ ] Todo erro esperado é um `ApplicationError` com `code` estável registrado no [catálogo](architecture/11-api.md#catálogo-de-códigos-de-erro) e coberto por teste.
- [ ] Todo repository declara o mapa `constraint → erro de negócio` das constraints que podem ocorrer; operações de banco passam por `CompanyTransactions`/`withDatabaseErrors`.
- [ ] Toda tabela nova com `company_id` ganha RLS na migration de segurança (o meta-teste bloqueia o build se faltar).
- [ ] A rota aparece corretamente no Scalar (`/docs/`) com resumo, descrição e tag.
- [ ] A rota declara `config.auth` (escopo do catálogo) e, se for de empresa, ganha caso na matriz `test/integration/api-isolation-matrix.test.ts`.

### Próximos passos (ordem)
1. ~~Spikes obrigatórios~~ ✔
2. ~~Drizzle + migrations + papéis de banco + RLS + meta-teste de schema + Testcontainers~~ ✔
3. ~~IAM, Company, Fiscal Settings, matriz de isolamento da API~~ ✔
4. ~~Certificate Vault, Audit log~~ ✔
5. ~~Semana 6: fila, outbox, validação de certificado pela fila, webhooks, rate limit, operação das filas~~ ✔ (o write-ahead e o reconciliador foram para a Fase 2a)
6. ~~Semana 7: backup WAL, âncora externa da auditoria, habilitação de produção, OpenAPI estável + `llms.txt`, changelog, `dryRun`, avisos de vencimento~~ ✔ (deploy real aguardando VPS, domínio e buckets)
7. ~~Encerramento da Fase 1: promoção e remoção dos spikes, remoção do pg-boss~~ ✔ (deploy real aguardando infraestrutura)
8. ~~Fase 2a, etapa 1: núcleo da emissão (estados, write-ahead, reconciliação, simulador, fluxo completo com documento fake)~~ ✔ (ADR-0032)
9. ~~Fase 2a, etapa 2: contrato da DPS na API e preparador real (XML + XSD + assinatura)~~ ✔ (ADR-0033)
10. ~~Fase 2a, etapa 3: resolução manual de `UNKNOWN` e alertas~~ ✔ (ADR-0034)
11. ~~Fase 2a, etapa 4: roteamento Teresina (ADR-0028)~~ ✔
12. ~~Fase 2a, etapa 5: cancelamento~~ ✔ (ADR-0035)
13. ~~Fase 2a, etapa 6: substituição~~ ✔ (ADR-0036)
14. Fase 2a, etapa 7: regras L2/L3 catalogadas com fonte e contrato v2 (endereço, intermediário, deduções, IBS/CBS).

   A parte fiscal (regras L3, adapter SEFIN real) espera os pré-requisitos do roadmap: CNPJ e A1 reais, contador e gate fiscal 1.

### Versões adotadas
Node 24.12, TypeScript 6.0, Fastify 5.12, Zod 4.6, fastify-type-provider-zod 7.0, pino 10.4, Vitest 5.1, ESLint 10, decimal.js 10.6 (fixadas no `package-lock.json`).

## Implementado (Fase 0)
- [x] Documentação de arquitetura (`docs/architecture/01..15`)
- [x] Aprofundamentos: recuperação `UNKNOWN` (12), certificados A1 (13), integridade e isolamento (14), infraestrutura (15)
- [x] Investigação NFS-e Teresina (`docs/fiscal/nfse-teresina.md`)
- [x] ADRs 0001–0022
- [x] Roadmap revisado (1 dev + agente + especialista pontual)
- [x] Avaliação de 5 repositórios de terceiros ([fiscal/avaliacao-repositorios.md](fiscal/avaliacao-repositorios.md)) + ADR-0023 (proposto)

## Decisões tomadas
| Data | Decisão | ADR |
|---|---|---|
| 2026-11-09 | Monólito modular, API e workers separados, PostgreSQL + fila persistente | 0001, 0005 |
| 2026-11-09 | Drizzle ORM + Drizzle Kit, somente na infraestrutura | 0004 |
| 2026-11-09 | Idempotência + UNKNOWN + write-ahead de tentativas | 0006, 0007, 0022 |
| 2026-11-09 | RLS com testes rigorosos de isolamento como gate | 0011 |
| 2026-11-09 | Envelope encryption com KEK assimétrica; workers separados por privilégio | 0009, 0021 |
| 2026-11-09 | Motor não decide política tributária, mas valida dados, consistência, matemática e leiaute | 0018 |
| 2026-11-09 | Piloto NFS-e Teresina: API Nacional (Simples) primeiro, emissor municipal depois | 0017 |
| 2026-11-09 | VPS Hostinger + Coolify; Redis adiado; S3 externo | 0020, 0010 |
| 2026-11-09 | NFC-e Piauí: motor central primeiro, contingência local NERP/Tauri preparada | 0019 |
| 2026-11-09 | Vocabulário único "empresa" (company) no lugar de "tenant" | 0025 |
| 2026-11-09 | Convenções de API inspiradas na Focus NFe (referência externa, 201×202, dryRun, rate limit, hint) | 0026 |
| 2026-11-10 | Cadastro fiscal, certificados e documentação inspirados na NFE.io (habilitação de produção, inscrições, contingência configurável) | 0027 |
| 2026-11-10 | Piloto em Teresina pela SEFIN Nacional (Res. CGSN 191/2026); adapter municipal DSF na Fase 2b conforme demanda | 0017 (revisado) |
| 2026-11-10 | Canal de NFS-e decidido pela data de competência, por tabela versionada com fonte | 0028 |
| 2026-11-10 | Cliente único do padrão nacional com perfil de endpoint; reconciliação por Id da DPS antes de reenviar | 0029 |
| 2026-11-13 | Substituição como NFS-e nova com `subst`; a original só vira SUBSTITUTED com a substituta autorizada; exclusiva com o cancelamento; campos travados pela matriz do Anexo I (na dúvida, trava a menos) | 0036 |
| 2026-11-12 | Cancelamento assíncrono com write-ahead e UNKNOWN; um pedido ativo por nota; nota cancelada continua ocupando a referência externa | 0035 |
| 2026-11-12 | Roteamento implementado como dado versionado; município = do estabelecimento; conflito entre linhas recusa (sem precedência implícita) | 0028 |
| 2026-11-12 | Resolução manual de `UNKNOWN`: o operador pede, o worker-fiscal confere o XML oficial e decide; `NOT_ISSUED` retransmite o mesmo XML; alertas por idade com um job por nota | 0034 |
| 2026-11-12 | Contrato v1 da DPS (um campo por elemento do XSD, valores do cliente), perfil de leiaute por pacote, pré-validação no aceite | 0033 |
| 2026-11-12 | Núcleo da emissão de NFS-e: recuperação de queda pela própria fila (sem varredura entre empresas), DPS assinada uma vez, reconciliação por função pura | 0032 |

## Pendente de decisão do responsável
1. ~~Aprovação final da arquitetura consolidada~~ — aprovada em 2026-11-09.
2. Provedor S3 (recomendado Backblaze B2; alternativa AWS S3 sa-east-1) e parecer LGPD se fora do Brasil. **Agora bloqueia o deploy:** são 3 buckets (backups, âncoras com Object Lock, XML), e o provedor precisa oferecer Object Lock pela API S3 (ADR-0031).
9. VPS Hostinger com Coolify e domínio da API, para o primeiro deploy (runbook deploy-coolify §1).
10. Visibilidade do repositório no GitHub (hoje público) e das imagens no GHCR.
3. CNPJ real + certificado A1 para a produção restrita da NFS-e (dados de nota fictícios).
4. ~~Contato com a SEMF para o manual do webservice~~: o manual foi publicado (Guia API THE V7). Falta enviar à SEMF as perguntas do §10 do diagnóstico (conflito da Portaria 20/2026, eventos de notas antigas, endpoint ADN/DPS).
7. Levantar o regime dos clientes de Teresina (Simples/MEI × Lucro Presumido/Real), que define a prioridade da Fase 2b.
8. Com o contador: enquadramento da empresa-piloto (`opSimpNac`, `regApTribSN`, `cTribNac`/NBS, alíquota, retenções). R-30 depende disso.
5. ~~Aprovar o [ADR-0026](adr/0026-convencoes-api-referencia-mercado.md)~~ — aprovado em 2026-11-09.
6. ~~Aprovar o [ADR-0027](adr/0027-convencoes-cadastro-fiscal-referencia-nfe-io.md) (cadastro fiscal, certificados e documentação inspirados na NFE.io)~~ — aprovado em 2026-11-10.

## Riscos ativos principais
R-01 duplicidade · R-03 Reforma Tributária · R-07 NFC-e offline · R-17 VPS única · R-19 Teresina em transição · R-21 obrigação Simples já vigente · R-30 enquadramento `regApTribSN` da empresa-piloto · R-33 Swagger da SEFIN só com certificado · R-34 corrente de âncora · R-35 Coolify não exercitado · R-36 errata do XSD de produção da NFS-e · R-37 assinatura da SEFIN na resolução manual · R-39 MEI retroativo em Teresina sem precedência na tabela · R-40 formato do Id do evento e da chave entre pacotes · R-38 fuso do `dhEmi`. Ver [riscos.md](riscos.md).

## Código temporário / dívidas registradas
| Item | Finalidade | Remoção |
|---|---|---|
| Vulnerabilidade moderada `minimatch` (cadeia do ESLint, só em desenvolvimento) | — | Atualizar quando o ESLint publicar a correção; o CI audita só dependências de produção |
| Faixas reservadas de série NF-e/NFC-e não validadas (SERIES-001) | Fontes secundárias conflitantes (R-26) | Conferir MOC/XSD oficiais antes da Fase 3 |
| Séries do motor ainda aceitam 80000–89999 (faixa de transcrição manual do Emissor Web) | SERIES-002, conferida em 2026-11-10 | Bloquear na Fase 2a, junto com a DPS |
| Perfil de endpoint e de assinatura da SEFIN provisórios (prefixo, envelope, RSA-SHA1) | Swagger só com certificado (R-31, R-33) | Ler o Swagger com o A1 real e testar a primeira DPS em produção restrita |
| Teste baseado em propriedades entre 3 empresas (docs/14 §B4, teste 10) | Ainda não escrito | Junto com o primeiro documento fiscal (Fase 2a) |
| Bundle de ACs raiz ICP-Brasil (ITI) não carregado | Só a PKI fictícia de teste existe (R-29) | Antes da produção restrita (Fase 2a), com versão e hash em fontes-oficiais |
| Sem consulta de revogação (LCR/OCSP) na validação de certificado | Fora do escopo da semana 5 (R-29) | Fase 2a |
| Errata XSD-ERRATA-001 no pacote de produção da NFS-e (R-36) | Defeito do XSD oficial (`^`/`$` em `TSSerieDPS`) | Retirar quando o pacote de produção for substituído; confirmar no primeiro envio aceito |
| `resources/fiscal` fora da imagem Docker | O catálogo de schemas ainda não é usado em tempo de execução | Copiar na imagem do worker-fiscal quando a validação L4 for ligada (Fase 2a) |
| Validação XSD instancia o wasm a cada chamada (~200 ms com o XSD oficial) | Suficiente para o volume do piloto | Instância persistente ou `worker_threads` se a vazão exigir |
| `withCertificate` sem cache com TTL | O uso real (assinatura/mTLS) chega na Fase 2a | Junto com a assinatura XML |
| Comando de re-embrulho das DEKs (rotação da KEK) | O banco e o opener já aceitam; falta o comando | Antes da primeira rotação (runbook kek-certificados §3) |
| Escrita da trilha serializada por empresa (trava da cabeça) | Simplicidade e ordem total; volume atual baixo | Reavaliar com carga real de emissão |
| DPS assinada guardada só no banco (`service_invoices.signed_dps`) | O arquivo fiscal em S3 (ADR-0010) depende do provedor | Copiar para o bucket `fiscal-archive` quando ele existir |
| Assinatura da SEFIN no XML da NFS-e trazido na resolução manual não verificada | Cadeia de confiança do emissor nacional não definida (ADR-0034) | Adapter da SEFIN |
| Alertas de `UNKNOWN` só em log, sem métrica `fiscal_unknown_documents` | Sem stack de métricas ainda | Observabilidade do deploy |
| Worker-fiscal de produção sem as filas `nfse.*` ligadas | Preparador real pronto; falta o adapter SEFIN | Adapter SEFIN (com o A1) |
| Falha de XSD no worker grava só `DPS_SCHEMA_INVALID`, sem o detalhe | As mensagens da libxml2 podem citar dados pessoais | A pré-validação do aceite já devolve o detalhe ao cliente; avaliar detalhe sanitizado |
| Contrato v1 sem endereço, intermediário, exterior, obra, deduções, tributos federais e IBS/CBS | Escopo do piloto (ME/EPP de Teresina) | Contrato v2, conforme a demanda dos clientes |
| Rate limit em memória por réplica da API | Uma réplica hoje (ADR-0020) | Redis ou tabela quando houver mais de uma réplica |
| Fila por polling (sem LISTEN/NOTIFY) | Simplicidade; 1 s de latência basta | Reavaliar no teste de carga (Fase 5) |
| Endpoints HTTP de operação (`/ops/v1`) substituídos pela CLI `npm run ops` | Menor superfície; o papel da API não lê a fila (ADR-0030) | Reavaliar se surgir painel de operação |
| Restauração de backup e âncora ainda não exercitadas no provedor S3 real | Bucket de produção não existe (decisão pendente 2) | No primeiro deploy (runbooks backup-restauracao §5 e deploy-coolify §4) |
| Container one-shot `migrate` e login do Coolify no GHCR não confirmados num painel real (R-35) | Sem VPS ainda | No primeiro deploy |
| Alerta automático de fila morta (ex.: `audit.anchor-*`) | Hoje só `ops dead` e log (R-34) | Fase 5 (observabilidade) ou antes, se houver incidente |
| Imagem do banco no PostgreSQL 17.10 (17.11 tem menos de 2 semanas) | Prudência com versão recém-publicada | Atualizar para 17.11 e rodar `npm run drill:backup` |
| `scripts/dev-test-certificate.ts` usa a PKI de teste | Teste de fumaça local | Permanente (somente desenvolvimento) |
| Porta do PostgreSQL local alterada para 15432 | Evitar conflito com outro PostgreSQL (5432) e com as faixas que o Windows/Hyper-V reserva na faixa dinâmica (a 54329 foi reservada após reinício) | Configurável por `POSTGRES_PORT` |

## Evidências de homologação
Nenhuma ainda.
