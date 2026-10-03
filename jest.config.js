/** @type {import('jest').Config} */
// @swc/jest handles both our TypeScript and Nest 12's ESM node_modules by
// emitting CJS-compatible output for everything. ts-jest struggled here because
// Nest 12 ships as `type: module` and its .js files use `export *`, which the
// default Jest CJS loader cannot execute.
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.(spec|test)\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          transform: { decoratorMetadata: true, legacyDecorator: true },
          target: 'es2022',
        },
        module: { type: 'commonjs' },
      },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!(@nestjs|@us-man-qa-sim|rxjs|uuid|iterare|tslib)/)'],
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/', '\\.module\\.ts$', 'main\\.ts$'],
  testEnvironment: 'node',
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
};
