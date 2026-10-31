const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');

// ===== 配置(已写入,可被同名环境变量覆盖) =====
const CFG = {
  token:  process.env.ARGO_TOKEN || 'eyJhIjoiYWExZDM1MDYzNGQ1MDA2OGJkMGZkZDIxNjA3MGZhZTUiLCJ0IjoiNjZlMGI4NzktMGE1Zi00MjI5LWE3YzEtMTFkNDc1ZWFlNGQ4IiwicyI6IllqZGhaalF6WkdZdE9EVTBZUzAwTkRnMExUaGpPRGd0TkdFNFpqRTNNVEkxWmpBNSJ9',
  uuid:   process.env.UUID || '62493c57-0d1d-4edf-9236-83a9c9c29ed3',
  domain: process.env.ARGO_DOMAIN || 'hostship.globalleo.dpdns.org',
  port:   Number(process.env.PORT) || 30509,
  host:   process.env.HOST || '0.0.0.0',
  cdn:    process.env.CDN || 'www.visa.com.sg',
  name:   process.env.NODE_NAME || 'ArgoX-Node',
  proto:  process.env.ARGO_PROTOCOL || 'http2',
  dir:    path.resolve(process.env.WORKDIR || path.join(__dirname, 'data')),
};
fs.mkdirSync(CFG.dir, { recursive: true });

const ARCH = { x64: ['amd64', '64'], arm64: ['arm64', 'arm64-v8a'] }[process.arch];
if (!ARCH || process.platform !== 'linux') {
  console.error('仅支持 linux x64/arm64,当前: ' + process.platform + '/' + process.arch);
  process.exit(1);
}
const CF_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-' + ARCH[0];
const XR_URL = 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-' + ARCH[1] + '.zip';

function download(url, out, n) {
  n = n || 0;
  return new Promise((resolve, reject) => {
    if (n > 8) return reject(new Error('重定向过多'));
    https.get(url, { headers: { 'User-Agent': 'argox-node' } }, res => {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0) {
        res.resume();
        return resolve(download(res.headers.location, out, n + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(url + ' -> HTTP ' + res.statusCode)); }
      const f = fs.createWriteStream(out);
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve()));
      f.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureBins() {
  const cf = path.join(CFG.dir, 'cloudflared');
  const xr = path.join(CFG.dir, 'xray');
  if (!fs.existsSync(cf)) {
    console.log('[setup] 下载 cloudflared ...');
    await download(CF_URL, cf);
    fs.chmodSync(cf, 0o755);
  }
  if (!fs.existsSync(xr)) {
    console.log('[setup] 下载 xray ...');
    const AdmZip = require('adm-zip');
    const zp = path.join(CFG.dir, 'xray.zip');
    await download(XR_URL, zp);
    new AdmZip(zp).extractAllTo(CFG.dir, true);
    fs.chmodSync(xr, 0o755);
    fs.unlinkSync(zp);
  }
}

const XRAY_PORT = 3001;
const WS_PATH = '/' + CFG.uuid + '-vl';

function writeXrayConfig() {
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [{
      listen: '127.0.0.1', port: XRAY_PORT, protocol: 'vless',
      settings: { clients: [{ id: CFG.uuid }], decryption: 'none' },
      streamSettings: { network: 'ws', wsSettings: { path: WS_PATH } },
      sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
    }],
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [{ type: 'field', ip: ['geoip:private'], outboundTag: 'block' }],
    },
  };
  fs.writeFileSync(path.join(CFG.dir, 'config.json'), JSON.stringify(cfg, null, 2));
}

const children = [];
let stopping = false;
function supervise(name, cmd, args) {
  const start = () => {
    if (stopping) return;
    const p = spawn(cmd, args, { stdio: 'inherit', cwd: CFG.dir });
    children.push(p);
    p.on('error', e => console.error('[' + name + '] 启动失败:', e.message));
    p.on('exit', code => {
      const i = children.indexOf(p); if (i >= 0) children.splice(i, 1);
      if (stopping) return;
      console.log('[' + name + '] 退出(' + code + '), 3 秒后重启');
      setTimeout(start, 3000);
    });
  };
  start();
}
function shutdown() {
  stopping = true;
  children.forEach(c => { try { c.kill('SIGTERM'); } catch (e) {} });
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function vlessLink() {
  const p = encodeURIComponent(WS_PATH + '?ed=2560');
  return 'vless://' + CFG.uuid + '@' + CFG.cdn + ':443?encryption=none&security=tls&sni=' + CFG.domain +
    '&fp=chrome&type=ws&host=' + CFG.domain + '&path=' + p + '#' + encodeURIComponent(CFG.name);
}
function clashYaml() {
  return [
    'proxies:',
    '  - name: "' + CFG.name + '"',
    '    type: vless',
    '    server: ' + CFG.cdn,
    '    port: 443',
    '    uuid: ' + CFG.uuid,
    '    udp: true',
    '    tls: true',
    '    network: ws',
    '    servername: ' + CFG.domain,
    '    client-fingerprint: chrome',
    '    ws-opts:',
    '      path: "' + WS_PATH + '?ed=2560"',
    '      headers:',
    '        Host: ' + CFG.domain,
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '    proxies: ["' + CFG.name + '", DIRECT]',
    'rules:',
    '  - GEOIP,CN,DIRECT',
    '  - MATCH,PROXY',
    '',
  ].join('\n');
}

function startGateway() {
  const link = vlessLink();
  const base = '/' + CFG.uuid;
  const srv = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (u === base + '/base64') return res.end(Buffer.from(link).toString('base64'));
    if (u === base + '/raw') return res.end(link);
    if (u === base + '/clash') return res.end(clashYaml());
    if (u === '/') return res.end('OK');
    res.statusCode = 404; res.end('Not Found');
  });
  srv.on('upgrade', (req, sock, head) => {
    if (req.url.indexOf(WS_PATH) !== 0) return sock.destroy();
    const up = net.connect(XRAY_PORT, '127.0.0.1', () => {
      let raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
      up.write(raw + '\r\n');
      if (head && head.length) up.write(head);
      sock.pipe(up); up.pipe(sock);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
    sock.on('close', () => up.destroy());
    up.on('close', () => sock.destroy());
  });
  srv.on('error', e => { console.error('网关错误:', e.message); process.exit(1); });
  srv.listen(CFG.port, CFG.host, () => {
    console.log('[gateway] 监听 ' + CFG.host + ':' + CFG.port);
    console.log('--------------------------------------------------');
    console.log('节点  : ' + link);
    console.log('订阅  : https://' + CFG.domain + base + '/base64');
    console.log('Clash : https://' + CFG.domain + base + '/clash');
    console.log('--------------------------------------------------');
  });
}

(async () => {
  await ensureBins();
  writeXrayConfig();
  supervise('xray', path.join(CFG.dir, 'xray'), ['run', '-c', path.join(CFG.dir, 'config.json')]);
  supervise('argo', path.join(CFG.dir, 'cloudflared'),
    ['tunnel', '--no-autoupdate', '--protocol', CFG.proto, 'run', '--token', CFG.token]);
  startGateway();
})().catch(e => { console.error(e); process.exit(1); });
