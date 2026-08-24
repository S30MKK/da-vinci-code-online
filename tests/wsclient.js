'use strict';
// 测试用最小 WebSocket 客户端（零依赖）
const http = require('http');
const crypto = require('crypto');

class WsTestClient {
  constructor(port) {
    this.port = port;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.messages = [];
    this.waiters = [];
    this.consumed = 0;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: '127.0.0.1',
        port: this.port,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13'
        }
      });
      req.on('upgrade', (res, socket) => {
        this.socket = socket;
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('close', () => { /* ignore */ });
        socket.on('error', () => { /* ignore */ });
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
  }
  send(obj) {
    if (!this.socket) throw new Error('not connected');
    const payload = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      let plen = this.buffer[1] & 0x7f;
      let off = 2;
      if (plen === 126) {
        if (this.buffer.length < 4) return;
        plen = this.buffer.readUInt16BE(2);
        off = 4;
      } else if (plen === 127) {
        if (this.buffer.length < 10) return;
        plen = Number(this.buffer.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buffer.length < off + plen) return;
      const payload = this.buffer.slice(off, off + plen).toString('utf8');
      this.buffer = this.buffer.slice(off + plen);
      let msg;
      try { msg = JSON.parse(payload); } catch (e) { continue; }
      this.messages.push(msg);
      this._notify(msg);
    }
  }
  _notify(msg) {
    for (const w of this.waiters) {
      if (w.pred(msg)) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter(x => x !== w);
        w.resolve(msg);
      }
    }
  }
  // 按顺序消费消息：从当前 consumed 位置起找第一个匹配消息
  nextMessage(pred, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const scan = () => {
        for (let i = this.consumed; i < this.messages.length; i++) {
          const m = this.messages[i];
          if (pred(m)) {
            this.consumed = i + 1;
            return m;
          }
        }
        return null;
      };
      const found = scan();
      if (found) return resolve(found);
      const w = {
        pred: (m) => {
          const f = scan();
          if (f) {
            clearTimeout(w.timer);
            this.waiters = this.waiters.filter(x => x !== w);
            w.resolve(f);
            return true;
          }
          return false;
        },
        resolve,
        reject
      };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(x => x !== w);
        reject(new Error('nextMessage timeout'));
      }, timeout);
      this.waiters.push(w);
    });
  }
  close() {
    if (this.socket) {
      try { this.socket.destroy(); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { WsTestClient };