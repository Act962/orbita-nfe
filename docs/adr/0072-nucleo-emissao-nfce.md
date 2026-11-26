# ADR-0072 — Núcleo da emissão da NFC-e: estados, tentativas e XML montado no envio

- Status: **Aceito** (as 3 fatias implementadas, com o simulador) · Data: 2026-11-26
- Relacionados:
  - ADR-0032 e ADR-0022 (núcleo da NFS-e e write-ahead: o molde);
  - ADR-0029 (incerteza se resolve consultando);
  - ADR-0064 (consulta pela chave);
  - ADR-0065 (chave e assinatura);
  - ADR-0067 (contingência, em aberto);
  - ADR-0069 (contrato e XML);
  - ADR-0070 (autorização);
  - ADR-0071 (perfil estadual).

## Contexto
O núcleo da NFS-e já garante:
- aceite idempotente;
- número alocado na transação;
- registro da tentativa antes da rede;
- `UNKNOWN` resolvido só por consulta.

A NFC-e segue o mesmo molde, com duas diferenças que vêm das fontes:
1. **Prazo de 5 minutos:** a NFC-e de emissão normal (`tpEmis=1`) com `dhEmi` mais de 5 minutos antes da recepção é rejeitada (regra **B09-40**, cStat 704, NT 2026.002 v1.11). A NFS-e retransmite os mesmos bytes, o que na NFC-e só traria rejeição.
2. **Denegação de uso (110, 301–303):** grava a nota no autorizador (MOC 7.0, item 5.1.6). É um fim diferente da rejeição, e o número fica consumido.

## Decisão
1. **Estados:** `PENDING`, `PROCESSING`, `AUTHORIZED`, `REJECTED`, `DENIED`, `FAILED`, `UNKNOWN`. O cancelamento virá com o seu próprio ADR.
   - `PENDING → PROCESSING | FAILED`
   - `PROCESSING → AUTHORIZED | REJECTED | DENIED | UNKNOWN | PENDING | FAILED`
   - `UNKNOWN → AUTHORIZED | DENIED | PENDING`
   - `FAILED` só se nenhuma tentativa chegou a `SENDING`.
2. **O XML é montado e assinado a cada tentativa,** com `dhEmi` no momento do envio. A tentativa guarda:
   - o XML assinado;
   - a chave;
   - o SHA-256;
   - o `DigestValue`.

   A reconciliação usa a chave e o digest da tentativa (ADR-0070).
3. **Uma tentativa nova só nasce quando a nota voltou a `PENDING`,** e isso só acontece quando está provado que nada foi gravado:
   - `NOT_SENT` (o transporte provou que nada saiu);
   - queda com a tentativa ainda em `PREPARED`;
   - consulta pela chave que respondeu "não consta" (217) duas vezes, com intervalo, como na NFS-e.

   O número e o `cNF` são os mesmos em toda tentativa. A chave só muda se o mês virar entre as tentativas, porque o AAMM da chave segue o `dhEmi`. Nesse caso a chave antiga já foi provada inexistente, e a duplicidade de número (539) segue como rede de proteção (ADR-0070).
4. **Banco (migrations 0038 e 0039),** no molde da 0012:
   - `consumer_invoices` e `consumer_invoice_attempts`, com FKs compostas pela empresa e RLS forçado;
   - triggers de transição, imutabilidade da venda e da identidade, resultado do autorizador gravado uma vez, nada apagado;
   - `FAILED` proibido depois de `SENDING`;
   - no máximo uma tentativa aberta;
   - o XML, a chave e o digest da tentativa nunca mudam.
   - **Permissões por coluna:**
     - a API insere o pedido e lê, mas não muda estado nem lê o XML assinado das tentativas;
     - o worker-fiscal muda só as colunas de processamento;
     - o XML assinado é barrado duas vezes: pela permissão e pelo trigger.

## Fatias
1. **Feita:** domínio da máquina de estados, tabelas e travas, com testes de integração. Cobrem as transições, a imutabilidade (inclusive para o superusuário), as permissões por papel e o RLS entre empresas.
2. **Feita: aceite e API.**
   - **Rotas, com os escopos novos `nfce:issue` e `nfce:read`:**
     - `POST /v1/consumer-invoices`, com `Idempotency-Key`. Devolve 202 `PENDING`, e 200 numa repetição com o mesmo corpo.
     - `GET /v1/consumer-invoices/{id}`.
     - `GET /v1/consumer-invoices?externalReference=…`.
   - **Conferências, na ordem, antes de numerar:**
     1. referência externa ocupada (409);
     2. estabelecimento ativo **com perfil estadual** (422 `NFCE_STATE_PROFILE_REQUIRED`);
     3. regras da venda do ADR-0069, todas de uma vez em `issues` com `ruleId` (422 `NFCE_RULES_VIOLATED`);
     4. habilitação de produção, para credencial `live`;
     5. série NFC-e ativa no ambiente.
   - **Depois, na mesma transação:**
     - número alocado;
     - `cNF` sorteado e conferido pela regra B03-10 (ADR-0065);
     - `PENDING`;
     - auditoria `consumer_invoice.accepted`;
     - job `nfce.process`, que espera na fila até a fatia 3.
   - **Visibilidade:** nota de outra aplicação ou de outro ambiente responde 404, como na NFS-e.
   - **Testes:** as três rotas entraram na matriz de isolamento. Os testes de integração cobrem o aceite, a repetição, a chave reusada, a regra violada, a forma do XSD, o perfil ausente, o CRT fora da v1, a referência ocupada e a produção sem habilitação.
3. **Feita: worker.**
   - **Processador (`nfce.process`)**, no molde da NFS-e:
     1. concessão;
     2. emitente do cadastro (ADR-0071) e certificado do cofre;
     3. XML **montado e assinado no envio**, validado no XSD do PL_010h;
     4. tentativa `PREPARED` com o XML, a chave e o digest;
     5. `SENDING` com commit antes da rede;
     6. o resultado, pelo ADR-0070.
   - **Emitente:** razão social da empresa, perfil estadual, e o nome do município e a UF pela tabela do IBGE. A razão social com mais de 60 caracteres falha antes do envio (`NFCE_ISSUER_NAME_LENGTH`): o motor não corta dado fiscal.
   - **Fuso do `dhEmi`:** -03:00, só para o Piauí, que não tem horário de verão. Outra UF falha antes do envio (`NFCE_TIMEZONE_NOT_SUPPORTED`), em vez de presumir o fuso.
   - **Destino de cada resposta:**
     - `AUTHORIZED`: grava a chave, o cStat, o protocolo e o `nfeProc` (NFe + protNFe), com o SHA-256.
     - `DENIED`: grava a chave e o cStat.
     - `REJECTED`: guarda o código.
     - `NOT_SENT`: volta a `PENDING`, com backoff.
     - `UNKNOWN` e `ALREADY_EXISTS`: viram `UNKNOWN` e agendam a consulta.
     - Queda: `PREPARED` volta a `PENDING`; `SENDING` vira `UNKNOWN`.
   - **Reconciliador (`nfce.reconcile`):** a regra pura da NFS-e passou para `shared/domain/reconciliation.ts` e é a mesma nas duas notas. Ele consulta pela chave e pelo digest **da última tentativa**:
     - autorizada ou denegada: grava o resultado;
     - duas respostas "não consta" espaçadas: a nota volta a `PENDING`, e a tentativa seguinte monta um XML novo;
     - erro: backoff, sem fim, e nunca `FAILED`.
   - **Simulador (`SimulatedNfceAuthorizer`):** autoriza, denega, rejeita, não envia, processa e derruba, ou derruba antes. Responde duplicidade (204) para chave já gravada. O protocolo é fictício (`nProt` começa com 9).
   - **Configuração `NFCE_GATEWAY`:** `none` ou `simulator`. O simulador é recusado em produção.
   - **Teste de ponta a ponta:** Postgres real, preparador real (certificado ICP de teste, XSD oficial) e simulador. Cobre:
     - autorizada, rejeitada e denegada;
     - `NOT_SENT` com XML novo na tentativa seguinte;
     - processa e derruba, resolvido pela consulta sem reenvio;
     - nada chegou, com nova tentativa só depois de duas respostas "não consta";
     - erro de consulta;
     - queda em `SENDING`;
     - falha local antes do envio.

## Ainda falta
- **Adaptador real do SVRS:** liga o `authorize` do ADR-0070 e a consulta do ADR-0064 ao processador. Entra com o credenciamento da empresa piloto.
- **Webhook de mudança de estado da NFC-e:** hoje as mudanças ficam só na auditoria.
- **Download do XML autorizado e DANFE NFC-e.**
- **Arquivamento com Object Lock,** como no ADR-0048.

## Em aberto
- **QR Code 2.00 (CSC) ou 3.00:** decisão do responsável (ADR-0066). O simulador usa o 3.00, que não precisa de CSC.
- **Contingência off-line:** decisão do responsável (ADR-0067). Até lá, a incerteza segue o caminho da consulta, e a venda fica `UNKNOWN` até a SEFAZ responder.
