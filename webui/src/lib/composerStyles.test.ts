import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

test('landing composer starts at single-line text row and keeps shared auto-growth behavior', () => {
  const chat = readFileSync(join(root, 'src/components/Chat.tsx'), 'utf8');
  const css = readFileSync(join(root, 'src/styles/app.css'), 'utf8');

  assert.match(chat, /class="message-input[^"]*"\s*\n\s*rows=\{1\}/);
  assert.match(css, /\.message-input\s*\{[^}]*min-height:\s*3em;/s);
  assert.doesNotMatch(css, /\.landing-inner \.message-input\s*\{[^}]*min-height:/s);
  assert.match(chat, /ta\.style\.height = Math\.min\(ta\.scrollHeight, 160\) \+ 'px';/);
});

test('landing review shortcut uses the supported review command', () => {
  const chat = readFileSync(join(root, 'src/components/Chat.tsx'), 'utf8');
  const i18n = readFileSync(join(root, 'src/i18n.ts'), 'utf8');

  assert.match(chat, /insert: '\/review '/);
  assert.doesNotMatch(chat, /insert: '\/code-review '/);
  assert.match(i18n, /'chat\.chipReview': '\/review /);
  assert.doesNotMatch(i18n, /'chat\.chipReview': '\/code-review /);
});

test('mobile composer integrates media upload and action controls into a single streamlined row', () => {
  const chat = readFileSync(join(root, 'src/components/Chat.tsx'), 'utf8');
  const css = readFileSync(join(root, 'src/styles/app.css'), 'utf8');

  assert.match(chat, /class="[^"]*input-footer-primary[^"]*"/);
  assert.match(chat, /class="[^"]*input-footer-actions[^"]*"/);
  assert.match(chat, /class="input-turn-controls"/);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*?\.input-footer\s*\{[^}]*flex-direction:\s*row\s*!important;/);
  assert.match(css, /padding:\s*6px 8px max\(8px, env\(safe-area-inset-bottom\)\);/);
});
