#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DeepbaseSecure } from '../src/shared/deepbase-secure';

const TINYCLAW_DIR = join(process.cwd(), '.tinyclaw');
const ENCRYPTION_KEY_PATH = join(TINYCLAW_DIR, '.encryption_key');
const ENV_PATH = join(TINYCLAW_DIR, '.env');
const SECRETS_DB_PATH = join(TINYCLAW_DIR, 'db', 'secrets.json');

async function main() {
  console.log('🔐 Migrating API keys to encrypted storage...');

  // Read encryption key
  const encryptionKey = readFileSync(ENCRYPTION_KEY_PATH, 'utf-8').trim();
  console.log('✅ Loaded encryption key');

  // Initialize encrypted DB
  const secretsDb = new DeepbaseSecure({
    encryptionKey,
    path: SECRETS_DB_PATH
  });

  // Read .env file
  const envContent = readFileSync(ENV_PATH, 'utf-8');
  const envLines = envContent.split('\n').filter(line => line.trim() && !line.startsWith('#'));

  const keys: Record<string, string> = {};
  for (const line of envLines) {
    const [key, ...valueParts] = line.split('=');
    const value = valueParts.join('=').trim();
    if (key && value) {
      keys[key] = value;
    }
  }

  console.log(`📦 Found ${Object.keys(keys).length} API keys in .env`);

  // Save to encrypted DB
  for (const [key, value] of Object.entries(keys)) {
    await secretsDb.set('secrets', key, { value });
    console.log(`✅ Migrated ${key}`);
  }

  console.log('\n✨ Migration complete!');
  console.log('🔒 API keys are now stored encrypted in:', SECRETS_DB_PATH);
  console.log('🔑 Encryption key is stored in:', ENCRYPTION_KEY_PATH);
  console.log('\n⚠️  IMPORTANT: Backup your encryption key! Without it, the secrets cannot be decrypted.');
}

main().catch(console.error);
