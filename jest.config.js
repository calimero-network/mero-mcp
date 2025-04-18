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
      functions: 43,
      lines: 58,
      statements: 58
    },
    './src/transport/sseTransport.ts': {
      branches: 44,
      functions: 30,
      lines: 44,
      statements: 44
    },
    './src/index.ts': {
      statements: 75,
      branches: 0,
      functions: 33,
      lines: 75
    }
  }
}; 