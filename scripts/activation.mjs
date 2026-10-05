// Activation codes for multi-tenant mode's Super Admin tasks (docs/multi-tenant.md).
// For the maintainer, on their own machine:
//
//   node scripts/activation.mjs keygen <private-key-file>
//       Makes the Ed25519 key pair once. Keep the private key file safe and out of any
//       repository; the printed public key goes into ISSUER_KEYS in src/activation.js.
//
//   node scripts/activation.mjs issue <private-key-file> "<organisation>" <max-tenants> [months=12]
//       Prints a multi-tenant activation code for one organisation.
//
//   node scripts/activation.mjs lang <private-key-file> "<organisation>" he on|off [months=12]
//       Prints a Hebrew activation code ("on") or deactivation code ("off").
//
//   node scripts/activation.mjs show <code>
//       What a code says (without checking its signature).
import fs from 'node:fs';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

import { readCode } from '../src/activation.js';

const [command, ...args] = process.argv.slice(2);
const b64url = (data) => Buffer.from(data).toString('base64url');

function usage() {
  console.error('Usage:\n  keygen <private-key-file>\n  issue <private-key-file> "<organisation>" <max-tenants> [months]\n  lang <private-key-file> "<organisation>" he on|off [months]\n  show <code>');
  process.exit(2);
}

/** Sign a payload (expiry filled in) into an MZ1 code. */
function makeCode(key, payload, months) {
  const issued = new Date();
  const expires = new Date(issued);
  expires.setUTCMonth(expires.getUTCMonth() + Math.max(1, Number(months) || 12));
  const full = { v: 1, id: randomBytes(6).toString('hex'), issued: issued.toISOString(), expires: expires.toISOString(), ...payload };
  const head = `MZ1.${b64url(JSON.stringify(full))}`;
  return { code: `${head}.${b64url(sign(null, Buffer.from(head), key))}`, full };
}

if (command === 'keygen') {
  const [file] = args;
  if (!file) usage();
  if (fs.existsSync(file)) {
    console.error(`${file} already exists; not overwriting it.`);
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  fs.writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  console.log(`Private key written to ${file} (keep it safe; never commit it).`);
  console.log('Public key, for ISSUER_KEYS in src/activation.js:');
  console.log(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
} else if (command === 'issue') {
  const [file, org, max, months = '12'] = args;
  const maxTenants = Number(max);
  if (!file || !org || !Number.isInteger(maxTenants) || maxTenants < 2) usage();
  const key = createPrivateKey(fs.readFileSync(file));
  const { code, full } = makeCode(key, { org: org.trim(), scope: 'tenants', maxTenants }, months);
  console.log(code);
  console.error(`For ${full.org}: up to ${maxTenants} tenants, until ${full.expires.slice(0, 10)} (public key ${createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64').slice(-12)}).`);
} else if (command === 'lang') {
  const [file, org, langCode, onOff, months = '12'] = args;
  if (!file || !org || langCode !== 'he' || !['on', 'off'].includes(onOff)) usage();
  const key = createPrivateKey(fs.readFileSync(file));
  const action = onOff === 'on' ? 'activate' : 'deactivate';
  const { code, full } = makeCode(key, { org: org.trim(), scope: `lang:${langCode}`, action }, months);
  console.log(code);
  console.error(`For ${full.org}: Hebrew ${action === 'activate' ? 'ON' : 'OFF'}, until ${full.expires.slice(0, 10)}.`);
} else if (command === 'show') {
  const read = readCode(args[0]);
  if (!read) {
    console.error('Not an activation code.');
    process.exit(1);
  }
  console.log(JSON.stringify(read.payload, null, 2));
} else {
  usage();
}
