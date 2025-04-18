module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true
    }]
  },
  transformIgnorePatterns: [
    '/node_modules/(?!node-fetch)/'
  ],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  coverageThreshold: {
    global: {
      branches: 40,
      functions: 39,
      lines: 56,
      statements: 56
    },
    './src/transport/sseTransport.ts': {
      branches: 44,
      functions: 30,
      lines: 44,
      statements: 44
    }
  }
}; 