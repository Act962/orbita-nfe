---
title: Sandbox local (emissão de ponta a ponta com o simulador)
status: current
last_updated: 2026-11-25
---

# Sandbox local

Este roteiro sobe o motor inteiro nesta máquina e exercita a API como um cliente faria:
1. credencial de teste;
2. empresa, estabelecimento e série;
3. certificado A1;
4. emissão, consulta, XML e cancelamento.

O autorizador é o **simulador** (`NFSE_GATEWAY=simulator`): **nada sai para órgão nenhum** e a nota não tem validade fiscal. O certificado é um e-CNPJ **fictício**, de uma PKI de teste.

## O que é real e o que é simulado

| Parte | No sandbox |
|---|---|
| API HTTP, autenticação, escopos, isolamento da empresa, idempotência, `Prefer: wait` | real |
| Validação do contrato, regras do Anexo I, roteamento do canal | real |
| Montagem da DPS, assinatura XMLDSig e validação no XSD oficial | real |
| Cofre de certificados (KEK, validação contra as ACs do bundle) | real, com ACs **de teste** |
| Filas, outbox, webhooks e auditoria | real |
| Resposta do autorizador (autorização, número, chave de acesso, `cStat`) | **simulada** |

## Passo a passo

Faça os passos uma vez, na ordem:

1. **Prepare o ambiente** (uma vez; veja também o [README](../../README.md)):

   ```bash
   npm ci
   cp .env.example .env
   npm run dev:secrets
   docker compose -f docker/docker-compose.yml up -d
   npm run dev:object-storage
   npm run db:migrate
   ```

2. **Gere a credencial e o certificado fictício**, antes de subir o worker-fiscal:

   ```bash
   npm run sandbox -- init
   ```

   - Cria uma aplicação cliente e uma credencial de **teste**, pela CLI do operador (papel `fiscal_admin`).
   - A credencial tem os escopos do roteiro e nenhum de produção.
   - Gera o PFX fictício e **substitui** `secrets/trust-bundle.pem` pelas ACs de teste.
   - Tudo fica em `secrets/sandbox.json`, com permissão 0600 e fora do git. A chave nunca é impressa.

3. **Suba os três processos**, cada um no seu terminal:

   ```bash
   npm run dev:api
   npm run dev:worker-fiscal
   npm run dev:worker-general
   ```

4. **Cadastre pela API**:

   ```bash
   npm run sandbox -- setup
   ```

   Cria a empresa (raiz de CNPJ aleatória), a matriz em Teresina (2211001) e a série 1 de DPS em homologação. Depois envia o PFX e espera o worker-fiscal ativar o certificado.

5. **Emita, consulte e cancele**:

   ```bash
   npm run sandbox -- emit
   npm run sandbox -- get
   npm run sandbox -- cancel
   ```

   - `emit` usa `Prefer: wait=10` e uma `Idempotency-Key` nova. Ele mostra o status, a chave de acesso, o `authorizerStatus` e os `links`. O XML e o DANFSe (PDF) vão para `.local/sandbox/`.
   - `get` e `cancel` usam a última nota emitida; para outra, passe o id.

6. **Conferência automática de ponta a ponta**:

   ```bash
   npm run sandbox -- smoke
   ```

   Sobe um receptor de webhook em `127.0.0.1:3199` (mude com `SANDBOX_WEBHOOK_PORT`) e confere 13 passos. Para no primeiro que falhar, com código de saída 1:
   - validação sem efeitos;
   - recusa local da E0302 (município inexistente), antes de numerar;
   - emissão `201 AUTHORIZED` com `cStat` 100;
   - repetição com a mesma `Idempotency-Key`, que devolve a mesma nota;
   - mesma chave com outro corpo, que dá `IDEMPOTENCY_KEY_REUSED`;
   - consulta pela referência;
   - XML com `ETag` igual ao SHA-256;
   - DANFSe;
   - diagnóstico;
   - webhook da autorização com a assinatura conferida;
   - cancelamento `REGISTERED`, com a nota `CANCELLED` e o XML do evento;
   - webhook do cancelamento;
   - reenvio do aviso pela nota, com o mesmo `webhook-id`.

   A assinatura de webhook do smoke é criada uma vez. O segredo de teste fica em `secrets/sandbox.json`, nunca no terminal.

## Testar os seus dados

A DPS padrão tem valores **fictícios** (`test/support/dps-fixtures.ts`). Eles servem para exercitar o fluxo e o leiaute; não são enquadramento de ninguém.

Para testar uma nota com os seus dados, ou os do seu contador, grave o corpo da emissão num arquivo, sem `establishmentId`:

```bash
npm run sandbox -- emit --dps minha-nota.json
```

O contrato do corpo está em `/docs/` e no [guia rápido](../api/guia-rapido.md#7-emitir-nfs-e).

O que o simulador não confere:
- o cadastro do contribuinte;
- a parametrização do município;
- as regras que só o autorizador aplica.

Uma nota autorizada aqui pode ser rejeitada na homologação real.

## Usar a API diretamente

Com o `setup` feito, a documentação interativa está em `http://127.0.0.1:3000/docs/`.

A chave de teste está em `secrets/sandbox.json` (campo `apiKey`). Para chamar a API com `curl` ou Postman, leia a chave de lá. Não a copie para outro lugar nem para o histórico do terminal.

Toda rota de empresa exige `X-Company-Id` com o `companyId` do mesmo arquivo.

## Começar de novo

`npm run sandbox -- init --force` gera outra credencial e outro certificado. Depois, reinicie o worker-fiscal e rode o `setup`, que cria uma empresa nova. As empresas anteriores continuam no banco local.

## Travas

O roteiro recusa:
- `NODE_ENV=production`;
- uma API fora desta máquina: `SANDBOX_API_URL` só aceita `127.0.0.1`, `localhost` ou `[::1]`.

O simulador também é recusado em produção pela configuração do worker-fiscal.
