#!/usr/bin/env node
/**
 * Make the value for the ADMIN_PASSWORD_HASH environment variable.
 *   node scripts/hash-password.mjs
 * (Or open /admin/setup.html in a browser - it does the same thing locally without Node.)
 * The password itself is never written anywhere; only this one-way hash goes into Netlify.
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question('Choose an admin password (12+ characters): ', (pw) => {
  rl.close();
  if (!pw || pw.length < 12) { console.error('Use at least 12 characters.'); process.exit(1); }
  const iterations = 310000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(pw, salt, iterations, 32, 'sha256');
  console.log('\nADMIN_PASSWORD_HASH =');
  console.log(`pbkdf2-sha256$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`);
  console.log('\nSESSION_SECRET = (any long random value, e.g.)');
  console.log(randomBytes(32).toString('base64url'));
});
