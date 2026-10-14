#!/usr/bin/env node
import { validateRequiredBootEnv } from './lib/boot-env.mjs';

try {
  validateRequiredBootEnv();
  console.log('check-env: ok (non-secret auth config; vault credentials are loaded at boot)');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
