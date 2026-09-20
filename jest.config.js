const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1';

module.exports = {
  rootDir: __dirname, // explicit - avoids mapped/UNC drive rootDir detection bugs
  testEnvironment: 'node',
  clearMocks: true,
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.js'],
  testTimeout: 10000,

  // Without RUN_INTEGRATION=1, only run unit tests
  // Exclude production/ directory (it has duplicate tests)
  testMatch: RUN_INTEGRATION
    ? ['<rootDir>/tests/unit/**/*.test.js', '<rootDir>/tests/integration/**/*.test.js']
    : ['<rootDir>/tests/unit/**/*.test.js'],
};
