import { Tool, ToolAnnotations, Content, ResourceContent } from '../types/mcp/schema';
import { fileTools, readFile } from '../tools/fileTools';
import { FileSystemResourceProvider } from '../resources/fileSystemResource';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';

describe('MCP Schema Compliance', () => {
  describe('Tool Schema', () => {
    it('should have valid Tool interfaces', () => {
      for (const tool of fileTools) {
        // Check required properties
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool.inputSchema).toHaveProperty('type', 'object');
        
        // Check optional properties
        if (tool.description) {
          expect(typeof tool.description).toBe('string');
        }
        
        if (tool.inputSchema.properties) {
          expect(typeof tool.inputSchema.properties).toBe('object');
        }
        
        if (tool.inputSchema.required) {
          expect(Array.isArray(tool.inputSchema.required)).toBe(true);
        }
        
        // Check annotations
        if (tool.annotations) {
          validateToolAnnotations(tool.annotations);
        }
      }
    });
    
    it('should have tools with all annotation types', () => {
      // Find at least one tool with readOnlyHint = true
      const readOnlyTool = fileTools.find(tool => tool.annotations?.readOnlyHint === true);
      expect(readOnlyTool).toBeDefined();
      
      // Find at least one tool with destructiveHint = true
      const destructiveTool = fileTools.find(tool => tool.annotations?.destructiveHint === true);
      expect(destructiveTool).toBeDefined();
    });
  });
  
  describe('Tool Handler', () => {
    it('should return content with the correct structure', async () => {
      // Create a test file
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-'));
      const filePath = path.join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'Test content');
      
      try {
        // Call the tool handler
        const signal = new AbortController().signal;
        const result = await readFile({ filePath: filePath.replace(tempDir, '') }, { signal });
        
        // Validate the result structure
        expect(result).toHaveProperty('content');
        expect(Array.isArray(result.content)).toBe(true);
        expect(result.content.length).toBeGreaterThan(0);
        
        for (const item of result.content) {
          expect(item).toHaveProperty('type');
          expect(item).toHaveProperty('text');
          expect(typeof item.text).toBe('string');
        }
      } finally {
        // Clean up
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
  
  describe('Resource Provider', () => {
    let tempDir: string;
    let resourceProvider: FileSystemResourceProvider;
    
    beforeEach(async () => {
      // Create a test directory
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-resource-test-'));
      
      // Create a file in the test directory
      await fs.writeFile(path.join(tempDir, 'test.txt'), 'Test resource content');
      
      // Create the resource provider
      resourceProvider = new FileSystemResourceProvider(tempDir);
    });
    
    afterEach(async () => {
      // Clean up
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    });
    
    it('should handle resource requests according to the MCP spec', async () => {
      // Create a test URI and variables
      const uri = new URL('file:///test.txt');
      const variables = { id: 'test-id' };
      
      // Call the handler
      const result = await resourceProvider.handleResource(uri, variables);
      
      // Validate the result structure
      expect(result).toHaveProperty('contents');
      expect(Array.isArray(result.contents)).toBe(true);
      
      for (const content of result.contents) {
        validateResourceContent(content);
      }
    });
    
    it('should handle URI template variables', async () => {
      // Create a file with a variable in the name
      await fs.writeFile(path.join(tempDir, 'var-test.txt'), 'Variable content');
      
      // Create a test URI with a variable and variables
      const uri = new URL('file:///{varname}.txt');
      const variables = { varname: 'var-test' };
      
      // Call the handler
      const result = await resourceProvider.handleResource(uri, variables);
      
      // Validate the result
      expect(result.contents[0].text).toBe('Variable content');
    });
  });
});

/**
 * Helper function to validate ToolAnnotations
 */
function validateToolAnnotations(annotations: ToolAnnotations): void {
  if (annotations.readOnlyHint !== undefined) {
    expect(typeof annotations.readOnlyHint).toBe('boolean');
  }
  
  if (annotations.destructiveHint !== undefined) {
    expect(typeof annotations.destructiveHint).toBe('boolean');
  }
  
  if (annotations.idempotentHint !== undefined) {
    expect(typeof annotations.idempotentHint).toBe('boolean');
  }
  
  if (annotations.openWorldHint !== undefined) {
    expect(typeof annotations.openWorldHint).toBe('boolean');
  }
}

/**
 * Helper function to validate ResourceContent
 */
function validateResourceContent(content: ResourceContent): void {
  expect(content).toHaveProperty('uri');
  expect(typeof content.uri).toBe('string');
  
  expect(content).toHaveProperty('text');
  expect(typeof content.text).toBe('string');
} 