# ADR-0044 — Tomador no exterior e exportação de serviço

- Status: **Aceito** · Data: 2026-11-23
- Relacionados:
  - ADR-0018 (o motor não decide a tributação);
  - ADR-0037 (regras do Anexo I no aceite);
  - ADR-0040 (contrato v2: endereço nacional e intermediário).

## Contexto
O contrato só identificava tomador e intermediário por CNPJ ou CPF, com endereço nacional. A exportação de serviço (`tribISSQN` = 3) já era aceita, mas sem os grupos que o Anexo I exige para ela.

## Fontes
XSD v1.01 dos dois pacotes, **iguais** nestes grupos:
- **`TCInfoPessoa`:** choice CNPJ | CPF | **NIF** (1–40) | **cNaoNIF** (0, 1, 2), CAEPF?, IM?, xNome, end?, fone?, email?.
  - Na produção restrita, o `xNome` é opcional; o contrato sempre o exige.
- **`TCEndereco`:** choice endNac | **endExt**, seguida de xLgr, nro, xCpl?, xBairro.
  - `endExt` é `TCEnderExt`: cPais (ISO2), cEndPost (1–11), xCidade (1–60), xEstProvReg (1–60).
- **`TCServ`:** locPrest, cServ, **comExt?**, obra?, atvEvento?, infoCompl?.
- **`TCComExterior`:** mdPrestacao, vincPrest, tpMoeda (3 dígitos), vServMoeda, mecAFComexP, mecAFComexT, movTempBens, nDI?, nRE? e mdic. As enumerações vêm do XSD.
- **`TCTribMunicipal`:** **cPaisResult?** (ISO2) logo depois de `tribISSQN`.

Anexo I, aba "RN DPS_NFS-e", dos dois ambientes. Hashes em [fontes oficiais](../fiscal/fontes-oficiais.md).

## Decisão
1. **Contrato.** Os acréscimos são opcionais, e quem já integra não muda nada.
   - **Documento:** `document.type` passa a aceitar também `NIF` (`value`) e `NO_NIF` (`reason`, o cNaoNIF).
   - **Endereço no exterior:** `address` aceita a forma nacional (contrato v2) ou a do exterior, reconhecida pela presença de `countryCode`.
   - **Comércio exterior:** `service.foreignTrade` (comExt), com `shareWithMdic` booleano.
   - **País do resultado:** `values.issqn.resultCountryCode` (cPaisResult).
   - Os valores, inclusive moeda, modo de prestação e mecanismos de apoio, são do contribuinte (ADR-0018).
2. **XML** na ordem do XSD, validado nos dois pacotes.
3. **Regras do aceite** ([NFSE-DPS](../fiscal/regras/NFSE-DPS.md)). Quando o texto difere entre os Anexos, cada ambiente segue o seu.
   - **Tomador no exterior:**
     - E0223: endereço no exterior exige NIF ou cNaoNIF.
     - E0226: cNaoNIF 0 não é aceito.
     - E0242: na produção, NIF exige endereço no exterior; na produção restrita, NIF **ou** cNaoNIF exigem.
     - E0246: país diferente de BR; na produção restrita, também diferente de ZZ, que não é aceito na Sefin Nacional (Obs. 2 do texto).
   - **Intermediário no exterior:** E0281, E0286, E0298 e E0299, com o mesmo texto nos dois Anexos.
   - **Comércio exterior:**
     - E0330: comExt é obrigatório com tomador ou intermediário no exterior e com exportação. O `cPaisPrestacao` não existe no contrato.
     - E0333, E0341, E0343, E0345: os valores "desconhecido" (0 ou 00) não são aceitos.
     - E0352, E0354, E0356: nDI e nRE conforme o `movTempBens`.
   - **Ajustes** nas regras que já existiam:
     - E0204 e E0264 passam a exigir CNPJ ou CPF, como o texto diz, e não apenas a presença do tomador ou do intermediário;
     - E0235 e E0237 passam a exigir o endereço **nacional**.
4. **Lacuna do contrato v2 corrigida.** Entram E1388 (intermediário com CNPJ exige endereço nacional) e E0293 (retenção pelo intermediário exige o endereço nacional dele), com o mesmo texto nos dois Anexos.
   - Até aqui, a DPS com intermediário por CNPJ e sem endereço era aceita e iria para o autorizador.
5. **Fora do aceite**, com o motivo no catálogo:
   - existência do país na tabela ISO2: o motor só confere o BR e o ZZ;
   - E0590 e E0591 (`cPaisResult` conforme a incidência da LC 116/03);
   - E0529 e E0530 (cenários da planilha de exportação);
   - E0222, E0224, E0280, E0284: tratam de `tpEmit` 2 ou 3, e o motor sempre emite como prestador.
6. **Ficam para depois:** prestação no exterior (`cPaisPrestacao` em `locPrest`), importação de serviço (E0331, que não se aplica com `tpEmit` 1) e IBS/CBS.

## Consequências
- A nota de exportação para tomador no exterior passa a ser aceita e montada. O teste de ponta a ponta mostra NIF, endExt, comExt e cPaisResult no XML assinado, válido no XSD.
- **Mudança de comportamento (correção):** DPS com intermediário por CNPJ sem endereço nacional, ou com retenção pelo intermediário sem esse endereço, passa a ser recusada no aceite (E1388, E0293). Antes, seria rejeitada pelo autorizador. O changelog registra a mudança.
