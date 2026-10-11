/**
 * Skill identity helpers shared by the sidebar skills menu, the "attach" (+) menu,
 * and the "/" slash menu so all three render the SAME short name.
 *
 * Registry names carry a namespace prefix (`skills:foo`, `plugin:bar`). The menus
 * show and submit only the bare name — the same unqualified form the TUI's skills
 * menu uses (the registry resolves a unique bare name; the model gets the fully
 * qualified name from the injected catalog).
 */
export function bareSkillName(name: string): string {
  const idx = name.lastIndexOf(':');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/** Display form for a skill row: `/foo`. */
export function skillSlashLabel(name: string): string {
  return `/${bareSkillName(name)}`;
}
