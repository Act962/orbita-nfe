# ADR-0061 — Inscrição municipal no cadastro do estabelecimento (só cadastro)

- Status: **Aceito** · Data: 2026-11-25 (decisão do responsável: "só cadastrar, sem preencher")
- Relacionados:
  - ADR-0027 (convenções de cadastro inspiradas na NFE.io);
  - docs/architecture/04 (modelo de domínio, `municipalRegistration`);
  - contrato da DPS v1 (`provider.municipalRegistration` → `prest/IM`).

## Contexto
O roadmap pedia a inscrição municipal (IM) como dado do estabelecimento. A IM do prestador vai na DPS (`prest/IM`, tipo `TSInscMun`), e o Anexo I tem regras que a conferem contra o cadastro do município e o CNC.

Preencher a IM sozinho mudaria o conteúdo fiscal enviado ao autorizador. Uma nota que hoje sai sem IM passaria a sair com ela, e as regras de IM do Anexo I passariam a valer para ela. Isso é decisão do contribuinte e do contador, não técnica.

## Decisão
1. **`municipalRegistration` no estabelecimento**, opcional:
   - informada no cadastro (`POST /v1/establishments`);
   - alterada ou apagada (`null`) em `PATCH /v1/establishments/{id}`, que só aceita esse campo, com o escopo `companies:manage`;
   - devolvida na consulta.
2. **Formato** do `TSInscMun`, igual nos dois pacotes: de 1 a 15 caracteres, sem os espaços das pontas. Fora disso, `400 VALIDATION_FAILED`. O banco tem o mesmo limite (migration 0036).
3. **A IM do cadastro NÃO entra na DPS.** Na emissão, a IM do prestador continua sendo só a que o cliente envia em `provider.municipalRegistration`.
4. **Auditoria:** a alteração é registrada como `establishment.municipal_registration_changed`, com o valor anterior e o novo. Repetir o mesmo valor não gera registro.
5. A rota entrou na matriz de isolamento: em outra empresa responde `404 ESTABLISHMENT_NOT_FOUND`.

## Consequências
- Os sistemas clientes (Orbita, NERP) passam a ter um lugar único para a IM, sem mudar nada no que vai ao órgão.
- Para que o motor preencha a IM na DPS, será preciso outro ADR, com a decisão do contador e as regras de IM do Anexo I estudadas.
