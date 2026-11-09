# CNPJ-001 — Formato e dígitos verificadores do CNPJ (numérico e alfanumérico)

- Implementação: `src/shared/domain/cnpj.ts` · Testes: `src/shared/domain/cnpj.test.ts`
- Vigência: CNPJ alfanumérico a partir de julho/2026; CNPJ numérico continua válido.
- Fonte: Instrução Normativa RFB nº 2.229/2024 e orientação técnica da RFB sobre o cálculo do DV do CNPJ alfanumérico. **Pendente**: anexar link e versão do documento técnico oficial da RFB em `fontes-oficiais.md` e confirmar com o especialista fiscal (gate fiscal 1).

## Regra
1. 14 posições: 12 alfanuméricas (`A–Z`, `0–9`) + 2 dígitos verificadores **numéricos**.
2. Valor de cada caractere para o cálculo: código ASCII − 48 (`0..9` → 0..9; `A` → 17 … `Z` → 42).
3. DV1 sobre as 12 primeiras posições; DV2 sobre as 12 posições + DV1. Pesos 2 a 9 aplicados da direita para a esquerda, reiniciando em 2. Resto da soma por 11: se < 2, DV = 0; senão DV = 11 − resto.
4. Sequências com todos os caracteres iguais são rejeitadas (convenção de validação, não do cálculo).

## Normalizações do motor (não são regras fiscais)
- Remoção de `.`, `/`, `-` e espaços; letras convertidas para maiúsculas.

## Casos de teste de referência
| Entrada | Resultado |
|---|---|
| `12.ABC.345/01DE-35` | válido (exemplo publicado pela RFB) |
| `11.222.333/0001-81` | válido (exemplo numérico clássico) |
| `12ABC34501DE36` | DV inválido |
| `12ABC34501DEAB` | formato inválido (DV deve ser numérico) |

## Impactos a verificar
Chave de acesso de NF-e/NFC-e e leiautes DF-e com CNPJ alfanumérico: verificar NT específica (risco R-10).
