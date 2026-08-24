'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-stats-'));
process.env.STATS_FILE = path.join(tmpDir, 'stats.json');

const S = require('../server');

test('战绩：胜/负/连胜/胜率/积分累计', () => {
  S.loadStats();
  S.recordGameResult('小明', { result: 'win', score: 80, skill: 85, luck: 70, ratingDelta: 15, gameId: 'G1' });
  S.recordGameResult('小明', { result: 'win', score: 70, skill: 75, luck: 60, ratingDelta: 10, gameId: 'G2' });
  S.recordGameResult('小明', { result: 'loss', score: 40, skill: 35, luck: 55, ratingDelta: -12, gameId: 'G3' });
  const p = S.getPlayerStats('小明');
  assert.strictEqual(p.games, 3);
  assert.strictEqual(p.wins, 2);
  assert.strictEqual(p.losses, 1);
  assert.strictEqual(p.currentStreak, 0);
  assert.strictEqual(p.bestStreak, 2);
  assert.ok(Math.abs(p.winRate - 0.667) < 1e-9, 'winRate=' + p.winRate);
  assert.strictEqual(p.rating, 1000 + 15 + 10 - 12);
  assert.strictEqual(p.recent.length, 3);
});

test('战绩：最近记录最多保留 20 条', () => {
  for (let i = 0; i < 25; i++) {
    S.recordGameResult('大强', { result: 'loss', score: 50, skill: 50, luck: 50, ratingDelta: -1, gameId: 'G' + i });
  }
  const p = S.getPlayerStats('大强');
  assert.strictEqual(p.recent.length, 20);
  assert.strictEqual(p.games, 25);
});

test('持久化：写入文件后可重新读回', () => {
  S.recordGameResult('小红', { result: 'win', score: 66, skill: 70, luck: 55, ratingDelta: 8, gameId: 'GX' });
  const fresh = { version: 1, players: {} };
  // 模拟重启：重新加载
  S.loadStats();
  const p = S.getPlayerStats('小红');
  assert.ok(p, '小红应存在');
  assert.strictEqual(p.wins, 1);
  assert.ok(fs.existsSync(process.env.STATS_FILE));
  const raw = JSON.parse(fs.readFileSync(process.env.STATS_FILE, 'utf8'));
  assert.strictEqual(raw.players['小红'].rating, 1008);
});

test('容错：损坏的战绩文件自动重建', () => {
  fs.writeFileSync(process.env.STATS_FILE, '{broken json!!!');
  S.loadStats();
  const p = S.getPlayerStats('不存在的人');
  assert.strictEqual(p, null);
  assert.deepStrictEqual(S.getPlayerStats('小明'), null); // 重建后数据清空
  // 重建后仍可正常写入
  S.recordGameResult('新玩家', { result: 'win', score: 60, skill: 60, luck: 60, ratingDelta: 5, gameId: 'GN' });
  assert.strictEqual(S.getPlayerStats('新玩家').games, 1);
});