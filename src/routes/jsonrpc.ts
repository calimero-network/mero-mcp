import express from 'express';
import { fileTools, fileToolHandlers } from '../tools/fileTools';
import logger from '../utils/logger';

const router = express.Router();

/**
 * POST /jsonrpc
 * JSON-RPC 2.0 compatible endpoint for Cursor
 */
router.post('/', async (req, res) => {
  try {
    const { id, method, params } = req.body;
    
    // Validate request
    if (!id || !method) {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request' },
        id: id || null
      });
    }
    
    // Method handler for listing tools
    if (method === 'listTools') {
      const toolsList = fileTools.map(tool => ({
        name: tool.name,
        description: tool.description || "",
        inputSchema: tool.inputSchema,
        annotations: tool.annotations || {}
      }));
      
      logger.info("JSON-RPC listTools called", { count: toolsList.length });
      
      return res.json({
        jsonrpc: '2.0',
        result: { tools: toolsList },
        id
      });
    }
    
    // Method handler for executing tools
    if (method === 'executeTool') {
      const { name, parameters } = params || {};
      
      if (!name) {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32602, message: 'Invalid params: tool name is required' },
          id
        });
      }
      
      const handler = fileToolHandlers[name as keyof typeof fileToolHandlers];
      if (!handler) {
        return res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32601, message: `Tool '${name}' not found` },
          id
        });
      }
      
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        
        // Execute the tool
        const result = await handler(parameters || {}, { signal: controller.signal });
        clearTimeout(timeout);
        
        logger.info(`JSON-RPC executeTool called for ${name}`);
        
        return res.json({
          jsonrpc: '2.0',
          result,
          id
        });
      } catch (error) {
        logger.error(`Error executing tool ${name}`, { error });
        return res.status(500).json({
          jsonrpc: '2.0',
          error: { 
            code: -32000, 
            message: `Error executing tool: ${error instanceof Error ? error.message : String(error)}` 
          },
          id
        });
      }
    }
    
    // Method handler for server config
    if (method === 'getServerConfig') {
      return res.json({
        jsonrpc: '2.0',
        result: {
          name: 'mero-mcp',
          version: '1.0.0',
          capabilities: {
            tools: true,
            resources: true,
            sse: true
          }
        },
        id
      });
    }
    
    // Method not found
    return res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32601, message: `Method '${method}' not found` },
      id
    });
    
  } catch (error) {
    logger.error("JSON-RPC error", { error });
    return res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal JSON-RPC error' },
      id: req.body?.id || null
    });
  }
});

export default router; 