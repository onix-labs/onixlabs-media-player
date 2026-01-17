import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

const commonRules = {
  '@typescript-eslint/typedef': [
    'error',
    {
      arrayDestructuring: true,
      objectDestructuring: true,
      arrowParameter: true,
      parameter: true,
      propertyDeclaration: true,
      memberVariableDeclaration: true,
      variableDeclaration: true,
      variableDeclarationIgnoreFunction: false,
    },
  ],
  '@typescript-eslint/explicit-function-return-type': [
    'error',
    {
      allowExpressions: false,
      allowTypedFunctionExpressions: false,
      allowHigherOrderFunctions: false,
    },
  ],
  '@typescript-eslint/explicit-member-accessibility': [
    'error',
    {
      accessibility: 'explicit',
      overrides: {
        constructors: 'no-public',
      },
    },
  ],
  '@typescript-eslint/prefer-readonly': 'error',
  '@typescript-eslint/no-inferrable-types': 'off',
};

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'electron/dist/**', '**/*.d.ts'],
  },
  // Electron files - disable prefer-readonly-parameter-types for Node.js APIs
  {
    files: ['electron/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        sourceType: 'module',
        project: ['./electron/tsconfig.json'],
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...commonRules,
      // Disable for electron files - Node.js APIs use mutable types extensively
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
    },
  },
  // Angular/src files - also disable prefer-readonly-parameter-types for DOM/Angular APIs
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        sourceType: 'module',
        project: ['./tsconfig.app.json', './tsconfig.spec.json'],
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...commonRules,
      // Disable for Angular files - DOM APIs and Angular types use mutable types extensively
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
    },
  },
];
