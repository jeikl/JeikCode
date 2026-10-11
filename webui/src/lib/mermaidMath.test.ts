import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type katex from 'katex';

// Resolve the renderer used by Mermaid, including when npm installs it separately.
const mermaidKatex: Pick<typeof katex, 'renderToString'> = createRequire(import.meta.resolve('mermaid'))('katex');
const options = { throwOnError: true, displayMode: true };

test('Mermaid math preserves fractions and both supported output modes', () => {
  for (const output of ['mathml', 'htmlAndMathml'] as const) {
    const html = mermaidKatex.renderToString(String.raw`\frac{x^2}{2}`, { ...options, output });
    assert.match(html, /<math\b/);
    assert.match(html, /<mfrac>/);
    assert.match(html, /<msup>/);
    if (output === 'htmlAndMathml') assert.match(html, /class="katex-html"/);
  }
});

test('Mermaid math rejects malformed expressions instead of returning broken markup', () => {
  assert.throws(() => mermaidKatex.renderToString(String.raw`\frac{1`, { ...options, output: 'mathml' }));
});

test('Mermaid math ignores inherited trust when rendering untrusted labels', () => {
  const previousTrust = Object.getOwnPropertyDescriptor(Object.prototype, 'trust');
  try {
    Object.defineProperty(Object.prototype, 'trust', { value: true, writable: true, configurable: true });
    const html = mermaidKatex.renderToString(String.raw`\href{javascript:alert(1)}{click}`, {
      ...options,
      output: 'htmlAndMathml',
    });
    assert.doesNotMatch(html, /<a\b|href="javascript:/i);
  } finally {
    if (previousTrust) Object.defineProperty(Object.prototype, 'trust', previousTrust);
    else Reflect.deleteProperty(Object.prototype, 'trust');
  }
});
