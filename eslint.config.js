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

  // No magic numbers - numeric literals should be assigned to named constants
  // Exceptions: common indices, percentages, angles, time, RGB, MIDI, and power-of-2 values
  '@typescript-eslint/no-magic-numbers': [
    'error',
    {
      ignore: [
        // Common indices and arithmetic
        -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16, 20, 24, 25, 30, 32, 36,
        // Common fractions and percentages (0.X)
        0.08, 0.12, 0.15, 0.18, 0.25, 0.3, 0.35, 0.375, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9,
        // Whole percentages and common dimensions
        40, 45, 48, 50, 51, 55, 60, 64, 65, 70, 75, 78, 80, 81, 85, 90, 95, 96, 100, 102,
        // RGB values, degrees, screen dimensions, MIDI values (sorted, no duplicates)
        111, 112, 115, 120, 123, 127, 128, 130, 144, 149, 150, 152, 155, 160, 161, 171, 173, 176, 179, 180, 184, 186,
        192, 200, 204, 206, 208, 210, 224, 239, 240, 243, 247, 255, 256, 270, 300, 320, 360,
        // HTTP status codes, screen dimensions, time values
        400, 403, 404, 413, 500, 512, 600, 640, 800, 1000, 1024, 2048, 4096, 5000, 10000, 30000, 32768, 65535, 1000000,
      ],
      ignoreArrayIndexes: true,
      ignoreDefaultValues: true,
      ignoreEnums: true,
      ignoreNumericLiteralTypes: true,
      ignoreReadonlyClassProperties: true,
      ignoreTypeIndexes: true,
    },
  ],
};

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'src/electron/dist/**', '**/*.d.ts'],
  },

  {
    files: ['src/electron/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...commonRules,
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
      // Disable rules that require type information for Electron files
      '@typescript-eslint/prefer-readonly': 'off',
    },
  },

  {
    files: ['src/angular/**/*.ts'],
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
