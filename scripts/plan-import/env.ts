import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** Only server settings; never pass this environment to a browser build. */
export function loadImportEnv() {
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    const values = parseEnv(readFileSync(file, 'utf8'));
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']) {
      if (process.env[key] === undefined && values[key]) process.env[key] = values[key];
    }
  }
}
