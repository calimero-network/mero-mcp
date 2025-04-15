import { Tool, ToolAnnotations } from '../types/mcp/schema';
import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger';

/**
 * Base path for file operations, used to prevent access to files outside this directory
 */
const SAFE_BASE_PATH = './data';

/**
 * Ensure a path is within the safe base path
 * 
 * @param filePath - Path to validate
 * @returns Normalized, safe path
 */
function getSafePath(filePath: string): string {
  // Normalize the path to prevent directory traversal attacks
  const normalizedPath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  return path.join(SAFE_BASE_PATH, normalizedPath);
}

/**
 * Safely reads a file's contents
 */
export async function readFile(
  args: { filePath: string },
  _extra: { signal: AbortSignal }
): Promise<{ content: { type: 'text', text: string }[] }> {
  try {
    const fullPath = getSafePath(args.filePath);
    
    // Check if file exists
    await fs.access(fullPath);
    
    // Read file contents
    const content = await fs.readFile(fullPath, 'utf8');
    logger.info('File read successfully', { path: args.filePath });
    
    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  } catch (error) {
    logger.error('Error reading file', { error, path: args.filePath });
    return {
      content: [{
        type: 'text',
        text: `Error reading file ${args.filePath}: ${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }
}

/**
 * Reads and returns a file's metadata
 */
export async function getFileInfo(
  args: { filePath: string },
  _extra: { signal: AbortSignal }
): Promise<{ content: { type: 'text', text: string }[] }> {
  try {
    const fullPath = getSafePath(args.filePath);
    
    // Check if file exists
    await fs.access(fullPath);
    
    // Get file stats
    const stats = await fs.stat(fullPath);
    const info = {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile()
    };
    
    logger.info('File info retrieved', { path: args.filePath });
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(info, null, 2)
      }]
    };
  } catch (error) {
    logger.error('Error getting file info', { error, path: args.filePath });
    return {
      content: [{
        type: 'text',
        text: `Error getting file info for ${args.filePath}: ${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }
}

/**
 * Lists files in a directory
 */
export async function listDirectory(
  args: { dirPath: string },
  _extra: { signal: AbortSignal }
): Promise<{ content: { type: 'text', text: string }[] }> {
  try {
    const fullPath = getSafePath(args.dirPath);
    
    // Check if directory exists
    await fs.access(fullPath);
    
    // List files
    const files = await fs.readdir(fullPath);
    logger.info('Directory listed successfully', { path: args.dirPath, fileCount: files.length });
    
    return {
      content: [{
        type: 'text',
        text: files.join('\n')
      }]
    };
  } catch (error) {
    logger.error('Error listing directory', { error, path: args.dirPath });
    return {
      content: [{
        type: 'text',
        text: `Error listing directory ${args.dirPath}: ${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }
}

/**
 * Writes content to a file
 */
export async function writeFile(
  args: { filePath: string, content: string },
  _extra: { signal: AbortSignal }
): Promise<{ content: { type: 'text', text: string }[] }> {
  try {
    const fullPath = getSafePath(args.filePath);
    
    // Ensure directory exists
    const dirPath = path.dirname(fullPath);
    await fs.mkdir(dirPath, { recursive: true });
    
    // Write file contents
    await fs.writeFile(fullPath, args.content);
    logger.info('File written successfully', { path: args.filePath });
    
    return {
      content: [{
        type: 'text',
        text: `File ${args.filePath} written successfully`
      }]
    };
  } catch (error) {
    logger.error('Error writing file', { error, path: args.filePath });
    return {
      content: [{
        type: 'text',
        text: `Error writing file ${args.filePath}: ${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }
}

/**
 * Deletes a file
 */
export async function deleteFile(
  args: { filePath: string },
  _extra: { signal: AbortSignal }
): Promise<{ content: { type: 'text', text: string }[] }> {
  try {
    const fullPath = getSafePath(args.filePath);
    
    // Check if file exists
    await fs.access(fullPath);
    
    // Delete file
    await fs.unlink(fullPath);
    logger.info('File deleted successfully', { path: args.filePath });
    
    return {
      content: [{
        type: 'text',
        text: `File ${args.filePath} deleted successfully`
      }]
    };
  } catch (error) {
    logger.error('Error deleting file', { error, path: args.filePath });
    return {
      content: [{
        type: 'text',
        text: `Error deleting file ${args.filePath}: ${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }
}

/**
 * Tool definitions with annotations
 */
export const fileTools: Tool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file from the server',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'The path to the file to read' }
      },
      required: ['filePath']
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'get_file_info',
    description: 'Get metadata information about a file',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'The path to the file to get info for' }
      },
      required: ['filePath']
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'list_directory',
    description: 'List all files in a directory',
    inputSchema: {
      type: 'object',
      properties: {
        dirPath: { type: 'string', description: 'The path to the directory to list' }
      },
      required: ['dirPath']
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'write_file',
    description: 'Write content to a file on the server',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'The path to the file to write' },
        content: { type: 'string', description: 'The content to write to the file' }
      },
      required: ['filePath', 'content']
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the server',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'The path to the file to delete' }
      },
      required: ['filePath']
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  }
];

/**
 * Map of tool names to their implementation functions
 */
export const fileToolHandlers = {
  read_file: readFile,
  get_file_info: getFileInfo,
  list_directory: listDirectory,
  write_file: writeFile,
  delete_file: deleteFile
}; 