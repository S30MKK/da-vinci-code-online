'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-e2e-'));
process.env.STATS_FILE = path.join(tmpDir, 'stats.json');

const S = require('../server');
const { WsTestClient } = require('./wsclient');

let server;

before(async () => {
  server = await S.startServer({ port: 0 });
});

after(async () => {
  if (server) await server.close();
});

function makeDriver(client) {
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
        client.send({ type: 'draw' });
      } else if (st.pendingAction === 'place') {
        client.send({ type: 'place_drawn', position: 0 });
      } else if (st.pendingAction === 'guess') {
        const opp = st.seats.find((s) => s && !s.eliminated && s.index !== st.you.seat);
        const pos = opp.tiles.findIndex((t) => !t.revealed);
        client.send({ type: 'guess', target: opp.index, position: pos, color: 'b', number: 0 });
      } else if (st.pendingAction === 'reveal') {
        const me = st.seats[st.you.seat];
        const pos = me.tiles.findIndex((t) => !t.revealed);
        client.send({ type: 'reveal_own', position: pos });
      }
    }
  };
}

test('端到端：建房/加入/聊天/完整对局/回放/战绩', { timeout: 90000 }, async () => {
  const a = new WsTestClient(server.port);
  const b = new WsTestClient(server.port);
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
  a.send({ type: 'start_game' });
  const play = async (client) => {
    const st = await client.nextMessage((m) => m.type === 'state' && m.phase === 'arranging');
    const me = st.seats[st.you.seat];
    client.send({ type: 'arrange_done', positions: me.tiles.map((t) => t.id) });
    return makeDriver(client)();
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
  const a = new WsTestClient(server.port);
  const b = new WsTestClient(server.port);
  await a.connect();
  await b.connect();

  a.send({ type: 'create_room', nickname: '房主' });
  const roomState = await a.nextMessage((m) => m.type === 'state');
  const code = roomState.code;
  b.send({ type: 'join_room', nickname: '乘客', code });
  const bState = await b.nextMessage((m) => m.type === 'state' && m.you.seat != null);
  const bSeat = bState.you.seat;

  a.send({ type: 'start_game' });
  const confirm = async (client) => {
    const st = await client.nextMessage((m) => m.type === 'state' && m.phase === 'arranging');
    const me = st.seats[st.you.seat];
    client.send({ type: 'arrange_done', positions: me.tiles.map((t) => t.id) });
  };
  await Promise.all([confirm(a), confirm(b)]);
  await a.nextMessage((m) => m.type === 'state' && m.phase === 'playing');

  // b 掉线
  b.close();
  await new Promise((r) => setTimeout(r, 400));
  const notice = await a.nextMessage((m) => m.type === 'notice' && m.text.includes('掉线'));
  assert.ok(notice, '应广播掉线提示');

  // b 重连回原座位
  const b2 = new WsTestClient(server.port);
  await b2.connect();
  b2.send({ type: 'join_room', nickname: '乘客', code });
  const rebind = await b2.nextMessage((m) => m.type === 'state' && m.you.seat != null);
  assert.strictEqual(rebind.you.seat, bSeat);

  a.close();
  b2.close();
});

test('观战：观战者视角与房主切换', { timeout: 30000 }, async () => {
  const a = new WsTestClient(server.port);
  await a.connect();
  a.send({ type: 'create_room', nickname: '房主2' });
  const roomState = await a.nextMessage((m) => m.type === 'state');
  const code = roomState.code;

  const c = new WsTestClient(server.port);
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
  const a = new WsTestClient(server.port);
  await a.connect();
  a.send({ type: 'create_room', nickname: '独狼' });
  const roomState = await a.nextMessage((m) => m.type === 'state');
  const code = roomState.code;

  a.send({ type: 'add_bot' });
  await a.nextMessage((m) => m.type === 'state' && m.seats.filter(Boolean).length === 2);

  a.send({ type: 'start_game' });
  const st = await a.nextMessage((m) => m.type === 'state' && m.phase === 'arranging');
  const me = st.seats[st.you.seat];
  a.send({ type: 'arrange_done', positions: me.tiles.map((t) => t.id) });

  const finalState = await makeDriver(a)();
  assert.strictEqual(finalState.phase, 'ended');
  a.close();
});