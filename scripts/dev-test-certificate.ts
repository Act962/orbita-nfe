// Gera um e-CNPJ A1 FICTÍCIO (PKI de teste) e o bundle de ACs de teste, só para desenvolvimento.
// Uso: node --import tsx scripts/dev-test-certificate.ts <cnpj> <senha>
// Saída: secrets/dev-test-certificate.pfx e secrets/trust-bundle.pem (ignorados pelo git).
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { createTestIcpPki } from '../test/support/icp-test-pki.js';

const [cnpj, password] = process.argv.slice(2);
if (cnpj === undefined || password === undefined) {
  process.stderr.write('uso: dev-test-certificate <cnpj> <senha>\n');
  process.exit(1);
}
const pki = createTestIcpPki();
writeFileSync('secrets/dev-test-certificate.pfx', pki.pfx({ cnpj, password }), { mode: 0o600 });
writeFileSync('secrets/trust-bundle.pem', pki.trustBundlePem);
process.stdout.write('secrets/dev-test-certificate.pfx e secrets/trust-bundle.pem criados (PKI fictícia de teste)\n');
