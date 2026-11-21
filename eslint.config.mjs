import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.embedded-pg/**',
      '.claude/**',
      'frontend/vite.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    files: ['backend/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      // Architecture guard: controllers stay HTTP-only (no SQL / DB access).
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pg', 'ioredis', '**/infrastructure/**'],
              message: 'Use services/repositories; layers must not skip each other.',
            },
          ],
        },
      ],
    },
  },
  {
    // Only composition root, infrastructure, repositories, db tooling, middlewares and tests may touch drivers.
    files: [
      'backend/src/infrastructure/**',
      'backend/src/repositories/**',
      'backend/src/db/**',
      'backend/src/container.ts',
      'backend/src/middlewares/errorHandler.ts',
      'backend/tests/**',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['backend/**/*.js', 'backend/**/*.mjs'],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['backend/tests/**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['frontend/**/*.cjs'],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  prettier,
);
