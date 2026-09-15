import assert from 'node:assert/strict';
import test from 'node:test';
import { modelAliasLabel, modelSourceLabel } from './modelLabel.ts';

test('alias is the selection id', () => {
  assert.equal(
    modelAliasLabel({ provider: 'gemini-3.8-flash-high' }),
    'gemini-3.8-flash-high',
  );
});

test('source is account/modelId', () => {
  assert.equal(
    modelSourceLabel({
      account: 'maxmd',
      model: 'deepseek-v4-flash-0731',
      provider_type: 'openai',
    }),
    'maxmd/deepseek-v4-flash-0731',
  );
});

test('source falls back to provider_type/modelId without account', () => {
  assert.equal(
    modelSourceLabel({
      model: 'MiniMax-M3',
      provider_type: 'openai',
    }),
    'openai/MiniMax-M3',
  );
});
