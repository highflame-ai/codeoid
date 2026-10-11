/**
 * Where `/mcp/control` is mounted. Its own module so the CLI client
 * (`codeoid mcp config`) can build the URL without importing the endpoint and
 * everything it pulls in.
 */
export const CONTROL_MCP_PATH = "/mcp/control";
