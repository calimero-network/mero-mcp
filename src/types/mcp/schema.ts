/**
 * TypeScript type definitions for the MCP schema version 2025-03-26
 *
 * Based on: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-03-26/schema.ts
 */

/**
 * Describes the role of a participant in a conversation.
 */
export type Role = "system" | "user" | "assistant" | "tool";

/**
 * Optional annotations for the client. The client can use annotations to inform how objects are used or displayed
 */
export interface Annotations {
  /**
   * Describes who the intended customer of this object or data is.
   *
   * It can include multiple entries to indicate content useful for multiple audiences (e.g., ["user", "assistant"]).
   */
  audience?: Role[];

  /**
   * Describes how important this data is for operating the server.
   *
   * A value of 1 means "most important," and indicates that the data is
   * effectively required, while 0 means "least important," and indicates that
   * the data is entirely optional.
   */
  priority?: number;
}

/**
 * Text provided to or from an LLM.
 */
export interface TextContent {
  type: "text";
  /**
   * The text content of the message.
   */
  text: string;
  /**
   * Optional annotations for the client.
   */
  annotations?: Annotations;
}

/**
 * An image provided to or from an LLM.
 */
export interface ImageContent {
  type: "image";
  /**
   * The base64-encoded image data.
   */
  data: string;
  /**
   * The MIME type of the image. Different providers may support different image types.
   */
  mimeType: string;
  /**
   * Optional annotations for the client.
   */
  annotations?: Annotations;
}

/**
 * Audio provided to or from an LLM.
 */
export interface AudioContent {
  type: "audio";
  /**
   * The base64-encoded audio data.
   */
  data: string;
  /**
   * The MIME type of the audio. Different providers may support different audio types.
   */
  mimeType: string;
  /**
   * Optional annotations for the client.
   */
  annotations?: Annotations;
}

/**
 * Content type union for messages
 */
export type Content = TextContent | ImageContent | AudioContent;

/**
 * Resource content returned by the MCP server
 */
export interface ResourceContent {
  /**
   * The URI of the resource
   */
  uri: string;

  /**
   * The text content of the resource
   */
  text: string;
}

/**
 * Optional annotations for tools.
 */
export interface ToolAnnotations {
  /**
   * If true, this tool doesn't modify any state and is safe to call
   * repeatedly. If false, this tool may change external state.
   *
   * Default: false
   */
  readOnlyHint?: boolean;

  /**
   * If true, this tool may modify state in a non-reversible way
   * (e.g., sending an email or making a payment). The agent should
   * be especially careful when calling destructive tools.
   *
   * (This property is meaningful only when `readOnlyHint == false`)
   *
   * Default: true
   */
  destructiveHint?: boolean;

  /**
   * If true, calling the tool repeatedly with the same arguments
   * will have no additional effect on the its environment.
   *
   * (This property is meaningful only when `readOnlyHint == false`)
   *
   * Default: false
   */
  idempotentHint?: boolean;

  /**
   * If true, this tool may interact with an "open world" of external
   * entities. If false, the tool's domain of interaction is closed.
   * For example, the world of a web search tool is open, whereas that
   * of a memory tool is not.
   *
   * Default: true
   */
  openWorldHint?: boolean;
}

/**
 * Definition for a tool the client can call.
 */
export interface Tool {
  /**
   * The name of the tool.
   */
  name: string;

  /**
   * A human-readable description of the tool.
   *
   * This can be used by clients to improve the LLM's understanding of available tools.
   * It can be thought of like a "hint" to the model.
   */
  description?: string;

  /**
   * A JSON Schema object defining the expected parameters for the tool.
   */
  inputSchema: {
    type: "object";
    properties?: { [key: string]: object };
    required?: string[];
  };

  /**
   * Optional additional tool information.
   */
  annotations?: ToolAnnotations;
}

/**
 * The severity of a log message.
 *
 * These map to syslog message severities, as specified in RFC-5424:
 * https://datatracker.ietf.org/doc/html/rfc5424#section-6.2.1
 */
export type LoggingLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

/**
 * Message passed between the client and LLM model
 */
export interface SamplingMessage {
  role: Role;
  content: Content;
}

/**
 * Model preferences for sampling
 */
export interface ModelPreferences {
  /**
   * The name of a specific model to use, if available.
   */
  name?: string;

  /**
   * Minimum requirements the model should meet.
   */
  requirements?: {
    /**
     * Minimum number of context tokens required.
     */
    minContextTokens?: number;

    /**
     * Minimum generation tokens required.
     */
    minGenerationTokens?: number;

    /**
     * Whether multimodal capabilities are required.
     */
    multimodal?: boolean;
  };
}
