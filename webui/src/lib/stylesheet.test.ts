import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import postcss from 'postcss';
import type { Root } from 'postcss';
import config from '../../postcss.config.js';

const stylesheet = new URL('../index.css', import.meta.url);

async function renderStyles() {
  // Plugin names come from the active PostCSS configuration, not a fixed test pipeline.
  const plugins = await Promise.all(Object.entries(config.plugins).map(async ([name, options]) => {
    const { default: plugin } = await import(name);
    return plugin(options);
  }));
  return postcss(plugins).process(readFileSync(stylesheet, 'utf8'), {
    from: fileURLToPath(stylesheet),
  });
}

function declarations(root: Root, selector: string): Record<string, string> {
  const values: Record<string, string> = {};
  root.walkRules((rule) => {
    if (rule.selectors.includes(selector)) {
      rule.walkDecls((declaration) => {
        values[declaration.prop] = declaration.value;
      });
    }
  });
  return values;
}

test('browser reset preserves layout, typography, controls, and media defaults', async () => {
  const { root } = await renderStyles();
  const universal = declarations(root, '*');
  assert.equal(universal['box-sizing'], 'border-box');
  assert.equal(universal['border-width'], '0');
  assert.equal(universal['border-style'], 'solid');
  assert.equal(declarations(root, 'body').margin, '0');
  assert.equal(declarations(root, 'body')['line-height'], 'inherit');
  assert.equal(declarations(root, 'h1')['font-size'], 'inherit');
  assert.equal(declarations(root, 'h1')['font-weight'], 'inherit');
  assert.equal(declarations(root, 'button')['font-family'], 'inherit');
  assert.equal(declarations(root, 'button')['background-color'], 'transparent');
  assert.equal(declarations(root, ':disabled').cursor, 'default');
  assert.equal(declarations(root, 'textarea').resize, 'vertical');
  assert.equal(declarations(root, 'img').display, 'block');
  assert.equal(declarations(root, 'img')['max-width'], '100%');
  assert.equal(declarations(root, 'svg')['vertical-align'], 'middle');
  assert.equal(declarations(root, '[hidden]:where(:not([hidden="until-found"]))').display, 'none');
});

