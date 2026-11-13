# ADR-0037 — Regras do Anexo I conferidas no aceite da DPS

- Status: **Aceito** · Data: 2026-11-13
- Relacionados:
  - ADR-0018 (o motor valida, mas não decide política tributária);
  - ADR-0033 (contrato v1 da DPS);
  - ADR-0036 (substituição);
  - doc 14 §A1 (camadas L1 a L6).

## Contexto
Até aqui, o aceite conferia o contrato (L1, Zod), o XSD (L4) e o roteamento. As regras de negócio do Anexo I ficavam todas com o autorizador. Uma DPS que ele certamente rejeitaria consumia número e ia até a SEFIN para voltar `REJECTED`.

O doc 14 pede que cada regra L3 tenha ID, fonte, vigência, teste e documento, e que sem fonte a regra não entre.

## Decisão
1. **Catálogo versionado no domínio:** `domain/dps-rules.ts`, versão `anexo-i-v1.01-20260209+20261020`. Cada regra declara:
   - o código de rejeição do Anexo I;
   - os ambientes em que vale;
   - o campo do contrato;
   - uma mensagem que resume o texto oficial;
   - um predicado puro.
   - O documento é [NFSE-DPS](../fiscal/regras/NFSE-DPS.md): um catálogo por modalidade em vez de um arquivo por regra, com a tabela completa e o motivo de cada regra que ficou de fora.
2. **Critério de entrada:** nível 1 ou 2, dependência **só** da DPS e texto claro.
   - Ficam com o autorizador as que consultam cadastro, a parametrização do município ou tabelas que o motor não tem.
   - O motor não completa a regra com suposição.
3. **Um Anexo por ambiente.** `PRODUCTION` segue o Anexo de produção (09/02/2026) e `HOMOLOGATION` o de produção restrita (20/10/2026), a mesma separação dos pacotes XSD (ADR-0013).
   - A E0309 e a E0313 só existem na produção restrita.
   - A E0596 só existe na produção.
   - A E0532 muda de 99.01.01 para 99.XX.XX.
   - A E0592 tem texto ilegível na produção restrita (célula deslocada), então só vale na produção: **na dúvida, confere-se menos**.
4. **No aceite, antes de numerar**, logo depois do roteamento. Vale também na substituição.
   - O roteamento vem antes porque a recusa dele é mais específica. Exemplo: ME/EPP sem regime recebe `ROUTE_REGIME_REQUIRED`, que explica que o canal depende do regime, e não a E0166.
   - Todas as violações voltam de uma vez: `422 NFSE_RULES_VIOLATED`, com `issues[]` (`code` = código do Anexo, `field`, `message`, `ruleId: "NFSE-DPS"`).
   - Nada é gravado e nenhum número é consumido.
5. **E0015 e o relógio.** A competência não pode ser posterior à data do `dhEmi`, que o worker monta em UTC−03:00 no envio (ADR-0033 item 4). O aceite compara com a data de hoje no mesmo fuso.
   - Uma nota aceita às 23h59 e enviada depois da meia-noite continua válida, porque a data só avança.
6. **Lacunas do contrato v1 viram recusa local** com a regra oficial:
   - E0235: tomador por CNPJ exige o endereço nacional;
   - E0237: retenção pelo tomador exige o endereço;
   - E0264: retenção pelo intermediário exige o intermediário;
   - E0592: imunidade exige `tpImunidade`.
   - A mensagem diz que o caso depende do contrato v2. Isso torna urgente o contrato v2 (R-42).

## Alternativas consideradas
- **Deixar tudo com o autorizador.** Rejeitada: consome número, gasta uma ida à SEFIN e devolve ao cliente uma rejeição que o motor sabia que viria.
- **Implementar as regras que dependem de parametrização com valores "prováveis" de Teresina.** Rejeitada: seria inventar regra. Se o município mudar o parâmetro, o motor recusaria uma nota válida.
- **Um arquivo por regra em `docs/fiscal/regras/`.** Rejeitada para estas regras: são 35 linhas curtas da mesma fonte, e uma tabela com os critérios e as exclusões é mais fácil de revisar no gate fiscal.

## Consequências
- O cliente recebe na hora, com o campo, o que o autorizador rejeitaria, e o número não é consumido.
- Validar localmente não confere validade fiscal: o autorizador (L6) continua decidindo.
- Ao trocar o pacote de produção, os Anexos precisam ser confrontados de novo e os ambientes de cada regra ajustados.
- Com o contrato v1, só se emite sem tomador ou com tomador por CPF, sem retenção, e com tributação diferente de imunidade.
