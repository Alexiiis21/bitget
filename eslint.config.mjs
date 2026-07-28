import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['out/**', 'release/**', 'dist/**', 'node_modules/**', 'coverage/**', 'docs/**']
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  /* ---------------- proceso principal y preload ---------------- */
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }]
    }
  },

  /* ---------------- renderer ---------------- */
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module', ecmaFeatures: { jsx: true } }
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',

      /*
       * Frontera de seguridad: el renderer no puede tocar Node ni el sistema de
       * archivos. Todo pasa por el contrato de IPC. Ver docs/01 seccion 2.
       */
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'El renderer solo habla por window.pcb (preload).' },
            { name: 'fs', message: 'El renderer no accede a disco.' },
            { name: 'node:fs', message: 'El renderer no accede a disco.' },
            { name: 'undici', message: 'Toda la red vive en el proceso principal.' },
            { name: 'ws', message: 'Toda la red vive en el proceso principal.' }
          ],
          patterns: [
            { group: ['@main/*'], message: 'El renderer no importa codigo del proceso principal.' }
          ]
        }
      ]
    }
  },

  /* ---------------- pruebas ---------------- */
  {
    files: ['test/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-console': 'off' }
  },

  /* ---------------- archivos de configuracion ---------------- */
  {
    files: ['*.config.{ts,js}', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' }
  }
);
