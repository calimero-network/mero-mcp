import { Request, Response } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import logger from "../utils/logger";

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
 * Enhanced SSE transport wrapper that adds logging, error handling, and connection management
 */
export class EnhancedSSETransport extends SSEServerTransport {
  private connectionState: ConnectionState = ConnectionState.CONNECTED;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatSeconds = 30;
  private lastActivityTime: number = Date.now();
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts: number = 5;

  /**
   * Create a new enhanced SSE transport instance
   * @param path The path for SSE events
   * @param res The Express response object
   * @param options Configuration options
   */
  constructor(
    path: string, 
    res: Response, 
    options: {
      heartbeatSeconds?: number;
      maxReconnectAttempts?: number;
    } = {}
  ) {
    super(path, res);
    this.heartbeatSeconds = options.heartbeatSeconds ?? 30;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    
    logger.info(`SSE transport created with session ID: ${this.sessionId}`, {
      heartbeatSeconds: this.heartbeatSeconds,
      maxReconnectAttempts: this.maxReconnectAttempts
    });

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
        if (startError instanceof Error && 
            startError.message.includes('already started')) {
          logger.debug(`SSE transport already started for session ID: ${this.sessionId}`);
        } else {
          // If it's another type of error, rethrow it
          throw startError;
        }
      }
      
      // Start heartbeat after connection is established
      this.startHeartbeat();
      
      logger.info(`SSE transport connected for session ID: ${this.sessionId}`);
    } catch (error) {
      logger.error(`Error connecting SSE transport for session ID: ${this.sessionId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      this.connectionState = ConnectionState.ERROR;
      throw error;
    }
  }

  /**
   * Set up connection event handlers
   * @param res Express response object
   */
  private setupConnectionHandlers(res: Response): void {
    // Handle connection close
    res.on("close", () => {
      this.connectionState = ConnectionState.DISCONNECTED;
      this.stopHeartbeat();
      logger.info(`SSE connection closed for session ID: ${this.sessionId}`);
    });

    // Handle connection errors
    res.on("error", (error) => {
      this.connectionState = ConnectionState.ERROR;
      this.stopHeartbeat();
      logger.error(`SSE connection error for session ID: ${this.sessionId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Start the heartbeat mechanism to keep the connection alive
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      try {
        // Check if it's been too long since the last activity
        const now = Date.now();
        const timeSinceLastActivity = now - this.lastActivityTime;
        
        // If too much time has passed without activity, send a heartbeat
        if (timeSinceLastActivity > this.heartbeatSeconds * 1000 / 2) {
          this.sendHeartbeat();
          this.lastActivityTime = now;
        }
      } catch (error) {
        logger.error(`Error in heartbeat for session ID: ${this.sessionId}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.heartbeatSeconds * 1000);
  }

  /**
   * Stop the heartbeat mechanism
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Send a heartbeat message to check if connection is still alive
   */
  private sendHeartbeat(): void {
    try {
      // This is a comment event that won't affect the client but keeps the connection alive
      const event: SSEEvent = {
        event: "heartbeat",
        data: JSON.stringify({ timestamp: Date.now() }),
      };
      
      // Use the internal method from SSEServerTransport to send the event
      // @ts-ignore - We're using the internal send method which may not match the expected type
      this.send(event);
      
      logger.debug(`Sent heartbeat for session ID: ${this.sessionId}`);
    } catch (error) {
      logger.error(`Failed to send heartbeat for session ID: ${this.sessionId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      
      // Handle connection failure
      this.handleConnectionFailure();
    }
  }

  /**
   * Handle a connection failure by attempting to reconnect
   */
  private handleConnectionFailure(): void {
    if (this.connectionState === ConnectionState.RECONNECTING) {
      return; // Already trying to reconnect
    }

    this.connectionState = ConnectionState.RECONNECTING;
    this.reconnectAttempts++;

    logger.info(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) for session ID: ${this.sessionId}`);

    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      this.connectionState = ConnectionState.ERROR;
      logger.error(`Max reconnect attempts reached for session ID: ${this.sessionId}`);
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
    this.lastActivityTime = Date.now();

    try {
      // Check connection state
      if (this.connectionState !== ConnectionState.CONNECTED && 
          this.connectionState !== ConnectionState.RECONNECTING) {
        throw new Error(`Cannot handle message in ${this.connectionState} state`);
      }

      logger.info(`Handling message for session ID: ${this.sessionId}`, {
        method: req.method,
        path: req.path,
        body: req.body,
      });

      // If the client is reconnecting, mark as connected on successful message
      if (this.connectionState === ConnectionState.RECONNECTING) {
        this.connectionState = ConnectionState.CONNECTED;
        this.reconnectAttempts = 0;
        logger.info(`Reconnected successfully for session ID: ${this.sessionId}`);
      }
      await super.handlePostMessage(req, res);
    } catch (error) {
      logger.error(`Error handling message for session ID: ${this.sessionId}`, {
        error: error instanceof Error ? error.message : String(error),
        state: this.connectionState,
      });

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
   * Check if the transport is in a connected state
   */
  isConnected(): boolean {
    return this.connectionState === ConnectionState.CONNECTED ||
           this.connectionState === ConnectionState.RECONNECTING;
  }

  /**
   * Clean up resources when transport is no longer needed
   */
  public cleanup(): void {
    this.stopHeartbeat();
    logger.info(`Cleaned up transport resources for session ID: ${this.sessionId}`);
  }
}

/**
 * Store of active transports by session ID
 */
export const transports: { [sessionId: string]: EnhancedSSETransport } = {};

/**
 * Get an existing transport by session ID or create a new one
 * @param sessionId The session ID
 * @param path The SSE path
 * @param res The Express response object
 * @param options Configuration options
 * @returns The transport instance
 */
export function getOrCreateTransport(
  sessionId: string | undefined,
  path: string,
  res: Response,
  options: {
    heartbeatSeconds?: number;
    maxReconnectAttempts?: number;
  } = {}
): EnhancedSSETransport | null {
  if (sessionId && transports[sessionId]) {
    const existingTransport = transports[sessionId];
    
    // Check if the transport is still in a usable state
    if (existingTransport.isConnected()) {
      logger.info(`Reusing transport for session ID: ${sessionId}`);
      return existingTransport;
    } else {
      // Transport exists but is in an unusable state, clean it up
      existingTransport.cleanup();
      delete transports[sessionId];
      logger.info(`Removed stale transport for session ID: ${sessionId}`);
    }
  }
  
  if (!sessionId) {
    // Create a new transport
    const newTransport = new EnhancedSSETransport(path, res, options);
    transports[newTransport.sessionId] = newTransport;

    // Clean up transport when connection closes
    res.on("close", () => {
      const transportToCleanup = transports[newTransport.sessionId];
      if (transportToCleanup) {
        transportToCleanup.cleanup();
        delete transports[newTransport.sessionId];
      }
    });

    return newTransport;
  }

  return null;
}

/**
 * Clean up stale transports that haven't been active for a while
 * @param maxAgeSeconds Maximum age in seconds for a transport to be considered active
 */
export function cleanupStaleTransports(maxAgeSeconds = 3600): void {
  const now = Date.now();
  const staleThreshold = now - (maxAgeSeconds * 1000);
  
  let cleaned = 0;
  
  Object.entries(transports).forEach(([sessionId, transport]) => {
    // Type assertion is safe here since we're checking the lastActivityTime property
    // which we know exists on our EnhancedSSETransport instances
    if (transport && (transport as unknown as { lastActivityTime: number }).lastActivityTime < staleThreshold) {
      transport.cleanup();
      delete transports[sessionId];
      cleaned++;
    }
  });
  
  if (cleaned > 0) {
    logger.info(`Cleaned up ${cleaned} stale transports`);
  }
}
