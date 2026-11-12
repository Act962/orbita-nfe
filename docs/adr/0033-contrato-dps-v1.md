# ADR-0033 — Contrato v1 da DPS na API e preparador real

- Status: **Aceito** · Data: 2026-11-12
- Relacionados: ADR-0013 (schemas por ambiente), ADR-0014 (assinatura), ADR-0018 (o motor não decide tributação), ADR-0026 (convenções da API), ADR-0032 (núcleo da emissão)

## Contexto
O núcleo da emissão (ADR-0032) já aceita, transmite e reconcilia, mas não tinha rota na API nem montava o XML real. Os XSD oficiais estão versionados.

A comparação dos dois pacotes mostrou que eles **não têm a mesma estrutura**:
- no pacote da produção restrita (20/10/2026), `finNFSe` é obrigatório em `infDPS`;
- `xDescServ` vai para o fim de `cServ`;
- o nome do tomador deixa de ser obrigatório.

## Decisão
1. **Contrato v1 (JSON) com um campo por elemento do XSD.** A tabela, com a origem de cada campo, está em [contrato-dps-v1.md](../fiscal/contrato-dps-v1.md). Cobre:
   - competência, regime do prestador e tomador (CNPJ/CPF, nome, IM e e-mail);
   - local, códigos e descrição do serviço;
   - valor, ISSQN (tributação, retenção e alíquota) e totais aproximados (Lei 12.741/2012).

   Ficam para versões seguintes: endereço, intermediário, comércio exterior, obra, evento, deduções, tributos federais e o grupo IBS/CBS.
2. **Valores fiscais vêm do cliente.** O contrato valida só formato e enumeração, copiados dos tipos simples do XSD.
   - O motor não escolhe opção do Simples, regime, código de tributação, alíquota nem retenção.
   - Regras condicionais entre campos (L3) ficam a cargo do autorizador até serem catalogadas com fonte.
3. **Valores fixos que o motor preenche**, com a justificativa de cada um:

   | Campo | Valor | Justificativa |
   |---|---|---|
   | `tpAmb` | ambiente da credencial | 1 = Produção, 2 = Homologação (TSTipoAmbiente) |
   | `tpEmit` | `1` | O motor emite como prestador |
   | `finNFSe` | `0` | Só no pacote que exige; é a única enumeração existente ("NFS-e regular") |
   | `cLocEmi` e `CNPJ` do prestador | do Id da DPS | O Id foi montado no aceite a partir do estabelecimento |
   | `dhEmi` | UTC−03:00 | **Provisório**, ver item 4 |
4. **`dhEmi` em horário de Brasília (UTC−03:00).** O XSD aceita qualquer fuso de −11 a +12 h. O fuso esperado para emitentes de outros fusos será confirmado na produção restrita.
5. **Montagem por perfil de leiaute** (`LAYOUT_PROFILES`), indexado pelo id do pacote.
   - Pacote sem perfil não monta (`LAYOUT_NOT_SUPPORTED`, falha local).
   - Texto do cliente é sempre escapado: um teste prova que uma tentativa de injeção de XML continua texto.
6. **Duas validações no XSD:**
   - **No aceite (API):** XML com identificadores provisórios, sem assinatura, fora da transação, porque leva cerca de 200 ms e não pode segurar a trava da série. Se falhar, a resposta é **400 `VALIDATION_FAILED`** com `issues[].code = DPS_SCHEMA_INVALID`, antes de numerar.
   - **No worker:** XML real assinado, no XSD do ambiente. É essa validação que vale; falha aqui vira `FAILED` com `DPS_SCHEMA_INVALID`.
7. **Rotas:**
   - `POST /v1/service-invoices`:
     - `Idempotency-Key` obrigatório;
     - 202 com `Location`, ou 200 na repetição idempotente;
     - o hash do pedido inclui o ambiente.
   - `GET /v1/service-invoices/{id}`: devolve 404 para nota de outra aplicação **ou de outro ambiente**. Uma credencial `test` não enxerga notas de produção.
8. **Worker-fiscal:** `NFSE_GATEWAY=none` (padrão) ou `simulator`.
   - A configuração recusa o simulador em produção.
   - O adapter real da SEFIN entra quando houver o certificado A1 real (R-33).
9. **Imagem:** `resources/fiscal` vai para a imagem. A API e o worker conferem os SHA-256 dos XSD na subida.

## Consequências
- Emissão de ponta a ponta testável sem órgão nenhum: HTTP, XML real, assinatura, XSD oficial e simulador.
- Mudança de leiaute exige um perfil novo e testes contra o XSD do pacote novo. Isso é intencional.
- Contrato v1 limitado: clientes com tomador estrangeiro, obra, dedução ou IBS/CBS precisam esperar a v2.
