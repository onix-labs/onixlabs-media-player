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
        constructors: 'explicit',
      },
    },
  ],

  '@typescript-eslint/prefer-readonly': 'error',
  '@typescript-eslint/no-inferrable-types': 'off',

  // Prefer getters/setters over parameterless methods
  '@typescript-eslint/prefer-getter-setter': 'error',

  // Optional: forbid getX() methods entirely
  '@typescript-eslint/naming-convention': [
    'error',
    {
      selector: 'method',
      format: ['camelCase'],
      filter: {
        regex: '^get[A-Z]',
        match: false,
      },
    },
  ],
};

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'electron/dist/**', '**/*.d.ts'],
  },

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
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
    },
  },

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
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
    },
  },
];
