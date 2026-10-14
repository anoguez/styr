import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      '.claude/**',
      'resources/**/.claude-plugin/types/**'
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }]
    }
  },

  // `src/core/` and `src/host/` run outside Electron (the MCP server, and later `styr serve`), so
  // neither may import `electron` or reach into the Electron main process. Core is the lower layer
  // and never imports the host.
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: 'src/core/ must stay Electron-free.' }],
          patterns: [
            { group: ['@host/*', '**/host/*'], message: 'src/core/ must not import src/host/.' },
            { group: ['**/main/*'], message: 'src/core/ must not import src/main/.' }
          ]
        }
      ]
    }
  },
  {
    files: ['src/host/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: 'src/host/ must stay Electron-free: take what you need as a port.'
            }
          ],
          patterns: [{ group: ['**/main/*'], message: 'src/host/ must not import src/main/.' }]
        }
      ]
    }
  },

  {
    files: ['scripts/**/*.{js,mjs}', '*.config.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' }
  }
)
