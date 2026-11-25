# ADR-0060 — ANEXO_A do Sistema Nacional: municípios e países no aceite

- Status: **Aceito** · Data: 2026-11-25 (download autorizado pelo responsável)
- Relacionados:
  - ADR-0058, que fica complementado: municípios pelo IBGE e o risco do ANEXO_A;
  - ADR-0037 e o catálogo [NFSE-DPS](../fiscal/regras/NFSE-DPS.md);
  - ADR-0044 e ADR-0045 (exterior).

## Contexto
As regras do Anexo I sobre localidades citam a planilha "ANEXO_A-MUNICIPIO_IBGE-PAISES_ISO2-SNNFSe". Ela foi baixada em 25/11/2026 da "Documentação Atual" do Portal da NFS-e, na versão v1.00 de 10/12/2025. A produção restrita não publica um ANEXO_A próprio.
- **Abas:** `TAB.MUN_IBGE` (5.570 municípios), `TAB.PAÍS_ISO2` (250 países, inclusive `ZZ`, "Município não possui a informação no sistema próprio") e `TAB.LOC.GERAL` (`0000000`, "ÁGUAS MARÍTIMAS").
- **Regras que a citam:** E0246 (tomador), E0299 (intermediário) e E0304 (prestação no exterior): o país "deve existir e ser diferente de Brasil (BR), conforme a tabela ISO2". A E0302 cita os municípios.

Comparado com a tabela do IBGE do ADR-0057:
- O ANEXO_A não tem o 5101837 (Boa Esperança do Norte-MT), instalado depois da v1.00.
- 17 municípios têm nome antigo no ANEXO_A (ex.: 2401305 "Augusto Severo", hoje "Campo Grande").

## Decisão
1. **Países:** E0246, E0299 e E0304 passam a conferir a existência na tabela ISO2 do ANEXO_A, além de "≠ BR". Não são mais parciais.
   - O `ZZ` existe na tabela: a produção o aceita, e a produção restrita continua recusando, pela Obs. 2 da E0246.
2. **Municípios (E0238, E0294, E0302):** o código existe se estiver no ANEXO_A **ou** na tabela atual do IBGE. A recusa local só acontece quando nenhuma das duas fontes conhece o código. Assim o motor não recusa um município real que o autorizador possa já ter, como o 5101837.
3. **Nomes no DANFSe** continuam vindo do IBGE (nome atual), como a NT 008 pede ("Tabela do IBGE").
4. **Arquivos versionados com hash conferido na carga** (ADR-0013), em `resources/fiscal/nfse-anexo-a/`:
   - a planilha original;
   - a tabela gerada por `scripts/anexo-a.mjs`, sem alterar códigos nem nomes;
   - o `MANIFEST.json`.
5. **Fora:** `cPaisResult` (E0590, E0591) continua com o autorizador, porque depende da incidência do serviço.

## Consequências
- País inexistente no exterior passa a ser recusado antes de numerar, com o mesmo código que o autorizador daria.
- Ao sair uma versão nova do ANEXO_A, gerar o arquivo novo com o script, registrar o hash e trocar o nome em `src/main/fiscal-resources.ts`.
