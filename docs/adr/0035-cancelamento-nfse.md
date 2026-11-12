# ADR-0035 — Cancelamento de NFS-e (evento e101101)

- Status: **Aceito** · Data: 2026-11-12
- Relacionados:
  - ADR-0006 (UNKNOWN);
  - ADR-0014 (assinatura);
  - ADR-0022 (write-ahead);
  - ADR-0028 (o canal gravado vale para os eventos);
  - ADR-0029 (transmissão e reconciliação);
  - ADR-0032 (núcleo da emissão).

## Contexto
Uma NFS-e autorizada só deixa de valer por evento registrado no autorizador. Para o cancelamento simples, é o pedido de registro de evento (`pedRegEvento`) com o grupo `e101101`.

Um evento sofre os mesmos riscos de um envio de DPS:
- timeout depois do envio;
- queda do processo;
- consistência eventual na consulta.

Fontes, todas dos pacotes oficiais versionados. O `tiposEventos_v1.01.xsd` (estrutura do pedido e do `e101101`) é **idêntico** nos dois pacotes; os tipos simples da chave e do Id **não** são (item 6).
- **`TCPedRegEvt` / `TCInfPedReg`:**
  - `tpAmb`, `verAplic`, `dhEvento`;
  - `CNPJAutor` ou `CPFAutor`;
  - `chNFSe`;
  - escolha do grupo do evento;
  - `@Id` (TSIdPedRegEvt).
- **`TE101101`:**
  - `xDesc` com a única enumeração "Cancelamento de NFS-e";
  - `cMotivo` (TSCodJustCanc: 1 Erro na Emissão, 2 Serviço não Prestado, 9 Outros);
  - `xMotivo` (TSMotivo, de 15 a 255 caracteres).
- **Caminhos `POST /nfse/{chaveAcesso}/eventos` e `GET /nfse/{chaveAcesso}/eventos/{tipoEvento}`:** manual de contribuintes v1.2 (diagnóstico §3.2). O prefixo de caminho ainda não está confirmado (R-33).

## Decisão
1. **Contrato.**
   - `POST /v1/service-invoices/{id}/cancellation`, escopo `nfse:cancel`, com corpo `{ reasonCode, reasonText }`.
     - Os valores e os limites são copiados de TSCodJustCanc e TSMotivo.
     - **O motivo é do cliente**; o motor não escolhe.
     - Resposta `202` com `Location`. Repetir o mesmo corpo devolve `200` com o mesmo pedido.
   - `GET /v1/service-invoices/{id}/cancellation`, escopo `nfse:read`.
   - Só nota `AUTHORIZED`, da mesma aplicação, do mesmo ambiente e do canal `NATIONAL_SEFIN` (o canal gravado no aceite).
2. **Um pedido de cancelamento por nota.** Há no máximo um ativo (índice parcial). Depois de `REJECTED` ou `FAILED`, o cliente pode pedir de novo, por exemplo com outro motivo.
3. **Write-ahead e UNKNOWN, como na emissão:**
   - **Sequência:**
     - `PENDING → PROCESSING`, com concessão;
     - o XML é montado, assinado e validado no `pedRegEvento_v1.01.xsd` **uma vez**, e gravado;
     - `sending_at` é gravado com commit **antes** da rede;
     - só então o resultado.
   - **Respostas do autorizador:**
     - timeout, reset ou resposta ilegível vão para `UNKNOWN`. A consulta usa a política da reconciliação da emissão: espera mínima, duas respostas "não encontrado" espaçadas antes de retransmitir **os mesmos bytes**, e backoff infinito;
     - duplicidade (o evento já existe) vai para `UNKNOWN`, com consulta imediata.
   - **Queda do processo:** com `sending_at` gravado, a nota vai para `UNKNOWN`; sem ele, volta a `PENDING`.
   - `FAILED` só antes de qualquer envio (trigger).
4. **Registro.** Com o evento registrado:
   - o cancelamento vai para `REGISTERED`;
   - a nota vai de `AUTHORIZED` para `CANCELLED`, na mesma transação (transição nova na máquina de estados e no trigger);
   - o webhook `service_invoice.status_changed` sai com `CANCELLED`.

   Os outros desfechos (`REJECTED`, `FAILED`, `UNKNOWN`) saem em `service_invoice.cancellation_changed`, e a nota continua `AUTHORIZED`.
5. **Valores fixos que o motor preenche:**

   | Campo | Valor | Justificativa |
   |---|---|---|
   | `tpAmb` | ambiente da nota | TSTipoAmbiente |
   | `CNPJAutor` | CNPJ do prestador | O motor emite como prestador (`tpEmit` 1) |
   | `xDesc` | "Cancelamento de NFS-e" | Única enumeração do XSD |
   | `dhEvento` | horário de Brasília (`-03:00`) | Mesmo critério provisório do `dhEmi` (R-38) |

6. **`@Id` do pedido** = `"PRE"` + chave de acesso (50) + `"101101"`.
   - A documentação de TSIdPedRegEvt cita também `nPedRegEvento`, mas:
     - o padrão do tipo (até 59 posições) só comporta chave + tipo;
     - `TCInfPedReg` não tem elemento `nPedRegEvento` na v1.01.
   - **Segue-se o padrão** (é o que o XSD valida), e o ponto fica **a confirmar** na produção restrita (R-40).
   - **Os pacotes divergem** no formato da chave e do Id (achado do teste com o XSD real):

     | Tipo | Produção (09/02/2026) | Produção restrita (20/10/2026) |
     |---|---|---|
     | TSChaveNFSe | `[0-9]{50}` | `[0-9]{6}([0-9A-Z]{14})[0-9]{30}` |
     | TSIdPedRegEvt | `PRE[0-9]{56}` | `PRE[0-9]{8}(1[0-9]{14}\|2[0-9A-Z]{14})[0-9]{33}` |
     | TSIdNFSe | `NFS[0-9]{50}` | `NFS[0-9]{9}[0-9A-Z]{14}[0-9]{27}` |

     Na produção restrita, a posição das letras do CNPJ alfanumérico não é a mesma em TSChaveNFSe e em TSIdPedRegEvt, ou seja, o pacote é inconsistente consigo mesmo.
   - **O motor não escolhe nenhum dos padrões.** O domínio confere só a forma geral (50 posições, dígitos ou letras maiúsculas), e o XSD do pacote da nota decide no preparador. Se a chave real não passar, o resultado é `FAILED` com `EVENT_SCHEMA_INVALID` **antes de qualquer envio**, o que é seguro, e o caso vai para confirmação.
7. **Assinatura:** perfil `nfse-nacional-dps` (RSA-SHA1, C14N), sobre `infPedReg`, com o certificado do prestador. É o mesmo provisório da DPS (R-31).

## Fora deste ADR
- **Substituição:** é uma DPS nova com o grupo `subst`, e a SEFIN gera o `e105102`. As restrições da E0061 para ME/EPP entram na próxima etapa.
- **Prazo de cancelamento:** E0050 segue a parametrização do município e o prazo não está confirmado. O motor **não** impõe prazo: o autorizador rejeita, e a rejeição chega ao cliente.
- **Liberação da `externalReference`:** uma nota `CANCELLED` continua ocupando a referência (ADR-0026 item 1 só libera `REJECTED` e `FAILED`). Para reemitir a mesma venda, use uma referência nova. A revisão disso é decisão do responsável.
- **Resolução manual e alertas de idade do cancelamento em UNKNOWN:** o runbook orienta; a ferramenta entra se houver necessidade.

## Alternativas consideradas
- **Status `CANCELLING` na própria nota.** Rejeitada: o estado do cancelamento tem ciclo próprio (UNKNOWN, rejeição) e misturaria duas máquinas.
- **Cancelar síncrono na requisição HTTP.** Rejeitada: um timeout viraria "cancelado ou não?" para o cliente. O fluxo assíncrono com `UNKNOWN` é o mesmo da emissão.
