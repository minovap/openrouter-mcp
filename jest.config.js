export default {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js', '**/src/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  transform: {},
};
