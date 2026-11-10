// Gera os segredos LOCAIS de desenvolvimento em secrets/ (ignorado pelo git).
// Em produção, cada segredo é um arquivo montado pelo Coolify só no container que precisa dele
// (docs/runbooks/kek-certificados.md): a KEK privada NUNCA vai para o container da API.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';

mkdirSync('secrets', { recursive: true });

const pepper = 'secrets/api-key-pepper';
if (existsSync(pepper)) {
  process.stdout.write(`${pepper} já existe (não sobrescrito: trocar o pepper invalida todas as API keys)\n`);
} else {
  writeFileSync(pepper, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  process.stdout.write(`${pepper} criado\n`);
}

const kekPublic = 'secrets/certificate-kek-public.pem';
const kekPrivate = 'secrets/certificate-kek-private.pem';
if (existsSync(kekPublic) || existsSync(kekPrivate)) {
  process.stdout.write('KEK de certificados já existe (não sobrescrita: trocar a KEK torna ilegíveis os certificados já enviados)\n');
} else {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(kekPrivate, privateKey, { mode: 0o600 });
  writeFileSync(kekPublic, publicKey, { mode: 0o644 });
  process.stdout.write(`${kekPublic} e ${kekPrivate} criados (somente desenvolvimento)\n`);
}
