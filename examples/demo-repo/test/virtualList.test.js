import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleRange, atBottom } from '../src/virtualList.js';

test('初始位置从第 0 行开始', () => {
  assert.deepEqual(visibleRange(100, 0, 300, 50), { start: 0, end: 6 });
});

test('滚动 300px 后从第 6 行开始', () => {
  assert.deepEqual(visibleRange(100, 300, 300, 50), { start: 6, end: 12 });
});

test('滚到底部时不超出总数', () => {
  assert.deepEqual(visibleRange(10, 9999, 300, 50), { start: 4, end: 10 });
});

test('可视区高度不整除行高时不丢最后一行', () => {
  assert.deepEqual(visibleRange(10, 0, 305, 50), { start: 0, end: 7 });
});

test('空列表返回 0,0', () => {
  assert.deepEqual(visibleRange(0, 0, 300, 50), { start: 0, end: 0 });
});

test('只有一屏内容时不算到底', () => {
  assert.equal(atBottom(5, 0, 300, 50), true);
});
