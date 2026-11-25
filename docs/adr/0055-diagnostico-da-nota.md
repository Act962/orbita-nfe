# ADR-0055 — Diagnóstico da NFS-e pela API, com escopo próprio

- Status: **Aceito** · Data: 2026-11-24
- Relacionados:
  - ADR-0026 item 8 e doc 16 A13 (`include=` para depuração, com escopo próprio): **revisto aqui na forma**;
  - ADR-0012 (catálogo fechado de escopos);
  - ADR-0022 e ADR-0032 (tentativas de transmissão e write-ahead);
  - doc 12 (reconciliação).

## Contexto
Quando uma nota demora, fica em `UNKNOWN` ou é rejeitada, quem integra precisa saber o que aconteceu: quantas tentativas houve, se alguma chegou a sair, que código voltou, quantas consultas de reconciliação já foram feitas. Hoje isso só se vê no banco ou pela CLI do operador.

O ADR-0026 previa `include=attempts,events,protocol` na consulta da nota, com escopo próprio. A checagem de escopo do projeto é feita **por rota**, antes do handler (ADR-0012): é ali que o OpenAPI mostra o escopo e que a matriz de isolamento testa cada rota. Um escopo exigido só quando um parâmetro aparece ficaria fora desse mecanismo.

## Decisão
1. **Rota própria:** `GET /v1/service-invoices/{id}/diagnostics`, no lugar de `include=` na consulta. A consulta comum continua com o mesmo corpo.
2. **Escopo novo, `nfse:debug`.** Não implica nenhum outro, e `nfse:read` não o inclui. A credencial do sistema que emite não precisa tê-lo; a do suporte, sim.
3. **A mesma visibilidade da consulta:** nota de outra aplicação ou de outro ambiente responde 404 `SERVICE_INVOICE_NOT_FOUND`.
4. **Conteúdo: só metadados e códigos.**
   - `protocol`: canal, versão da tabela de roteamento, pacote de leiaute, SHA-256 da DPS assinada e do XML autorizado, data do arquivamento e da retenção;
   - `attempts`: cada tentativa de transmissão, com estado, resultado, código do resultado (nunca mensagem livre), horários e consultas de reconciliação;
   - `cancellations`: todos os pedidos de cancelamento da nota, com estado, envios, consultas e códigos.
   - **Nenhum XML e nenhum dado do tomador.** O XML tem as rotas próprias (ADR-0050).
5. **Nada novo no banco:** a API já lia as tentativas e os metadados dos pedidos.

## Consequências
- O ADR-0026 item 8 fica cumprido no objetivo (depuração com escopo próprio) com outra forma. Se o responsável preferir `include=` na consulta, a troca é só de apresentação.
- Os detalhes de rede (mensagem de erro do transporte, corpo da resposta do autorizador) continuam fora: só códigos estáveis saem do motor.
