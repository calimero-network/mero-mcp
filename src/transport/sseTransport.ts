import { Request, Response } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import defaultLogger from "../utils/logger";

/**
 * Connection state of a transport
 */
export enum ConnectionState {
  CONNECTED = "connected",
  DISCONNECTED = "disconnected",
  RECONNECTING = "reconnecting",
  ERROR = "error",
}

// Define type for the event to send
interface SSEEvent {
  event: string;
  data: string;
}

/**
 * Interface for logger dependency
 */
export interface ILogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Interface for timer functions
 */
export interface ITimerProvider {
  setInterval(callback: () => void, ms: number): NodeJS.Timeout;
  clearInterval(intervalId: NodeJS.Timeout): void;
  getCurrentTime(): number;
}

/**
 * Default timer implementation
 */
export class DefaultTimerProvider implements ITimerProvider {
  setInterval(callback: () => void, ms: number): NodeJS.Timeout {
    return global.setInterval(callback, ms);
  }

  clearInterval(intervalId: NodeJS.Timeout): void {
    global.clearInterval(intervalId);
  }

  getCurrentTime(): number {
    return Date.now();
  }
}

/**
 * Enhanced SSE transport configuration options
 */
export interface EnhancedSSETransportOptions {
  heartbeatSeconds?: number;
  maxReconnectAttempts?: number;
  logger?: ILogger;
  timerProvider?: ITimerProvider;
}

/**
 * Enhanced SSE transport wrapper that adds logging, error handling, and connection management
 */
export class EnhancedSSETransport extends SSEServerTransport {
  private connectionState: ConnectionState = ConnectionState.CONNECTED;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatSeconds = 30;
  private lastActivityTime: number;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts: number = 5;

  // Dependencies
  protected readonly logger: ILogger;
  protected readonly timerProvider: ITimerProvider;

  /**
   * Create a new enhanced SSE transport instance
   * @param path The path for SSE events
   * @param res The Express response object
   * @param options Configuration options
   */
  constructor(
    path: string,
    res: Response,
    options: EnhancedSSETransportOptions = {},
  ) {
    super(path, res);
    this.heartbeatSeconds = options.heartbeatSeconds ?? 30;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.logger = options.logger ?? defaultLogger;
    this.timerProvider = options.timerProvider ?? new DefaultTimerProvider();
    this.lastActivityTime = this.timerProvider.getCurrentTime();

    this.logger.info(
      `SSE transport created with session ID: ${this.sessionId}`,
      {
        heartbeatSeconds: this.heartbeatSeconds,
        maxReconnectAttempts: this.maxReconnectAttempts,
      },
    );

    // Add connection handlers
    this.setupConnectionHandlers(res);
  }

  /**
   * Initialize the SSE connection
   * This must be called after creating the transport
   */
  async connect(): Promise<void> {
    try {
      // Only call start() if not already started
      // The SSEServerTransport may already be started if using the Server class
      try {
        await super.start();
      } catch (startError) {
        // If the error is about already being started, we can continue
        if (
          startError instanceof Error &&
          startError.message.includes("already started")
        ) {
          this.logger.debug(
            `SSE transport already started for session ID: ${this.sessionId}`,
          );
        } else {
          // If it's another type of error, rethrow it
          throw startError;
        }
      }

      // Start heartbeat after connection is established
      this.startHeartbeat();

      this.logger.info(
        `SSE transport connected for session ID: ${this.sessionId}`,
      );
    } catch (error) {
      this.logger.error(
        `Error connecting SSE transport for session ID: ${this.sessionId}`,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      this.connectionState = ConnectionState.ERROR;
      throw error;
    }
  }

  /**
   * Set up connection event handlers
   * @param res Express response object
   */
  protected setupConnectionHandlers(res: Response): void {
    // Handle connection close
    res.on("close", () => {
      this.connectionState = ConnectionState.DISCONNECTED;
      this.stopHeartbeat();
      this.logger.info(
        `SSE connection closed for session ID: ${this.sessionId}`,
      );
    });

    // Handle connection errors
    res.on("error", (error) => {
      this.connectionState = ConnectionState.ERROR;
      this.stopHeartbeat();
      this.logger.error(
        `SSE connection error for session ID: ${this.sessionId}`,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    });
  }

  /**
   * Start the heartbeat mechanism to keep the connection alive
   */
  protected startHeartbeat(): void {
    this.heartbeatInterval = this.timerProvider.setInterval(() => {
      try {
        // Check if it's been too long since the last activity
        const now = this.timerProvider.getCurrentTime();
        const timeSinceLastActivity = now - this.lastActivityTime;

        // If too much time has passed without activity, send a heartbeat
        if (timeSinceLastActivity > (this.heartbeatSeconds * 1000) / 2) {
          this.sendHeartbeat();
          this.lastActivityTime = now;
        }
      } catch (error) {
        this.logger.error(
          `Error in heartbeat for session ID: ${this.sessionId}`,
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }, this.heartbeatSeconds * 1000);
  }

  /**
   * Stop the heartbeat mechanism
   */
  protected stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      this.timerProvider.clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Send a heartbeat message to check if connection is still alive
   */
  protected sendHeartbeat(): void {
    try {
      // This is a comment event that won't affect the client but keeps the connection alive
      const event: SSEEvent = {
        event: "heartbeat",
        data: JSON.stringify({
          timestamp: this.timerProvider.getCurrentTime(),
        }),
      };

      // Use the internal method from SSEServerTransport to send the event
      // @ts-expect-error - We're using the internal send method which may not match the expected type
      this.send(event);

      this.logger.debug(`Sent heartbeat for session ID: ${this.sessionId}`);
    } catch (error) {
      this.logger.error(
        `Failed to send heartbeat for session ID: ${this.sessionId}`,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );

      // Handle connection failure
      this.handleConnectionFailure();
    }
  }

  /**
   * Handle a connection failure by attempting to reconnect
   */
  protected handleConnectionFailure(): void {
    if (this.connectionState === ConnectionState.RECONNECTING) {
      return; // Already trying to reconnect
    }

    this.connectionState = ConnectionState.RECONNECTING;
    this.reconnectAttempts++;

    this.logger.info(
      `Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) for session ID: ${this.sessionId}`,
    );

    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      this.connectionState = ConnectionState.ERROR;
      this.logger.error(
        `Max reconnect attempts reached for session ID: ${this.sessionId}`,
      );
      return;
    }

    // Attempt to send a ping to check if connection is still viable
    this.sendHeartbeat();
  }

  /**
   * Handle a post message request
   * @param req The Express request object
   * @param res The Express response object
   */
  async handlePostMessage(req: Request, res: Response): Promise<void> {
    // Update activity timestamp
    this.lastActivityTime = this.timerProvider.getCurrentTime();

    try {
      // Check connection state
      if (
        this.connectionState !== ConnectionState.CONNECTED &&
        this.connectionState !== ConnectionState.RECONNECTING
      ) {
        throw new Error(
          `Cannot handle message in ${this.connectionState} state`,
        );
      }

      this.logger.info(`Handling message for session ID: ${this.sessionId}`, {
        method: req.method,
        path: req.path,
        body: req.body,
      });

      // If the client is reconnecting, mark as connected on successful message
      if (this.connectionState === ConnectionState.RECONNECTING) {
        this.connectionState = ConnectionState.CONNECTED;
        this.reconnectAttempts = 0;
        this.logger.info(
          `Reconnected successfully for session ID: ${this.sessionId}`,
        );
      }
      await super.handlePostMessage(req, res);
    } catch (error) {
      this.logger.error(
        `Error handling message for session ID: ${this.sessionId}`,
        {
          error: error instanceof Error ? error.message : String(error),
          state: this.connectionState,
        },
      );

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  }

  /**
   * Get the current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Check if the transport is currently connected (includes RECONNECTING state)
   */
  isConnected(): boolean {
    return (
      this.connectionState === ConnectionState.CONNECTED ||
      this.connectionState === ConnectionState.RECONNECTING
    );
  }

  /**
   * Clean up all resources used by this transport
   */
  public cleanup(): void {
    this.stopHeartbeat();
    this.logger.info(
      `Cleaned up transport resources for session ID: ${this.sessionId}`,
      {
        state: this.connectionState,
      },
    );
  }
}

// Store all active transports
export const transports: { [sessionId: string]: EnhancedSSETransport } = {};

/**
 * Get an existing transport or create a new one
 * @param sessionId Unique session identifier
 * @param path The base path for SSE events
 * @param res Express response object
 * @param options Configuration options
 * @returns The transport instance or null if sessionId is undefined
 */
export function getOrCreateTransport(
  sessionId: string | undefined,
  path: string,
  res: Response,
  options: EnhancedSSETransportOptions = {},
): EnhancedSSETransport | null {
  const logger = options.logger ?? defaultLogger;

  if (!sessionId) {
    logger.error("Cannot create transport without sessionId");
    return null;
  }

  // Check if a transport already exists for this session
  if (transports[sessionId]) {
    const existingTransport = transports[sessionId];

    // Check if the transport is still in a usable state
    if (existingTransport.isConnected()) {
      logger.info(`Reusing transport for session ID: ${sessionId}`);
      return existingTransport;
    } else {
      // Clean up the old transport if it's not in a usable state
      existingTransport.cleanup();
      delete transports[sessionId];
      logger.info(`Cleaned up stale transport for session ID: ${sessionId}`);
    }
  }

  // Create a new transport
  const transport = new EnhancedSSETransport(path, res, options);
  transports[sessionId] = transport;
  return transport;
}

/**
 * Clean up stale transports that haven't had activity for a while
 * @param maxAgeSeconds Maximum age in seconds before a transport is considered stale
 */
export function cleanupStaleTransports(maxAgeSeconds = 3600): void {
  const now = Date.now();
  let cleanedCount = 0;

  Object.entries(transports).forEach(([sessionId, transport]) => {
    // If the transport has a lastActivityTime property (which it should)
    // @ts-expect-error - We're accessing a private property, but it's safe in this context
    const lastActivity: number = transport.lastActivityTime || 0;
    const age = now - lastActivity;

    if (age > maxAgeSeconds * 1000) {
      transport.cleanup();
      delete transports[sessionId];
      cleanedCount++;
    }
  });

  if (cleanedCount > 0) {
    defaultLogger.info(`Cleaned up ${cleanedCount} stale transports`);
  }
}
