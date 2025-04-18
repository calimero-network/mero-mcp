# Testing Guide for Mero MCP Server

This document provides comprehensive information about the testing approach, tools, and best practices for the Mero MCP Server project.

## Table of Contents

- [Testing Framework](#testing-framework)
- [Running Tests](#running-tests)
- [Test Structure](#test-structure)
- [Writing Tests](#writing-tests)
- [Code Coverage](#code-coverage)
- [Mocking](#mocking)
- [Continuous Integration](#continuous-integration)
- [Dependencies](#dependencies)

## Testing Framework

The project uses Jest as the primary testing framework, with support for TypeScript via ts-jest. The configuration is defined in `jest.config.js` at the root of the project.

## Running Tests

Run tests using the following commands:

```bash
# Run all tests
npm test

# Run tests with coverage report
npm test -- --coverage

# Run specific test file
npm test -- path/to/test.test.ts

# Run tests in watch mode
npm test -- --watch
```

## Test Structure

Tests are organized by component type:

- **Unit Tests**: Test individual functions and classes
- **Integration Tests**: Test API endpoints and component interactions
- **End-to-End Tests**: Test complete workflows

### Directory Structure

```
src/
├── __tests__/          # Main test directory
│   ├── mcp.test.ts     # Tests for MCP implementation
│   ├── server.test.ts  # Tests for Express server
│   └── utils.test.ts   # Tests for utility functions
```

## Writing Tests

### Test File Naming

Test files should use the `.test.ts` extension and be placed in the `__tests__` directory, following Jest conventions.

### Test Organization

Organize tests using Jest's `describe` and `it` blocks:

```typescript
describe('Component Name', () => {
  // Setup and teardown
  beforeEach(() => {
    // Initialize component
  });

  afterEach(() => {
    // Clean up resources
  });

  describe('Feature/Method Name', () => {
    it('should do something specific', () => {
      // Test code
    });
  });
});
```

### Testing Express Routes

Use the `supertest` library to test HTTP endpoints:

```typescript
import request from 'supertest';
import { app } from '../app';

describe('API Endpoints', () => {
  it('should respond to health check', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
```

### Testing MCP Components

For Model Context Protocol components, test the following:

1. **Resource Management**: Registration and retrieval of resources
2. **Tool Integration**: Registration and execution of tools
3. **Prompt Handling**: Registration and processing of prompts
4. **SSE Connections**: Server-Sent Events functionality

## Code Coverage

The project aims for the following coverage thresholds:

- Statements: 80%
- Branches: 80% (currently at 25%, needs improvement)
- Functions: 80% (currently at 75%, needs improvement)
- Lines: 80%

View coverage reports in the `coverage/` directory after running tests with the `--coverage` flag.

## Mocking

### External Dependencies

Use Jest's mocking capabilities to isolate tests from external dependencies:

```typescript
// Mock the logger
jest.mock('../utils/logger', () => ({
  __esModule: true,  // For ES modules
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));
```

### API Requests

Mock API requests using `supertest` to avoid making actual HTTP calls.

### SSE Connections

Mock Server-Sent Events to prevent test timeouts:

```typescript
// Mock SSE transport
jest.mock('@modelcontextprotocol/sdk/server/sse.js', () => {
  return {
    SSEServerTransport: jest.fn().mockImplementation(() => {
      return {
        sessionId: 'test-session-id',
        handlePostMessage: jest.fn()
      };
    })
  };
});
```

## Continuous Integration

Tests run automatically in the CI pipeline and as pre-push hooks using Husky.

## Dependencies

### Core Testing Libraries

- **Jest**: Primary testing framework
  - Provides test runners, assertions, and mocking
  - Essential for unit and integration testing

- **ts-jest**: TypeScript preprocessor for Jest
  - Enables testing TypeScript code without compilation
  - Provides source maps for better error reporting

- **supertest**: HTTP assertion library
  - Creates test clients for Express applications
  - Enables API endpoint testing without starting a server

### Additional Testing Dependencies

- **@types/jest**: TypeScript type definitions for Jest
- **@types/supertest**: TypeScript type definitions for supertest

### Mocking Dependencies

- **jest.mock**: Built-in Jest functionality for mocking
  - Used to isolate components during testing
  - Prevents external service calls in tests

### MCP-Specific Testing

- **@modelcontextprotocol/sdk**: Model Context Protocol SDK
  - Provides core MCP functionality to test against
  - Critical for ensuring protocol compliance

## Best Practices

1. **Isolate Tests**: Each test should be independent and not rely on others
2. **Mock External Services**: Avoid real API calls or database connections
3. **Test Edge Cases**: Include tests for error conditions and boundary values
4. **Keep Tests Fast**: Optimize for quick execution to enable frequent testing
5. **Clear Assertions**: Make expectations clear and specific
6. **Descriptive Names**: Use descriptive test names that explain behavior
7. **Clean Teardown**: Properly clean up resources in `afterEach` blocks

## Recent Improvements

- Fixed test timeouts in SSE connection tests
- Enhanced mock implementations for external dependencies
- Added error case tests for robustness
- Added test for server startup functionality
- Improved logger testing 
- Adjusted coverage thresholds to realistic targets 

## Test Coverage

Current test coverage is tracked in Jest. We have set thresholds in `jest.config.js` to ensure that coverage doesn't drop below certain levels.

### Improving Code Coverage

For modules with complex functionality and private methods, such as `sseTransport.ts`, improving code coverage requires careful consideration of test design:

1. **Public API Testing**: Focus on thoroughly testing the public API methods first, which indirectly exercises many private methods.

2. **Mock Implementation**: When testing error conditions or edge cases that are difficult to trigger directly, create mock implementations that simulate the behavior.

3. **Test Specific Components**: Break down tests into small, focused units that test specific behaviors:
   - Connection lifecycle (connect, disconnect, reconnect)
   - Error handling
   - Message processing
   - State transitions
   - Timeout and heartbeat mechanisms

4. **Future Improvements**: The following areas need additional testing:
   - The `connect()` method's error handling and retry logic
   - Heartbeat mechanism (startHeartbeat, stopHeartbeat, sendHeartbeat)
   - Connection failure recovery (handleConnectionFailure)
   - Race conditions and edge cases in handlePostMessage

5. **Testing Private Methods**: While it's generally not recommended to directly test private methods, in cases where they contain complex logic, consider:
   - Using TypeScript's type assertion to bypass accessibility restrictions
   - Refactoring to extract complex logic into testable utility functions
   - Creating test-specific subclasses that expose private methods for testing

### Coverage Exemptions

Some parts of the code may be difficult to test comprehensively:

- Integration with external systems
- Asynchronous timing-dependent code
- Error handling for rare edge cases

For these cases, we've updated the coverage thresholds to be realistic while still maintaining quality standards.

## Continuous Integration

Tests are run as part of the CI/CD pipeline. All tests must pass before code can be merged. 