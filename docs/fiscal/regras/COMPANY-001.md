# COMPANY-001 — Estabelecimento pertence à raiz do CNPJ da empresa

- Implementação: `src/modules/company/domain/company.ts` (`newEstablishment`) · Testes: `company.test.ts`, `test/integration/company-api.test.ts`, matriz de isolamento
- Status: implementada.

## Regra
Uma empresa é o contribuinte identificado pela **raiz do CNPJ** (8 primeiras posições). Todo estabelecimento (matriz ou filial) cadastrado na empresa precisa ter CNPJ com essa mesma raiz. Caso contrário: `422 ESTABLISHMENT_ROOT_MISMATCH`.

## Origem
- Estrutura do CNPJ (raiz de 8 posições + ordem do estabelecimento de 4 posições + 2 DV): regra [CNPJ-001](CNPJ-001.md), IN RFB nº 2.229/2024.
- O vínculo empresa = raiz é decisão de modelagem do motor (docs/architecture/02 §2), não regra fiscal. Serve também como defesa contra *CNPJ spoofing* (docs/architecture/14 §B4, teste 7): um cliente não cadastra na sua empresa um CNPJ de outra empresa.

## Limitação conhecida
Grupos econômicos com raízes diferentes viram empresas diferentes; a mesma aplicação recebe concessão para cada uma.
