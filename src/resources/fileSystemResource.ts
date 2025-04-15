import { ResourceContent } from "../types/mcp/schema";
import fs from "fs/promises";
import path from "path";
import logger from "../utils/logger";

/**
 * A simple file system resource provider that serves files from the disk
 */
export class FileSystemResourceProvider {
  private basePath: string;

  /**
   * Create a new FileSystemResourceProvider
   *
   * @param basePath - The base directory to serve files from
   */
  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Read a file from the file system
   *
   * @param filePath - Relative path to the file
   * @returns Promise with file contents
   */
  async readFile(filePath: string): Promise<string> {
    try {
      // Normalize the path to prevent directory traversal attacks
      const normalizedPath = path
        .normalize(filePath)
        .replace(/^(\.\.[/\\])+/, "");
      const fullPath = path.join(this.basePath, normalizedPath);

      // Check if file exists
      await fs.access(fullPath);

      // Read file contents
      const content = await fs.readFile(fullPath, "utf8");
      return content;
    } catch (error) {
      logger.error("Error reading file", { error, filePath });
      throw new Error(`Could not read file: ${filePath}`);
    }
  }

  /**
   * List files in a directory
   *
   * @param dirPath - Relative path to the directory
   * @returns Promise with array of file names
   */
  async listDirectory(dirPath: string): Promise<string[]> {
    try {
      // Normalize the path to prevent directory traversal attacks
      const normalizedPath = path
        .normalize(dirPath)
        .replace(/^(\.\.[\\])+/, "");
      const fullPath = path.join(this.basePath, normalizedPath);

      // Check if directory exists
      await fs.access(fullPath);

      // List files
      const files = await fs.readdir(fullPath);
      return files;
    } catch (error) {
      logger.error("Error listing directory", { error, dirPath });
      throw new Error(`Could not list directory: ${dirPath}`);
    }
  }

  /**
   * Convert a URI template to a file path
   *
   * @param uri - The URI to convert
   * @param variables - Variables to substitute in the URI template
   * @returns The corresponding file path
   */
  uriToPath(uri: URL, variables: Record<string, string | string[]>): string {
    // Extract the path from the URI
    // For a file:// URI this removes the "file://" prefix
    let filePath = decodeURIComponent(uri.pathname);

    // Handle Windows paths
    if (process.platform === "win32" && filePath.startsWith("/")) {
      filePath = filePath.substring(1);
    }

    // Apply any variables - this is a simple implementation
    // A more robust implementation would use proper URI template handling
    for (const [key, value] of Object.entries(variables)) {
      const valueStr = Array.isArray(value) ? value.join(",") : value;
      filePath = filePath.replace(`{${key}}`, valueStr);
    }

    return filePath;
  }

  /**
   * Handle a resource request
   *
   * @param uri - The URI of the resource
   * @param variables - Variables from the URI template
   * @returns Promise with resource content
   */
  async handleResource(
    uri: URL,
    variables: Record<string, string | string[]>,
  ): Promise<{ contents: ResourceContent[] }> {
    try {
      const filePath = this.uriToPath(uri, variables);
      const content = await this.readFile(filePath);

      return {
        contents: [
          {
            uri: uri.href,
            text: content,
          },
        ],
      };
    } catch (error) {
      logger.error("Error handling resource", { error, uri: uri.href });
      throw error;
    }
  }
}
