import logger from "../utils/logger";
import winston from "winston";

// Mock winston
jest.mock("winston", () => {
  const mockFormat = {
    combine: jest.fn().mockReturnThis(),
    timestamp: jest.fn().mockReturnThis(),
    printf: jest.fn().mockReturnThis(),
    colorize: jest.fn().mockReturnThis(),
  };

  const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };

  return {
    format: mockFormat,
    createLogger: jest.fn().mockReturnValue(mockLogger),
    transports: {
      Console: jest.fn(),
    },
  };
});

describe("Logger", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should have the expected methods", () => {
    expect(logger.info).toBeDefined();
    expect(logger.error).toBeDefined();
    expect(logger.warn).toBeDefined();
    expect(logger.debug).toBeDefined();
  });

  it("should log info messages", () => {
    logger.info("Test info message", { data: "test" });
    expect(jest.mocked(winston).createLogger().info).toHaveBeenCalled();
  });

  it("should log error messages", () => {
    logger.error("Test error message", { error: new Error("Test error") });
    expect(jest.mocked(winston).createLogger().error).toHaveBeenCalled();
  });

  it("should log warning messages", () => {
    logger.warn("Test warning message");
    expect(jest.mocked(winston).createLogger().warn).toHaveBeenCalled();
  });

  it("should log debug messages", () => {
    logger.debug("Test debug message");
    expect(jest.mocked(winston).createLogger().debug).toHaveBeenCalled();
  });
});
