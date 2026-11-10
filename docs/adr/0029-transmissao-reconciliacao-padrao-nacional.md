# ADR-0029 — Transmissão e reconciliação no padrão nacional da NFS-e

- Status: **Aceito**
- Data: 2026-11-10
- Aprovação: responsável, em 2026-11-10
- Complementa: ADR-0006 (UNKNOWN), ADR-0007 (idempotência), ADR-0008 (numeração), ADR-0022 (write-ahead)

## Contexto
A SEFIN Nacional e o emissor de Teresina (DSF) expõem o mesmo desenho de API.

| | SEFIN Nacional (manual "v1.2 out/2025") | Teresina DSF (Guia V7) |
|---|---|---|
| Emissão | `POST /nfse` | `POST /notafiscal-ws/nfse` |
| Chave pela DPS | `GET /dps/{id}` (só para ator da nota) + `HEAD /dps/{id}` | `GET /notafiscal-ws/nfse/dps/{id}` |
| Consulta | `GET /nfse/{chave}` | `GET /notafiscal-ws/nfse/{chave}` |
| Eventos | `POST/GET /nfse/{chave}/eventos` | `POST /notafiscal-ws/nfse/{chave}/eventos` |
| Envelope | JSON + XML gzip+Base64 (regras E1225/E1226) | JSON `dpsXmlGZipB64` / `pedidoRegistroEventoXmlGZipB64` |
| Autenticação | Certificado de cliente ICP-Brasil (E1200–E1209) | Certificado de cliente com o mesmo CNPJ raiz |

A SEFIN impõe unicidade de série + número + município + CNPJ pela regra **E0014**. O Id da DPS é determinístico (XSD `TSIdDPS`).

## Decisão
1. **Um cliente do padrão nacional**, em `nfse/infrastructure/gateways/national/`, faz a serialização, o gzip+Base64, a assinatura, o mTLS e a leitura do JSON. Ele é parametrizado por um **perfil de endpoint**, que é dado:
   - URLs por ambiente e caminhos;
   - capacidades (`supportsHeadDps`, `dpsLookupPath`);
   - perfil de assinatura (ADR-0014);
   - versão de leiaute por ambiente (ADR-0013).
   - Perfis previstos: `sefin-nacional` (Fase 2a) e `teresina-dsf` (Fase 2b). Fora isso, não há framework genérico de provedores.
2. A porta `NfseGateway` devolve uma união fechada: `Authorized(chave, xml) | Rejected(codigo, mensagem) | AlreadyExists | Indeterminate(fase)`.
   - Timeout, reset de conexão, 5xx e resposta ilegível **sempre** resultam em `Indeterminate`.
   - Rejeição definitiva só vem de uma resposta do autorizador com código `Exxxx`.
3. **Reconciliação antes de qualquer reenvio:**
   - `Indeterminate` deixa o documento em `UNKNOWN`. Daí, consulta `GET` (ou `HEAD`) `/dps/{id}`:
     - chave encontrada → `GET /nfse/{chave}` → `AUTHORIZED`;
     - 404 consistente após uma janela mínima → reenvio **da mesma DPS assinada**, com o mesmo Id, série e número.
   - `E0014` também leva à reconciliação, nunca a uma nova numeração.
4. A DPS assinada é guardada (S3 + hash) **antes** do envio, junto com o write-ahead da tentativa. O reenvio usa os mesmos bytes.
5. Número enviado nunca é reaproveitado, nem depois de rejeição. As séries do motor não usam a faixa 80000–89999, que o Emissor Web usa na transcrição manual (comunicado de implantação do gov.br/nfse; ver [SERIES-002](../fiscal/regras/SERIES-002.md)).

## Alternativas consideradas
- **Gerar uma nova DPS no reenvio.** Rejeitada: arrisca duplicar a nota e perde a reconciliação por Id.
- **Tratar timeout como falha e reenviar.** Rejeitada: contraria a premissa do projeto.

## Consequências
- O adapter de Teresina, se vier, vira um perfil novo mais as validações locais (`cTribMun` obrigatório).
- Pendências a confirmar no Swagger da SEFIN, com certificado real:
  - prefixo de caminho (`/SefinNacional` ou `/API/SefinNacional`);
  - nome exato do campo do envelope;
  - schema de erro.
  - Até lá, esses valores existem só no perfil e no simulador, e ficam marcados como provisórios.

## Fontes
[Diagnóstico](../fiscal/nfse-teresina-api-municipal-x-nacional.md) §1.3, §3.2–3.4, §8 e §9.1.
