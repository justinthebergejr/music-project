import tsParser from '@typescript-eslint/parser';

const noReact = {
  group: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  message:
    'core/** is plain TypeScript. React binds to core through features/ and useSyncExternalStore, never from inside core.',
};

// core/platform is the single sanctioned native seam: it owns invoke() and the Tauri
// path API. Every other directory under src/core must stay portable TypeScript.
const noTauri = {
  group: ['@tauri-apps', '@tauri-apps/*', '@tauri-apps/**'],
  message:
    'Only src/core/platform may import @tauri-apps/*. Put the native call behind a platform function.',
};

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
  },
  {
    files: ['src/core/**/*.{ts,tsx}'],
    ignores: ['src/core/platform/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [noReact, noTauri] }],
    },
  },
  {
    files: ['src/core/platform/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [noReact] }],
    },
  },
];