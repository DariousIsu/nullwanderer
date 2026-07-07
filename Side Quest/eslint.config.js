/* ESLint flat config — a STANDING GUARD against the bug classes this codebase actually hit:
 *   • no-use-before-define (variables) → catches the TDZ bug (a `let` used above its declaration,
 *     e.g. the `qv: userQv` regression) that `node --check` and unit smokes both miss.
 *   • no-undef → catches typos / undeclared references.
 *   • no-unused-vars (warn) → dead references, non-blocking.
 * Deliberately minimal: this is a correctness guard, not a style overhaul. Run: npm run lint
 */
const globals = require('globals');

const NODE_GLOBALS = {
  ...globals.node,
  fetch: 'readonly', AbortController: 'readonly', TextDecoder: 'readonly',
  TextEncoder: 'readonly', URL: 'readonly', structuredClone: 'readonly',
};
const RULES = {
  'no-use-before-define': ['error', { functions: false, classes: false, variables: true }],
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
};

module.exports = [
  { ignores: ['node_modules/**', 'renderer/vendor/**', 'data/**', 'recipes/**'] },
  {
    files: ['lib/**/*.js', 'scripts/**/*.js', 'studio/**/*.js', 'main.js', 'preload.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...NODE_GLOBALS, window: 'readonly' } },
    rules: RULES,
  },
  {
    files: ['renderer/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser } },
    rules: RULES,
  },
  {
    // esbuild ESM entry files (bundled → renderer/vendor/*.bundle.js): real ES modules, browser-targeted.
    // They mix `import` (bundled deps) with `require` (our own CommonJS libs), which esbuild resolves.
    files: ['scripts/*_entry.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser, require: 'readonly' } },
    rules: RULES,
  },
];
