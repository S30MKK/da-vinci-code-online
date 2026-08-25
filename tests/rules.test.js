'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../server');

test('牌堆：26 张，黑白 0-11 各 12，Joker 2', () => {
  const deck = S.makeDeck();
  assert.strictEqual(deck.length, 26);
  const blacks = deck.filter(t => t.color === 'b' && !t.joker);
  const whites = deck.filter(t => t.color === 'w' && !t.joker);
  const jokers = deck.filter(t => t.joker);
  assert.strictEqual(blacks.length, 12);
  assert.strictEqual(whites.length, 12);
  assert.strictEqual(jokers.length, 2);
  assert.deepStrictEqual(blacks.map(t => t.number).sort((a, b) => a - b), [...Array(12).keys()]);
});

test('排序：黑0 < 白0 < 黑1 < 白1 < ... < 黑11 < 白11', () => {
  const b0 = { color: 'b', number: 0, joker: false };
  const w0 = { color: 'w', number: 0, joker: false };
  const b1 = { color: 'b', number: 1, joker: false };
  const w11 = { color: 'w', number: 11, joker: false };
  const b11 = { color: 'b', number: 11, joker: false };
  assert.ok(S.compareTiles(b0, w0) < 0);
  assert.ok(S.compareTiles(w0, b1) < 0);
  assert.ok(S.compareTiles(b1, w1()) < 0);
  assert.ok(S.compareTiles(w1(), w11) < 0);
  assert.ok(S.compareTiles(b11, w11) < 0);
  const j = { joker: true };
  assert.strictEqual(S.compareTiles(j, b0), 0); // Joker 百搭
  assert.strictEqual(S.compareTiles(b0, j), 0);
});

function w1() { return { color: 'w', number: 1, joker: false }; }

test('猜牌概率：公开信息近似估算', () => {
  const room = { seats: [null, null, null, null], removed: new Set(), drawPile: [] };
  const guesser = { index: 0, tiles: [{ id: 0, color: 'b', number: 0, joker: false, revealed: false, known: true }] };
  const target = {
    index: 1,
    tiles: [
      { id: 17, color: 'w', number: 5, joker: false, revealed: false },
      { id: 9, color: 'b', number: 9, joker: false, revealed: false }
    ]
  };
  room.seats[0] = guesser;
  room.seats[1] = target;

  // 无明牌约束：25 个未知（23 数字 + 2 Joker），白色5可行 -> 1/25
  const p1 = S.estimateGuessProbability(room, guesser, target, 0, 'w', 5);
  assert.ok(Math.abs(p1 - 1 / 25) < 1e-9, 'p1=' + p1);

  // 明牌约束：位置 1 左侧明牌黑3（rank 6），猜黑1（rank 2）不可行 -> 0
  target.tiles[0] = { id: 6, color: 'b', number: 3, joker: false, revealed: true };
  const p2 = S.estimateGuessProbability(room, guesser, target, 1, 'b', 1);
  assert.strictEqual(p2, 0);
  const p3 = S.estimateGuessProbability(room, guesser, target, 1, 'w', 9);
  assert.ok(p3 > 0, 'p3=' + p3);
});

test('评分：范围与高低', () => {
  const room = {
    seats: [null, null, null, null],
    winner: 0
  };
  const s0 = S.makeSeat(0, '甲', false);
  s0.stats = {
    draws: [{ joker: false, number: 10 }, { joker: false, number: 11 }],
    guesses: 2, correctGuesses: 2, expectedHits: 0.2,
    highProbGuesses: 0, highProbHits: 0,
    guessedAgainst: 1, guessedCorrectAgainst: 0, lowProbCorrectAgainst: 0,
    eliminations: 1
  };
  const s1 = S.makeSeat(1, '乙', false);
  s1.stats = {
    draws: [{ joker: false, number: 0 }, { joker: false, number: 1 }],
    guesses: 2, correctGuesses: 0, expectedHits: 1.5,
    highProbGuesses: 2, highProbHits: 0,
    guessedAgainst: 3, guessedCorrectAgainst: 3, lowProbCorrectAgainst: 3,
    eliminations: 0
  };
  room.seats[0] = s0;
  room.seats[1] = s1;
  const sc = S.computeScoring(room);
  assert.ok(sc[0].score >= 0 && sc[0].score <= 100);
  assert.ok(sc[1].score >= 0 && sc[1].score <= 100);
  assert.ok(sc[0].skill > sc[1].skill, `${sc[0].skill} > ${sc[1].skill}`);
  assert.ok(sc[0].luck > sc[1].luck, `${sc[0].luck} > ${sc[1].luck}`);
});

test('积分增减：胜者加分、负者减分（同分对手）', () => {
  const room = {
    seats: [null, null, null, null],
    winner: 0
  };
  const s0 = S.makeSeat(0, '甲', false);
  const s1 = S.makeSeat(1, '乙', false);
  s0.stats = { draws: [], guesses: 1, correctGuesses: 1, expectedHits: 0.5, highProbGuesses: 0, highProbHits: 0, guessedAgainst: 0, guessedCorrectAgainst: 0, lowProbCorrectAgainst: 0, eliminations: 0 };
  s1.stats = { draws: [], guesses: 1, correctGuesses: 0, expectedHits: 0.5, highProbGuesses: 0, highProbHits: 0, guessedAgainst: 0, guessedCorrectAgainst: 0, lowProbCorrectAgainst: 0, eliminations: 0 };
  room.seats[0] = s0;
  room.seats[1] = s1;
  const sc = S.computeScoring(room);
  const d = S.computeRatingDeltas(room, sc);
  assert.ok(d[0] > 0, 'winner delta=' + d[0]);
  assert.ok(d[1] < 0, 'loser delta=' + d[1]);
});
test('猜牌概率：抽牌选择牌堆后颜色公开', () => {
  const room = { seats: [null, null, null, null], removed: new Set(), drawPile: [] };
  const guesser = { index: 0, tiles: [{ id: 0, color: 'b', number: 0, joker: false, revealed: false, known: true }] };
  // 目标第 0 张是从黑牌堆抽的（颜色公开，数字未知）
  const target = {
    index: 1,
    tiles: [
      { id: 9, color: 'b', number: 5, joker: false, revealed: false, pile: 'b' }
    ]
  };
  room.seats[0] = guesser;
  room.seats[1] = target;
  // 猜白色必然错误
  const pWhite = S.estimateGuessProbability(room, guesser, target, 0, 'w', 5);
  assert.strictEqual(pWhite, 0);
  // 猜黑色可行（黑牌堆里剩余的黑数字牌 + 黑 Joker）
  const pBlack = S.estimateGuessProbability(room, guesser, target, 0, 'b', 5);
  assert.ok(pBlack > 0, 'pBlack=' + pBlack);
});