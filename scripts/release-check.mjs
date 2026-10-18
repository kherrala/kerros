import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const workspaces = ['schema', 'viewer', 'editor', 'server'];
const manifests = workspaces.map(workspace => ({
  workspace,
  path: `packages/${workspace}/package.json`,
  value: JSON.parse(readFileSync(`packages/${workspace}/package.json`, 'utf8')),
}));

const fail = message => {
  throw new Error(`Release check failed: ${message}`);
};

if (!root.private) fail('the workspace root must remain private');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(root.version)) fail(`invalid version ${root.version}`);

for (const { workspace, path, value } of manifests) {
  if (value.version !== root.version) fail(`${path} is ${value.version}; expected ${root.version}`);
  if (value.private) fail(`${path} is private`);
  if (value.name !== `@kerros/${workspace}`) fail(`${path} has unexpected name ${value.name}`);
  if (value.publishConfig?.access !== 'public') fail(`${path} does not publish with public access`);
  if (value.publishConfig?.registry !== 'https://registry.npmjs.org/') fail(`${path} targets another registry`);
  for (const file of ['README.md', 'LICENSE'])
    if (!existsSync(resolve(`packages/${workspace}`, file))) fail(`${path} does not ship ${file}`);
  const visit = target => {
    if (typeof target === 'string' && !existsSync(resolve(`packages/${workspace}`, target)))
      fail(`${value.name} export target does not exist: ${target}`);
    if (target && typeof target === 'object') for (const nested of Object.values(target)) visit(nested);
  };
  visit(value.exports);
}

const changelog = readFileSync('CHANGELOG.md', 'utf8');
if (!changelog.includes(`## [${root.version}]`)) fail(`CHANGELOG.md has no ${root.version} entry`);

const releaseTag = process.env.GITHUB_REF_NAME;
if (releaseTag && process.env.GITHUB_EVENT_NAME === 'release' && releaseTag !== `v${root.version}`)
  fail(`release tag ${releaseTag} does not match v${root.version}`);

console.log(`Release metadata is consistent for ${manifests.map(({ value }) => value.name).join(', ')} at ${root.version}.`);
