import type { CommandInfo, SkillInfo } from '../../api';
import { useT } from '../../settings';
import { FRONTEND_COMMANDS, buildSlashMenuItems } from '../../lib/slashCommands';

export function SlashMenu({
  skills,
  userCommands,
  query,
  skillsOnly,
  index,
  onHover,
  onSelect,
}: {
  skills: SkillInfo[];
  userCommands: CommandInfo[];
  query: string;
  skillsOnly: boolean;
  index: number;
  onHover: (index: number) => void;
  onSelect: (name: string) => void;
}) {
  const t = useT();
  const items = buildSlashMenuItems(
    FRONTEND_COMMANDS,
    skills,
    userCommands,
    query,
    t as (k: string) => string,
    skillsOnly,
  );
  return (
    <div class="slash-popover">
      {items.map((item, i) => (
        <button
          key={`${item.kind}:${item.name}`}
          class={'slash-row' + (i === index ? ' active' : '')}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onSelect(item.name); }}
          onMouseEnter={() => onHover(i)}
          type="button"
          title={item.description || ''}
        >
          <span class={'slash-name' + (item.kind === 'skill' ? ' notranslate' : '')} translate={item.kind === 'skill' ? false : undefined}>/{item.name}</span>
          {item.description && (
            <span class={'slash-desc' + (item.kind === 'skill' ? ' notranslate' : '')} translate={item.kind === 'skill' ? false : undefined}>
              {item.description}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
