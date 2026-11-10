# ADR-0030 — Fila própria em PostgreSQL (substitui o pg-boss)

- Status: **Aceito**
- Data: 2026-11-10
- Decisão técnica tomada na implementação da semana 6, dentro do ADR-0005
- Substitui: a conclusão do spike 04 ("pg-boss confirmado") no [ADR-0005](0005-fila-em-postgresql.md)

## Contexto
O ADR-0005 previa o pg-boss se o enqueue participasse da transação da aplicação, ou uma tabela própria com `FOR UPDATE SKIP LOCKED`. O spike 04 confirmou que o pg-boss 12 participa da transação.

Ao ligar a fila aos papéis de banco do projeto, surgiram três problemas:
- **DDL e manutenção em tempo de execução.** O pg-boss 12 cria e mantém o próprio schema em tempo de execução: partições por fila, partições de estatística, funções e migrações automáticas. Para isso, os papéis da aplicação precisariam de permissão de DDL. Isso conflita com o modelo de privilégio mínimo: as migrations rodam só com o dono das tabelas, e os papéis `fiscal_*` não têm DDL (ADR-0011).
- **Separação por lane.** A separação por privilégio do ADR-0021 (worker-fiscal × worker-general) pede que cada papel enxergue só as próprias filas. No pg-boss isso exigiria políticas sobre tabelas internas da biblioteca, que mudam entre versões.
- **Superfície grande.** O plano SQL do pg-boss 12 tem cerca de 2.800 linhas: grupos, dependências, comandos em lote e telemetria. É muito código fora do nosso controle num ponto crítico, contra a política do ADR-0023.

## Decisão
1. **Tabela própria `jobs`**, criada pelas nossas migrations (Drizzle), com `queue_controls` para pausa:
   - consumo com `FOR UPDATE SKIP LOCKED`;
   - concessão (`lease_until`) e reaproveitamento de job com concessão vencida;
   - backoff exponencial com jitter e fila de mortos (`state = 'dead'`);
   - unicidade por `(queue, singleton_key)` enquanto o job está pendente ou em execução;
   - retenção de 7 dias para jobs concluídos ou descartados.
2. **Lanes com RLS por papel:**
   - `fiscal` é consumida só pelo `fiscal_worker`, e `general` só pelo `fiscal_general`;
   - qualquer papel enfileira em qualquer lane, mas só como job novo;
   - a API só faz INSERT e não lê a fila;
   - o operador (`fiscal_admin`) lê e reprocessa.
3. **O job carrega só identificadores** (UUID). Isso é conferido no código (`assertIdsOnlyPayload`). O handler recarrega o estado do banco, na transação da empresa, onde vale o RLS dos dados.
4. **Imutabilidade por trigger** (`jobs_guard`): fila, lane, conteúdo, chave singleton e origem não mudam. Além disso, os workers não têm grant de UPDATE nessas colunas.
5. **`ON CONFLICT` só na lane do próprio processo.** O PostgreSQL exige que a linha nova passe na política de LEITURA quando há `ON CONFLICT`, e a API não lê a fila. Por isso a API sempre enfileira com chave nova. Se uma chave se repetir fora da lane do processo, é erro de programação, e o banco devolve violação de unicidade.
6. **Catálogo fechado de filas** em `shared/application/job-queue.ts` (lane, tentativas, backoff, timeout, prioridade).
7. **Operação manual pela CLI `npm run ops`** (papel `fiscal_admin`), com auditoria na cadeia da plataforma. Não há endpoints HTTP de operação na API pública: eles exigiriam dar ao papel da API acesso à fila de todas as empresas, e aumentariam a superfície exposta.
8. O pg-boss continua só como dependência de desenvolvimento do spike 04, que será apagado no fim da Fase 1.

## Alternativas consideradas
- **pg-boss com `migrate: false` e schema criado pela nossa migration.** Ainda exigiria grants amplos sobre tabelas e funções internas e manutenção periódica com DDL de partições. Também criaria acoplamento a detalhes internos que mudam entre versões.
- **BullMQ/Redis.** Já fora pelo ADR-0005, por causa do dual write.

## Consequências
- Cerca de 350 linhas próprias (store + runner + admin), cobertas por testes de integração: atomicidade, SKIP LOCKED com 6 consumidores, backoff e mortos, concessão vencida, lanes, imutabilidade, pausa e auditoria.
- Sem LISTEN/NOTIFY: o consumo é por polling (1 s por padrão). Isso basta para o volume atual; reavaliar no teste de carga da Fase 5.
- A troca de implementação continua isolada atrás da porta `JobScheduler` / `JobRunner`.

## Fontes
[doc 07](../architecture/07-filas-processamento.md), [runbook de filas e webhooks](../runbooks/filas-e-webhooks.md), migrations 0004 e 0005.
