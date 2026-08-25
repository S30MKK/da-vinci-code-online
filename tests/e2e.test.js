'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-e2e-'));
process.env.STATS_FILE = path.join(tmpDir, 'stats.json');

const S = require('../server');
const { WsTestClient } = require('./wsclient');

const tracked = [];
function track(c) { tracked.push(c); return c; }
// 构造服务端可接受的合法排列：数字牌按 rank 升序，Joker 放最后
function validPositions(tiles) {
  const order = tiles.slice().sort((x, y) => {
    if (x.joker && y.joker) return (x.color === 'b' ? 0 : 1) - (y.color === 'b' ? 0 : 1);
    if (x.joker) return 1;
    if (y.joker) return -1;
    return (x.color === 'b' ? x.number * 2 : x.number * 2 + 1) - (y.color === 'b' ? y.number * 2 : y.number * 2 + 1);
  });
  return order.map(t => t.id);
}

let server;

before(async () => {
  server = await S.startServer({ port: 0 });
});

after(async () => {
  for (const c of tracked) c.close();
  if (server) await server.close();
});

// 测试驱动：从服务端实际状态读取正确答案来猜牌，保证对局必然结束
function makeDriver(client, code) {
  return async () => {
    let guard = 0;
    for (;;) {
      if (++guard > 500) throw new Error('对局驱动超时（步数过多）');
      const st = await client.nextMessage(
        (m) => m.type === 'state' && (m.phase === 'playing' || m.phase === 'ended')
      );
      if (st.phase === 'ended') return st;
      if (st.you.isSpectator || st.you.seat !== st.currentTurn) continue;
      if (st.pendingAction === 'draw') {
        const pile = (st.blackPileSize || 0) > 0 ? 'b' : 'w';
        client.send({ type: 'draw', pile });
      } else if (st.pendingAction === 'place') {
        client.send({ type: 'place_drawn', position: 0 });
      } else if (st.pendingAction === 'guess') {
        const room = S._rooms.get(st.code);
        const seat = room.seats[st.you.seat];
        // 优先猜一张非 Joker 的暗牌（必中）；若对手只剩 Joker，则随便猜（必然猜错）
        let target = room.seats.find(
          (s) => s && !s.eliminated && s.index !== seat.index &&
            s.tiles.some((t) => !t.revealed && !t.joker)
        );
        if (target) {
          const pos = target.tiles.findIndex((t) => !t.revealed && !t.joker);
          const tile = target.tiles[pos];
          client.send({ type: 'guess', target: target.index, position: pos, color: tile.color, number: tile.number });
        } else {
          target = room.seats.find(
            (s) => s && !s.eliminated && s.index !== seat.index && s.tiles.some((t) => !t.revealed)
          );
          const pos = target.tiles.findIndex((t) => !t.revealed);
          client.send({ type: 'guess', target: target.index, position: pos, color: 'b', number: 0 });
        }
      } else if (st.pendingAction === 'reveal') {
        const me = st.seats[st.you.seat];
        const pos = me.tiles.findIndex((t) => !t.revealed);
        client.send({ type: 'reveal_own', position: pos });
      } else if (st.pendingAction === 'discard') {
        const me = st.seats[st.you.seat];
        const pos = me.tiles.findIndex((t) => !t.revealed);
        client.send({ type: 'discard', position: pos });
      } else if (st.pendingAction === 'continue') {
        // 模拟正常玩家：猜对一次就停手，让对局逐回合推进（机器人因此能真实参与）
        client.send({ type: 'stop_turn' });
      }
    }
  };
}

test('端到端：建房/加入/聊天/完整对局/回放/战绩', { timeout: 90000 }, async () => {
  const a = track(new WsTestClient(server.port));
  const b = track(new WsTestClient(server.port));
  await a.connect();
  await b.connect();

  a.send({ type: 'create_room', nickname: '阿甲' });
  const roomState = await a.nextMessage((m) => m.type === 'state');
  assert.strictEqual(roomState.you.seat, 0);
  const code = roomState.code;
  assert.match(code, /^\d{6}$/);

  b.send({ type: 'join_room', nickname: '阿乙', code });
  const bState = await b.nextMessage((m) => m.type === 'state' && m.you.seat != null);
  assert.strictEqual(bState.you.seat, 1);

  // 聊天
  a.send({ type: 'chat', kind: 'text', text: '大家好' });
  const chatMsg = await b.nextMessage((m) => m.type === 'chat' && m.text === '大家好');
  assert.strictEqual(chatMsg.nickname, '阿甲');

  // 开始对局：双方各自确认排列后自动进入对局
  S._rooms.get(code).firstTurn = 0; // 测试固定房主先手
  a.send({ type: 'start_game' });
  const play = async (client) => {
    const st = await client.nextMessage((m) => m.type === 'state' && m.phase === 'arranging');
    const me = st.seats[st.you.seat];
    client.send({ type: 'arrange_done', positions: validPositions(me.tiles) });
    return makeDriver(client, code)();
  };
  const [ra, rb] = await Promise.all([play(a), play(b)]);
  assert.strictEqual(ra.phase, 'ended');
  assert.strictEqual(rb.phase, 'ended');

  // 回放列表与内容
  a.send({ type: 'get_replays' });
  const rl = await a.nextMessage((m) => m.type === 'replay_list');
  assert.ok(rl.replays.length >= 1);
  a.send({ type: 'get_replay', id: rl.replays[0].id });
  const rp = await a.nextMessage((m) => m.type === 'replay');
  assert.ok(rp.replay.events.length > 0);
  assert.ok(rp.replay.results.length === 2);

  // 战绩写入
  a.send({ type: 'get_stats', nickname: '阿甲' });
  const sa = await a.nextMessage((m) => m.type === 'stats' && m.nickname === '阿甲');
  assert.strictEqual(sa.stats.games, 1);
  assert.strictEqual(sa.stats.wins + sa.stats.losses, 1);
  b.send({ type: 'get_stats', nickname: '阿乙' });
  const sb = await b.nextMessage((m) => m.type === 'stats' && m.nickname === '阿乙');
  assert.strictEqual(sb.stats.games, 1);

  a.close();
  b.close();
});

test('断线重连：对局中掉线可凭昵称+房间码回到原座位', { timeout: 30000 }, async () => {
  const a = track(new WsTestClient(server.port));
  const b = track(new WsTestClient(server.port));
  await a.connect();
  await b.connect();

  a.send({ type: 'create_room', nickname: '房主' });
  const roomState = await a.nextMessage((m) => m.type === 'state');
  const code = roomState.code;
  b.send({ type: 'join_room', nickname: '乘客', code });
  const bState = await b.nextMessage((m) => m.type === 'state' && m.you.seat != null);
  const bSeat = bState.you.seat;

  S._rooms.get(code).firstTurn = 0; // 测试固定房主先手
  a.send({ type: 'start_game' });
  const confirm = async (client) => {
    const st = await client.nextMessage((m) => m.type === 'state' && m.phase === 'arranging');
    const me = st.seats[st.you.seat];
    client.send({ type: 'arrange_done', positions: validPositions(me.tiles) });
  };
  await Promise.all([confirm(a), confirm(b)]);
  await a.nextMessage((m) => m.type === 'state' && m.phase === 'playing');

  // b 掉线
  b.close();
  await new Promise((r) => setTimeout(r, 400));
  const notice = await a.nextMessage((m) => m.type === 'notice' && m.text.includes('掉线'));
  assert.ok(notice, '应广播掉线提示');

  // b 重连回原座位
  const b2 = track(new WsTestClient(server.port));
  await b2.connect();
  b2.send({ type: 'join_room', nickname: '乘客', code });
  const rebind = await b2.nextMessage((m) => m.type === 'state' && m.you.seat != null);
  assert.strictEqual(rebind.you.seat, bSeat);

  a.close();
  b2.close();
});

test('猜牌：可猜 Joker（横线），猜中即移除目标牌', { timeout: 30000 }, async () => {
  const a = track(new WsTestClient(server.port));
  const b = track(new WsTestClient(server.port));
  await a.connect();
  await b.connect();
  a.send({ type: 'create_room', nickname: '猜家' });
  const roomState = await a.nextMessage((m) => m.type === 'state');
  const code = roomState.code;
  b.send({ type: 'join_room', nickname: '靶子', code });
  await b.nextMessage((m) => m.type === 'state' && m.you.seat != null);
  S._rooms.get(code).firstTurn = 0; // 测试固定房主先手
  a.send({ type: 'start_game' });
  const confirm = async (client) => {
    const st = await client.nextMessage((m) => m.type === 'state' && m.phase === 'arranging');
    client.send({ type: 'arrange_done', positions: validPositions(st.seats[st.you.seat].tiles) });
  };
  await Promise.all([confirm(a), confirm(b)]);
  await a.nextMessage((m) => m.type === 'state' && m.phase === 'playing');

  // 房主（seat 0）先手；把目标座位一张暗牌强制改为 Joker（测试直连服务端状态）
  const room = S._rooms.get(code);
  const target = room.seats[1];
  const pos = target.tiles.findIndex((t) => !t.revealed);
  assert.ok(pos >= 0, '应有暗牌可猜');
  const tileId = target.tiles[pos].id;
  target.tiles[pos].joker = true;
  target.tiles[pos].number = null;

  // 驱动房主：抽牌 → 放置 → 猜牌
  for (;;) {
    const st = await a.nextMessage((m) => m.type === 'state' && m.phase === 'playing');
    if (st.you.seat !== st.currentTurn) continue;
    if (st.pendingAction === 'draw') {
      a.send({ type: 'draw', pile: (st.blackPileSize || 0) > 0 ? 'b' : 'w' });
    } else if (st.pendingAction === 'place') {
      a.send({ type: 'place_drawn', position: 0 });
    } else if (st.pendingAction === 'guess') {
      break;
    }
  }
  a.send({ type: 'guess', target: 1, position: pos, joker: true });
  const notice = await a.nextMessage((m) => m.type === 'notice' && m.text.includes('猜中') && m.text.includes('Joker'));
  assert.ok(notice, '猜中 Joker 应有提示');
  const room2 = S._rooms.get(code);
  const kept = room2.seats[1].tiles.find((t) => t.id === tileId);
  assert.ok(kept && kept.revealed, '被猜中的牌应翻开展示（明牌）');
  assert.ok(room2.removed.has(tileId), '被猜中的牌应移出牌池');
  a.close();
  b.close();
});
test('回合内：摸牌自动入序、可随时调整 Joker 位置', { timeout: 30000 }, async () => {
  const a = track(new WsTestClient(server.port));
  const b = track(new WsTestClient(server.port));
  await a.connect();
  await b.connect();
  a.send({ type: 'create_room', nickname: '甲' });
  const roomState = await a.nextMessage((m) => m.type === 'state');
  const code = roomState.code;
  b.send({ type: 'join_room', nickname: '乙', code });
  await b.nextMessage((m) => m.type === 'state' && m.you.seat != null);
  S._rooms.get(code).firstTurn = 0; // 测试固定房主先手
  a.send({ type: 'start_game' });
  const confirm = async (client) => {
    const st = await client.nextMessage((m) => m.type === 'state' && m.phase === 'arranging');
    client.send({ type: 'arrange_done', positions: validPositions(st.seats[st.you.seat].tiles) });
  };
  await Promise.all([confirm(a), confirm(b)]);
  // 房主先手：摸牌后应自动入序并直接进入猜牌（不再有放置阶段）
  const st0 = await a.nextMessage((m) => m.type === 'state' && m.phase === 'playing' && m.pendingAction === 'draw');
  const beforeCount = st0.seats[0].tiles.length;
  a.send({ type: 'draw', pile: (st0.blackPileSize || 0) > 0 ? 'b' : 'w' });
  const st1 = await a.nextMessage((m) => m.type === 'state' && m.phase === 'playing' && m.pendingAction === 'guess');
  assert.strictEqual(st1.pendingAction, 'guess', '摸牌后应直接进入猜牌（自动入序）');
  assert.strictEqual(st1.seats[0].tiles.length, beforeCount + 1, '摸到的牌应自动排入牌行');

  // 把甲的一张暗牌强制改为 Joker，回合内调整其位置
  const room = S._rooms.get(code);
  const mySeat = room.seats[0];
  const jpos = mySeat.tiles.findIndex((t) => !t.revealed);
  const jid = mySeat.tiles[jpos].id;
  mySeat.tiles[jpos].joker = true;
  mySeat.tiles[jpos].number = null;
  const before = mySeat.tiles.map((t) => t.id);
  const moved = before.slice();
  const fi = moved.indexOf(jid);
  moved.splice(fi, 1);
  moved.splice(0, 0, jid);
  a.send({ type: 'reorder_tiles', positions: moved });
  await a.nextMessage((m) => m.type === 'state');
  const after = S._rooms.get(code).seats[0].tiles.map((t) => t.id);
  assert.deepStrictEqual(after, moved, 'Joker 应移动到新位置');
  a.close();
  b.close();
});
test('猜错规则：翻开本回合新抽的牌；牌堆空则自选抛弃', { timeout: 30000 }, async () => {
  const a = track(new WsTestClient(server.port));
  const b = track(new WsTestClient(server.port));
  await a.connect();
  await b.connect();
  a.send({ type: 'create_room', nickname: '甲' });
  const roomState = await a.nextMessage((m) => m.type === 'state');
  const code = roomState.code;
  b.send({ type: 'join_room', nickname: '乙', code });
  await b.nextMessage((m) => m.type === 'state' && m.you.seat != null);
  S._rooms.get(code).firstTurn = 0; // 测试固定房主先手
  a.send({ type: 'start_game' });
  const confirm = async (client) => {
    const st = await client.nextMessage((m) => m.type === 'state' && m.phase === 'arranging');
    client.send({ type: 'arrange_done', positions: validPositions(st.seats[st.you.seat].tiles) });
  };
  await Promise.all([confirm(a), confirm(b)]);
  // a 先手抽牌，应看到新抽的牌带 fresh 标记
  const st0 = await a.nextMessage((m) => m.type === 'state' && m.phase === 'playing' && m.pendingAction === 'draw');
  a.send({ type: 'draw', pile: (st0.blackPileSize || 0) > 0 ? 'b' : 'w' });
  const st1 = await a.nextMessage((m) => m.type === 'state' && m.phase === 'playing' && m.pendingAction === 'guess');
  const freshTile = st1.seats[0].tiles.find((t) => t.fresh);
  assert.ok(freshTile, '本回合新抽到的牌应有标记');
  const freshId = freshTile.id;

  // 故意猜错（报相反颜色）
  const room = S._rooms.get(code);
  const target = room.seats[1];
  const pos = target.tiles.findIndex((t) => !t.revealed);
  const wrongColor = target.tiles[pos].color === 'b' ? 'w' : 'b';
  a.send({ type: 'guess', target: 1, position: pos, color: wrongColor, number: 0 });
  const st2 = await a.nextMessage((m) => m.type === 'state' && m.phase === 'playing');
  const myTiles = S._rooms.get(code).seats[0].tiles;
  const drawn = myTiles.find((t) => t.id === freshId);
  assert.ok(drawn && drawn.revealed, '猜错应翻开本回合新抽到的牌');

  // 构造牌堆已空 + 轮到甲且未抽牌：猜错后进入抛弃阶段
  const room2 = S._rooms.get(code);
  room2.currentTurn = 0;
  room2.pendingAction = 'guess';
  room2.seats[0].drawnThisTurn = null;
  room2.blackPile = [];
  room2.whitePile = [];
  const target2 = room2.seats[1];
  const pos2 = target2.tiles.findIndex((t) => !t.revealed);
  const wrongColor2 = target2.tiles[pos2].color === 'b' ? 'w' : 'b';
  a.send({ type: 'guess', target: 1, position: pos2, color: wrongColor2, number: 0 });
  const st3 = await a.nextMessage((m) => m.type === 'state' && m.pendingAction === 'discard');
  assert.strictEqual(st3.pendingAction, 'discard', '牌堆空时猜错应进入抛弃阶段');
  const mySeat = S._rooms.get(code).seats[0];
  const dropPos = mySeat.tiles.findIndex((t) => !t.revealed);
  const dropId = mySeat.tiles[dropPos].id;
  a.send({ type: 'discard', position: dropPos });
  await a.nextMessage((m) => m.type === 'state');
  const room3 = S._rooms.get(code);
  const dropped = room3.seats[0].tiles.find((t) => t.id === dropId);
  assert.ok(dropped && dropped.revealed, '抛弃的牌应翻开');
  assert.ok(room3.removed.has(dropId), '抛弃的牌应移出牌池');
  a.close();
  b.close();
});
test('猜对后：可继续猜或停手', { timeout: 30000 }, async () => {
  const a = track(new WsTestClient(server.port));
  const b = track(new WsTestClient(server.port));
  await a.connect();
  await b.connect();
  a.send({ type: 'create_room', nickname: '甲' });
  const roomState = await a.nextMessage((m) => m.type === 'state');
  const code = roomState.code;
  b.send({ type: 'join_room', nickname: '乙', code });
  await b.nextMessage((m) => m.type === 'state' && m.you.seat != null);
  S._rooms.get(code).firstTurn = 0; // 测试固定房主先手
  a.send({ type: 'start_game' });
  const confirm = async (client) => {
    const st = await client.nextMessage((m) => m.type === 'state' && m.phase === 'arranging');
    client.send({ type: 'arrange_done', positions: validPositions(st.seats[st.you.seat].tiles) });
  };
  await Promise.all([confirm(a), confirm(b)]);
  // a 先手：抽牌后从服务端读一张必中的暗牌来猜
  const st0 = await a.nextMessage((m) => m.type === 'state' && m.phase === 'playing' && m.pendingAction === 'draw');
  a.send({ type: 'draw', pile: (st0.blackPileSize || 0) > 0 ? 'b' : 'w' });
  await a.nextMessage((m) => m.type === 'state' && m.phase === 'playing' && m.pendingAction === 'guess');
  const room = S._rooms.get(code);
  const target = room.seats[1];
  const pos = target.tiles.findIndex((t) => !t.revealed && !t.joker);
  assert.ok(pos >= 0, '应存在可猜中的非 Joker 暗牌');
  const tile = target.tiles[pos];
  a.send({ type: 'guess', target: 1, position: pos, color: tile.color, number: tile.number });
  const st1 = await a.nextMessage((m) => m.type === 'state' && m.pendingAction === 'continue');
  assert.strictEqual(st1.you.seat, st1.currentTurn, '猜对后仍应轮到本人');
  // 继续猜：再猜中一张
  a.send({ type: 'continue_guess' });
  const st2 = await a.nextMessage((m) => m.type === 'state' && m.pendingAction === 'guess');
  assert.strictEqual(st2.you.seat, st2.currentTurn, '继续猜后仍应轮到本人');
  const target2 = S._rooms.get(code).seats[1];
  const pos2 = target2.tiles.findIndex((t) => !t.revealed && !t.joker);
  assert.ok(pos2 >= 0, '应仍有可猜中的暗牌');
  const tile2 = target2.tiles[pos2];
  a.send({ type: 'guess', target: 1, position: pos2, color: tile2.color, number: tile2.number });
  await a.nextMessage((m) => m.type === 'state' && m.pendingAction === 'continue');
  // 停手：轮到乙
  a.send({ type: 'stop_turn' });
  const st3 = await a.nextMessage((m) => m.type === 'state' && m.currentTurn === 1);
  assert.strictEqual(st3.currentTurn, 1, '停手后应轮到下一名玩家');
  a.close();
  b.close();
});
test('观战：观战者视角与房主切换', { timeout: 30000 }, async () => {
  const a = track(new WsTestClient(server.port));
  await a.connect();
  a.send({ type: 'create_room', nickname: '房主2' });
  const roomState = await a.nextMessage((m) => m.type === 'state');
  const code = roomState.code;

  const c = track(new WsTestClient(server.port));
  await c.connect();
  c.send({ type: 'spectate_room', nickname: '路人', code });
  const cState = await c.nextMessage((m) => m.type === 'state' && m.you.isSpectator === true);
  assert.ok(cState.you.isSpectator);

  a.send({ type: 'set_spectator_view', view: 'public' });
  const cPublic = await c.nextMessage((m) => m.type === 'state' && m.spectatorView === 'public');
  assert.strictEqual(cPublic.spectatorView, 'public');

  a.close();
  c.close();
});
test('机器人：添加机器人后自动参与完整对局', { timeout: 120000 }, async () => {
  const a = track(new WsTestClient(server.port));
  await a.connect();
  a.send({ type: 'create_room', nickname: '独狼' });
  const roomState = await a.nextMessage((m) => m.type === 'state');
  const code = roomState.code;

  a.send({ type: 'add_bot' });
  await a.nextMessage((m) => m.type === 'state' && m.seats.filter(Boolean).length === 2);

  S._rooms.get(code).firstTurn = 0; // 测试固定房主先手
  a.send({ type: 'start_game' });
  const st = await a.nextMessage((m) => m.type === 'state' && m.phase === 'arranging');
  const me = st.seats[st.you.seat];
  a.send({ type: 'arrange_done', positions: validPositions(me.tiles) });

  const finalState = await makeDriver(a, code)();
  assert.strictEqual(finalState.phase, 'ended');
  a.close();
});
test('战绩备份 API：下载与上传恢复', { timeout: 30000 }, async () => {
  const getStats = () => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.port, path: '/api/stats' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
  const postStats = (body) => new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: server.port, path: '/api/stats', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });

  const before = JSON.parse((await getStats()).body);
  assert.strictEqual(before.version, 1);

  const fake = {
    version: 1,
    players: {
      '备份侠': {
        games: 9, wins: 7, losses: 2, winRate: 0.778,
        currentStreak: 3, bestStreak: 5, rating: 1123,
        recent: [{ at: 1, gameId: 'G', result: 'win', score: 80, skill: 85, luck: 60, ratingDelta: 10 }]
      }
    }
  };
  const up = await postStats(fake);
  assert.strictEqual(up.status, 200);

  const after = JSON.parse((await getStats()).body);
  assert.strictEqual(after.players['备份侠'].rating, 1123);
  assert.strictEqual(after.players['备份侠'].games, 9);
  assert.strictEqual(after.players['备份侠'].recent.length, 1);

  const bad = await postStats({ hello: 'world' });
  assert.strictEqual(bad.status, 400);
});

test('在线玩家：列表可见、查战绩、邀请进房（接受/拒绝）', { timeout: 30000 }, async () => {
  
  const host = track(new WsTestClient(server.port));
  const guest = track(new WsTestClient(server.port));
  const spy = track(new WsTestClient(server.port));
  await host.connect();
  await guest.connect();
  await spy.connect();

  // 三人先绑定昵称（模拟在大厅）
  host.send({ type: 'set_nickname', nickname: '邀请主' });
  guest.send({ type: 'set_nickname', nickname: '邀请客' });
  spy.send({ type: 'set_nickname', nickname: '邀请观' });
  await new Promise((r) => setTimeout(r, 200));

  // 在线列表应包含三人
  
  spy.send({ type: 'list_online' });
  const ol = await spy.nextMessage((m) => m.type === 'online_list');
  
  const names = ol.players.map((p) => p.nickname);
  assert.ok(names.includes('邀请主'), '列表应包含房主');
  assert.ok(names.includes('邀请客'), '列表应包含乘客');
  assert.ok(names.includes('邀请观'), '列表应包含间谍');

  // 查询他人战绩（房主无战绩 → stats 为 null 或 0 局）
  
  spy.send({ type: 'get_stats', nickname: '邀请主' });
  const st = await spy.nextMessage((m) => m.type === 'stats' && m.nickname === '邀请主');
  
  assert.ok(st.stats === null || st.stats.games === 0, '可查询他人战绩');

  // 房主建房并邀请乘客
  
  host.send({ type: 'create_room', nickname: '邀请主' });
  const roomState = await host.nextMessage((m) => m.type === 'state');
  
  const code = roomState.code;
  
  host.send({ type: 'invite_player', nickname: '邀请客', code });
  const inv = await guest.nextMessage((m) => m.type === 'invite');
  
  assert.strictEqual(inv.from, '邀请主');
  assert.strictEqual(inv.code, code);

  // 乘客接受 → 加入房间
  
  guest.send({ type: 'invite_response', from: '邀请主', code, accept: true });
  const gState = await guest.nextMessage((m) => m.type === 'state' && m.you.seat != null);
  
  assert.strictEqual(gState.code, code);
  
  const notice = await host.nextMessage((m) => m.type === 'notice' && m.text.includes('接受了邀请'));
  
  assert.ok(notice, '房主应收到接受通知');

  // 等节流窗口（2s）后再邀请
  await new Promise((r) => setTimeout(r, 2100));
  // 房主再邀请间谍，间谍拒绝 → 房主收到拒绝通知
  host.send({ type: 'invite_player', nickname: '邀请观', code });
  const inv2 = await spy.nextMessage((m) => m.type === 'invite');
  assert.strictEqual(inv2.code, code);
  spy.send({ type: 'invite_response', from: '邀请主', code, accept: false });
  const declined = await host.nextMessage((m) => m.type === 'notice' && m.text.includes('拒绝了你的邀请'));
  assert.ok(declined, '房主应收到拒绝通知');

  await new Promise((r) => setTimeout(r, 2100));
  // 邀请不在线玩家 → 报错
  host.send({ type: 'invite_player', nickname: '不存在的人', code });
  const errMsg = await host.nextMessage((m) => m.type === 'error');
  assert.ok(errMsg.message.includes('不在线'), '应提示对方不在线');

  host.close();
  guest.close();
  spy.close();
});

test('开局先手：每局随机，且先手在活跃玩家内', { timeout: 90000 }, async () => {
  const a = track(new WsTestClient(server.port));
  const b = track(new WsTestClient(server.port));
  await a.connect();
  await b.connect();
  const seen = new Set();
  let prevCode = null;
  for (let i = 0; i < 10; i++) {
    a.send({ type: 'create_room', nickname: '先手甲' });
    // 跳过上一局离开时残留的旧房间 state
    const roomState = await a.nextMessage((m) => m.type === 'state' && m.code !== prevCode);
    const code = roomState.code;
    prevCode = code;
    b.send({ type: 'join_room', nickname: '先手乙', code });
    await b.nextMessage((m) => m.type === 'state' && m.you.seat != null && m.code === code);
    a.send({ type: 'start_game' }); // 不注入 firstTurn → 随机先手
    const confirm = async (client) => {
      const st = await client.nextMessage((m) => m.type === 'state' && m.phase === 'arranging');
      client.send({ type: 'arrange_done', positions: validPositions(st.seats[st.you.seat].tiles) });
    };
    await Promise.all([confirm(a), confirm(b)]);
    const st = await a.nextMessage((m) => m.type === 'state' && m.phase === 'playing');
    assert.ok(st.currentTurn === 0 || st.currentTurn === 1, '先手应在活跃玩家座位内，实际=' + st.currentTurn);
    seen.add(st.currentTurn);
    a.send({ type: 'leave' });
    b.send({ type: 'leave' });
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.ok(seen.size >= 2, '10 局应出现不同的先手，实际=' + JSON.stringify([...seen]));
  a.close();
  b.close();
});

test('Joker 黑/白：对手仅见颜色、自己见横线标记（joker 字段）', { timeout: 30000 }, async () => {
  const a = track(new WsTestClient(server.port));
  const b = track(new WsTestClient(server.port));
  await a.connect();
  await b.connect();
  a.send({ type: 'create_room', nickname: '看牌家' });
  const roomState = await a.nextMessage((m) => m.type === 'state');
  const code = roomState.code;
  b.send({ type: 'join_room', nickname: '持牌家', code });
  await b.nextMessage((m) => m.type === 'state' && m.you.seat != null);
  S._rooms.get(code).firstTurn = 0; // 固定房主先手
  a.send({ type: 'start_game' });
  const confirm = async (client) => {
    const st = await client.nextMessage((m) => m.type === 'state' && m.phase === 'arranging');
    client.send({ type: 'arrange_done', positions: validPositions(st.seats[st.you.seat].tiles) });
  };
  await Promise.all([confirm(a), confirm(b)]);
  await a.nextMessage((m) => m.type === 'state' && m.phase === 'playing');
  // 把 b 一张暗牌改成黑 Joker
  const room = S._rooms.get(code);
  const target = room.seats[1];
  const pos = target.tiles.findIndex((t) => !t.revealed);
  target.tiles[pos].joker = true;
  target.tiles[pos].number = null;
  target.tiles[pos].color = 'b';
  // a 抽牌触发一次广播
  a.send({ type: 'draw', pile: (room.blackPile.length > 0 ? 'b' : 'w') });
  // a 视角：对手牌只公开颜色，joker 标记隐藏
  const stA = await a.nextMessage((m) => m.type === 'state' && m.phase === 'playing' && m.pendingAction === 'guess');
  const tileA = stA.seats[1].tiles[pos];
  assert.strictEqual(tileA.color, 'b', '对手可见黑 Joker 的颜色');
  assert.strictEqual(tileA.joker, false, '对手看不到 Joker 标记');
  // b 视角：自己的 Joker 带标记 + 颜色
  const stB = await b.nextMessage((m) => m.type === 'state' && m.you.seat != null && m.pendingAction === 'guess');
  const tileB = stB.seats[1].tiles[pos];
  assert.strictEqual(tileB.joker, true, '自己能看到 Joker 标记');
  assert.strictEqual(tileB.color, 'b', '自己能看到 Joker 颜色');
  a.close();
  b.close();
});
