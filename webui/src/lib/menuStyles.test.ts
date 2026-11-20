import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

test('/ and @ menus share command menu selection colors', () => {
  const css = readFileSync(join(root, 'src/styles/app.css'), 'utf8');
  const theme = readFileSync(join(root, 'src/styles/theme.css'), 'utf8');

  assert.match(theme, /--app-command-menu-hover-background:/);
  assert.match(theme, /--app-command-menu-active-background:/);
  assert.match(theme, /--app-command-menu-active-background:color-mix\(in srgb,var\(--app-brand\)/);
  assert.match(theme, /--app-command-menu-active-accent:/);
  assert.match(css, /\.slash-row\.active\s*\{\s*background:\s*var\(--app-command-menu-active-background\)/);
  assert.match(css, /\.at-row\.active\s*\{\s*background:\s*var\(--app-command-menu-active-background\)/);
  assert.match(css, /\.slash-row\.active\s*\{[^}]*--app-command-menu-active-accent/s);
  assert.match(css, /\.at-row\.active\s*\{[^}]*--app-command-menu-active-accent/s);
  assert.match(css, /\.slash-row:hover\s*\{\s*background:\s*var\(--app-command-menu-hover-background\)/);
  assert.match(css, /\.at-row:hover\s*\{\s*background:\s*var\(--app-command-menu-hover-background\)/);
});

test('approval modes use canonical order and label bypass wire mode as Auto', () => {
  const selector = readFileSync(join(root, 'src/components/ModeSelector.tsx'), 'utf8');
  const messages = readFileSync(join(root, 'src/i18n.ts'), 'utf8');
  const build = selector.indexOf("val: 'build'");
  const acceptEdits = selector.indexOf("val: 'accept_edits'");
  const auto = selector.indexOf("val: 'bypass', label: 'mode.auto'");
  const plan = selector.indexOf("val: 'plan'");

  assert.ok(build >= 0);
  assert.ok(build < acceptEdits);
  assert.ok(acceptEdits < auto);
  assert.ok(auto < plan);
  assert.doesNotMatch(selector, /label:\s*'mode\.bypass'/);
  assert.match(messages, /'mode\.auto':\s*'Auto'/);
  assert.doesNotMatch(messages, /'mode\.bypass':/);
});

test('ModeSelector places settings gear before global switch and SystemSettingsDialog exposes Agent Mode options', () => {
  const selector = readFileSync(join(root, 'src/components/ModeSelector.tsx'), 'utf8');
  const dialog = readFileSync(join(root, 'src/components/SystemSettingsDialog.tsx'), 'utf8');

  const controlsIdx = selector.indexOf('mode-global-controls');
  const settingsBtnIdx = selector.indexOf('mode-settings-btn');
  const switchIdx = selector.indexOf('mode-global-switch');
  assert.ok(controlsIdx >= 0 && settingsBtnIdx > controlsIdx && switchIdx > settingsBtnIdx);
  assert.match(selector, /onOpenModeSettings/);

  assert.match(dialog, /name="agent_mode_policy"/);
  assert.match(dialog, /value="memory"/);
  assert.match(dialog, /value="global"/);
  assert.match(dialog, /value="build"/);
  assert.match(dialog, /value="plan"/);
  assert.match(dialog, /value="accept_edits"/);
  assert.match(dialog, /value="bypass"/);
});
