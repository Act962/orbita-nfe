---
title: Versionamento e descontinuação
status: current
last_updated: 2026-11-11
---

# Versionamento e descontinuação

Política da API pública (ADR-0026, item 9). Vale para tudo sob `/v1`.

## O que muda sem aviso prévio (compatível)

Estas mudanças entram a qualquer momento e são registradas no [changelog](/guides/changelog.md):

- rota nova;
- campo novo **opcional** no corpo da requisição;
- campo novo na resposta;
- valor novo em um enum de **resposta**, como um status ou tipo de evento novo;
- `code` de erro novo;
- tipo de evento de webhook novo (só é entregue a quem assiná-lo).

**A sua integração precisa tolerar essas mudanças:** ignore campos desconhecidos e trate `code` desconhecido como erro genérico do mesmo status HTTP.

## O que exige nova versão (incompatível)

Estas mudanças só acontecem em um novo prefixo de caminho (`/v2`), que convive com o anterior:

- remover ou renomear campo, rota ou valor de enum de entrada;
- tornar obrigatório um campo que era opcional;
- mudar o tipo ou o significado de um campo;
- mudar o status HTTP de um caso que já existia.

## Descontinuação

Uma rota descontinuada continua funcionando até a data de `Sunset` e passa a responder com três headers:

```
Deprecation: @1798761600
Sunset: Sat, 01 Jul 2028 00:00:00 GMT
Link: </guides/changelog.md>; rel="deprecation"; type="text/markdown"
```

- `Deprecation` ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745)): desde quando a rota está descontinuada, em segundos Unix.
- `Sunset` ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)): a partir de quando a rota pode deixar de existir. **É sempre pelo menos 180 dias depois do anúncio.**
- `Link`: o guia de migração, publicado no changelog junto com a versão nova, com o mapa dos campos antigos para os novos.

No OpenAPI, a operação aparece com `deprecated: true`. Monitore o header `Deprecation` nas respostas para ser avisado automaticamente.
