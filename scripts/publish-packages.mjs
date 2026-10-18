import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = root.version.includes('-') ? 'next' : 'latest';
const dryRun = process.argv.includes('--dry-run');

for (const workspace of ['@kerros/schema', '@kerros/viewer', '@kerros/editor', '@kerros/server']) {
  const args = ['publish', '--workspace', workspace, '--access', 'public', '--tag', tag];
  if (dryRun) args.push('--dry-run');
  else args.push('--provenance');
  console.log(`${dryRun ? 'Checking' : 'Publishing'} ${workspace}@${root.version} with the ${tag} tag.`);
  execFileSync('npm', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_cache: join(tmpdir(), 'kerros-npm-cache'),
    },
  });
}
