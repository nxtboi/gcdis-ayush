/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.spec.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/\\.next/',
    '/dist/',
    '<rootDir>/tests/e2e/',
    '<rootDir>/tests/load/'
  ],
  // Only ignore Next build output here: packages/shared/dist is the resolved entry of @gcdis/shared.
  modulePathIgnorePatterns: ['<rootDir>/apps/[^/]+/\\.next/'],
  watchPathIgnorePatterns: ['/node_modules/', '/\\.next/', '/dist/', '/uploads/', '/storage/'],
  // Points STORAGE_LOCAL_DIR at an OS temp dir so tests never write into ./uploads
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
    // sanitize-html >= 2.17.7 depends on the ESM-only htmlparser2 12 family. Node >= 20.19 loads it via
    // require(esm) at runtime, but Jest's CommonJS module runtime cannot, so transpile just those packages.
    '^.+\\.js$': ['ts-jest', { tsconfig: { allowJs: true, module: 'commonjs', target: 'ES2022', esModuleInterop: true } }]
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(?:[^/]+/node_modules/)*(?:htmlparser2|domhandler|domutils|dom-serializer|domelementtype|entities)/)'
  ]
};
