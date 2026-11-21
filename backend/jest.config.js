/** @type {import('jest').Config} */
const tsJest = ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }];

const common = {
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': tsJest },
  setupFiles: ['<rootDir>/tests/helpers/setupEnv.ts'],
  clearMocks: true,
  restoreMocks: true,
};

module.exports = {
  collectCoverageFrom: ['src/**/*.ts', '!src/server.ts', '!src/db/cli/**', '!src/**/index.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'lcov', 'json-summary'],
  coverageThreshold: {
    global: { branches: 70, functions: 80, lines: 80, statements: 80 },
  },
  projects: [
    { ...common, displayName: 'unit', testMatch: ['<rootDir>/tests/unit/**/*.test.ts'] },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      // Real PostgreSQL only for the integration project.
      globalSetup: '<rootDir>/tests/helpers/globalSetup.mjs',
      globalTeardown: '<rootDir>/tests/helpers/globalTeardown.mjs',
      setupFilesAfterEnv: ['<rootDir>/tests/helpers/integrationTimeout.ts'],
    },
  ],
};
