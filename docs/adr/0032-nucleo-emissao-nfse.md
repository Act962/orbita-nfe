# ADR-0032 — Núcleo da emissão de NFS-e: estados, write-ahead e reconciliação

- Status: **Aceito** · Data: 2026-11-12
- Implementa: ADR-0006, ADR-0007, ADR-0008, ADR-0022, ADR-0029 e o doc 12, na parte que **não depende de decisão fiscal**.

## Contexto
O gate da Fase 1 pede um "fluxo completo com documento fake", que foi reescopado para a Fase 2a junto com o write-ahead e o reconciliador. A parte fiscal da DPS espera pré-requisitos do responsável:
- campos do contrato, regras L3 e adapter SEFIN real;
- CNPJ e A1 reais, contador e gate fiscal 1.

O núcleo de emissão pode ser feito agora: aceitar, numerar, preparar, transmitir, classificar, reconciliar e nunca duplicar.

## Decisão
1. **Módulo `nfse`** com o agregado `ServiceInvoice` e a máquina de estados do doc 04:
   - `PENDING → PROCESSING → AUTHORIZED | REJECTED | UNKNOWN | PENDING`;
   - `UNKNOWN → AUTHORIZED | PENDING`;
   - `PENDING → FAILED`.

   `CANCELLED` e `SUBSTITUTED` ficam para quando os eventos forem implementados. As transições valem no domínio **e** num trigger do banco.
2. **Id da DPS** montado pela regra escrita no próprio XSD oficial (`TSIdDPS`, documentação do tipo):

   `"DPS" + Cód.Mun (7) + Tipo de Inscrição Federal (1) + Inscrição Federal (14) + Série (5) + Número (15)`.

   O tipo 2 é o CNPJ (14 posições, alfanumérico no pacote de produção restrita) e o tipo 1 é o CPF com zeros à esquerda (padrão do XSD de 20/10/2026). Fica gravado com `UNIQUE`.
3. **Aceite (API)**, numa única transação:
   - confere a idempotência;
   - escolhe a série ativa do ambiente da credencial;
   - em produção, exige a habilitação;
   - aloca o número (ADR-0008) e monta o Id da DPS;
   - grava `PENDING`, auditoria e o job `nfse.process`.

   Idempotência (ADR-0007):
   - a chave fica em `(empresa, aplicação, Idempotency-Key)` com o hash do pedido; mesmo hash devolve o mesmo documento, hash diferente dá `IDEMPOTENCY_KEY_REUSED`;
   - uma corrida perdida para a restrição `UNIQUE` é relida numa transação nova;
   - a `externalReference` é única por (empresa, aplicação) enquanto o documento não estiver em `REJECTED` ou `FAILED` (ADR-0026 item 1).
4. **Envio (worker-fiscal), write-ahead do ADR-0022:**
   - **TX1:** `PENDING → PROCESSING` com concessão (`lease_until`).
     - Na primeira vez, prepara a DPS: monta, valida no XSD (L4) e assina.
     - O XML assinado e o SHA-256 são gravados **no documento** e nunca mais mudam. Toda retransmissão usa os mesmos bytes.
     - Grava a tentativa `PREPARED`.
   - **TX2:** tentativa `SENDING`, com commit **antes** da rede.
   - **Rede:** `NfseGateway.submit`.
   - **TX3:** fecha a tentativa e aplica o resultado:
     - `AUTHORIZED` ou `REJECTED`: estado final;
     - `NOT_SENT`: volta a `PENDING`, com novo job e backoff;
     - `UNKNOWN` ou `ALREADY_EXISTS`: vai para `UNKNOWN`, e o job `nfse.reconcile` é agendado.
5. **Recuperação de queda sem varredura entre empresas.** Nenhum papel lista empresas sob FORCE RLS (mesma restrição do ADR-0031). Por isso a varredura de travados (*stuck-scan*) é a **própria fila**:
   - um job cujo processo morreu volta quando a concessão vence;
   - o handler relê o documento e, se ele estiver `PROCESSING` com a concessão vencida, aplica a tabela do doc 12 §2:
     - tentativa `PREPARED` volta a `PENDING`, porque é certo que nada saiu;
     - tentativa `SENDING` vai para `UNKNOWN`.
   - Com a concessão ainda válida, o handler não toca no documento.
6. **Reconciliação** (doc 12 §3), decidida por uma função pura do domínio:
   - espera mínima de 2 min depois do `SENDING`;
   - consulta pelo Id da DPS;
   - encontrado: `AUTHORIZED`;
   - não encontrado: só retransmite depois da **segunda** resposta "não encontrado", separada da primeira por pelo menos 5 min;
   - erro na consulta: backoff de 1, 2, 5, 10 e 30 min, depois de 1 h em 1 h.
   - Cada consulta é um job novo com `runAt` (o `singletonKey` leva o número da consulta).
   - **Nenhum caminho automático leva `UNKNOWN` a `FAILED`.**
7. **L5 no worker antes de preparar:**
   - em produção, habilitação ativa;
   - certificado ativo e dentro da validade (`withCertificate`).

   Falha aqui é `FAILED`, porque é certo que nada foi transmitido.
8. **Portas:**
   - `NfseGateway`: `submit` e `findByDpsId`, com uniões fechadas;
   - `DpsPreparer`: monta, valida e assina.

   Nesta etapa:
   - o gateway real é o **simulador** (`SimulatedNfseGateway`): guarda o que recebeu, tem modos de falha e conta as recepções;
   - o preparador real depende do contrato da DPS, que é a próxima etapa;
   - o worker-fiscal de produção ainda não liga as filas `nfse.*`: o `composeFiscalWorker` só registra os handlers quando recebe gateway e preparador, e o `main` não os passa.
9. **Webhook** `service_invoice.status_changed` a cada mudança de estado visível, com `status`. `UNKNOWN` significa **"em verificação, não reemita"** (doc 12 §8).

## Consequências
- O fluxo inteiro, com quedas e falhas injetadas, é testável antes de existir qualquer acesso à SEFIN.
- O XML assinado fica no banco, que tem backup WAL. A cópia para o arquivo fiscal em S3 (ADR-0010) é uma dívida registrada da Fase 2a.
- Alertas por idade do `UNKNOWN` (15 min, 2 h, 24 h) ficam no log até a fase de observabilidade.
