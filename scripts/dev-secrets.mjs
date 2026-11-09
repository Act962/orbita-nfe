// Gera os segredos LOCAIS de desenvolvimento em secrets/ (ignorado pelo git).
// Em produção, cada segredo é um arquivo montado pelo Coolify só no container que precisa dele.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';

mkdirSync('secrets', { recursive: true });
const path = 'secrets/api-key-pepper';
if (existsSync(path)) {
  process.stdout.write(`${path} já existe (não sobrescrito: trocar o pepper invalida todas as API keys)\n`);
} else {
  writeFileSync(path, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  process.stdout.write(`${path} criado\n`);
}
