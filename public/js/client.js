'use strict';

/* ===================== 全局状态 ===================== */
const App = {
  ws: null,
  nickname: localStorage.getItem('dvc-nick') || '',
  state: null,          // 最新房间状态快照
  view: 'lobby',        // lobby | room | game | replay
  myStats: null,
  results: null,        // game_over 数据
  arranged: false,      // 本局是否已确认手牌排列
  arrangeOrder: null,   // 排列中的牌 id 顺序
  selJoker: null,       // 选中要移动的 Joker id
  guess: null,          // { target, position, color, number }
  chatMsgs: [],
  online: [],        // 在线玩家列表
  replay: null,         // 回放原始数据
  replaySnaps: null,
  replayLog: null,
  replayIdx: 0,
  replayAutoTimer: null,
  reconnectTimer: null,
  curGameId: null
};

/* ===================== 工具 ===================== */
const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function showToast(text, ms) {
  const root = $('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  root.appendChild(el);
  setTimeout(() => el.remove(), ms || 2600);
}
/* ===================== 复制 ===================== */
function copyText(text) {
  return new Promise((resolve) => {
    const ok = (v) => resolve(!!v);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => ok(true), () => ok(fallbackCopy(text)));
    } else {
      ok(fallbackCopy(text));
    }
  });
}
function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}
function copyRoomCode() {
  const code = (App.state && App.state.code) || ($('room-code').textContent.trim());
  if (!code) return;
  copyText(code).then((ok) => {
    showToast(ok ? '房间码已复制：' + code : '复制失败，房间码：' + code, ok ? 2200 : 4000);
  });
}
function openModal(html, opts = {}) {
  const root = $('modal-root');
  root.innerHTML = '';
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="panel"><div class="modal-body">${html}</div></div>`;
  if (opts.dismissable !== false) {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  }
  root.appendChild(overlay);
  return overlay;
}
function closeModal() { $('modal-root').innerHTML = ''; }
function mySeat() {
  if (!App.state || App.state.you.isSpectator) return null;
  return App.state.seats[App.state.you.seat] || null;
}
function canAct() {
  const st = App.state;
  return st && st.phase === 'playing' && !st.you.isSpectator && st.you.seat === st.currentTurn;
}

/* ===================== WebSocket ===================== */
function updateDebugBadge() {
  try {
    const el = document.getElementById('debug-badge');
    if (!el) return;
    const st = App.state;
    const parts = ['v2.9'];
    if (st) {
      parts.push('phase=' + st.phase, 'turn=' + st.currentTurn, 'act=' + st.pendingAction, 'you=' + (st.you.seat != null ? st.you.seat : '观战'));
    }
    parts.push('modal=' + (document.getElementById('modal-root').children.length));
    const roEl = document.getElementById('results-overlay');
    parts.push('ro=' + (roEl ? (getComputedStyle(roEl).display === 'none' ? '0' : 'SHOW') : 'x'));
    parts.push('arranged=' + App.arranged);
    el.textContent = parts.join(' | ');
  } catch (e) { /* ignore */ }
}
function reportClientError(kind, msg) {
  try {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, msg: String(msg).slice(0, 500), url: location.href })
    }).catch(() => {});
  } catch (e) { /* ignore */ }
}
window.addEventListener('error', (e) => {
  console.error('全局异常:', e.message);
  reportClientError('window-error', e.message + ' | ' + (e.filename || '') + ':' + (e.lineno || ''));
  showToast('出现异常，请刷新页面重试');
});
window.addEventListener('unhandledrejection', (e) => {
  reportClientError('unhandledrejection', e.reason && e.reason.message ? e.reason.message : String(e.reason));
});
function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const ws = new WebSocket(proto + location.host);
  App.ws = ws;
  ws.onopen = () => {
    reportClientError('ws', 'connected');
    showToast('已连接服务器');
    if (App.nickname) send({ type: 'set_nickname', nickname: App.nickname });
    if (App.nickname) send({ type: 'get_stats', nickname: App.nickname });
    send({ type: 'list_online' });
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleMessage(msg);
  };
  ws.onclose = () => {
    reportClientError('ws', 'closed');
    showToast('连接断开，正在自动重连…', 4000);
    if (!App.reconnectTimer) {
      App.reconnectTimer = setInterval(() => {
        if (!App.ws || App.ws.readyState === WebSocket.CLOSED) {
          clearInterval(App.reconnectTimer);
          App.reconnectTimer = null;
          connect();
        }
      }, 3000);
    }
  };
  ws.onerror = () => {};
}
function send(obj) {
  if (App.ws && App.ws.readyState === WebSocket.OPEN) App.ws.send(JSON.stringify(obj));
}

/* ===================== 消息处理 ===================== */
function handleMessage(msg) {
  try {
    handleMessageInner(msg);
  } catch (e) {
    console.error('消息处理异常:', e);
    reportClientError('handleMessage', e.message);
    showToast('出现异常，请刷新页面重试');
  }
}

function handleMessageInner(msg) {
  switch (msg.type) {
    case 'state':
      if (App.state && App.state.gameId !== msg.gameId) {
        App.curGameId = null;
        App.arranged = false;
        App.arrangeOrder = null;
        App.results = null;
        closeModal();
      }
      App.state = msg;
      if (App.view !== 'replay') render();
      break;
    case 'stats':
      if (msg.nickname && msg.nickname !== App.nickname) {
        showStatsModal(msg.nickname, msg.stats);
      } else {
        App.myStats = msg;
        if (App.view === 'lobby') renderStats();
      }
      break;
    case 'online_list':
      App.online = msg.players || [];
      if (App.view === 'lobby') renderOnline();
      if (App.onlineModalOpen) renderOnlineModal();
      break;
    case 'invite':
      showInviteModal(msg.from, msg.code);
      break;
    case 'notice':
      showToast(msg.text);
      break;
    case 'error':
      showToast('⚠️ ' + msg.message);
      break;
    case 'chat':
      App.chatMsgs.push(msg);
      renderChat();
      break;
    case 'game_over':
      App.results = msg;
      renderResults();
      autoBackupStats();
      break;
    case 'replay_list':
      showReplayList(msg.replays);
      break;
    case 'replay':
      loadReplay(msg.replay);
      break;
    default:
      break;
  }
}

/* ===================== 视图切换 ===================== */
function showView(name) {
  App.view = name;
  for (const v of ['lobby', 'room', 'game', 'replay']) {
    $('view-' + v).hidden = v !== name;
  }
  if (name === 'lobby') renderStats();
  if (name === 'room' || name === 'game') renderChat();
}

/* ===================== 渲染 ===================== */
function render() {
  const st = App.state;
  if (!st) return;
  updateDebugBadge();
  try {
    if (st.phase === 'lobby') {
      showView('room');
      renderRoom();
    } else {
      showView('game');
      renderGame();
    }
  } catch (e) {
    console.error('渲染异常:', e);
    reportClientError('render', e.message);
    showToast('界面渲染出错，请刷新页面重试');
  }
}

function renderRoom() {
  const st = App.state;
  $('room-code').textContent = st.code;
  const filled = st.seats.filter(Boolean).length;
  $('seat-count').textContent = filled;
  const list = $('seat-list');
  list.innerHTML = '';
  st.seats.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'seat-item';
    if (!s) {
      item.innerHTML = `<div class="dot off"></div><div class="name empty">空位</div>`;
    } else {
      const tags = [];
      if (s.isHost) tags.push('<span class="tag host">房主</span>');
      if (s.isBot) tags.push('<span class="tag">机器人</span>');
      if (!s.connected) tags.push('<span class="tag">掉线</span>');
      item.innerHTML = `<div class="dot ${s.connected ? '' : 'off'}"></div><div class="name">${esc(s.nickname)}${tags.join('')}</div>`;
      if (st.you.seat === st.hostSeat && s.isBot && st.phase === 'lobby') {
        const btn = document.createElement('button');
        btn.className = 'btn small ghost';
        btn.textContent = '移除';
        btn.onclick = () => send({ type: 'remove_bot', seat: i });
        item.appendChild(btn);
      }
    }
    list.appendChild(item);
  });
  const isHost = st.you.seat === st.hostSeat;
  $('invite-row').hidden = st.you.isSpectator || st.you.seat == null;
  $('host-controls').hidden = !isHost || st.phase !== 'lobby';
  $('spec-controls').hidden = !isHost;
  $('btn-view-all').classList.toggle('primary', st.spectatorView === 'all');
  $('btn-view-public').classList.toggle('primary', st.spectatorView === 'public');
  $('replay-row').hidden = false;
  $('room-hint').textContent =
    `把房间码 ${st.code} 发给朋友即可加入（2–4 人）。` +
    (st.spectatorCount > 0 ? ` 当前观战 ${st.spectatorCount} 人。` : '');
}

/* ---------------- 牌面 ---------------- */
function tileEl(t, onClick) {
  const div = document.createElement('div');
  div.className = 'tile';
  const faceDown = !t.revealed && t.number == null && !t.joker; // 暗牌：黑/白公开，数字保密
  if (t.fresh) {
    div.classList.add('tile-fresh');
    const badge = document.createElement('span');
    badge.className = 'tile-fresh-badge';
    badge.textContent = '新';
    div.appendChild(badge);
  }
  if (faceDown) {
    div.classList.add('tile-down');
    if (t.color === 'b') div.classList.add('tile-down-b');
    else if (t.color === 'w') div.classList.add('tile-down-w');
    if (t.knownToOwner) div.classList.add('tile-own');
  } else if (t.color != null) {
    if (t.joker) div.classList.add('tile-joker', t.color === 'b' ? 'tile-joker-b' : 'tile-joker-w');
    else div.classList.add(t.color === 'b' ? 'tile-b' : 'tile-w');
    if (!t.joker) div.textContent = t.number;
    if (t.revealed) {
      div.classList.add('tile-revealed');
      const mark = document.createElement('span');
      mark.className = 'tile-revealed-mark';
      mark.textContent = '已翻';
      div.appendChild(mark);
    }
    else if (t.number == null && !t.joker) {
      div.textContent = '?';
      div.classList.add('tile-unknown');
    }
    if (!t.revealed && t.knownToOwner) div.classList.add('tile-own');
  } else {
    div.classList.add('tile-down');
  }
  if (onClick) {
    div.classList.add('clickable');
    div.addEventListener('click', onClick);
  }
  return div;
}

function seatTags(s, isMe) {
  const tags = [];
  if (s.isHost) tags.push('<span class="tag host">房主</span>');
  if (s.isBot) tags.push('<span class="tag">机器人</span>');
  if (isMe) tags.push('<span class="tag">我</span>');
  if (s.eliminated) tags.push('<span class="tag">出局</span>');
  if (!s.connected && !s.isBot) tags.push('<span class="tag">掉线</span>');
  return tags.join('');
}

function playerBox(s, isMe) {
  const box = document.createElement('div');
  box.className = 'player-box' + (isMe ? ' me' : '');
  const isTurn = App.state.currentTurn === s.index && App.state.phase === 'playing' && !s.eliminated;
  const label = document.createElement('div');
  label.className = 'seat-label';
  label.innerHTML = `${esc(s.nickname)}<span class="tag">${isTurn ? '▶ 回合' : ''}</span>${seatTags(s, isMe)}`;
  box.appendChild(label);
  const row = document.createElement('div');
  row.className = 'tile-row';
  const guessable = canAct() && App.state.pendingAction === 'guess';
  s.tiles.forEach((t, pos) => {
    let onClick = null;
    if (guessable && !t.revealed && !s.eliminated) {
      onClick = () => openGuessModal(s.index, pos);
    }
    row.appendChild(tileEl(t, onClick));
  });
  if (s.eliminated) box.style.opacity = '.55';
  box.appendChild(row);
  const hint = document.createElement('div');
  hint.className = 'row-hint';
  hint.textContent = '← 小 · 大 →';
  box.appendChild(hint);
  return box;
}

/* ---------------- 对局桌 ---------------- */
function renderGame() {
  const st = App.state;
  $('game-room-code').textContent = st.code;
  $('turn-banner').textContent = turnBannerText(st);

  const myIdx = st.you.isSpectator ? null : st.you.seat;
  // 对手区域
  const oppWrap = $('opponents');
  oppWrap.innerHTML = '';
  const seats = st.seats.map((s, i) => ({ s, i })).filter(x => x.s && (myIdx == null ? true : x.i !== myIdx));
  if (myIdx != null) seats.sort((a, b) => ((a.i - myIdx + 4) % 4) - ((b.i - myIdx + 4) % 4));
  else seats.sort((a, b) => a.i - b.i);
  for (const { s } of seats) oppWrap.appendChild(playerBox(s, false));

  // 自己区域
  const ownArea = $('own-area');
  if (myIdx != null) {
    ownArea.hidden = false;
    const me = st.seats[myIdx];
    $('own-label').innerHTML = `${esc(me.nickname)}${seatTags(me, true)}`;
    const row = $('own-row');
    row.innerHTML = '';
    renderOwnRow(row, me);
  } else {
    ownArea.hidden = true;
  }

  $('pile-count').textContent = st.drawPileSize;
  renderActionArea();

  if (st.phase === 'arranging' && myIdx != null && !App.arranged) {
    openArrangeModal();
  }
}

function renderOwnRow(row, me) {
  const st = App.state;
  const placing = canAct() && st.pendingAction === 'place';
  const revealing = canAct() && st.pendingAction === 'reveal';
  const discarding = canAct() && st.pendingAction === 'discard';
  if (placing) {
    for (let pos = 0; pos <= me.tiles.length; pos++) {
      const slot = document.createElement('div');
      slot.className = 'tile slot';
      slot.textContent = '▮';
      slot.title = '放在第 ' + (pos + 1) + ' 位';
      slot.addEventListener('click', () => send({ type: 'place_drawn', position: pos }));
      row.appendChild(slot);
      if (pos < me.tiles.length) row.appendChild(tileEl(me.tiles[pos]));
    }
  } else {
    me.tiles.forEach((t, pos) => {
      let onClick = null;
      if (revealing && !t.revealed) onClick = () => send({ type: 'reveal_own', position: pos });
      if (discarding && !t.revealed) onClick = () => send({ type: 'discard', position: pos });
      row.appendChild(tileEl(t, onClick));
    });
  }
}

function renderActionArea() {
  const area = $('action-area');
  area.innerHTML = '';
  // 事件委托：操作区按钮绑定在容器上，任何 innerHTML 重建都不会丢事件
  if (!area.dataset.actions) {
    area.dataset.actions = '1';
    area.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!btn) return;
      const a = btn.dataset.action;
      if (a === 'draw-b') send({ type: 'draw', pile: 'b' });
      else if (a === 'draw-w') send({ type: 'draw', pile: 'w' });
      else if (a === 'continue_guess') send({ type: 'continue_guess' });
      else if (a === 'stop_turn') send({ type: 'stop_turn' });
      else if (a === 'adjust_joker') openJokerAdjust();
    });
  }
  const st = App.state;
  if (st.phase === 'arranging') {
    area.innerHTML = '<div class="hint">正在排列手牌…</div>';
    return;
  }
  if (st.phase === 'ended') {
    area.innerHTML = '<div class="hint">对局结束</div>';
    return;
  }
  if (st.you.isSpectator) {
    area.innerHTML = '<div class="hint">观战中</div>';
    return;
  }
  if (st.you.seat !== st.currentTurn) {
    const cur = st.seats[st.currentTurn];
    area.innerHTML = `<div class="hint">等待 ${esc(cur ? cur.nickname : '…')}</div>`;
    return;
  }
  switch (st.pendingAction) {
    case 'draw':
      area.innerHTML =
        '<div class="draw-choice">' +
        `<button class="btn draw-tile draw-b" id="btn-draw-b" data-action="draw-b"><span class="draw-tile-label">抽黑牌</span><span class="draw-tile-count">剩 ${st.blackPileSize || 0}</span></button>` +
        `<button class="btn draw-tile draw-w" id="btn-draw-w" data-action="draw-w"><span class="draw-tile-label">抽白牌</span><span class="draw-tile-count">剩 ${st.whitePileSize || 0}</span></button>` +
        '</div>';
      $('btn-draw-b').disabled = (st.blackPileSize || 0) <= 0;
      $('btn-draw-w').disabled = (st.whitePileSize || 0) <= 0;
      $('btn-draw-b').onclick = () => send({ type: 'draw', pile: 'b' });
      $('btn-draw-w').onclick = () => send({ type: 'draw', pile: 'w' });
      break;
    case 'place':
      area.innerHTML = '<div class="hint">抽到了牌（背面）—— 选择放置位置</div>';
      break;
    case 'guess':
      area.innerHTML = '<div class="hint">点击一名对手的暗牌来猜牌</div>';
      break;
    case 'reveal':
      area.innerHTML = '<div class="hint">猜错了！点击自己的一张暗牌翻开</div>';
      break;
    case 'discard':
      area.innerHTML = '<div class="hint">牌堆已空，猜错了 —— 点击自己的一张暗牌抛弃</div>';
      break;
    case 'continue':
      area.innerHTML = '<div class="hint">猜中了！可继续猜牌，或停手结束回合。</div>' +
        '<div class="row" style="justify-content:center;margin-top:10px">' +
        '<button class="btn primary" id="btn-continue-guess" data-action="continue_guess">继续猜</button>' +
        '<button class="btn ghost" id="btn-stop-turn" data-action="stop_turn">停手</button>' +
        '</div>';
      $('btn-continue-guess').onclick = () => send({ type: 'continue_guess' });
      $('btn-stop-turn').onclick = () => send({ type: 'stop_turn' });
      break;
    default:
      break;
  }
  // 自己的回合内可随时调整 Joker 位置
  const meSeat = st.seats[st.you.seat];
  if (meSeat && meSeat.tiles.some(t => t.joker && !t.revealed)) {
    const btn = '<div class="row" style="justify-content:center;margin-bottom:8px"><button class="btn small ghost" id="btn-adjust-joker" data-action="adjust_joker">⇄ 调整 Joker</button></div>';
    area.insertAdjacentHTML('afterbegin', btn);
    $('btn-adjust-joker').onclick = () => openJokerAdjust();
  }
}

function turnBannerText(st) {
  if (st.phase === 'arranging') return '手牌排列中…';
  if (st.phase === 'ended') return '对局结束';
  const cur = st.seats[st.currentTurn];
  const curName = cur ? cur.nickname : '—';
  if (st.you.isSpectator) return '观战中 · 轮到 ' + curName;
  if (st.you.seat === st.currentTurn) {
    const t = {
      draw: '轮到你：抽牌（可选黑/白牌堆，摸到后自动按序排入）',
      place: '轮到你：放置抽到的牌',
      guess: '轮到你：猜牌',
      reveal: '轮到你：翻开自己的一张牌',
      discard: '轮到你：选择一张牌抛弃',
      continue: '轮到你：猜中了！继续猜或停手'
    };
    return t[st.pendingAction] || '轮到你';
  }
  return '轮到 ' + curName;
}

/* ---------------- 手牌排列 ---------------- */
function openArrangeModal() {
  const me = mySeat();
  if (!me) return;
  App.arrangeMode = 'arrange';
  if (App.state.gameId !== App.curGameId || !App.arrangeOrder) {
    App.curGameId = App.state.gameId;
    App.arrangeOrder = me.tiles.map(t => t.id);
    App.arranged = false;
    App.selJoker = null;
  }
  const hasJoker = me.tiles.some(t => t.joker);
  if (!hasJoker) {
    send({ type: 'arrange_done', positions: App.arrangeOrder });
    App.arranged = true;
    return;
  }
  renderArrangeModal();
}

function renderArrangeModal() {
  const me = mySeat();
  if (!me || !App.arrangeOrder) return;
  const byId = new Map(me.tiles.map(t => [t.id, t]));
  const order = App.arrangeOrder.map(id => byId.get(id));
  const isAdjust = App.arrangeMode === 'adjust';
  let html = `<h3>${isAdjust ? '调整 Joker 位置' : '排列你的手牌'}</h3>`;
  html += '<p class="hint">Joker 是百搭牌，可以放在任意位置。点击 Joker 选中，再点下方位置移动。</p>';
  html += '<div class="tile-row" style="margin:12px 0">';
  order.forEach((t) => {
    const jcls = t.joker ? (t.color === 'b' ? 'tile-joker tile-joker-b' : 'tile-joker tile-joker-w') : (t.color === 'b' ? 'tile-b' : 'tile-w');
    const cls = 'tile ' + jcls + (App.selJoker === t.id ? ' tile-revealed' : '');
    const click = t.joker ? ` onclick="selectJoker(${t.id})" style="cursor:pointer"` : '';
    const content = t.joker ? '' : esc(t.number);
    html += `<div class="${cls}"${click}>${content}</div>`;
  });
  html += '</div>';
  html += '<div class="row" style="justify-content:center">';
  if (App.selJoker != null) {
    for (let pos = 0; pos < order.length; pos++) {
      const idx = pos;
      html += `<button class="btn small" onclick="App.selJoker && moveJoker(App.selJoker, ${idx})">第${pos + 1}位</button>`;
    }
  } else {
    html += '<span class="hint">（没有选中 Joker，可直接确认）</span>';
  }
  html += '</div>';
  html += '<div class="row" style="justify-content:center;margin-top:14px">';
  html += `<button class="btn primary" onclick="confirmArrange()">${isAdjust ? '确认调整' : '确认排列'}</button>`;
  html += '</div>';
  const overlay = openModal(html, { dismissable: false });
  overlay.querySelector('.panel').style.maxWidth = '520px';
}
function selectJoker(id) {
  App.selJoker = App.selJoker === id ? null : id;
  renderArrangeModal();
}
function moveJoker(id, pos) {
  const from = App.arrangeOrder.indexOf(id);
  if (from < 0) return;
  const tid = App.arrangeOrder.splice(from, 1)[0];
  App.arrangeOrder.splice(pos, 0, tid);
  App.selJoker = null;
  renderArrangeModal();
}
function confirmArrange() {
  if (App.arrangeMode === 'adjust') {
    send({ type: 'reorder_tiles', positions: App.arrangeOrder });
    App.arrangeOrder = null;
  } else {
    send({ type: 'arrange_done', positions: App.arrangeOrder });
    App.arranged = true;
  }
  closeModal();
}
function openJokerAdjust() {
  const me = mySeat();
  if (!me) return;
  App.arrangeMode = 'adjust';
  App.arrangeOrder = me.tiles.map(t => t.id);
  App.selJoker = null;
  renderArrangeModal();
}

/* ---------------- 猜牌弹窗 ---------------- */
function openGuessModal(targetIdx, pos) {
  const target = App.state.seats[targetIdx];
  if (!target) return;
  const tile = target.tiles[pos];
  const knownColor = tile && (tile.color === 'b' || tile.color === 'w') ? tile.color : 'b';
  App.guess = { target: targetIdx, position: pos, joker: false, color: knownColor, number: 0 };
  renderGuessModal();
}
function renderGuessModal() {
  const g = App.guess;
  const target = App.state.seats[g.target];
  const tile = target.tiles[g.position];
  const knownColor = tile && (tile.color === 'b' || tile.color === 'w') ? (tile.color === 'b' ? '黑' : '白') : null;
  let html = `<h3>猜 ${esc(target.nickname)} 的第 ${g.position + 1} 张牌</h3>`;
  html += '<div class="color-pick">';
  html += `<button class="btn ${g.joker ? 'on' : ''}" onclick="setGuessJoker(true)" title="猜这张牌是 Joker（横线百搭牌，黑/白颜色公开）"><span class="joker-guess-mark"></span>Joker</button>`;
  if (knownColor) {
    const isJokerTile = tile && tile.joker;
    html += `<span class="hint" style="align-self:center">这是一张<b>${knownColor}${isJokerTile ? ' Joker' : '牌'}</b>${isJokerTile ? '（百搭）' : '（颜色公开）'}</span>`;
  } else {
    html += `<button class="btn ${!g.joker && g.color === 'b' ? 'on' : ''}" onclick="setGuessColor('b')">黑色</button>`;
    html += `<button class="btn ${!g.joker && g.color === 'w' ? 'on' : ''}" onclick="setGuessColor('w')">白色</button>`;
  }
  html += '</div>';
  if (!g.joker) {
    html += '<div class="num-grid">';
    for (let n = 0; n <= 11; n++) {
      html += `<button class="btn ${g.number === n ? 'on' : ''}" onclick="setGuessNumber(${n})">${n}</button>`;
    }
    html += '</div>';
  }
  html += `<button class="btn primary block" onclick="submitGuess()">确认猜牌</button>`;
  html += '<button class="btn link" onclick="closeModal()">取消</button>';
  openModal(html);
}
function setGuessJoker(v) {
  if (App.guess) App.guess.joker = !!v;
  renderGuessModal();
}
function setGuessColor(c) {
  if (App.guess) { App.guess.color = c; App.guess.joker = false; }
  renderGuessModal();
}
function setGuessNumber(n) {
  if (App.guess) App.guess.number = n;
  renderGuessModal();
}
function submitGuess() {
  const g = App.guess;
  if (!g) return;
  send({ type: 'guess', target: g.target, position: g.position, joker: g.joker, color: g.joker ? null : g.color, number: g.joker ? null : g.number });
  App.guess = null;
  closeModal();
}

/* ---------------- 结算 ---------------- */
function renderResults() {
  const r = App.results;
  if (!r) return;
  const st = App.state;
  const winnerSeat = r.winner != null && st && st.seats[r.winner] ? st.seats[r.winner] : null;
  let html = `<h3>${winnerSeat ? esc(winnerSeat.nickname) + ' 获胜！' : '对局结束'}</h3>`;
  html += '<div style="margin:12px 0">';
  for (const row of r.results) {
    html += `<div class="result-row ${row.result === 'win' ? 'win' : ''}">` +
      `<div class="name">${esc(row.nickname)}${row.result === 'win' ? ' 🏆' : ''}</div>` +
      `<div class="num"><b>${row.ratingDelta >= 0 ? '+' : ''}${row.ratingDelta} 分</b>` +
      `综合 ${Math.round(row.score)} · 技术 ${Math.round(row.skill)} · 运气 ${Math.round(row.luck)}</div></div>`;
  }
  html += '</div>';
  html += '<div class="row" style="justify-content:center">';
  html += '<button class="btn" id="btn-see-replay">🎬 查看回放</button>';
  html += '<button class="btn ghost" id="btn-back-lobby">返回大厅</button>';
  html += '</div>';
  const overlay = openModal(html, { dismissable: false });
  overlay.querySelector('.panel').style.maxWidth = '520px';
  $('btn-see-replay').onclick = () => send({ type: 'get_replays' });
  $('btn-back-lobby').onclick = () => {
    closeModal();
    App.results = null;
    send({ type: 'leave' });
    App.state = null;
    showView('lobby');
  };
}

/* ---------------- 回放列表 ---------------- */
function showReplayList(list) {
  if (!list || list.length === 0) {
    showToast('暂无回放');
    return;
  }
  let html = '<h3>最近回放</h3>';
  html += '<div style="margin:10px 0">';
  for (const rp of list) {
    const names = rp.players.map(p => p.nickname).join('、');
    const time = new Date(rp.at).toLocaleString('zh-CN', { hour12: false });
    html += `<div class="result-row" style="cursor:pointer" onclick="send({type:'get_replay', id:'${rp.id}'}); closeModal();">` +
      `<div class="name">${esc(names)}</div><div class="num">${esc(time)}</div></div>`;
  }
  html += '</div>';
  html += '<button class="btn link" onclick="closeModal()">关闭</button>';
  openModal(html);
}

/* ===================== 聊天 ===================== */
const QUICK = ['好厉害！', '运气真好', '有点悬了', '哈哈', '加油！', '再来一局'];
const EMOJIS = ['😀', '😂', '😅', '😎', '🤔', '😭', '👍', '🙏'];

function buildChat(containerId) {
  const box = $(containerId);
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'chat-head';
  const quickRow = document.createElement('div');
  quickRow.className = 'quick-row';
  for (const q of QUICK) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = q;
    b.onclick = () => send({ type: 'chat', kind: 'phrase', text: q });
    quickRow.appendChild(b);
  }
  for (const e of EMOJIS) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = e;
    b.onclick = () => send({ type: 'chat', kind: 'emoji', text: e });
    quickRow.appendChild(b);
  }
  head.appendChild(quickRow);
  const msgs = document.createElement('div');
  msgs.className = 'chat-msgs';
  msgs.id = containerId + '-msgs';
  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input-row';
  const input = document.createElement('input');
  input.maxLength = 60;
  input.placeholder = '说点什么…';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendChat(input);
    }
  });
  const btn = document.createElement('button');
  btn.className = 'btn primary';
  btn.textContent = '发送';
  btn.onclick = () => sendChat(input);
  inputRow.appendChild(input);
  inputRow.appendChild(btn);
  box.appendChild(head);
  box.appendChild(msgs);
  box.appendChild(inputRow);
}
function sendChat(input) {
  const text = input.value.trim();
  if (!text) return;
  send({ type: 'chat', kind: 'text', text });
  input.value = '';
}
function renderChat() {
  const id = App.view === 'room' ? 'room-chat' : 'game-chat';
  const msgs = $(id + '-msgs');
  if (!msgs) return;
  msgs.innerHTML = '';
  for (const m of App.chatMsgs) {
    const div = document.createElement('div');
    if (m.kind === 'emoji') {
      div.className = 'msg emoji';
      div.textContent = m.text;
    } else {
      div.className = 'msg';
      div.innerHTML = `<b>${esc(m.nickname)}</b>${esc(m.text)}`;
    }
    msgs.appendChild(div);
  }
  msgs.scrollTop = msgs.scrollHeight;
}

/* ===================== 大厅战绩 ===================== */
/* ===================== 战绩备份 ===================== */
function autoBackupStats() {
  // 每局结束后把最新战绩自动存到浏览器本地（静默）
  fetch('/api/stats')
    .then((r) => r.json())
    .then((d) => localStorage.setItem('dvc-stats-backup', JSON.stringify(d)))
    .catch(() => {});
}
function downloadStatsBackup() {
  fetch('/api/stats')
    .then((r) => r.json())
    .then((d) => {
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'dvc-stats-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      showToast('战绩备份已下载');
    })
    .catch(() => showToast('下载失败'));
}
function uploadStatsBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    fetch('/api/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: reader.result
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          showToast('战绩已恢复（' + d.players + ' 名玩家）');
          if (App.nickname) send({ type: 'get_stats', nickname: App.nickname });
        } else {
          showToast('恢复失败：' + (d.error || '文件格式不正确'));
        }
      })
      .catch(() => showToast('上传失败'));
  };
  reader.readAsText(file);
}
function avgRecent(recent, key) {
  const arr = (recent || []).filter((r) => typeof r[key] === 'number');
  if (arr.length === 0) return '-';
  return Math.round(arr.reduce((s, r) => s + r[key], 0) / arr.length);
}

function renderStats() {
  const panel = $('lobby-stats');
  if (!App.nickname) {
    panel.hidden = true;
    return;
  }
  const data = App.myStats;
  if (!data || !data.stats) {
    panel.hidden = false;
    $('stats-name').textContent = App.nickname + '（暂无战绩）';
    $('stats-grid').innerHTML = '';
    $('stats-chart').innerHTML = '';
    return;
  }
  panel.hidden = false;
  const s = data.stats;
  $('stats-name').textContent = App.nickname + ' 的战绩';
  const cells = [
    ['总局数', s.games],
    ['胜 / 负', s.wins + ' / ' + s.losses],
    ['胜率', Math.round(s.winRate * 100) + '%'],
    ['当前连胜', s.currentStreak],
    ['最长连胜', s.bestStreak],
    ['积分', s.rating],
    ['平均技术', avgRecent(s.recent, 'skill')],
    ['平均运气', avgRecent(s.recent, 'luck')]
  ];
  $('stats-grid').innerHTML = cells.map(c => `<div class="stat-cell"><b>${c[1]}</b><span>${c[0]}</span></div>`).join('');
  const chart = $('stats-chart');
  chart.innerHTML = '';
  const recent = s.recent || [];
  if (recent.length === 0) {
    chart.innerHTML = '<span class="hint">打完一局后这里会显示综合分走势</span>';
    return;
  }
  for (const r of recent.slice(-20)) {
    const bar = document.createElement('div');
    bar.className = 'bar' + (r.result === 'loss' ? ' loss' : '');
    bar.style.height = Math.max(4, r.score) + '%';
    bar.title = `综合 ${r.score} · 技术 ${r.skill} · 运气 ${r.luck} · ${r.result === 'win' ? '胜' : '负'}`;
    chart.appendChild(bar);
  }
}


/* ===================== 在线玩家（阉割好友系统） ===================== */
function renderOnlineRows(box, list) {
  if (!box) return;
  box.innerHTML = '';
  const rows = (list || []).slice();
  if (rows.length === 0) {
    box.innerHTML = '<span class="hint">暂时没有其他玩家在线</span>';
    return;
  }
  for (const p of rows) {
    const row = document.createElement('div');
    row.className = 'online-row';
    const isMe = p.nickname === App.nickname;
    let status = '在大厅';
    if (p.inRoom) {
      if (p.seat == null) status = '观战中 ' + p.code;
      else status = p.phase === 'lobby' ? '房间 ' + p.code : '对局中 ' + p.code;
    }
    const name = document.createElement('div');
    name.className = 'name';
    name.innerHTML = esc(p.nickname) + (isMe ? ' <span class="tag">我</span>' : '') + '<span class="status">' + esc(status) + '</span>';
    row.appendChild(name);
    const btnStats = document.createElement('button');
    btnStats.className = 'btn small ghost';
    btnStats.textContent = '战绩';
    btnStats.onclick = () => viewPlayerStats(p.nickname);
    row.appendChild(btnStats);
    if (!isMe) {
      const btnInvite = document.createElement('button');
      btnInvite.className = 'btn small';
      btnInvite.textContent = '邀请';
      btnInvite.onclick = () => invitePlayer(p.nickname);
      row.appendChild(btnInvite);
    }
    box.appendChild(row);
  }
}

function renderOnline() {
  renderOnlineRows($('online-list'), App.online);
}

function openOnlineModal() {
  openModal(
    '<h3>🟢 在线玩家</h3>' +
    '<div id="online-modal-list"></div>' +
    '<div class="row" style="justify-content:center;margin-top:6px">' +
    '<button class="btn small ghost" id="btn-online-modal-refresh">刷新</button>' +
    '<button class="btn link" id="btn-online-modal-close">关闭</button>' +
    '</div>'
  );
  $('btn-online-modal-refresh').onclick = () => send({ type: 'list_online' });
  $('btn-online-modal-close').onclick = () => { App.onlineModalOpen = false; closeModal(); };
  App.onlineModalOpen = true;
  renderOnlineModal();
  send({ type: 'list_online' });
}

function renderOnlineModal() {
  renderOnlineRows($('online-modal-list'), App.online);
}

function viewPlayerStats(nick) {
  if (!nick) return;
  showToast('正在查询 ' + nick + ' 的战绩…');
  send({ type: 'get_stats', nickname: nick });
}

function showStatsModal(nickname, stats) {
  const s = stats;
  if (!s) {
    openModal(
      '<h3>' + esc(nickname) + ' 的战绩</h3>' +
      '<p class="hint">暂无战绩</p>' +
      '<button class="btn link" onclick="closeModal()">关闭</button>'
    );
    return;
  }
  const cells = [
    ['总局数', s.games], ['胜 / 负', s.wins + ' / ' + s.losses],
    ['胜率', Math.round((s.winRate || 0) * 100) + '%'],
    ['当前连胜', s.currentStreak], ['最长连胜', s.bestStreak], ['积分', s.rating],
    ['平均技术', avgRecent(s.recent, 'skill')], ['平均运气', avgRecent(s.recent, 'luck')]
  ];
  const grid = '<div class="stat-grid">' + cells.map((c) => '<div class="stat-cell"><b>' + c[1] + '</b><span>' + c[0] + '</span></div>').join('') + '</div>';
  openModal(
    '<h3>' + esc(nickname) + ' 的战绩</h3>' + grid +
    '<button class="btn link" onclick="closeModal()">关闭</button>'
  );
}

function invitePlayer(nick) {
  if (!nick) return;
  const st = App.state;
  if (!st || st.phase !== 'lobby') {
    showToast('请先创建或加入房间（大厅阶段）再邀请');
    return;
  }
  if (st.you && st.you.isSpectator) {
    showToast('观战中不能邀请，请先加入房间');
    return;
  }
  send({ type: 'invite_player', nickname: nick, code: st.code });
}

function showInviteModal(from, code) {
  openModal(
    '<h3>🎮 游戏邀请</h3>' +
    '<p class="hint" style="margin:10px 0">' + esc(from) + ' 邀请你加入房间</p>' +
    '<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:6px 0 10px">' + esc(code) + '</p>' +
    '<div class="row" style="justify-content:center;margin-bottom:8px"><button class="btn small ghost" id="btn-invite-copy">📋 复制房间码</button></div>' +
    '<div class="row" style="justify-content:center">' +
    '<button class="btn primary" id="btn-invite-accept">接受</button>' +
    '<button class="btn ghost" id="btn-invite-decline">拒绝</button>' +
    '</div>'
  );
  $('btn-invite-accept').onclick = () => {
    send({ type: 'invite_response', from, code, accept: true });
    closeModal();
    showToast('已接受邀请');
  };
  $('btn-invite-decline').onclick = () => {
    send({ type: 'invite_response', from, code, accept: false });
    closeModal();
  };
  $('btn-invite-copy').onclick = () => {
    copyText(code).then((ok) => showToast(ok ? '房间码已复制：' + code : '复制失败，房间码：' + code));
  };
}
/* ===================== 回放 ===================== */
function tileText(t) {
  if (!t) return '?';
  if (t.joker) return (t.color === 'b' ? '黑' : '白') + 'Joker';
  return (t.color === 'b' ? '黑' : '白') + t.number;
}

function buildReplaySnapshots(replay) {
  const seats = [];
  for (const p of replay.players) {
    seats[p.index] = { ...p, tiles: [], eliminated: false, _drawn: null };
  }
  const snaps = [];
  const log = [];
  let drawPile = 26;
  const push = (note) => {
    snaps.push(JSON.parse(JSON.stringify({
      seats: seats.map(s => s ? { nickname: s.nickname, isBot: s.isBot, eliminated: s.eliminated, tiles: s.tiles } : null),
      drawPile,
      note
    })));
    log.push(note);
  };
  push('对局加载');
  for (const ev of replay.events) {
    switch (ev.type) {
      case 'deal': {
        const s = seats[ev.seat];
        s.tiles = ev.tiles.map(t => ({ ...t, revealed: false }));
        drawPile -= ev.tiles.length;
        push(`${s.nickname} 起手 ${ev.tiles.length} 张牌`);
        break;
      }
      case 'arranged':
        push('全部就位，对局开始');
        break;
      case 'draw': {
        const s = seats[ev.seat];
        s._drawn = ev;
        drawPile -= 1;
        push(`${s.nickname} 抽了一张牌（${tileText(ev)}）`);
        break;
      }
      case 'place': {
        const s = seats[ev.seat];
        const d = s._drawn;
        s.tiles.splice(ev.position, 0, { id: d.tileId, color: d.color, number: d.number, joker: d.joker, revealed: false });
        s._drawn = null;
        push(`${s.nickname} 将抽到的牌放在第 ${ev.position + 1} 位`);
        break;
      }
      case 'guess': {
        const g = seats[ev.seat];
        const t = seats[ev.target];
        const text = `${g.nickname} 猜 ${t.nickname} 第 ${ev.position + 1} 张是${ev.joker ? '横线(Joker)' : (ev.color === 'b' ? '黑' : '白') + ev.number}`;
        push(ev.correct ? text + ' —— 猜中！' : text + ' —— 猜错');
        break;
      }
      case 'reveal': {
        const s = seats[ev.seat];
        const t = s.tiles[ev.position];
        if (t) t.revealed = true;
        if (ev.reason === 'correct') push(`${s.nickname} 的牌被翻开：${tileText(t)}，移出游戏`);
        else push(`${s.nickname} 翻开自己的牌：${tileText(t)}`);
        break;
      }
      case 'remove': {
        const s = seats[ev.seat];
        const idx = s.tiles.findIndex(t => t.id === ev.tileId);
        if (idx >= 0) s.tiles.splice(idx, 1);
        break;
      }
      case 'eliminate': {
        const s = seats[ev.seat];
        s.eliminated = true;
        push(`${s.nickname} 出局`);
        break;
      }
      case 'end': {
        const w = ev.winner != null ? seats[ev.winner] : null;
        push(w ? `${w.nickname} 获胜！` : '对局结束');
        break;
      }
      default:
        break;
    }
  }
  return { snaps, log };
}

function loadReplay(replay) {
  stopReplayAuto();
  const built = buildReplaySnapshots(replay);
  App.replay = replay;
  App.replaySnaps = built.snaps;
  App.replayLog = built.log;
  App.replayIdx = -1;
  showView('replay');
  renderReplay();
}

function renderReplay() {
  const idx = App.replayIdx;
  const snap = App.replaySnaps[Math.max(0, idx)];
  const body = $('replay-body');
  body.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'seat-label';
  header.innerHTML = `${idx < 0 ? '初始' : '第 ' + idx + ' 步'}：${esc(snap ? snap.note : '')}`;
  body.appendChild(header);
  const wrap = document.createElement('div');
  wrap.className = 'opponents';
  wrap.style.flexDirection = 'column';
  wrap.style.alignItems = 'center';
  for (const s of snap.seats) {
    if (!s) continue;
    const box = document.createElement('div');
    box.className = 'player-box';
    if (s.eliminated) box.style.opacity = '.55';
    const label = document.createElement('div');
    label.className = 'seat-label';
    label.innerHTML = `${esc(s.nickname)}${s.isBot ? '<span class="tag">机器人</span>' : ''}${s.eliminated ? '<span class="tag">出局</span>' : ''}`;
    box.appendChild(label);
    const row = document.createElement('div');
    row.className = 'tile-row';
    for (const t of s.tiles) row.appendChild(tileEl({ ...t, knownToOwner: true }));
    box.appendChild(row);
    wrap.appendChild(box);
  }
  body.appendChild(wrap);
  // 日志
  const logEl = $('replay-log');
  logEl.innerHTML = '';
  App.replayLog.forEach((line, i) => {
    const div = document.createElement('div');
    div.textContent = line;
    if (i === idx) div.className = 'cur';
    logEl.appendChild(div);
  });
  logEl.scrollTop = logEl.scrollHeight;
  $('rp-auto').classList.toggle('primary', !!App.replayAutoTimer);
}

function replayGoTo(i) {
  App.replayIdx = Math.max(-1, Math.min(App.replaySnaps.length - 1, i));
  renderReplay();
}
function stopReplayAuto() {
  if (App.replayAutoTimer) {
    clearInterval(App.replayAutoTimer);
    App.replayAutoTimer = null;
  }
}

/* ===================== 初始化 ===================== */
function init() {
  const nick = $('nickname');
  nick.value = App.nickname;
  nick.addEventListener('input', () => {
    App.nickname = nick.value.trim().slice(0, 12);
    localStorage.setItem('dvc-nick', App.nickname);
    if (App.nickname) send({ type: 'set_nickname', nickname: App.nickname });
    if (App.nickname) send({ type: 'get_stats', nickname: App.nickname });
    send({ type: 'list_online' });
    renderOnline();
  });

  $('btn-create').onclick = () => {
    const name = nick.value.trim();
    if (!name) return showToast('请先输入昵称');
    App.nickname = name;
    localStorage.setItem('dvc-nick', name);
    send({ type: 'create_room', nickname: name });
  };
  $('btn-join').onclick = () => {
    const name = nick.value.trim();
    const code = $('join-code').value.trim();
    if (!name) return showToast('请先输入昵称');
    if (!/^\d{6}$/.test(code)) return showToast('请输入 6 位房间码');
    App.nickname = name;
    localStorage.setItem('dvc-nick', name);
    send({ type: 'join_room', nickname: name, code });
  };
  $('btn-spectate').onclick = () => {
    const name = nick.value.trim();
    const code = $('spec-code').value.trim();
    if (!/^\d{6}$/.test(code)) return showToast('请输入 6 位房间码');
    send({ type: 'spectate_room', nickname: name || '观战者', code });
  };
  $('btn-rules').onclick = () => {
    openModal(
      '<h3>📖 玩法说明</h3>' +
      '<p style="text-align:left;font-size:14px;line-height:1.9;color:#cfe3f5">' +
      '· 每回合先抽一张牌（可选黑/白牌堆）：摸到的牌对自己明牌，并自动按升序排入牌行；自己回合内可随时调整 Joker 位置。<br>' +
      '· 再猜一名对手的牌：报数字或报「Joker」；被猜中的牌翻开并全场可见。<br>' +
      '· 猜对：对方该牌翻开并全场可见，可继续猜或停手；猜错：翻开本回合新抽到的牌（牌堆已空则自选一张抛弃）。<br>' +
      '· 所有牌的黑/白颜色公开可见（数字保密），抽牌仍可选黑堆或白堆。<br>' +
      '· 牌序：黑0&lt;白0&lt;黑1&lt;白1&lt;…&lt;黑11&lt;白11；Joker（横线）是百搭，可放任意位置，猜牌时也可报「Joker」，猜中即移除、猜错翻自己一张。<br>' +
      '· 所有牌都被翻开即出局，最后仍持有暗牌者获胜。<br>' +
      '· 每局结束会给出综合分（技术+运气）并累计积分，战绩按昵称记录。</p>' +
      '<button class="btn link" onclick="closeModal()">关闭</button>'
    );
  };

  $('btn-online-refresh').onclick = () => send({ type: 'list_online' });
  $('btn-invite-online').onclick = () => openOnlineModal();
  $('btn-stats-download').onclick = () => downloadStatsBackup();
  $('btn-stats-upload').onclick = () => $('stats-file').click();
  $('stats-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) uploadStatsBackup(f);
    e.target.value = '';
  });

  $('btn-room-leave').onclick = () => {
    send({ type: 'leave' });
    App.state = null;
    App.results = null;
    showView('lobby');
  };
  $('btn-copy-code').onclick = () => copyRoomCode();
  $('room-code').addEventListener('click', () => copyRoomCode());
  $('game-room-code').addEventListener('click', () => copyRoomCode());
  $('btn-add-bot').onclick = () => send({ type: 'add_bot' });
  $('btn-start').onclick = () => send({ type: 'start_game' });
  $('btn-view-all').onclick = () => send({ type: 'set_spectator_view', view: 'all' });
  $('btn-view-public').onclick = () => send({ type: 'set_spectator_view', view: 'public' });
  $('btn-room-replays').onclick = () => send({ type: 'get_replays' });

  $('btn-replay-back').onclick = () => {
    stopReplayAuto();
    if (App.state) render();
    else showView('lobby');
  };
  $('rp-first').onclick = () => replayGoTo(-1);
  $('rp-prev').onclick = () => replayGoTo(App.replayIdx - 1);
  $('rp-next').onclick = () => replayGoTo(App.replayIdx + 1);
  $('rp-last').onclick = () => replayGoTo(App.replaySnaps.length - 1);
  $('rp-auto').onclick = () => {
    if (App.replayAutoTimer) {
      stopReplayAuto();
    } else {
      App.replayAutoTimer = setInterval(() => {
        if (App.replayIdx >= App.replaySnaps.length - 1) {
          stopReplayAuto();
          return;
        }
        replayGoTo(App.replayIdx + 1);
      }, 900);
    }
    renderReplay();
  };

  buildChat('room-chat');
  buildChat('game-chat');
  renderStats();
  setInterval(() => { if (App.ws && App.ws.readyState === WebSocket.OPEN) send({ type: 'list_online' }); }, 5000);
  connect();
}

// 供 inline onclick 使用
window.App = App;
window.send = send;
window.closeModal = closeModal;
window.selectJoker = selectJoker;
window.moveJoker = moveJoker;
window.confirmArrange = confirmArrange;
window.setGuessColor = setGuessColor;
window.setGuessNumber = setGuessNumber;
window.submitGuess = submitGuess;

document.addEventListener('DOMContentLoaded', init);