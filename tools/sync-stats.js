'use strict';
/* =====================================================================
 * 战绩同步脚本（零依赖）：在你的电脑上备份 / 恢复服务器战绩
 *
 * 用法：
 *   node tools/sync-stats.js pull <服务器地址> [保存文件]   下载备份
 *   node tools/sync-stats.js push <服务器地址> [来源文件]   上传恢复
 *
 * 示例：
 *   node tools/sync-stats.js pull https://da-vinci-code-online.onrender.com
 *   node tools/sync-stats.js push https://da-vinci-code-online.onrender.com
 *
 * 默认备份文件：项目根目录 stats-backup.json
 * 建议用 Windows 任务计划定时执行 pull（如每 30 分钟一次）。
 * ===================================================================== */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'stats-backup.json');

function request(method, target, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const mod = u.protocol === 'https:' ? https : http;
    const data = body ? Buffer.from(body, 'utf8') : null;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname || '/',
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const [cmd, serverUrl, file] = process.argv.slice(2);
  if (!cmd || !serverUrl) {
    console.log('用法:');
    console.log('  node tools/sync-stats.js pull <服务器地址> [保存文件]');
    console.log('  node tools/sync-stats.js push <服务器地址> [来源文件]');
    process.exit(1);
  }
  const base = String(serverUrl).replace(/\/+$/, '');
  const targetFile = file || DEFAULT_FILE;

  if (cmd === 'pull') {
    const r = await request('GET', base + '/api/stats');
    if (r.status !== 200) throw new Error('下载失败: HTTP ' + r.status);
    const parsed = JSON.parse(r.body);
    if (!parsed || parsed.version !== 1) throw new Error('服务器返回的数据格式不正确');
    fs.writeFileSync(targetFile, r.body);
    const n = Object.keys(parsed.players || {}).length;
    console.log('已备份到 ' + targetFile + '（' + n + ' 名玩家）');
  } else if (cmd === 'push') {
    const src = file || DEFAULT_FILE;
    if (!fs.existsSync(src)) throw new Error('找不到备份文件: ' + src);
    const data = fs.readFileSync(src, 'utf8');
    JSON.parse(data); // 校验格式
    const r = await request('POST', base + '/api/stats', data);
    console.log('上传结果: HTTP ' + r.status + ' ' + r.body);
  } else {
    throw new Error('未知命令: ' + cmd);
  }
})().catch((e) => {
  console.error('错误: ' + e.message);
  process.exit(1);
});
