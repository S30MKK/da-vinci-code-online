'use strict';
// 回归测试：client.js 在真实浏览器等效环境下渲染（含"手牌含Joker的排列阶段"崩溃场景）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function makeHarness() {
  const ids = new Map();
  class El {
    constructor(id) {
      this.id = id; this.hidden = false; this.innerHTML = ''; this.textContent = '';
      this.style = {}; this.className = ''; this.scrollTop = 0; this.scrollHeight = 0;
      this.children = []; this.listeners = {}; this.dataset = {};
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    appendChild(c) { this.children.push(c); }
    remove() {}
    querySelector() { return new El('q'); }
    setAttribute() {}
  }
  const getEl = (id) => { if (!ids.has(id)) ids.set(id, new El(id)); return ids.get(id); };
  const ctx = {
    console,
    document: { getElementById: getEl, createElement: () => new El('dyn'), addEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { protocol: 'http:', host: 'localhost:3000' },
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 1; } send(m) { ctx._sent = ctx._sent || []; ctx._sent.push(m); } close() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ version: 1, players: {} }) }),
    navigator: { clipboard: null }, Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    Date, JSON, Math, Promise, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'client.js'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'client.js' });
  ctx.init();
  return ctx;
}

function jokerArrangingState() {
  return {
    type: 'state', code: '123456', phase: 'arranging', hostSeat: 0,
    currentTurn: null, pendingAction: 'arrange', spectatorView: 'all',
    you: { isSpectator: false, seat: 0 }, drawPileSize: 14, winner: null,
    gameId: 'G1', spectatorCount: 0,
    seats: [
      { index: 0, nickname: '我', isBot: false, connected: true, eliminated: false, isHost: true, tiles: [
        { id: 0, revealed: false, hidden: true, color: 'b', number: 0, joker: false, knownToOwner: true },
        { id: 26, revealed: false, hidden: true, color: 'b', number: null, joker: true, knownToOwner: true },
        { id: 17, revealed: false, hidden: true, color: 'w', number: 5, joker: false, knownToOwner: true }
      ] },
      { index: 1, nickname: '机器人A', isBot: true, connected: true, eliminated: false, isHost: false, tiles: [{ id: 1, revealed: false, hidden: true, color: 'b', number: 2, joker: false, knownToOwner: true }] },
      { index: 2, nickname: '机器人B', isBot: true, connected: true, eliminated: false, isHost: false, tiles: [{ id: 2, revealed: false, hidden: true, color: 'w', number: 3, joker: false, knownToOwner: true }] },
      { index: 3, nickname: '机器人C', isBot: true, connected: true, eliminated: false, isHost: false, tiles: [{ id: 3, revealed: false, hidden: true, color: 'b', number: 4, joker: false, knownToOwner: true }] }
    ]
  };
}

test('渲染：手牌含 Joker 的排列阶段不再崩溃，弹窗可操作', () => {
  const ctx = makeHarness();
  const state = jokerArrangingState();

  assert.doesNotThrow(() => ctx.handleMessage(state));
  assert.strictEqual(ctx.App.arranged, false);
  assert.deepStrictEqual(ctx.App.arrangeOrder, [0, 26, 17]);

  // 点击 Joker 应出现位置按钮
  assert.doesNotThrow(() => { ctx.App.selJoker = 26; ctx.renderArrangeModal(); });
  assert.strictEqual(ctx.App.selJoker, 26);

  // 移动 Joker 到第 1 位
  assert.doesNotThrow(() => ctx.moveJoker(26, 0));
  assert.deepStrictEqual(ctx.App.arrangeOrder, [26, 0, 17]);

  // 确认排列：发送 arrange_done 且不再弹出
  assert.doesNotThrow(() => ctx.confirmArrange());
  assert.strictEqual(ctx.App.arranged, true);
  const sent = (ctx._sent || []).map((m) => JSON.parse(m));
  assert.ok(sent.some((m) => m.type === 'arrange_done' && JSON.stringify(m.positions) === '[26,0,17]'));
});

test('渲染：对局各阶段状态均可正常处理（含机器人回合与结算）', () => {
  const ctx = makeHarness();
  const base = (phase, turn, act) => ({
    type: 'state', code: '123456', phase, hostSeat: 0, currentTurn: turn, pendingAction: act,
    spectatorView: 'all', you: { isSpectator: false, seat: 0 }, drawPileSize: 13, winner: null,
    gameId: 'G1', spectatorCount: 0,
    seats: [
      { index: 0, nickname: '我', isBot: false, connected: true, eliminated: false, isHost: true, tiles: [
        { id: 0, revealed: false, hidden: true, color: 'b', number: 0, joker: false, knownToOwner: true },
        { id: 26, revealed: false, hidden: true, color: 'b', number: null, joker: true, knownToOwner: true },
        { id: 17, revealed: false, hidden: true, color: 'w', number: 5, joker: false, knownToOwner: true }
      ] },
      { index: 1, nickname: '机器人A', isBot: true, connected: true, eliminated: false, isHost: false, tiles: [{ id: 1, revealed: false, hidden: true, color: 'b', number: 2, joker: false, knownToOwner: true }] },
      { index: 2, nickname: '机器人B', isBot: true, connected: true, eliminated: false, isHost: false, tiles: [{ id: 2, revealed: true, hidden: false, color: 'w', number: 3, joker: false, knownToOwner: false }] },
      { index: 3, nickname: '机器人C', isBot: true, connected: true, eliminated: false, isHost: false, tiles: [{ id: 3, revealed: false, hidden: true, color: 'b', number: 4, joker: false, knownToOwner: true }] }
    ]
  });
  const cases = [
    ['房间', base('lobby', null, 'wait')],
    ['排列', base('arranging', null, 'arrange')],
    ['抽牌', base('playing', 0, 'draw')],
    ['放置', base('playing', 0, 'place')],
    ['猜牌', base('playing', 0, 'guess')],
    ['翻牌', base('playing', 0, 'reveal')],
    ['机器人回合', base('playing', 1, 'draw')],
    ['结束', Object.assign(base('ended', 2, 'wait'), { winner: 2 })]
  ];
  for (const [name, st] of cases) {
    assert.doesNotThrow(() => ctx.handleMessage(JSON.parse(JSON.stringify(st))), name);
  }
  assert.doesNotThrow(() => ctx.handleMessage({
    type: 'game_over', winner: 2,
    results: [{ nickname: '机器人C', seat: 2, result: 'win', score: 80, skill: 85, luck: 70, ratingDelta: 15 }],
    gameId: 'G1'
  }));
});
