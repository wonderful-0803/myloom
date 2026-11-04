import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, divide } from './calc.js';

test('add works', () => {
  assert.equal(add(2, 3), 5);
});

test('divide by zero must throw (expected after Loom patch)', () => {
  assert.throws(() => divide(10, 0), /zero|Zero|除以零|divisor/i);
});
