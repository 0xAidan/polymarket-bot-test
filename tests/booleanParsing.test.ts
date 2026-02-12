import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNullableBooleanInput } from '../src/utils/booleanParsing.js';

test('parseNullableBooleanInput handles nullish values', () => {
  assert.equal(parseNullableBooleanInput(null), null);
  assert.equal(parseNullableBooleanInput(undefined), undefined);
});

test('parseNullableBooleanInput handles booleans directly', () => {
  assert.equal(parseNullableBooleanInput(true), true);
  assert.equal(parseNullableBooleanInput(false), false);
});

test('parseNullableBooleanInput handles truthy/falsy strings', () => {
  assert.equal(parseNullableBooleanInput('true'), true);
  assert.equal(parseNullableBooleanInput('TRUE'), true);
  assert.equal(parseNullableBooleanInput('1'), true);
  assert.equal(parseNullableBooleanInput('yes'), true);
  assert.equal(parseNullableBooleanInput('on'), true);

  assert.equal(parseNullableBooleanInput('false'), false);
  assert.equal(parseNullableBooleanInput('FALSE'), false);
  assert.equal(parseNullableBooleanInput('0'), false);
  assert.equal(parseNullableBooleanInput('no'), false);
  assert.equal(parseNullableBooleanInput('off'), false);
  assert.equal(parseNullableBooleanInput(''), false);
});

test('parseNullableBooleanInput keeps safe fallback behavior', () => {
  assert.equal(parseNullableBooleanInput(1), true);
  assert.equal(parseNullableBooleanInput(0), false);
  assert.equal(parseNullableBooleanInput({}), true);
});
