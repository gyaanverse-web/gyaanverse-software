import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    // Tests share a DB; truncate-between-tests is incompatible with parallelism.
    fileParallelism: false,
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true },
    },
    testTimeout: 15000,
    hookTimeout: 30000,
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@modules': resolve(__dirname, 'src/modules'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@middleware': resolve(__dirname, 'src/middleware'),
      '@config': resolve(__dirname, 'src/config'),
    },
  },
})
