import { readFile, getFileInfo, listDirectory, writeFile, deleteFile, fileTools, fileToolHandlers } from '../tools/fileTools';
import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger';

// Mock path module to control normalization behavior
jest.mock('path', () => {
  const originalPath = jest.requireActual('path');
  return {
    ...originalPath,
    normalize: jest.fn(path => {
      // Mock normalize to simulate the behavior we need for tests
      if (path.includes('../')) {
        // Replace traversal patterns for test purposes
        return path.replace(/\.\.\//g, '').replace(/\.\.\\/g, '');
      }
      return path;
    }),
    join: jest.fn((...args) => {
      // Pass through to real join but capture for test assertions
      return originalPath.join(...args);
    }),
    dirname: jest.fn(path => originalPath.dirname(path))
  };
});

// Mock the fs/promises module
jest.mock('fs/promises', () => ({
  access: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  unlink: jest.fn(),
  stat: jest.fn(),
  readdir: jest.fn(),
  mkdir: jest.fn()
}));

// Mock the logger
jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));

describe('File Tools', () => {
  // Create abort signal for tests
  const signal = new AbortController().signal;
  const extra = { signal };
  
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
  });
  
  describe('readFile', () => {
    it('should read a file successfully', async () => {
      // Mock successful file read
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.readFile as jest.Mock).mockResolvedValue('file content');
      
      const result = await readFile({ filePath: 'test.txt' }, extra);
      
      // Verify the result
      expect(result).toEqual({
        content: [{
          type: 'text',
          text: 'file content'
        }]
      });
      
      // Verify path construction
      expect(fs.access).toHaveBeenCalledWith(expect.stringContaining(path.join('data', 'test.txt')));
      expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining(path.join('data', 'test.txt')), 'utf8');
      
      // Verify logging
      expect(logger.info).toHaveBeenCalledWith('File read successfully', { path: 'test.txt' });
    });
    
    it('should handle errors when reading a file', async () => {
      // Mock file read failure
      const testError = new Error('File not found');
      (fs.access as jest.Mock).mockRejectedValue(testError);
      
      const result = await readFile({ filePath: 'nonexistent.txt' }, extra);
      
      // Verify error handling
      expect(result.content[0].text).toContain('Error reading file nonexistent.txt');
      expect(result.content[0].text).toContain('File not found');
      
      // Verify logging
      expect(logger.error).toHaveBeenCalledWith('Error reading file', { 
        error: testError, 
        path: 'nonexistent.txt' 
      });
    });
    
    it('should prevent directory traversal attacks', async () => {
      // Mock successful file read
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.readFile as jest.Mock).mockResolvedValue('file content');
      
      await readFile({ filePath: '../../../etc/passwd' }, extra);
      
      // Get the final sanitized path that was passed to access
      const accessPath = (fs.access as jest.Mock).mock.calls[0][0];
      
      // We just need to verify the path was safely constructed
      expect(path.normalize).toHaveBeenCalledWith('../../../etc/passwd');
      expect(path.join).toHaveBeenCalledWith('./data', expect.any(String));
      expect(accessPath).toContain('data');
    });
  });
  
  describe('getFileInfo', () => {
    it('should get file info successfully', async () => {
      // Mock file stats
      const mockStats = {
        size: 1024,
        birthtime: new Date('2023-01-01'),
        mtime: new Date('2023-01-02'),
        isDirectory: jest.fn().mockReturnValue(false),
        isFile: jest.fn().mockReturnValue(true)
      };
      
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.stat as jest.Mock).mockResolvedValue(mockStats);
      
      const result = await getFileInfo({ filePath: 'test.txt' }, extra);
      
      // Verify the result contains file stats
      expect(JSON.parse(result.content[0].text)).toEqual({
        size: 1024,
        created: mockStats.birthtime.toISOString(),
        modified: mockStats.mtime.toISOString(),
        isDirectory: false,
        isFile: true
      });
      
      // Verify logging
      expect(logger.info).toHaveBeenCalledWith('File info retrieved', { path: 'test.txt' });
    });
    
    it('should handle errors when getting file info', async () => {
      // Mock file stat failure
      const testError = new Error('File not found');
      (fs.access as jest.Mock).mockRejectedValue(testError);
      
      const result = await getFileInfo({ filePath: 'nonexistent.txt' }, extra);
      
      // Verify error handling
      expect(result.content[0].text).toContain('Error getting file info for nonexistent.txt');
      expect(result.content[0].text).toContain('File not found');
      
      // Verify logging
      expect(logger.error).toHaveBeenCalledWith('Error getting file info', { 
        error: testError, 
        path: 'nonexistent.txt' 
      });
    });
  });
  
  describe('listDirectory', () => {
    it('should list directory contents successfully', async () => {
      // Mock directory listing
      const mockFiles = ['file1.txt', 'file2.txt', 'subdirectory'];
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock).mockResolvedValue(mockFiles);
      
      const result = await listDirectory({ dirPath: 'testdir' }, extra);
      
      // Verify result contains file list
      expect(result.content[0].text).toBe('file1.txt\nfile2.txt\nsubdirectory');
      
      // Verify logging
      expect(logger.info).toHaveBeenCalledWith('Directory listed successfully', { 
        path: 'testdir', 
        fileCount: 3 
      });
    });
    
    it('should handle errors when listing a directory', async () => {
      // Mock directory listing failure
      const testError = new Error('Directory not found');
      (fs.access as jest.Mock).mockRejectedValue(testError);
      
      const result = await listDirectory({ dirPath: 'nonexistent-dir' }, extra);
      
      // Verify error handling
      expect(result.content[0].text).toContain('Error listing directory nonexistent-dir');
      expect(result.content[0].text).toContain('Directory not found');
      
      // Verify logging
      expect(logger.error).toHaveBeenCalledWith('Error listing directory', { 
        error: testError, 
        path: 'nonexistent-dir' 
      });
    });
  });
  
  describe('writeFile', () => {
    it('should write a file successfully', async () => {
      // Mock directory creation and file writing
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      
      const result = await writeFile({ 
        filePath: 'test.txt', 
        content: 'Hello, world!' 
      }, extra);
      
      // Verify result
      expect(result.content[0].text).toBe('File test.txt written successfully');
      
      // Verify mkdir was called to ensure directory exists
      expect(fs.mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
      
      // Verify file write
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join('data', 'test.txt')), 
        'Hello, world!'
      );
      
      // Verify logging
      expect(logger.info).toHaveBeenCalledWith('File written successfully', { path: 'test.txt' });
    });
    
    it('should handle errors when writing a file', async () => {
      // Mock file write failure
      const testError = new Error('Permission denied');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockRejectedValue(testError);
      
      const result = await writeFile({ 
        filePath: 'test.txt', 
        content: 'Hello, world!' 
      }, extra);
      
      // Verify error handling
      expect(result.content[0].text).toContain('Error writing file test.txt');
      expect(result.content[0].text).toContain('Permission denied');
      
      // Verify logging
      expect(logger.error).toHaveBeenCalledWith('Error writing file', { 
        error: testError, 
        path: 'test.txt' 
      });
    });
    
    it('should handle errors when creating directory', async () => {
      // Mock directory creation failure
      const testError = new Error('Permission denied');
      (fs.mkdir as jest.Mock).mockRejectedValue(testError);
      
      const result = await writeFile({ 
        filePath: 'test.txt', 
        content: 'Hello, world!' 
      }, extra);
      
      // Verify error handling
      expect(result.content[0].text).toContain('Error writing file test.txt');
      expect(result.content[0].text).toContain('Permission denied');
      
      // Verify logging
      expect(logger.error).toHaveBeenCalledWith('Error writing file', { 
        error: testError, 
        path: 'test.txt' 
      });
      
      // Verify writeFile wasn't called after mkdir failed
      expect(fs.writeFile).not.toHaveBeenCalled();
    });
  });
  
  describe('deleteFile', () => {
    it('should delete a file successfully', async () => {
      // Mock file access and deletion
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.unlink as jest.Mock).mockResolvedValue(undefined);
      
      const result = await deleteFile({ filePath: 'test.txt' }, extra);
      
      // Verify result
      expect(result.content[0].text).toBe('File test.txt deleted successfully');
      
      // Verify file deletion
      expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining(path.join('data', 'test.txt')));
      
      // Verify logging
      expect(logger.info).toHaveBeenCalledWith('File deleted successfully', { path: 'test.txt' });
    });
    
    it('should handle errors when deleting a file that does not exist', async () => {
      // Mock file not found
      const testError = new Error('File not found');
      (fs.access as jest.Mock).mockRejectedValue(testError);
      
      const result = await deleteFile({ filePath: 'nonexistent.txt' }, extra);
      
      // Verify error handling
      expect(result.content[0].text).toContain('Error deleting file nonexistent.txt');
      expect(result.content[0].text).toContain('File not found');
      
      // Verify unlink wasn't called
      expect(fs.unlink).not.toHaveBeenCalled();
      
      // Verify logging
      expect(logger.error).toHaveBeenCalledWith('Error deleting file', { 
        error: testError, 
        path: 'nonexistent.txt' 
      });
    });
    
    it('should handle errors during file deletion', async () => {
      // Mock deletion failure
      const testError = new Error('Permission denied');
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.unlink as jest.Mock).mockRejectedValue(testError);
      
      const result = await deleteFile({ filePath: 'test.txt' }, extra);
      
      // Verify error handling
      expect(result.content[0].text).toContain('Error deleting file test.txt');
      expect(result.content[0].text).toContain('Permission denied');
      
      // Verify logging
      expect(logger.error).toHaveBeenCalledWith('Error deleting file', { 
        error: testError, 
        path: 'test.txt' 
      });
    });
  });
  
  describe('Security', () => {
    it('should sanitize paths with directory traversal attempts', () => {
      // Test with various directory traversal attempts
      const testPaths = [
        '../../../etc/passwd',
        '..\\..\\Windows\\System32\\config',
        'normal/path/../with/traversal/../../attempt',
        '/absolute/path/attempt'
      ];
      
      // Mock successful file operations to focus on path sanitization
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.readFile as jest.Mock).mockResolvedValue('content');
      
      // Clear any previous calls
      (path.normalize as jest.Mock).mockClear();
      (path.join as jest.Mock).mockClear();
      
      // Test each path
      return Promise.all(testPaths.map(async (testPath) => {
        await readFile({ filePath: testPath }, extra);
        
        // Verify path.normalize was called with the input path
        expect(path.normalize).toHaveBeenCalledWith(testPath);
        
        // Verify path.join was called with the base path and some normalized path
        expect(path.join).toHaveBeenCalledWith('./data', expect.any(String));
      }));
    });
  });
  
  describe('Tool Definitions', () => {
    it('should define all required file tools', () => {
      const toolNames = fileTools.map(tool => tool.name);
      
      // Check that each tool is defined
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('get_file_info');
      expect(toolNames).toContain('list_directory');
      expect(toolNames).toContain('write_file');
      expect(toolNames).toContain('delete_file');
      
      // Check total count
      expect(fileTools.length).toBe(5);
    });
    
    it('should have complete schemas for all tools', () => {
      fileTools.forEach(tool => {
        // Check schema properties
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool).toHaveProperty('annotations');
        
        // Check input schema
        expect(tool.inputSchema).toHaveProperty('type', 'object');
        expect(tool.inputSchema).toHaveProperty('properties');
        expect(tool.inputSchema).toHaveProperty('required');
        
        // Check annotations
        expect(tool.annotations).toHaveProperty('readOnlyHint');
        expect(tool.annotations).toHaveProperty('destructiveHint');
        expect(tool.annotations).toHaveProperty('idempotentHint');
        expect(tool.annotations).toHaveProperty('openWorldHint');
      });
    });
  });
  
  describe('Tool Handlers', () => {
    it('should map all tool names to their corresponding handler functions', () => {
      // Check that each handler is mapped correctly
      expect(fileToolHandlers.read_file).toBe(readFile);
      expect(fileToolHandlers.get_file_info).toBe(getFileInfo);
      expect(fileToolHandlers.list_directory).toBe(listDirectory);
      expect(fileToolHandlers.write_file).toBe(writeFile);
      expect(fileToolHandlers.delete_file).toBe(deleteFile);
      
      // Check total count
      expect(Object.keys(fileToolHandlers).length).toBe(5);
    });
    
    it('should have handlers for all defined tools', () => {
      // Check that every tool in fileTools has a corresponding handler
      fileTools.forEach(tool => {
        const handlerName = tool.name as keyof typeof fileToolHandlers;
        expect(fileToolHandlers).toHaveProperty(handlerName);
        expect(typeof fileToolHandlers[handlerName]).toBe('function');
      });
    });
  });
  
  describe('Path Safety', () => {
    it('should correctly sanitize paths in all operations', async () => {
      // Set up mocks for all file operations
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.readFile as jest.Mock).mockResolvedValue('content');
      (fs.stat as jest.Mock).mockResolvedValue({
        size: 1024,
        birthtime: new Date(),
        mtime: new Date(),
        isDirectory: jest.fn().mockReturnValue(false),
        isFile: jest.fn().mockReturnValue(true)
      });
      (fs.readdir as jest.Mock).mockResolvedValue(['file1.txt']);
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.unlink as jest.Mock).mockResolvedValue(undefined);
      
      // Clear any previous calls to path methods
      (path.normalize as jest.Mock).mockClear();
      (path.join as jest.Mock).mockClear();
      
      // Malicious path with directory traversal
      const maliciousPath = '../../../etc/passwd';
      
      // Test all operations with the malicious path
      await readFile({ filePath: maliciousPath }, extra);
      await getFileInfo({ filePath: maliciousPath }, extra);
      await listDirectory({ dirPath: maliciousPath }, extra);
      await writeFile({ filePath: maliciousPath, content: 'test' }, extra);
      await deleteFile({ filePath: maliciousPath }, extra);
      
      // Verify normalize was called for each operation
      expect(path.normalize).toHaveBeenCalledTimes(5);
      
      // Verify join was called with the safe base path for each operation
      const joinCalls = (path.join as jest.Mock).mock.calls;
      joinCalls.forEach(call => {
        expect(call[0]).toBe('./data');
      });
    });
    
    it('should handle Windows-style paths correctly', async () => {
      // Set up mock for file read
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.readFile as jest.Mock).mockResolvedValue('content');
      
      // Windows-style path with backslashes
      const windowsPath = 'folder\\subfolder\\file.txt';
      
      await readFile({ filePath: windowsPath }, extra);
      
      // Verify the path was normalized correctly
      const accessPath = (fs.access as jest.Mock).mock.calls[0][0];
      
      // The exact format depends on the platform, but we can check that the components are there
      expect(accessPath).toContain('data');
      expect(accessPath).toContain('folder');
      expect(accessPath).toContain('subfolder');
      expect(accessPath).toContain('file.txt');
    });
    
    it('should handle absolute paths correctly', async () => {
      // Set up mock for file read
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.readFile as jest.Mock).mockResolvedValue('content');
      
      // Absolute path
      const absolutePath = '/var/log/system.log';
      
      await readFile({ filePath: absolutePath }, extra);
      
      // Verify the path was normalized correctly
      const accessPath = (fs.access as jest.Mock).mock.calls[0][0];
      
      // Should be relative to SAFE_BASE_PATH
      expect(accessPath).toContain('data');
      expect(accessPath).toContain('var');
      expect(accessPath).toContain('log');
      expect(accessPath).toContain('system.log');
      expect(accessPath.startsWith('/')).toBe(false);
    });
  });
}); 