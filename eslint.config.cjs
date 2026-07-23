const eslint = require('@eslint/js');
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      '.homeybuild/**',
      'build/**',
      'node_modules/**',
    ],
  },
  eslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      'no-undef': 'off',
    },
  },
  {
    files: ['api.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['settings/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['tests/*.test.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
];
