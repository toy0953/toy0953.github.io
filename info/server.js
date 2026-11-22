// 周囲の電波スキャナ用サーバー (Node.js・追加パッケージ不要)
// 起動: node server.js  →  http://localhost:8000
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 8000;
let cache = { t: 0, data: null };

const run = (cmd, args, timeout = 25000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
    if (err && !stdout) reject(err); else resolve(stdout);
  });
});
const has = cmd => run('which', [cmd], 3000).then(() => true, () => false);

const chanFromFreq = f => {
  if (!f) return null;
  if (f === 2484) return 14;
  if (f < 3000) return Math.round((f - 2407) / 5);
  if (f < 5900) return Math.round((f - 5000) / 5);
  return Math.round((f - 5950) / 5);
};
const dbmToPct = d => Math.max(0, Math.min(100, Math.round(2 * (d + 100))));
const pctToDbm = p => Math.round(p / 2 - 100);

async function wifiNmcli() {
  const out = await run('nmcli', ['-t', '-f', 'SSID,BSSID,FREQ,SIGNAL,SECURITY', 'dev', 'wifi', 'list', '--rescan', 'yes']);
  return out.split('\n').filter(Boolean).map(line => {
    const p = line.split(/(?<!\\):/);
    if (p.length < 5) return null;
    const f = parseInt(p[2].replace(/\D/g, '')) || null;
    const s = parseInt(p[3]) || 0;
    return { ssid: p[0].replace(/\\:/g, ':'), bssid: p[1].replace(/\\:/g, ':'), freq: f,
             channel: chanFromFreq(f), pct: s, dbm: pctToDbm(s), security: p.slice(4).join(':') || 'なし' };
  }).filter(Boolean);
}

async function wifiIw() {
  const dev = /Interface\s+(\S+)/.exec(await run('iw', ['dev']));
  if (!dev) return [];
  const out = await run('iw', ['dev', dev[1], 'scan'], 30000);
  return out.split(/^BSS /m).slice(1).map(blk => {
    const f = /freq:\s*(\d+)/.exec(blk), s = /signal:\s*(-?\d+)/.exec(blk), n = /SSID:\s*(.*)/.exec(blk);
    const freq = f ? +f[1] : null, d = s ? +s[1] : -100;
    return { ssid: n ? n[1].trim() : '', bssid: blk.slice(0, 17), freq, channel: chanFromFreq(freq),
             pct: dbmToPct(d), dbm: d, security: /RSN:|WPA:/.test(blk) ? 'WPA/RSN' : 'なし' };
  });
}

async function wifiTermux() {
  const arr = JSON.parse((await run('termux-wifi-scaninfo')) || '[]');
  return (Array.isArray(arr) ? arr : []).map(a => {
    const d = a.rssi ?? -100;
    return { ssid: a.ssid || '', bssid: a.bssid || '', freq: a.frequency_mhz, channel: chanFromFreq(a.frequency_mhz),
             pct: dbmToPct(d), dbm: d, security: '不明' };
  });
}

async function cellTermux() {
  const arr = JSON.parse((await run('termux-telephony-cellinfo', [], 15000)) || '[]');
  const keys = ['type', 'registered', 'dbm', 'level', 'cid', 'pci', 'tac', 'earfcn', 'mcc', 'mnc'];
  return (Array.isArray(arr) ? arr : []).map(c => Object.fromEntries(keys.filter(k => k in c).map(k => [k, c[k]])));
}

async function scan() {
  if (cache.data && Date.now() - cache.t < 4000) return cache.data;
  const data = { time: new Date().toLocaleTimeString('ja-JP'), wifi: [], cell: [], source: null, errors: [] };
  const methods = [['nmcli', 'nmcli', wifiNmcli], ['iw', 'iw', wifiIw], ['termux', 'termux-wifi-scaninfo', wifiTermux]];
  for (const [name, exe, fn] of methods) {
    if (!(await has(exe))) continue;
    try {
      const r = await fn();
      if (r.length) { data.wifi = r; data.source = name; break; }
      data.errors.push(`${name}: 結果が空でした(権限・Wi-Fi機器を確認)`);
    } catch (e) { data.errors.push(`${name}: ${e.message}`); }
  }
  if (!data.source && !data.errors.length)
    data.errors.push('Wi-Fi取得コマンド(nmcli / iw / termux-wifi-scaninfo)が見つかりません');
  if (await has('termux-telephony-cellinfo')) {
    try { data.cell = await cellTermux(); } catch (e) { data.errors.push(`cell: ${e.message}`); }
  }
  cache = { t: Date.now(), data };
  return data;
}

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/scan')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(await scan()));
  } else {
    fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
      res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(err ? 'index.html が見つかりません' : buf);
    });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`http://localhost:${PORT} で起動しました`));
