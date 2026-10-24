import { defineConfig } from 'vitest/config';

// Manual real-account checks. Run explicitly:
//   E2E_MODE=backup E2E_BACKUP_DIR=<dir> npx vitest run --config vitest.e2e.config.ts
export default defineConfig({
  test: {
    include: ['test/**/*.e2e.ts'],
    testTimeout: 120_000,
    pool: 'forks',
  },
});
