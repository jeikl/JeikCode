import { frontendToolAlias } from '../../lib/toolDisplay';

/**
 * Display-only alias for tool names. Backend names stay unchanged; MCP names
 * render as the actual `server / tool` pair instead of a dead "MCP" string.
 */
export function displayToolName(name: string): string {
  return frontendToolAlias(name);
}
