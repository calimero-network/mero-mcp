import express from 'express';
import { fileTools } from '../tools/fileTools';
import logger from '../utils/logger';

const router = express.Router();

/**
 * GET /api/tools
 * Returns a list of all available tools with their schemas
 */
router.get('/', (req, res) => {
  try {
    // Return a list of all registered tools with their schemas
    const toolsList = fileTools.map(tool => ({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema,
      annotations: tool.annotations || {}
    }));
    
    res.json({ tools: toolsList });
    logger.info("Tools metadata requested", { count: toolsList.length });
  } catch (error) {
    logger.error("Error serving tools metadata", { error });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/tools/:name
 * Get the definition for a specific tool
 */
router.get('/:name', (req, res) => {
  try {
    const { name } = req.params;
    const tool = fileTools.find(t => t.name === name);
    
    if (!tool) {
      return res.status(404).json({ error: `Tool '${name}' not found` });
    }
    
    res.json({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema,
      annotations: tool.annotations || {}
    });
  } catch (error) {
    logger.error("Error serving tool metadata", { error });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router; 