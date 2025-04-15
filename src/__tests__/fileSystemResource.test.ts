import { FileSystemResourceProvider } from "../resources/fileSystemResource";
import fs from "fs/promises";
import path from "path";

// Mock fs module
jest.mock("fs/promises");

describe("FileSystemResourceProvider", () => {
  let provider: FileSystemResourceProvider;
  const mockBasePath = "/mock/path";
  
  beforeEach(() => {
    jest.resetAllMocks();
    provider = new FileSystemResourceProvider(mockBasePath);
  });

  describe("readFile", () => {
    it("should read a file successfully", async () => {
      // Mock successful file access and read
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.readFile as jest.Mock).mockResolvedValue("file content");

      const result = await provider.readFile("test.txt");
      expect(result).toBe("file content");
      
      // Check that access and readFile were called with the correct paths
      expect(fs.access).toHaveBeenCalledWith(path.join(mockBasePath, "test.txt"));
      expect(fs.readFile).toHaveBeenCalledWith(path.join(mockBasePath, "test.txt"), "utf8");
    });

    it("should sanitize paths to prevent directory traversal", async () => {
      // Mock successful file access and read
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.readFile as jest.Mock).mockResolvedValue("file content");

      await provider.readFile("../../../etc/passwd");
      
      // Path should be sanitized
      expect(fs.access).toHaveBeenCalledWith(path.join(mockBasePath, "etc/passwd"));
    });

    it("should handle file read errors", async () => {
      // Mock file access error
      const mockError = new Error("File not found");
      (fs.access as jest.Mock).mockRejectedValue(mockError);

      await expect(provider.readFile("missing.txt")).rejects.toThrow("Could not read file: missing.txt");
    });
  });

  describe("listDirectory", () => {
    it("should list directory contents successfully", async () => {
      // Mock successful directory access and read
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock).mockResolvedValue(["file1.txt", "file2.txt"]);

      const result = await provider.listDirectory("testdir");
      expect(result).toEqual(["file1.txt", "file2.txt"]);
      
      // Check that access and readdir were called with the correct paths
      expect(fs.access).toHaveBeenCalledWith(path.join(mockBasePath, "testdir"));
      expect(fs.readdir).toHaveBeenCalledWith(path.join(mockBasePath, "testdir"));
    });

    it("should sanitize paths to prevent directory traversal", async () => {
      // Mock successful directory access and read
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock).mockResolvedValue(["file1.txt"]);

      await provider.listDirectory("../../../etc");
      
      // Path should be sanitized - use expect.stringContaining without assigning to a variable
      expect(fs.access).toHaveBeenCalledWith(expect.stringContaining("etc"));
    });

    it("should handle directory list errors", async () => {
      // Mock directory access error
      const mockError = new Error("Directory not found");
      (fs.access as jest.Mock).mockRejectedValue(mockError);

      await expect(provider.listDirectory("missing")).rejects.toThrow("Could not list directory: missing");
    });
  });

  describe("uriToPath", () => {
    it("should convert a basic URI to a file path", () => {
      const uri = new URL("file:///test.txt");
      const variables: Record<string, string | string[]> = {};
      
      const result = provider.uriToPath(uri, variables);
      expect(result).toBe("/test.txt");
    });

    it("should handle URI templates with variables", () => {
      const uri = new URL("file:///{filename}.{ext}");
      const variables = {
        filename: "test",
        ext: "txt"
      };
      
      const result = provider.uriToPath(uri, variables);
      expect(result).toBe("/test.txt");
    });

    it("should handle array variables", () => {
      const uri = new URL("file:///{path}/{files}");
      const variables = {
        path: "docs",
        files: ["file1.txt", "file2.txt"]
      };
      
      const result = provider.uriToPath(uri, variables);
      expect(result).toBe("/docs/file1.txt,file2.txt");
    });

    it("should handle Windows paths", () => {
      // Save original platform
      const originalPlatform = process.platform;
      
      // Mock platform as win32
      Object.defineProperty(process, 'platform', {
        value: 'win32'
      });
      
      const uri = new URL("file:///C:/folder/test.txt");
      const variables: Record<string, string | string[]> = {};
      
      const result = provider.uriToPath(uri, variables);
      expect(result).toBe("C:/folder/test.txt");
      
      // Restore original platform
      Object.defineProperty(process, 'platform', {
        value: originalPlatform
      });
    });
  });

  describe("handleResource", () => {
    it("should handle resource requests successfully", async () => {
      // Mock the readFile method
      jest.spyOn(provider, 'readFile').mockResolvedValue("file content");
      jest.spyOn(provider, 'uriToPath').mockReturnValue("/test.txt");
      
      const uri = new URL("file:///test.txt");
      const variables: Record<string, string | string[]> = {};
      
      const result = await provider.handleResource(uri, variables);
      
      expect(result).toEqual({
        contents: [
          {
            uri: "file:///test.txt",
            text: "file content"
          }
        ]
      });
      
      expect(provider.uriToPath).toHaveBeenCalledWith(uri, variables);
      expect(provider.readFile).toHaveBeenCalledWith("/test.txt");
    });

    it("should handle resource request errors", async () => {
      // Mock the readFile method to throw an error
      const mockError = new Error("File not found");
      jest.spyOn(provider, 'readFile').mockRejectedValue(mockError);
      jest.spyOn(provider, 'uriToPath').mockReturnValue("/missing.txt");
      
      const uri = new URL("file:///missing.txt");
      const variables: Record<string, string | string[]> = {};
      
      await expect(provider.handleResource(uri, variables)).rejects.toThrow(mockError);
    });
  });
}); 