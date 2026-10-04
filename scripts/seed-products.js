// PRD-6: cross-platform launcher for the product-catalog seed.
//
// Plain JS so npm scripts do not need shell-specific env-var syntax or a
// dotenv dependency. It:
//   1. Loads a local `.env` if present (Node ≥ 21.7 built-in — no dep).
//   2. Registers ts-node in transpile-only mode with an explicit rootDir so
//      TS5011 ("common source directory") does not fire when the seed module
//      imports a sibling under src/ (base tsconfig.json intentionally has no
//      rootDir so tsc/build and lint/test can each set their own).
//   3. Requires the TypeScript entry and calls its exported `main()`. (The
//      entry only self-invokes when it is the program entry point, i.e. the
//      compiled `node dist/seed/seed-products.js` path used inside the
//      container.)

try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional — CI and Docker set env vars directly.
}

require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { rootDir: '.', module: 'commonjs' },
});

const { main } = require('../src/seed/seed-products');
main().catch((err) => {
  console.error('[seed-products] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
