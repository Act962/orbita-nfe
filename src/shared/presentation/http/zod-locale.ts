import { z } from 'zod';

let configured = false;

/** Mensagens de validação do Zod em português do Brasil (idempotente; configuração global do processo). */
export function configureZodLocale(): void {
  if (configured) return;
  z.config(z.locales.ptBR());
  configured = true;
}
