import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', env: { ANTHROPIC_API_KEY: '' }, include: ['server/**/*.test.ts', 'scripts/plan-import/**/*.test.ts'] } });
