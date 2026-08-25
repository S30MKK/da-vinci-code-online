'use strict';

/* =====================================================================
 * 达芬奇密码 多人联机数字版 — 零依赖 Node.js 服务端
 * - 静态页面托管 + 原生 WebSocket + JSON 消息协议
 * - 服务端权威游戏规则 / AI 机器人 / 观战 / 回放 / 聊天 / 断线重连
 * - 战绩与评分持久化到 stats.json（原子写入）
 *
 * 运行：node server.js（默认端口 3000，可用 PORT 环境变量覆盖）
 * ===================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STATS_FILE = process.env.STATS_FILE || path.join(ROOT, 'stats.json');

const MAX_SEATS = 4;
const RECONNECT_GRACE_MS = 90 * 1000;   // 断线保留座位时长
const INVITE_TTL_MS = 30 * 1000;      // 邀请待处理有效期
const pendingInvites = new Map();      // 被邀请昵称 -> { fromNick, fromClient, code, at }
const BOT_DELAY_MS = 700;               // 机器人行动间隔
const MAX_REPLAYS_PER_ROOM = 10;
const MAX_REPLAYS_GLOBAL = 500;
const MAX_RECENT_PER_PLAYER = 20;
const CHAT_RATE_LIMIT_MS = 800;
const CHAT_MAX_LEN = 60;
const NICKNAME_MAX_LEN = 12;
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5000;

/* ---------------------------------------------------------------------
 * 牌与排序
 * 规则：黑 0-11 < 白 0-11（同数字白色更大）；Joker 为百搭可放任意位置
 * ------------------------------------------------------------------- */

function makeDeck() {
  const deck = [];
  let id = 0;
  for (const color of ['b', 'w']) {
    for (let n = 0; n <= 11; n++) {
      deck.push({ id: id++, color, number: n, joker: false });
    }
  }
  deck.push({ id: id++, color: 'b', number: null, joker: true }); // 黑 Joker
  deck.push({ id: id++, color: 'w', number: null, joker: true }); // 白 Joker
  return deck;
}

// 黑 0 < 白 0 < 黑 1 < 白 1 < ... < 黑 11 < 白 11
function tileRank(t) {
  if (t.joker) return -1;
  return t.color === 'b' ? t.number * 2 : t.number * 2 + 1;
}

// 数字牌按 rank 升序；Joker 排最后（百搭可放任意位置，默认排列阶段再移到中间）。
// 注意：比较器必须是合法全序，否则 Array.sort 结果不确定，可能产生非升序的默认牌序。
function compareTiles(a, b) {
  const aj = a.joker ? 1 : 0;
  const bj = b.joker ? 1 : 0;
  if (aj !== bj) return aj - bj;
  if (aj) return a.color === b.color ? 0 : (a.color === 'b' ? -1 : 1);
  return tileRank(a) - tileRank(b);
}

function tileLabel(t) {
  if (t.joker) return (t.color === 'b' ? '黑' : '白') + 'Joker';
  return (t.color === 'b' ? '黑' : '白') + t.number;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/* ---------------------------------------------------------------------
 * stats.json 持久化（原子写入：先写临时文件再改名）
 * 字段：总局数/胜/负/胜率/当前连胜/最长连胜/积分/最近 20 局表现
 * ------------------------------------------------------------------- */

let statsData = { version: 1, players: {} };

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      if (raw && raw.version === 1 && raw.players) {
        statsData = raw;
        return;
      }
    }
  } catch (err) {
    console.error('[stats] 读取失败，自动重建:', err.message);
  }
  statsData = { version: 1, players: {} };
  saveStats();
}

function saveStats() {
  try {
    const tmp = STATS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(statsData, null, 2));
    fs.renameSync(tmp, STATS_FILE);
  } catch (err) {
    console.error('[stats] 写入失败:', err.message);
  }
}

function ensurePlayer(name) {
  if (!statsData.players[name]) {
    statsData.players[name] = {
      games: 0, wins: 0, losses: 0, winRate: 0,
      currentStreak: 0, bestStreak: 0,
      rating: 1000,
      recent: []
    };
  }
  return statsData.players[name];
}

function getPlayerStats(name) {
  return statsData.players[name] || null;
}

function recordGameResult(name, rec) {
  const p = ensurePlayer(name);
  p.games += 1;
  if (rec.result === 'win') {
    p.wins += 1;
    p.currentStreak += 1;
  } else {
    p.losses += 1;
    p.currentStreak = 0;
  }
  if (p.currentStreak > p.bestStreak) p.bestStreak = p.currentStreak;
  p.winRate = Math.round((p.wins / p.games) * 1000) / 1000;
  p.rating = Math.max(0, Math.round(p.rating + rec.ratingDelta));
  p.recent.push({
    at: Date.now(), gameId: rec.gameId, result: rec.result,
    score: Math.round(rec.score), skill: Math.round(rec.skill),
    luck: Math.round(rec.luck), ratingDelta: Math.round(rec.ratingDelta)
  });
  if (p.recent.length > MAX_RECENT_PER_PLAYER) p.recent = p.recent.slice(-MAX_RECENT_PER_PLAYER);
  saveStats();
}

/* ---------------------------------------------------------------------
 * WebSocket（RFC 6455，零依赖）
 * ------------------------------------------------------------------- */

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

// 服务端 -> 客户端帧（不掩码）
function encodeFrame(opcode, payload) {
  const buf = Buffer.from(payload);
  const first = 0x80 | opcode; // FIN + opcode
  let header;
  if (buf.length < 126) {
    header = Buffer.alloc(2);
    header[0] = first;
    header[1] = buf.length;
  } else if (buf.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(buf.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(buf.length), 2);
  }
  return Buffer.concat([header, buf]);
}

// 客户端 -> 服务端帧解码（必须掩码）
class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    for (;;) {
      const f = this.tryDecode();
      if (!f) break;
      frames.push(f);
    }
    return frames;
  }
  tryDecode() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const first = b[0];
    const second = b[1];
    const opcode = first & 0x0f;
    const fin = (first & 0x80) !== 0;
    const masked = (second & 0x80) !== 0;
    let len = second & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      len = Number(b.readBigUInt64BE(2));
      off = 10;
    }
    if (!masked) throw new Error('客户端帧必须带掩码');
    if (b.length < off + 4 + len) return null;
    const mask = b.slice(off, off + 4);
    off += 4;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = b[off + i] ^ mask[i & 3];
    this.buffer = b.slice(off + len);
    return { fin, opcode, payload };
  }
}

class Client {
  constructor(socket) {
    this.socket = socket;
    this.decoder = new FrameDecoder();
    this.msgBuffer = null;
    this.room = null;
    this.seatIndex = null;
    this.spectator = false;
    this.nickname = null;
    this.lastChatAt = 0;
    this.lastSeen = Date.now();
    this.alive = true;
  }
  send(obj) {
    if (!this.alive) return;
    try {
      this.socket.write(encodeFrame(0x1, JSON.stringify(obj)));
    } catch (e) { /* 忽略 */ }
  }
  close() {
    if (!this.alive) return;
    this.alive = false;
    try { this.socket.end(encodeFrame(0x8, Buffer.from('bye'))); } catch (e) { /* ignore */ }
    try { this.socket.destroy(); } catch (e) { /* ignore */ }
  }
}

/* ---------------------------------------------------------------------
 * HTTP 静态托管
 * ------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}
/* ---------------------------------------------------------------------
 * 房间与对局引擎
 * ------------------------------------------------------------------- */

const rooms = new Map();   // code -> room
const replays = new Map(); // replayId -> replay

function newRoomCode() {
  for (;;) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms.has(code)) return code;
  }
}

function makeSeat(index, nickname, isBot) {
  return {
    index,
    nickname,
    isBot,
    connected: isBot,        // 机器人始终"在线"
    disconnectedAt: null,
    client: null,            // 真人玩家的 Client 引用
    tiles: [],               // 牌行（移出牌后自动紧凑）
    eliminated: false,
    stats: freshSeatStats(),
    drawnThisTurn: null        // 本回合新抽到的牌 id（标记用）
  };
}

function freshSeatStats() {
  return {
    draws: [],              // 抽到的牌（供运气分计算）
    guesses: 0,
    correctGuesses: 0,
    expectedHits: 0,        // Σ p（猜中概率之和）
    highProbGuesses: 0,     // p >= 0.5 的猜测次数
    highProbHits: 0,        // 其中命中的次数
    guessedAgainst: 0,      // 被猜次数
    guessedCorrectAgainst: 0,
    lowProbCorrectAgainst: 0, // 低概率被猜中（倒霉）
    eliminations: 0
  };
}

function createRoom() {
  return {
    code: newRoomCode(),
    seats: [null, null, null, null],
    spectators: new Map(),     // client -> { nickname }
    hostSeat: null,
    phase: 'lobby',            // lobby | arranging | playing | ended
    spectatorView: 'all',      // all | public
    drawPile: [],
    blackPile: [],
    whitePile: [],
    removed: new Set(),        // 被猜中移出游戏的牌 id
    currentTurn: null,
    pendingAction: 'wait',     // arrange | draw | place | guess | reveal | wait
    pendingDraw: null,
    arrangementReady: [false, false, false, false],
    winner: null,
    gameId: null,
    events: [],
    replayList: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    timers: new Set()
  };
}

function roomClients(room) {
  const list = [];
  for (const s of room.seats) {
    if (s && !s.isBot && s.client) list.push(s.client);
  }
  for (const c of room.spectators.keys()) list.push(c);
  return list;
}

function broadcast(room, obj) {
  for (const c of roomClients(room)) c.send(obj);
}

function broadcastNotice(room, text) {
  broadcast(room, { type: 'notice', text });
}

function sendStats(client) {
  if (!client.nickname) return;
  const st = getPlayerStats(client.nickname);
  client.send({ type: 'stats', nickname: client.nickname, stats: st });
}

/* ---------------- 状态快照（按视角个性化） ---------------- */

function stateFor(room, client) {
  const seat = client.seatIndex != null ? room.seats[client.seatIndex] : null;
  const seeAll = client.spectator && room.spectatorView === 'all';
  const seats = room.seats.map((s, idx) => {
    if (!s) return null;
    const isSelf = s === seat;
    return {
      index: idx,
      nickname: s.nickname,
      isBot: s.isBot,
      connected: s.connected,
      eliminated: s.eliminated,
      isHost: room.hostSeat === idx,
      tiles: s.tiles.map(t => {
        const colorVisible = true; // 黑/白颜色对所有玩家公开（数字仍保密）
        const valueVisible = t.revealed || (isSelf && t.known) || seeAll;
        return {
          id: t.id,
          revealed: !!t.revealed,
          hidden: !t.revealed,
          color: colorVisible ? t.color : null,
          number: valueVisible ? t.number : null,
          joker: valueVisible ? !!t.joker : false,
          knownToOwner: !!t.known,
          pile: t.pile || null,
          fresh: t.id === s.drawnThisTurn   // 本回合新抽到的牌（标记）
        };
      })
    };
  });
  return {
    type: 'state',
    code: room.code,
    phase: room.phase,
    hostSeat: room.hostSeat,
    currentTurn: room.currentTurn,
    pendingAction: room.pendingAction,
    spectatorView: room.spectatorView,
    you: seat ? { isSpectator: false, seat: seat.index } : { isSpectator: true },
    drawPileSize: (room.blackPile ? room.blackPile.length : 0) + (room.whitePile ? room.whitePile.length : 0),
    blackPileSize: room.blackPile ? room.blackPile.length : 0,
    whitePileSize: room.whitePile ? room.whitePile.length : 0,
    winner: room.winner,
    gameId: room.gameId,
    spectatorCount: room.spectators.size,
    seats
  };
}

function broadcastState(room) {
  for (const c of roomClients(room)) c.send(stateFor(room, c));
}

/* ---------------- 开局 ---------------- */

function startGame(room) {
  const seats = room.seats.filter(Boolean);
  const perPlayer = seats.length >= 4 ? 3 : 4;
  const deck = makeDeck();
  shuffle(deck);
  let i = 0;
  for (const seat of seats) {
    seat.tiles = deck.slice(i, i + perPlayer).map(t => ({ ...t, revealed: false, known: true }));
    i += perPlayer;
    seat.tiles.sort(compareTiles);
    placeJokersDefault(seat);
    seat.eliminated = false;
    seat.stats = freshSeatStats();
  }
  const rest = deck.slice(i);
  room.blackPile = rest.filter(t => t.color === 'b');
  room.whitePile = rest.filter(t => t.color === 'w');
  room.drawPile = rest;
  room.removed = new Set();
  room.phase = 'arranging';
  room.currentTurn = null;
  room.pendingAction = 'arrange';
  room.pendingDraw = null;
  room.winner = null;
  room.gameId = 'G' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  room.events = [];
  room.arrangementReady = seats.map(() => false);
  for (const seat of seats) {
    room.events.push({
      type: 'deal', seat: seat.index,
      tiles: seat.tiles.map(t => ({ id: t.id, color: t.color, number: t.number, joker: t.joker }))
    });
  }
  // 机器人自动完成排列
  for (const seat of seats) if (seat.isBot) room.arrangementReady[seat.index] = true;
  room.lastActiveAt = Date.now();
  broadcastState(room);
  checkArrangement(room);
}

function placeJokersDefault(seat) {
  // 把 Joker 放到行中间（玩家可在排列阶段自行调整）
  for (let idx = 0; idx < seat.tiles.length; idx++) {
    if (!seat.tiles[idx].joker) continue;
    const t = seat.tiles.splice(idx, 1)[0];
    const mid = Math.floor(seat.tiles.length / 2);
    seat.tiles.splice(mid, 0, t);
  }
}

function checkArrangement(room) {
  if (room.phase !== 'arranging') return;
  const seats = room.seats.filter(Boolean);
  if (seats.every(s => room.arrangementReady[s.index])) {
    room.phase = 'playing';
    room.events.push({ type: 'arranged' });
    nextTurn(room);
    broadcastState(room);
    broadcastNotice(room, '对局开始！');
  }
}

function handleArrange(client, room, msg) {
  const seat = seatOf(client);
  if (!seat || room.phase !== 'arranging') return;
  const pos = msg.positions;
  if (Array.isArray(pos)) {
    const ids = new Set(seat.tiles.map(t => t.id));
    if (pos.length !== seat.tiles.length ||
        !pos.every(id => Number.isInteger(id) && ids.has(id)) ||
        new Set(pos).size !== pos.length) {
      client.send({ type: 'error', message: '排列无效，请重试' });
      return;
    }
    const byId = new Map(seat.tiles.map(t => [t.id, t]));
    const ordered = pos.map(id => byId.get(id));
    let prev = -Infinity;
    for (const t of ordered) {
      if (t.joker) continue;
      const r = tileRank(t);
      if (r < prev) {
        client.send({ type: 'error', message: '数字牌必须按升序排列' });
        return;
      }
      prev = r;
    }
    seat.tiles = ordered;
  }
  room.arrangementReady[seat.index] = true;
  room.lastActiveAt = Date.now();
  broadcastState(room);
  checkArrangement(room);
}

/* ---------------- 回合流转 ---------------- */

function nextTurn(room) {
  if (room.phase !== 'playing') return;
  const n = room.seats.length;
  let idx = room.currentTurn == null ? -1 : room.currentTurn;
  for (let k = 1; k <= n; k++) {
    const cand = (idx + k) % n;
    const s = room.seats[cand];
    if (s && !s.eliminated && s.tiles.some(t => !t.revealed)) {
      room.currentTurn = cand;
      break;
    }
  }
  const seat = room.seats[room.currentTurn];
  if (!seat) return;
  seat.drawnThisTurn = null;
  room.pendingDraw = null;
  room.pendingGuess = null;
  room.pendingAction = (room.blackPile.length + room.whitePile.length) > 0 ? 'draw' : 'guess';
  if (seat.isBot) {
    scheduleBot(room, seat);
  } else {
    broadcastState(room);
  }
}

function advanceAfterAction(room) {
  if (room.phase !== 'playing') return;
  const alive = room.seats.filter(s => s && !s.eliminated && s.tiles.some(t => !t.revealed));
  if (alive.length <= 1) {
    endGame(room, alive.length === 1 ? alive[0].index : null);
    return;
  }
  nextTurn(room);
}

function checkEliminations(room) {
  for (const seat of room.seats) {
    if (!seat || seat.eliminated) continue;
    if (seat.tiles.every(t => t.revealed)) {
      seat.eliminated = true;
      room.events.push({ type: 'eliminate', seat: seat.index });
      broadcastNotice(room, `${seat.nickname} 的牌全部被翻开，出局！`);
    }
  }
}

/* ---------------- 抽牌 / 放置 / 猜牌 / 翻牌 ---------------- */

// 摸到的新牌自动插入牌行：数字牌按升序就位，Joker 放中间（回合内可再调整）
function autoInsertPos(seat, tile) {
  if (tile.joker) return Math.floor(seat.tiles.length / 2);
  const r = tileRank(tile);
  for (let i = 0; i < seat.tiles.length; i++) {
    const t = seat.tiles[i];
    if (t.joker) continue;
    if (tileRank(t) > r) return i;
  }
  return seat.tiles.length;
}

function handleDraw(client, room, msg) {
  const seat = seatOf(client);
  if (!seat || room.phase !== 'playing' || room.currentTurn !== seat.index || room.pendingAction !== 'draw') return;
  const pile = msg && msg.pile === 'b' ? 'blackPile' : (msg && msg.pile === 'w' ? 'whitePile' : null);
  if (!pile || room[pile].length === 0) return;
  const tile = room[pile].pop();
  seat.stats.draws.push(tile);
  // 摸到的牌对自己明牌，并自动按升序排入牌行（Joker 放中间，回合内可再调整）
  const drawn = { ...tile, revealed: false, known: true, pile: pile === 'blackPile' ? 'b' : 'w' };
  const pos = autoInsertPos(seat, drawn);
  seat.tiles.splice(pos, 0, drawn);
  seat.drawnThisTurn = drawn.id; // 标记本回合新抽到的牌
  room.pendingDraw = null;
  room.pendingAction = 'guess';
  room.events.push({
    type: 'draw', seat: seat.index, pile: pile === 'blackPile' ? 'b' : 'w',
    tileId: tile.id, color: tile.color, number: tile.number, joker: tile.joker
  });
  room.events.push({ type: 'place', seat: seat.index, position: pos, auto: true });
  room.lastActiveAt = Date.now();
  broadcastState(room);
  if (seat.isBot) scheduleBot(room, seat);
}

function handlePlace(client, room, msg) {
  const seat = seatOf(client);
  if (!seat || room.phase !== 'playing' || room.currentTurn !== seat.index || room.pendingAction !== 'place') return;
  const pos = msg.position;
  if (!Number.isInteger(pos) || pos < 0 || pos > seat.tiles.length) return;
  const tile = room.pendingDraw;
  room.pendingDraw = null;
  seat.tiles.splice(pos, 0, tile);
  room.events.push({ type: 'place', seat: seat.index, position: pos });
  room.pendingAction = 'guess';
  room.lastActiveAt = Date.now();
  broadcastState(room);
  if (seat.isBot) scheduleBot(room, seat);
}

// 自己的回合内随时调整牌行（主要移动 Joker；数字牌必须保持升序）
function handleReorderTiles(client, room, msg) {
  const seat = seatOf(client);
  if (!seat || room.phase !== 'playing' || room.currentTurn !== seat.index) return;
  const pos = msg && msg.positions;
  if (!Array.isArray(pos)) return;
  const ids = new Set(seat.tiles.map(t => t.id));
  if (pos.length !== seat.tiles.length ||
      !pos.every(id => Number.isInteger(id) && ids.has(id)) ||
      new Set(pos).size !== pos.length) return;
  const byId = new Map(seat.tiles.map(t => [t.id, t]));
  const ordered = pos.map(id => byId.get(id));
  let prev = -Infinity;
  for (const t of ordered) {
    if (t.joker) continue;
    const r = tileRank(t);
    if (r < prev) return;
    prev = r;
  }
  seat.tiles = ordered;
  room.lastActiveAt = Date.now();
  broadcastState(room);
}

// 猜对后：选择继续猜
function handleContinueGuess(client, room, msg) {
  const seat = seatOf(client);
  if (!seat || room.phase !== 'playing' || room.currentTurn !== seat.index || room.pendingAction !== 'continue') return;
  room.pendingAction = 'guess';
  room.lastActiveAt = Date.now();
  broadcastState(room);
  if (seat.isBot) scheduleBot(room, seat); // 机器人继续猜
}

// 猜对后：停手，结束自己的回合
function handleStopTurn(client, room, msg) {
  const seat = seatOf(client);
  if (!seat || room.phase !== 'playing' || room.currentTurn !== seat.index || room.pendingAction !== 'continue') return;
  room.pendingAction = 'wait';
  room.lastActiveAt = Date.now();
  advanceAfterAction(room);
}

// 牌堆已空时猜错：自选一张牌抛弃（翻开并移出游戏）
function handleDiscard(client, room, msg) {
  const seat = seatOf(client);
  if (!seat || room.phase !== 'playing' || room.currentTurn !== seat.index || room.pendingAction !== 'discard') return;
  const pos = msg.position;
  if (!Number.isInteger(pos) || pos < 0 || pos >= seat.tiles.length) return;
  const tile = seat.tiles[pos];
  if (tile.revealed) return;
  tile.revealed = true;
  room.removed.add(tile.id);
  room.events.push({ type: 'reveal', seat: seat.index, position: pos, tileId: tile.id, reason: 'discard' });
  room.events.push({ type: 'remove', seat: seat.index, tileId: tile.id });
  room.pendingAction = 'wait';
  room.lastActiveAt = Date.now();
  broadcastState(room);
  broadcastNotice(room, `${seat.nickname} 抛弃了 ${tileLabel(tile)}。`);
  checkEliminations(room);
  advanceAfterAction(room);
}

function handleGuess(client, room, msg) {
  const seat = seatOf(client);
  if (!seat || room.phase !== 'playing' || room.currentTurn !== seat.index || room.pendingAction !== 'guess') return;
  const target = room.seats[msg.target];
  const pos = msg.position;
  if (!target || target === seat || target.eliminated ||
      !Number.isInteger(pos) || pos < 0 || pos >= target.tiles.length) return;
  const jokerGuess = msg.joker === true;
  if (!jokerGuess && msg.color !== 'b' && msg.color !== 'w') return;
  if (!jokerGuess && (!Number.isInteger(msg.number) || msg.number < 0 || msg.number > 11)) return;
  const guessedTile = target.tiles[pos];
  if (guessedTile.revealed) return;

  const correct = jokerGuess
    ? !!guessedTile.joker
    : !guessedTile.joker && guessedTile.color === msg.color && guessedTile.number === msg.number;
  const p = estimateGuessProbability(room, seat, target, pos, jokerGuess ? null : msg.color, jokerGuess ? null : msg.number, jokerGuess);

  seat.stats.guesses += 1;
  seat.stats.expectedHits += p;
  if (p >= 0.5) seat.stats.highProbGuesses += 1;
  target.stats.guessedAgainst += 1;
  if (correct) {
    seat.stats.correctGuesses += 1;
    if (p >= 0.5) seat.stats.highProbHits += 1;
    target.stats.guessedCorrectAgainst += 1;
    if (p < 0.5) target.stats.lowProbCorrectAgainst += 1;
  }

  room.events.push({
    type: 'guess', seat: seat.index, target: target.index,
    position: pos, color: jokerGuess ? null : msg.color, number: jokerGuess ? null : msg.number, joker: jokerGuess, correct
  });

  if (correct) {
    guessedTile.revealed = true; // 被猜中的牌翻开展示，全场可见（明牌）
    room.events.push({ type: 'reveal', seat: target.index, position: pos, tileId: guessedTile.id, reason: 'correct' });
    room.removed.add(guessedTile.id);
    room.events.push({ type: 'remove', seat: target.index, tileId: guessedTile.id });
    seat.stats.eliminations += 1;
    room.lastActiveAt = Date.now();
    checkEliminations(room);
    const alive = room.seats.filter(s => s && !s.eliminated && s.tiles.some(t => !t.revealed));
    const hitText = `${seat.nickname} 猜中了 ${target.nickname} 的${jokerGuess ? 'Joker' : (msg.color === 'b' ? '黑' : '白') + msg.number}！`;
    if (alive.length <= 1) {
      room.pendingAction = 'wait';
      broadcastNotice(room, hitText);
      endGame(room, alive.length === 1 ? alive[0].index : null);
    } else {
      // 猜对后：可选择继续猜或停手
      room.pendingAction = 'continue';
      broadcastState(room);
      broadcastNotice(room, hitText + ' 可继续猜或停手。');
      if (seat.isBot) scheduleBot(room, seat);
    }
  } else {
    // 规则：猜错翻开本回合新抽到的牌；牌堆已空没抽到牌时，自选一张抛弃
    const dPos = seat.drawnThisTurn != null ? seat.tiles.findIndex(t => t.id === seat.drawnThisTurn) : -1;
    const drawnTile = dPos >= 0 && !seat.tiles[dPos].revealed ? seat.tiles[dPos] : null;
    if (drawnTile) {
      drawnTile.revealed = true;
      seat.drawnThisTurn = null;
      room.events.push({ type: 'reveal', seat: seat.index, position: dPos, tileId: drawnTile.id, reason: 'wrong-drawn' });
      room.pendingAction = 'wait';
      room.lastActiveAt = Date.now();
      broadcastState(room);
      broadcastNotice(room, `${seat.nickname} 猜错了！翻开本回合抽到的牌 ${tileLabel(drawnTile)}。`);
      checkEliminations(room);
      advanceAfterAction(room);
    } else {
      room.pendingAction = 'discard';
      room.lastActiveAt = Date.now();
      broadcastState(room);
      broadcastNotice(room, `${seat.nickname} 猜错了！牌堆已空，请自选一张牌抛弃。`);
      if (seat.isBot) scheduleBot(room, seat);
    }
  }
}

function handleRevealOwn(client, room, msg) {
  const seat = seatOf(client);
  if (!seat || room.phase !== 'playing' || room.currentTurn !== seat.index || room.pendingAction !== 'reveal') return;
  const pos = msg.position;
  if (!Number.isInteger(pos) || pos < 0 || pos >= seat.tiles.length) return;
  const tile = seat.tiles[pos];
  if (tile.revealed) return;
  tile.revealed = true;
  room.events.push({ type: 'reveal', seat: seat.index, position: pos, tileId: tile.id, reason: 'wrong' });
  room.pendingAction = 'wait';
  room.lastActiveAt = Date.now();
  broadcastState(room);
  broadcastNotice(room, `${seat.nickname} 翻开了自己的${tileLabel(tile)}。`);
  checkEliminations(room);
  advanceAfterAction(room);
}
/* ---------------------------------------------------------------------
 * 概率估算（公开信息近似，供评分与 AI 使用）
 * 猜牌者可见：明牌、移出牌、自己的全部牌；牌堆内容不可见。
 * ------------------------------------------------------------------- */

function poolFor(room, guesser) {
  const used = new Set(room.removed);
  for (const seat of room.seats) {
    if (!seat) continue;
    for (const t of seat.tiles) {
      if (t.revealed) used.add(t.id);
      if (seat === guesser && t.known) used.add(t.id);
    }
  }
  return makeDeck().filter(t => !used.has(t.id));
}

// 目标行中，位置 pos 左侧明牌的最大 rank 与右侧明牌的最小 rank
function rowBounds(seat, pos) {
  let lo = -Infinity;
  let hi = Infinity;
  for (let i = 0; i < seat.tiles.length; i++) {
    const t = seat.tiles[i];
    if (!t.revealed || t.joker) continue;
    const r = tileRank(t);
    if (i < pos) lo = Math.max(lo, r);
    else if (i > pos) hi = Math.min(hi, r);
  }
  return { lo, hi };
}

function estimateGuessProbability(room, guesser, target, pos, color, number, isJoker) {
  const guessedTile = target.tiles[pos];
  // 黑/白颜色公开：暗牌颜色已知，猜其它颜色必然错误（Joker 亦按颜色区分）
  const restrictedColor = guessedTile && !guessedTile.revealed ? guessedTile.color : null;
  if (!isJoker && restrictedColor && color !== restrictedColor) return 0;
  const pool = poolFor(room, guesser);
  const nonJokers = pool.filter(t => !t.joker && (restrictedColor ? t.color === restrictedColor : true));
  const jokers = pool.filter(t => t.joker && (restrictedColor ? t.color === restrictedColor : true)).length;
  const { lo, hi } = rowBounds(target, pos);
  const feasible = nonJokers.filter(c => tileRank(c) >= lo && tileRank(c) <= hi);
  if (isJoker) {
    // Joker 是百搭，可放任意位置：命中概率 = 可行 Joker 数 /（可行数字牌 + 可行 Joker）
    const denom = feasible.length + jokers;
    return denom > 0 ? jokers / denom : 0;
  }
  const targetRank = color === 'b' ? number * 2 : number * 2 + 1;
  const hasExact = feasible.some(c => c.color === color && c.number === number);
  if (!hasExact) return 0;
  const denom = feasible.length + jokers;
  return denom > 0 ? 1 / denom : 1;
}

/* ---------------------------------------------------------------------
 * AI 机器人（基于公开信息做合理选择）
 * ------------------------------------------------------------------- */

function scheduleBot(room, seat) {
  const t = setTimeout(() => {
    if (room.phase !== 'playing' || room.currentTurn !== seat.index) return;
    if (seat.eliminated) return;
    if (room.pendingAction === 'draw') botDraw(room, seat);
    else if (room.pendingAction === 'place') botPlace(room, seat);
    else if (room.pendingAction === 'guess') botGuess(room, seat);
    else if (room.pendingAction === 'reveal') botReveal(room, seat);
    else if (room.pendingAction === 'discard') botDiscard(room, seat);
    else if (room.pendingAction === 'continue') botContinue(room, seat);
  }, BOT_DELAY_MS);
  room.timers.add(t);
  t.unref && t.unref();
}

function botDraw(room, seat) {
  if (room.pendingAction !== 'draw') return;
  // 白牌数值更高，优先抽白牌堆；白牌堆空则抽黑牌堆
  const pile = room.whitePile.length > 0 ? 'w' : 'b';
  if (pile === 'w' ? room.whitePile.length === 0 : room.blackPile.length === 0) return;
  handleDraw({ room, seatIndex: seat.index }, room, { pile });
}

function botPlace(room, seat) {
  const len = seat.tiles.length;
  const pool = poolFor(room, seat);
  const drawnPile = room.pendingDraw ? room.pendingDraw.pile : null;
  const nonJokers = pool.filter(t => !t.joker && (drawnPile ? t.color === drawnPile : true));
  let best = -1;
  let bestPos = Math.floor(len / 2);
  for (let p = 0; p <= len; p++) {
    const { lo, hi } = rowBounds(seat, p);
    let cnt = 0;
    for (const c of nonJokers) {
      const r = tileRank(c);
      if (r >= lo && r <= hi) cnt++;
    }
    if (cnt > best) { best = cnt; bestPos = p; }
  }
  handlePlace({ room, seatIndex: seat.index }, room, { position: bestPos });
}

function botGuess(room, seat) {
  let best = { p: -1 };
  for (const target of room.seats) {
    if (!target || target === seat || target.eliminated) continue;
    for (let pos = 0; pos < target.tiles.length; pos++) {
      if (target.tiles[pos].revealed) continue;
      for (const color of ['b', 'w']) {
        for (let number = 0; number <= 11; number++) {
          const p = estimateGuessProbability(room, seat, target, pos, color, number);
          if (p > best.p) {
            best = { p, target: target.index, position: pos, color, number };
          }
        }
      }
      // 也考虑猜 Joker（横线）
      const pJoker = estimateGuessProbability(room, seat, target, pos, null, null, true);
      if (pJoker > best.p) {
        best = { p: pJoker, target: target.index, position: pos, joker: true };
      }
    }
  }
  if (best.target == null) {
    // 兜底：所有候选概率为 0 时随机猜一张
    const targets = room.seats.filter((t) => t && t !== seat && !t.eliminated);
    if (!targets.length) return;
    const target = targets[Math.floor(Math.random() * targets.length)];
    const hidden = [];
    target.tiles.forEach((t, i) => { if (!t.revealed) hidden.push(i); });
    if (!hidden.length) return;
    const position = hidden[Math.floor(Math.random() * hidden.length)];
    const color = Math.random() < 0.5 ? 'b' : 'w';
    const number = Math.floor(Math.random() * 12);
    handleGuess({ room, seatIndex: seat.index }, room, { target: target.index, position, color, number });
    return;
  }
  handleGuess({ room, seatIndex: seat.index }, room, best);
}

// 猜对后机器人决策：有把握就继续猜，否则停手
function botContinue(room, seat) {
  if (room.pendingAction !== 'continue') return;
  let bestP = -1;
  for (const target of room.seats) {
    if (!target || target === seat || target.eliminated) continue;
    for (let pos = 0; pos < target.tiles.length; pos++) {
      if (target.tiles[pos].revealed) continue;
      for (const color of ['b', 'w']) {
        for (let number = 0; number <= 11; number++) {
          const p = estimateGuessProbability(room, seat, target, pos, color, number);
          if (p > bestP) bestP = p;
        }
      }
      const pJ = estimateGuessProbability(room, seat, target, pos, null, null, true);
      if (pJ > bestP) bestP = pJ;
    }
  }
  if (bestP >= 0.3) handleContinueGuess({ room, seatIndex: seat.index }, room, {});
  else handleStopTurn({ room, seatIndex: seat.index }, room, {});
}

function botDiscard(room, seat) {
  if (room.pendingAction !== 'discard') return;
  const pos = seat.tiles.findIndex(t => !t.revealed);
  if (pos < 0) return;
  handleDiscard({ room, seatIndex: seat.index }, room, { position: pos });
}

function botReveal(room, seat) {
  const hidden = [];
  seat.tiles.forEach((t, i) => { if (!t.revealed) hidden.push(i); });
  if (hidden.length === 0) return;
  const jokerIdx = hidden.filter(i => seat.tiles[i].joker);
  // 优先翻 Joker（不泄露数字信息）
  const pos = jokerIdx.length ? jokerIdx[0] : hidden[Math.floor(Math.random() * hidden.length)];
  handleRevealOwn({ room, seatIndex: seat.index }, room, { position: pos });
}

/* ---------------------------------------------------------------------
 * 评分系统（每局表现分 + 长期积分）
 * 综合分 = 0.7×技术分 + 0.3×运气分；权重可在此调整
 * ------------------------------------------------------------------- */

function computeScoring(room) {
  const out = {};
  for (const seat of room.seats) {
    if (!seat) continue;
    const s = seat.stats;

    // 技术分：猜牌难度加权 + 被猜中率 + 胜负/存活贡献
    let guessSkill = 50;
    if (s.guesses > 0) {
      const d = (s.correctGuesses - s.expectedHits) / s.guesses; // [-1,1]
      guessSkill = clamp(50 + 50 * d, 0, 100);
    }
    let beGuessed = 50;
    if (s.guessedAgainst > 0) {
      beGuessed = clamp(100 * (1 - s.guessedCorrectAgainst / s.guessedAgainst), 0, 100);
    }
    let outcome = 0;
    if (room.winner === seat.index) outcome = 40;
    else if (!seat.eliminated) outcome = 20;
    const skill = clamp(0.5 * guessSkill + 0.3 * beGuessed + 0.2 * outcome, 0, 100);

    // 运气分：抽牌质量 + 高概率猜中 + 低概率被猜中
    let draw = 50;
    if (s.draws.length > 0) {
      const vals = s.draws.map(t => (t.joker ? 12 : t.number));
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      draw = clamp(100 * (avg / 12), 0, 100);
    }
    let guessLuck = 50;
    if (s.highProbGuesses > 0) {
      guessLuck = clamp(100 * (s.highProbHits / s.highProbGuesses), 0, 100);
    }
    let beGuessedLuck = 50;
    if (s.guessedAgainst > 0) {
      beGuessedLuck = clamp(100 * (1 - s.lowProbCorrectAgainst / s.guessedAgainst), 0, 100);
    }
    const luck = clamp(0.5 * draw + 0.25 * guessLuck + 0.25 * beGuessedLuck, 0, 100);
    const score = clamp(0.7 * skill + 0.3 * luck, 0, 100);

    out[seat.index] = { score, skill, luck };
  }
  return out;
}

// 长期积分：初始 1000；胜 +20 / 负 −10 基础分，按对手平均积分 Elo 风格微调（K=24），
// 再加每局表现分偏离 50 的小幅修正（±5 封顶）
function computeRatingDeltas(room, scoring) {
  const deltas = {};
  const humans = room.seats.filter(s => s && !s.isBot);
  const pre = {};
  for (const s of humans) {
    const st = getPlayerStats(s.nickname);
    pre[s.index] = st ? st.rating : 1000;
  }
  for (const s of humans) {
    const oppRatings = [];
    for (const o of room.seats) {
      if (!o || o.index === s.index) continue;
      oppRatings.push(o.isBot ? 1000 : (getPlayerStats(o.nickname) ? getPlayerStats(o.nickname).rating : 1000));
    }
    const avgOpp = oppRatings.length ? oppRatings.reduce((a, b) => a + b, 0) / oppRatings.length : 1000;
    const expected = 1 / (1 + Math.pow(10, (avgOpp - pre[s.index]) / 400));
    const result = room.winner === s.index ? 1 : 0;
    const eloDelta = 24 * (result - expected);
    const base = result === 1 ? 20 : -10;
    const adjust = eloDelta - (result === 1 ? 12 : -12); // 与同分对手的基准差
    const perfAdj = clamp((scoring[s.index].score - 50) * 0.1, -5, 5);
    deltas[s.index] = Math.round(base + adjust + perfAdj);
  }
  return deltas;
}

/* ---------------------------------------------------------------------
 * 对局结束：评分 + 战绩 + 回放
 * ------------------------------------------------------------------- */

function endGame(room, winnerIndex) {
  if (room.phase === 'ended') return;
  room.phase = 'ended';
  room.winner = winnerIndex;
  room.pendingAction = 'wait';
  room.pendingDraw = null;
  room.events.push({ type: 'end', winner: winnerIndex });

  const scoring = computeScoring(room);
  const deltas = computeRatingDeltas(room, scoring);
  const humanResults = [];
  for (const seat of room.seats) {
    if (!seat || seat.isBot) continue;
    const result = seat.index === winnerIndex ? 'win' : 'loss';
    const sc = scoring[seat.index];
    const delta = deltas[seat.index];
    recordGameResult(seat.nickname, {
      result, score: sc.score, skill: sc.skill, luck: sc.luck,
      ratingDelta: delta, gameId: room.gameId
    });
    humanResults.push({
      nickname: seat.nickname, seat: seat.index, result,
      score: sc.score, skill: sc.skill, luck: sc.luck, ratingDelta: delta
    });
  }
  for (const c of roomClients(room)) {
    c.send({ type: 'game_over', winner: winnerIndex, results: humanResults, gameId: room.gameId });
  }
  saveReplay(room, humanResults);
  broadcastState(room);
  const winnerSeat = winnerIndex != null ? room.seats[winnerIndex] : null;
  broadcastNotice(room, winnerSeat ? `${winnerSeat.nickname} 获胜！` : '对局结束（无人获胜）');
  room.lastActiveAt = Date.now();
}

function saveReplay(room, results) {
  const id = 'R' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const replay = {
    id,
    roomCode: room.code,
    at: Date.now(),
    players: room.seats.filter(Boolean).map(s => ({ index: s.index, nickname: s.nickname, isBot: s.isBot })),
    winner: room.winner,
    events: room.events,
    results,
    spectatorView: room.spectatorView
  };
  replays.set(id, replay);
  room.replayList.unshift({ id, at: replay.at, players: replay.players, winner: replay.winner });
  if (room.replayList.length > MAX_REPLAYS_PER_ROOM) room.replayList.pop();
  if (replays.size > MAX_REPLAYS_GLOBAL) {
    const first = replays.keys().next().value;
    if (first) replays.delete(first);
  }
}
/* ---------------------------------------------------------------------
 * 房间管理 / 消息路由
 * ------------------------------------------------------------------- */

function seatOf(client) {
  if (client && client.room && client.seatIndex != null) {
    return client.room.seats[client.seatIndex];
  }
  return null;
}

function err(client, message) {
  client.send({ type: 'error', message });
}

function sanitizeNick(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().slice(0, NICKNAME_MAX_LEN);
  return s.length > 0 ? s : null;
}

function transferHost(room) {
  const first = room.seats.find(s => s !== null);
  room.hostSeat = first ? first.index : null;
}

function closeRoom(room) {
  for (const t of room.timers) clearTimeout(t);
  room.timers.clear();
  for (const c of roomClients(room)) {
    c.room = null;
    c.seatIndex = null;
    c.spectator = false;
  }
  rooms.delete(room.code);
}

function maybeCloseRoom(room) {
  const anySeat = room.seats.some(s => s !== null);
  const anySpec = room.spectators.size > 0;
  if (!anySeat && !anySpec) closeRoom(room);
}

function bindSeat(client, room, seat) {
  seat.connected = true;
  seat.disconnectedAt = null;
  seat.client = client;
  client.room = room;
  client.seatIndex = seat.index;
  client.spectator = false;
  client.nickname = seat.nickname;
  broadcastState(room);
  sendStats(client);
}

function handleCreateRoom(client, msg) {
  const nickname = sanitizeNick(msg.nickname);
  if (!nickname) return err(client, '请输入昵称');
  if (client.room) leaveRoom(client);
  const room = createRoom();
  rooms.set(room.code, room);
  const idx = room.seats.findIndex(s => s === null);
  room.seats[idx] = makeSeat(idx, nickname, false);
  room.hostSeat = idx;
  bindSeat(client, room, room.seats[idx]);
  client.send({ type: 'notice', text: `房间创建成功，房间码：${room.code}` });
}

function handleJoinRoom(client, msg) {
  const nickname = sanitizeNick(msg.nickname);
  const code = String(msg.code || '').trim();
  if (!nickname) return err(client, '请输入昵称');
  const room = rooms.get(code);
  if (!room) return err(client, '房间不存在或已关闭');
  if (client.room) leaveRoom(client);
  // 断线重连：对局进行中/已结束时，同名座位可重连
  if (room.phase !== 'lobby') {
    const seat = room.seats.find(s => s && !s.isBot && s.nickname === nickname);
    if (seat && (!seat.connected || seat.disconnectedAt)) {
      bindSeat(client, room, seat);
      broadcastNotice(room, `${nickname} 重新连接`);
      return;
    }
    return err(client, room.phase === 'ended' ? '对局已结束，可输入房间码观战查看' : '对局进行中，无法加入（可输入房间码观战）');
  }
  if (room.seats.some(s => s && s.nickname === nickname)) return err(client, '该昵称已在房间中');
  const idx = room.seats.findIndex(s => s === null);
  if (idx === -1) return err(client, '房间已满');
  room.seats[idx] = makeSeat(idx, nickname, false);
  if (room.hostSeat == null) room.hostSeat = idx;
  bindSeat(client, room, room.seats[idx]);
  broadcastNotice(room, `${nickname} 加入了房间`);
}

function handleSpectate(client, msg) {
  const nickname = sanitizeNick(msg.nickname) || '观战者';
  const code = String(msg.code || '').trim();
  const room = rooms.get(code);
  if (!room) return err(client, '房间不存在或已关闭');
  if (client.room) leaveRoom(client);
  client.room = room;
  client.spectator = true;
  client.seatIndex = null;
  client.nickname = nickname;
  room.spectators.set(client, { nickname });
  broadcastState(room);
  broadcastNotice(room, `${nickname} 开始观战`);
}

function leaveRoom(client) {
  clearPendingInvitesFrom(client);
  const room = client.room;
  if (!room) return;
  if (client.spectator) {
    room.spectators.delete(client);
    client.room = null;
    client.spectator = false;
    client.seatIndex = null;
    broadcastState(room);
    return;
  }
  const seat = room.seats[client.seatIndex];
  client.room = null;
  client.seatIndex = null;
  client.spectator = false;
  if (!seat) return;
  if (room.phase === 'lobby' || room.phase === 'ended') {
    room.seats[seat.index] = null;
    if (room.hostSeat === seat.index) transferHost(room);
    broadcastState(room);
    broadcastNotice(room, `${seat.nickname} 离开了房间`);
    maybeCloseRoom(room);
  } else {
    seat.connected = false;
    seat.disconnectedAt = Date.now();
    seat.client = null;
    broadcastState(room);
    broadcastNotice(room, `${seat.nickname} 暂时离开（90 秒内可重连）`);
  }
}

function handleAddBot(client, room) {
  if (room.hostSeat !== client.seatIndex) return err(client, '只有房主可以添加机器人');
  if (room.phase !== 'lobby') return err(client, '对局开始后不能添加机器人');
  const idx = room.seats.findIndex(s => s === null);
  if (idx === -1) return err(client, '房间已满');
  const names = ['机器人A', '机器人B', '机器人C', '机器人D'];
  room.seats[idx] = makeSeat(idx, names[idx], true);
  broadcastState(room);
  broadcastNotice(room, `已添加 ${names[idx]}`);
}

function handleRemoveBot(client, room, msg) {
  if (room.hostSeat !== client.seatIndex) return err(client, '只有房主可以操作');
  if (room.phase !== 'lobby') return err(client, '对局开始后不能移除机器人');
  const seat = room.seats[msg.seat];
  if (!seat || !seat.isBot) return;
  room.seats[msg.seat] = null;
  broadcastState(room);
  broadcastNotice(room, `${seat.nickname} 已移除`);
}

function handleStartGame(client, room) {
  if (room.hostSeat !== client.seatIndex) return err(client, '只有房主可以开始');
  if (room.phase !== 'lobby') return;
  if (room.seats.filter(Boolean).length < 2) return err(client, '至少需要 2 名玩家（可添加机器人）');
  startGame(room);
}

function handleSetSpectatorView(client, room, msg) {
  if (room.hostSeat !== client.seatIndex) return err(client, '只有房主可以设置');
  if (msg.view !== 'all' && msg.view !== 'public') return;
  room.spectatorView = msg.view;
  broadcastState(room);
  broadcastNotice(room, `观战视角已切换：${msg.view === 'all' ? '可以看到暗牌' : '仅公开信息'}`);
}

function handleChat(client, room, msg) {
  const now = Date.now();
  if (now - client.lastChatAt < CHAT_RATE_LIMIT_MS) return err(client, '发言太快，请稍候');
  const kind = ['text', 'phrase', 'emoji'].includes(msg.kind) ? msg.kind : 'text';
  let text = String(msg.text || '').trim().slice(0, CHAT_MAX_LEN);
  if (!text) return;
  client.lastChatAt = now;
  const name = client.spectator ? (client.nickname || '观战者') + '（观战）' : client.nickname;
  broadcast(room, { type: 'chat', nickname: name, kind, text, ts: now });
}

function handleGetStats(client, msg) {
  const name = sanitizeNick(msg.nickname) || client.nickname;
  if (!name) return;
  const st = getPlayerStats(name);
  client.send({ type: 'stats', nickname: name, stats: st });
}
function onlinePlayersList() {
  const list = [];
  for (const c of clients) {
    if (!c.alive || !c.nickname) continue;
    const room = c.room;
    list.push({
      nickname: c.nickname,
      inRoom: !!room,
      code: room ? room.code : null,
      phase: room ? room.phase : null,
      seat: c.spectator ? null : c.seatIndex
    });
  }
  list.sort((a, b) => (a.nickname < b.nickname ? -1 : a.nickname > b.nickname ? 1 : 0));
  return list;
}

function handleListOnline(client) {
  client.send({ type: 'online_list', players: onlinePlayersList() });
}
function handleSetNickname(client, msg) {
  const nick = sanitizeNick(msg.nickname);
  if (nick) client.nickname = nick;
}

function clearPendingInvitesFrom(client) {
  for (const [target, p] of pendingInvites) {
    if (p.fromClient === client) pendingInvites.delete(target);
  }
}

function handleInvitePlayer(client, msg) {
  if (!client.nickname) return err(client, '请先设置昵称');
  const room = client.room;
  if (!room) return err(client, '请先创建或加入房间');
  if (room.phase !== 'lobby') return err(client, '对局已开始，无法邀请加入');
  const target = sanitizeNick(msg.nickname);
  if (!target) return err(client, '无效的玩家昵称');
  if (target === client.nickname) return err(client, '不能邀请自己');
  if (Date.now() - (client.lastInviteAt || 0) < 2000) return err(client, '操作太快，请稍后再试');
  client.lastInviteAt = Date.now();
  const targetClient = [...clients].find((c) => c.alive && c.nickname === target);
  if (!targetClient) return err(client, `${target} 不在线`);
  if (targetClient.room === room) return err(client, `${target} 已在本房间`);
  if (pendingInvites.has(target)) return err(client, `${target} 已有待处理的邀请`);
  pendingInvites.set(target, { fromNick: client.nickname, fromClient: client, code: room.code, at: Date.now() });
  targetClient.send({ type: 'invite', from: client.nickname, code: room.code });
}

function handleInviteResponse(client, msg) {
  if (!client.nickname) return;
  const pending = pendingInvites.get(client.nickname);
  if (!pending) return err(client, '没有待处理的邀请');
  pendingInvites.delete(client.nickname);
  const inviter = pending.fromClient;
  const room = rooms.get(pending.code);
  const notifyInviter = (text) => {
    if (inviter && inviter.alive) inviter.send({ type: 'notice', text });
  };
  if (msg.accept !== true) {
    notifyInviter(`${client.nickname} 拒绝了你的邀请`);
    return;
  }
  if (!room) { notifyInviter(`${client.nickname} 接受了邀请，但房间已关闭`); return err(client, '房间已关闭'); }
  if (room.phase !== 'lobby') { notifyInviter(`${client.nickname} 接受了邀请，但对局已开始`); return err(client, '对局已开始，无法加入'); }
  if (room.seats.some((s) => s && s.nickname === client.nickname)) return err(client, '该昵称已在房间中');
  if (client.room) leaveRoom(client);
  const idx = room.seats.findIndex((s) => s === null);
  if (idx === -1) return err(client, '房间已满');
  room.seats[idx] = makeSeat(idx, client.nickname, false);
  if (room.hostSeat == null) room.hostSeat = idx;
  bindSeat(client, room, room.seats[idx]);
  broadcastNotice(room, `${client.nickname} 接受了邀请，加入了房间`);
  notifyInviter(`${client.nickname} 接受了邀请，加入了房间`);
}

function handleGetReplays(client, room) {
  client.send({ type: 'replay_list', replays: room.replayList });
}

function handleGetReplay(client, msg) {
  const r = replays.get(String(msg.id || ''));
  if (!r) return err(client, '回放不存在（服务重启后回放丢失）');
  client.send({ type: 'replay', replay: r });
}

function routeMessage(client, msg) {
  const room = client.room;
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'create_room': return handleCreateRoom(client, msg);
    case 'join_room': return handleJoinRoom(client, msg);
    case 'spectate_room': return handleSpectate(client, msg);
    case 'leave': return leaveRoom(client);
    case 'get_stats': return handleGetStats(client, msg);
    case 'list_online': return handleListOnline(client);
    case 'set_nickname': return handleSetNickname(client, msg);
    case 'invite_player': return handleInvitePlayer(client, msg);
    case 'invite_response': return handleInviteResponse(client, msg);
    case 'chat': return room ? handleChat(client, room, msg) : err(client, '请先进入房间');
    case 'get_replays': return room ? handleGetReplays(client, room) : null;
    case 'get_replay': return handleGetReplay(client, msg);
    case 'add_bot': return room ? handleAddBot(client, room) : null;
    case 'remove_bot': return room ? handleRemoveBot(client, room, msg) : null;
    case 'start_game': return room ? handleStartGame(client, room) : null;
    case 'set_spectator_view': return room ? handleSetSpectatorView(client, room, msg) : null;
    case 'arrange_done': return room ? handleArrange(client, room, msg) : null;
    case 'draw': return room ? handleDraw(client, room, msg) : null;
    case 'place_drawn': return room ? handlePlace(client, room, msg) : null;
    case 'reorder_tiles': return room ? handleReorderTiles(client, room, msg) : null;
    case 'guess': return room ? handleGuess(client, room, msg) : null;
    case 'reveal_own': return room ? handleRevealOwn(client, room, msg) : null;
    case 'continue_guess': return room ? handleContinueGuess(client, room, msg) : null;
    case 'stop_turn': return room ? handleStopTurn(client, room, msg) : null;
    case 'discard': return room ? handleDiscard(client, room, msg) : null;
    default: break;
  }
}

/* ---------------------------------------------------------------------
 * 断线与清理
 * ------------------------------------------------------------------- */

function onDisconnect(client) {
  clearPendingInvitesFrom(client);
  if (client.nickname) pendingInvites.delete(client.nickname);
  if (!client.room) return;
  const room = client.room;
  if (client.spectator) {
    room.spectators.delete(client);
    broadcastState(room);
    return;
  }
  const seat = room.seats[client.seatIndex];
  if (!seat) return;
  if (room.phase === 'lobby' || room.phase === 'ended') {
    room.seats[seat.index] = null;
    if (room.hostSeat === seat.index) transferHost(room);
    broadcastState(room);
    maybeCloseRoom(room);
  } else {
    seat.connected = false;
    seat.disconnectedAt = Date.now();
    seat.client = null;
    broadcastState(room);
    broadcastNotice(room, `${seat.nickname} 掉线了（90 秒内可重连）`);
  }
}

function sweep() {
  const now = Date.now();
  // 清理过期的待处理邀请
  for (const [target, p] of pendingInvites) {
    if (now - p.at > INVITE_TTL_MS) pendingInvites.delete(target);
  }
  for (const room of rooms.values()) {
    for (const seat of room.seats) {
      if (!seat || seat.isBot || seat.connected) continue;
      if (!seat.disconnectedAt || now - seat.disconnectedAt <= RECONNECT_GRACE_MS) continue;
      if (room.phase === 'lobby' || room.phase === 'arranging' || room.phase === 'ended') {
        room.seats[seat.index] = null;
        if (room.hostSeat === seat.index) transferHost(room);
        broadcastNotice(room, `${seat.nickname} 超时未重连，已移出房间`);
        broadcastState(room);
        maybeCloseRoom(room);
      } else if (room.phase === 'playing' && !seat.eliminated) {
        seat.eliminated = true;
        seat.connected = false;
        room.events.push({ type: 'eliminate', seat: seat.index, reason: 'timeout' });
        broadcastNotice(room, `${seat.nickname} 超时未重连，判负出局`);
        broadcastState(room);
        advanceAfterAction(room);
      }
    }
    // 空房间回收（保留一段观察期，便于回放访问）
    const anySeat = room.seats.some(s => s !== null);
    const anySpec = room.spectators.size > 0;
    if (!anySeat && !anySpec && now - room.lastActiveAt > EMPTY_ROOM_TTL_MS) {
      closeRoom(room);
    }
  }
}

/* ---------------------------------------------------------------------
 * WebSocket 升级与服务器启动
 * ------------------------------------------------------------------- */

const clients = new Set();

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAcceptKey(key) + '\r\n\r\n'
  );
  const client = new Client(socket);
  clients.add(client);
  socket.on('data', (chunk) => {
    client.lastSeen = Date.now();
    let frames;
    try {
      frames = client.decoder.push(chunk);
    } catch (e) {
      client.close();
      return;
    }
    for (const f of frames) handleFrame(client, f);
  });
  socket.on('error', () => { /* 忽略 */ });
  socket.on('close', () => {
    if (!client.alive) return;
    client.alive = false;
    clients.delete(client);
    onDisconnect(client);
  });
}

function handleFrame(client, f) {
  if (f.opcode === 0x8) {
    client.close();
    return;
  }
  if (f.opcode === 0x9) {
    if (client.alive) client.socket.write(encodeFrame(0xA, f.payload));
    return;
  }
  if (f.opcode === 0x1 || f.opcode === 0x0) {
    client.msgBuffer = client.msgBuffer ? Buffer.concat([client.msgBuffer, f.payload]) : f.payload;
    if (f.fin && client.msgBuffer) {
      const data = client.msgBuffer.toString('utf8');
      client.msgBuffer = null;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        return;
      }
      routeMessage(client, msg);
    }
  }
}

const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
if (sweepTimer.unref) sweepTimer.unref();

/* ---------------------------------------------------------------------
 * 战绩备份 API：GET 下载 / POST 恢复
 * ------------------------------------------------------------------- */

// 前端错误上报（内存保留最近 200 条，便于诊断）
const clientLogs = [];
function handleClientLog(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      clientLogs.push({ at: Date.now(), ...body });
      if (clientLogs.length > 200) clientLogs.shift();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400); res.end('{}');
    }
  });
  req.on('error', () => { try { res.writeHead(400); res.end('{}'); } catch (e) {} });
}

function handleStatsUpload(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 5 * 1024 * 1024) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || data.version !== 1 || !data.players || typeof data.players !== 'object') {
        throw new Error('文件格式不正确（需要 version:1 的 stats 文件）');
      }
      const clean = { version: 1, players: {} };
      for (const [name, p] of Object.entries(data.players)) {
        const nick = String(name || '').trim().slice(0, NICKNAME_MAX_LEN);
        if (!nick || !p || typeof p !== 'object') continue;
        clean.players[nick] = {
          games: Math.max(0, Number(p.games) || 0),
          wins: Math.max(0, Number(p.wins) || 0),
          losses: Math.max(0, Number(p.losses) || 0),
          winRate: Number(p.winRate) || 0,
          currentStreak: Math.max(0, Number(p.currentStreak) || 0),
          bestStreak: Math.max(0, Number(p.bestStreak) || 0),
          rating: Number.isFinite(p.rating) ? p.rating : 1000,
          recent: Array.isArray(p.recent)
            ? p.recent.slice(0, MAX_RECENT_PER_PLAYER).map((r) => ({
                at: Number(r.at) || 0,
                gameId: String(r.gameId || ''),
                result: r.result === 'win' ? 'win' : 'loss',
                score: Math.round(Number(r.score) || 0),
                skill: Math.round(Number(r.skill) || 0),
                luck: Math.round(Number(r.luck) || 0),
                ratingDelta: Math.round(Number(r.ratingDelta) || 0)
              }))
            : []
        };
      }
      statsData = clean;
      saveStats();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, players: Object.keys(clean.players).length }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
  req.on('error', () => {
    try { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{}'); } catch (e) { /* ignore */ }
  });
}
function startServer(opts = {}) {
  loadStats();
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/api/log' && req.method === 'POST') {
      handleClientLog(req, res);
      return;
    }
    if (urlPath === '/api/log' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(clientLogs));
      return;
    }
    if (urlPath === '/api/stats' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(JSON.stringify(statsData));
      return;
    }
    if (urlPath === '/api/stats' && req.method === 'POST') {
      handleStatsUpload(req, res);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res);
    else {
      res.writeHead(405);
      res.end();
    }
  });
  server.on('upgrade', handleUpgrade);
  const port = opts.port === undefined ? PORT : opts.port;
  return new Promise((resolve) => {
    server.listen(port, opts.host || HOST, () => {
      const actual = server.address().port;
      console.log(`达芬奇密码服务已启动: http://localhost:${actual}`);
      resolve({
        server,
        port: actual,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  startServer, loadStats, saveStats, getPlayerStats, recordGameResult,
  makeDeck, compareTiles, tileRank, tileLabel,
  estimateGuessProbability, computeScoring, computeRatingDeltas,
  createRoom, makeSeat, startGame, endGame,
  _rooms: rooms, _replays: replays, _sweep: sweep
};