// Mirror of the TUI's `display_tool_name` (event_loop/mod.rs): MCP wire names
// `mcp__server__tool` render as `mcp · server · tool`; everything else is
// snake_case → PascalCase (`read_file` → `ReadFile`).
export function displayToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const i = rest.indexOf('__');
    if (i >= 0) return `mcp · ${rest.slice(0, i)} · ${rest.slice(i + 2)}`;
  }
  return name
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
