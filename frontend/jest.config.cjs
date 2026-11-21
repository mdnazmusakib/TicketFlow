/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json', diagnostics: false }],
    // react-router ships ESM only: compile it (and its deps) to CommonJS with Babel.
    '^.+\\.m?js$': [
      'babel-jest',
      {
        presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }]],
        plugins: [require.resolve('./tests/babelImportMetaStub.cjs')],
      },
    ],
  },
  // Separator-agnostic so it also matches Windows paths.
  transformIgnorePatterns: [
    '[/\\\\]node_modules[/\\\\](?!(react-router|@remix-run|cookie-es)[/\\\\])',
  ],
  moduleNameMapper: {
    '\\.(css)$': 'identity-obj-proxy',
    // import.meta.env is Vite-only; tests use a plain module instead.
    '^(.*)/config/env$': '<rootDir>/tests/mocks/env.ts',
  },
  setupFiles: ['<rootDir>/tests/polyfills.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setupTests.ts'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/main.tsx',
    '!src/config/env.ts',
    '!src/vite-env.d.ts',
  ],
  coverageReporters: ['text-summary', 'lcov'],
  coverageThreshold: {
    global: { branches: 70, functions: 80, lines: 80, statements: 80 },
  },
};
