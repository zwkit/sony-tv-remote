/**
 * 电视遥控桥接服务（Node 零依赖，可跑 Windows / 群晖 Docker / 任意 Linux）
 *
 *   浏览器 ──HTTP──> 本服务 ──ADB──> 电视
 *
 * 能力：
 *   · 遥控按键：input keyevent
 *   · 中文输入：ADBKeyboard（广播注入，支持任意 UTF-8）
 *   · 应用列表：包名 / 中文名 / 图标（图标从 APK 内解析，见 apkicon.js）
 *
 * 环境变量：
 *   PORT            默认 8787
 *   TV_ADB          电视 adb 地址；示例 192.168.1.50:5555（务必改成你电视的 IP）
 *   ADB_PATH        adb 可执行文件（默认自动探测）
 *   AUTH_TOKEN      可选，设置后所有 /api 请求需带 ?t= 或 x-token
 *   LAN_SUBNET      可选，自动发现电视时只扫该网段，如 192.168.0.
 *   SONY_PSK        可选，索尼 IP 控制的预共享密钥——配了它，电视关掉 ADB 调试后按键仍可用
 *   SONY_HOST       可选，电视 IP（默认取 TV_ADB 的 IP 部分），IP 控制走 80 端口
 *   DATA_DIR        默认 ./data（保存原输入法、应用图标缓存等）
 *   HTTPS_PORT      默认 8788，0 = 关闭。实时预览走 WebCodecs，而 WebCodecs 是
 *                   「安全上下文」专属接口——用 http://192.168.x.x 打开时
 *                   window.VideoDecoder 直接是 undefined（Edge / Chrome 实测一致）。
 *                   所以额外开一路 HTTPS（自签证书，首次访问点「继续前往」即可）。
 */
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { extractIcon } = require('./apkicon');
/* 注意：色彩范围修正的代码**内联在本文件**（见 fixSpsRange），不要再拆成独立文件。
   教训（2026-10-25）：曾经拆成 h264fix.js 却没同步加进 Dockerfile 的 COPY 和
   compose 的 volumes，容器启动时 require 失败 → MODULE_NOT_FOUND → 直接退出，
   群晖上表现为「容器意外停止」。新增依赖文件必须同时改这两处，除非内联。 */

/* ================= 配置 ================= */
function whichAdb() {
  if (process.env.ADB_PATH) return process.env.ADB_PATH;
  const cands = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    cands.push(path.join(local, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
    cands.push('C:\\adb\\adb.exe');
  }
  cands.push('adb');
  for (const c of cands) {
    try {
      if (c === 'adb' || fs.existsSync(c)) return c;
    } catch (e) {}
  }
  return 'adb';
}

const CFG = {
  port: Number(process.env.PORT || 8787),
  adb: whichAdb(),
  token: process.env.AUTH_TOKEN || '',
  lanSubnet: process.env.LAN_SUBNET || '',
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  /* HTTPS_PORT 不设 = 8788 默认开启；显式给 0 才关闭（Number('0')=0，用 ===undefined 判断
     才能区分「没配」和「配了 0」）。 */
  httpsPort: process.env.HTTPS_PORT === undefined
    ? 8788
    : (Number(process.env.HTTPS_PORT) || 0),
  /* 个别电视的按键名对不上（比如 OK 键不认 Confirm 只认 Enter）时，
     不用改代码：IRCC_KEYS='{"66":"Enter"}' 就能把某个 Android 键码改到别的
     IRCC 键名上。键是数字键码，值是电视自己报的 IRCC 名字。 */
  irccKeys: (() => {
    try { return JSON.parse(process.env.IRCC_KEYS || '{}'); } catch (e) { return {}; }
  })(),
};
// 示例占位地址；务必用 TV_ADB 指定你电视的 adb 地址，连不上时 DISCOVER 会自动扫网段找回。
let SERIAL = process.env.TV_ADB || '192.168.1.50:5555';

/**
 * 索尼 IP 控制（80 端口 HTTP API）——ADB 之外的第二条通道。
 *
 * 电视关掉「ADB 调试」后 adb 整条链路断掉。索尼电视另开了一组 HTTP 服务，
 * 在「设置 → 网络和互联网 → 家庭网络设置 → IP 控制」里启用即可用，认证有两种：
 *   ·「普通」                 → 不需要密钥，直接发请求就行
 *   ·「普通和预共享密钥」     → 每次请求带 X-Auth-PSK
 * 两种我们都支持：配了 SONY_PSK 就带上，没配也不拦着，由探测结果决定能不能用。
 *
 * ── 这套 API 分三个服务，能做的事比想象的多（本机的实测结果）──
 *   /sony/system        按键码表 getRemoteControllerInfo（白送，152 个按键）、开关机状态
 *   /sony/IRCC          发遥控器按键：方向/确认/返回/主页/菜单/音量/静音/信号源/电源/
 *                       播放暂停/语音，以及 ApplicationLauncher（电视端应用抽屉）
 *   /sony/appControl    应用相关：getApplicationList（**带名称、intent、图标**）、
 *                       setActiveApp（按 intent 启动任意应用）、getApplicationStatusList、
 *                       terminateApps、installApp/uninstallApp（无需 adb 装包）
 * 注意粒度：IRCC 发的是「按键」，appControl 发的是「启动指令」，后者才是
 * 应用列表/应用启动的正确答案——不需要 adb 拉 pm list，也不需要 unzip 抠图标。
 *
 * getMethodTypes 这两个服务都肯免密回答（相当于自带说明书），但真正干活的方法
 * （getApplicationList / setActiveApp / X_SendIRCC）要过鉴权。
 */
const SONY = {
  host: process.env.SONY_HOST || SERIAL.replace(/:\d+$/, ''),
  psk: process.env.SONY_PSK || '',
  codes: null,      // name -> base64 IRCC 码（电视自己报的，共 152 个）
  at: 0,
  badAt: 0,         // 取码表失败的时间（10 秒内不重复试）
  lastOk: false,
  ok: false,        // 这条通道当前真的可用？由 ipReady() 探测
  checkedAt: 0,
  lastErr: '',
  apps: null,       // getApplicationList 的原始结果（含 name/uri/icon），带缓存
  appsAt: 0,
};

/**
 * 探测 IP 通道是否真的可用。
 * getPowerStatus 是免密的，只能证明 80 端口通；要证明「已经被授权」必须碰一个
 * 需要鉴权的方法——用只读的 getWebAppStatus 做探针（不产生任何副作用）。
 * 结果按 120s(好)/30s(坏) 缓存：坏了也不至于每次按键都空跑一趟。
 */
async function ipReady() {
  const ttl = SONY.ok ? 120000 : 30000;
  if (Date.now() - SONY.checkedAt < ttl) return SONY.ok;
  SONY.checkedAt = Date.now();
  const r = await sonyPost('/sony/appControl', JSON.stringify({
    method: 'getWebAppStatus', id: 1, params: [], version: '1.0',
  }));
  let j = null;
  try { j = JSON.parse(r.body); } catch (e) {}
  SONY.ok = r.status === 200 && j && !j.error;
  if (SONY.ok) SONY.lastErr = '';
  else if (r.status === 403) SONY.lastErr = '电视 IP 控制未授权（没开，或密钥和 SONY_PSK 不一致）';
  else SONY.lastErr = '电视 80 端口没响应（' + (r.status || r.body) + '）';
  return SONY.ok;
}

const IME_PKG = 'com.android.adbkeyboard';
const IME_ID = 'com.android.adbkeyboard/.AdbIME';
const APK = path.join(__dirname, 'vendor', 'ADBKeyboard.apk');
const HTML_FILE = path.join(__dirname, 'public', 'index.html');

/**
 * 构建指纹——用来分辨「NAS 上跑的是旧镜像」还是「浏览器缓存了旧页面」。
 *
 * 排查 rebuild 之后界面没变的经典问题：两种情况表现完全一样，光看页面分不出来。
 *   页面里 <meta name="app-ver" content="..."> 是版本号；
 *   这里读同一份 index.html 算出内容哈希。
 * /api/health 不需要令牌，一条 curl 就能看到实际送达浏览器的那份界面是哪一版。
 */
/* 版本号按 mtime 缓存：不能只在启动时读一次。因为 index.html 是 ro 挂载的，
   换了文件但没重启容器时，页面其实已经是新的，而启动时缓存的版本号还停在旧的，
   照着它核对会得出「还是旧版」的错误结论。 */
let _verCache = null;
function appVer() {
  try {
    const st = fs.statSync(HTML_FILE);
    if (_verCache && _verCache.mtime === st.mtimeMs && _verCache.size === st.size) return _verCache.v;
    const m = /<meta\s+name="app-ver"\s+content="([^"]+)"/.exec(fs.readFileSync(HTML_FILE, 'utf8'));
    const v = m ? m[1] : 'missing';
    _verCache = { mtime: st.mtimeMs, size: st.size, v };
    return v;
  } catch (e) { return 'nofile'; }
}
/* 进程启动时间：用本地时间（容器里 TZ=Asia/Shanghai），方便直接和"我刚重建的时间"对照。
   toISOString 是 UTC，差 8 小时会让人误判。 */
const STARTED = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
})();
let _uiCache = null;
function uiHash() {
  try {
    const st = fs.statSync(HTML_FILE);
    if (_uiCache && _uiCache.mtime === st.mtimeMs && _uiCache.size === st.size) return _uiCache.h;
    const h = crypto.createHash('sha1').update(fs.readFileSync(HTML_FILE)).digest('hex').slice(0, 8);
    _uiCache = { mtime: st.mtimeMs, size: st.size, h };
    return h;
  } catch (e) { return 'nofile'; }
}

try { fs.mkdirSync(CFG.dataDir, { recursive: true }); } catch (e) {}

/* ================= adb 基础 ================= */
const MAX_OUT = 48 * 1024 * 1024;

/**
 * stdin 必须 ignore：否则 adb shell 会等 EOF，命令挂死。
 */
function run(args, timeout, raw) {
  return runCmd(CFG.adb, args, timeout, raw);
}

function runCmd(bin, args, timeout, raw) {
  return new Promise((resolve) => {
    const so = [], se = [];
    let size = 0, done = false, timer = null;
    const finish = (err) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      const bo = Buffer.concat(so), be = Buffer.concat(se);
      resolve({ err, stdout: raw ? bo : bo.toString('utf8'), stderr: raw ? be : be.toString('utf8') });
    };
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return finish(e); }
    timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      finish(new Error('timeout ' + (timeout || 8000) + 'ms'));
    }, timeout || 8000);
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > MAX_OUT) { try { child.kill(); } catch (e) {} return finish(new Error('output too large')); }
      so.push(d);
    });
    child.stderr.on('data', (d) => se.push(d));
    child.on('error', (e) => finish(e));
    child.on('close', (code) => finish(code === 0 ? null : Object.assign(new Error('exit ' + code), { code })));
  });
}

const dev = (args, timeout, raw) => run(['-s', SERIAL, ...args], timeout, raw);
const out = (r) => (String(r.stdout) + String(r.stderr)).trim();

let lastConnect = 0;
let connecting = null;

function localSubnets() {
  if (CFG.lanSubnet) return [CFG.lanSubnet.endsWith('.') ? CFG.lanSubnet : CFG.lanSubnet + '.'];
  const subs = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address;
      if (!(ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip))) continue;
      const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(ip);
      if (m) subs.push(m[1] + '.');
    }
  }
  return [...new Set(subs)];
}

function probe(host, port, timeout) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let fin = false;
    const done = (ok) => { if (fin) return; fin = true; s.destroy(); resolve(ok); };
    s.setTimeout(timeout || 400);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

// 电视 DHCP 换 IP 后自动找回：扫网段里所有开了 5555 的机器
// DISCOVER=0 可彻底关掉（家里东西杂的时候推荐关，见下）
const DISCOVER = process.env.DISCOVER || '1';

/**
 * 验明正身：adb 那头连着的到底是不是电视。返回 true/false/null。
 *
 * 这一层校验是被真实事故逼出来的：局域网里开 5555 的远不止电视——雷电/MuMu/夜神
 * 这类模拟器，以及某些安卓盒子，都把 adbd 挂在 0.0.0.0:5555 上（本机实测 dnplayer
 * 就是 0.0.0.0:5555，隔壁网段 .177 还有第二台）。原来扫到谁就用谁，于是 NAS 上跑的
 * 服务把 PC 上的模拟器当成了电视，界面显示的型号变成 V1938CT（模拟器的 ro.product.model）。
 * 电视自己会认：getprop ro.build.characteristics 回报含 tv（这台索尼是 "nosdcard,tv"）。
 *
 * null 表示「还没授权，身份待定」——这时候不能判死刑，否则每次连接都会白跑一遍扫描。
 */
async function isOurTV(serial) {
  const r = await run(['-s', serial, 'shell', 'getprop ro.build.characteristics'], 6000);
  const c = out(r).trim();
  if (/unauthorized|offline|no devices|not found|still connecting/i.test(c)) return null;
  if (/(^|,)tv(,|$)/i.test(c)) return true;
  // 个别固件不给 characteristics 打 tv 标记：跟历史记住的型号完全一致也算自己人
  const known = readState().tvModel;
  if (known) {
    const m = out(await run(['-s', serial, 'shell', 'getprop ro.product.model'], 6000)).trim();
    if (m && m === known) return true;
  }
  return false;
}

/** 连上之后把这台记下来，以后型号对得上就直接认，不必依赖 characteristics */
async function rememberTV(serial) {
  const m = out(await run(['-s', serial, 'shell', 'getprop ro.product.model'], 6000)).trim();
  if (m) writeState({ tvModel: m, tvSerial: serial });
  return m;
}

async function discover() {
  if (DISCOVER === '0') return null;
  for (const sub of localSubnets()) {
    const hosts = [];
    for (let i = 1; i <= 254; i++) hosts.push(sub + i);
    const found = [];
    let idx = 0;
    const worker = async () => {
      while (idx < hosts.length) {
        const h = hosts[idx++];
        if (await probe(h, 5555, 400)) found.push(h);
      }
    };
    await Promise.all(Array.from({ length: 48 }, worker));
    if (!found.length) continue;
    // 候选排序：上次记住的电视优先，其次按 IP 顺序
    const prior = readState().tvSerial;
    const queue = [...new Set([prior, String(SERIAL).split(':')[0], ...found])].filter(Boolean);
    console.log('[tv] 直接连接失败，扫描到 5555 端口：' + found.join(', ') + '，逐个验明正身…');
    for (const h of queue) {
      const host = h + ':5555';
      const r = await run(['connect', host], 12000);
      if (!/connected to|already connected/i.test(out(r))) continue;
      if (await isOurTV(host)) {
        await rememberTV(host);
        return host;
      }
      await run(['disconnect', host], 5000);   // 不是电视，断开再试下一个
    }
  }
  return null;
}

async function findTV(fallbackMsg) {
  const hit = await discover();
  if (hit) {
    if (hit !== SERIAL) {
      SERIAL = hit;
      console.log('[tv] 自动发现电视 → ' + hit + '（对照 ro.build.characteristics 认出来的）');
      await run(['connect', SERIAL], 12000);
      return '已连接到 ' + hit + '（自动发现）';
    }
    return '已连接到 ' + hit;
  }
  return fallbackMsg;
}

function connect() {
  if (connecting) return connecting;
  connecting = (async () => {
    lastConnect = Date.now();
    await run(['start-server'], 15000);
    const r = await run(['connect', SERIAL], 12000);
    const msg = out(r);
    if (!/connected to|already connected/i.test(msg)) return findTV(msg);
    // 连上了也要抽查一次：TV_ADB 手滑写成别的设备时，别把遥控器交到别人手里
    if (DISCOVER !== '0') {
      const ok = await isOurTV(SERIAL);
      if (ok === false) {
        console.log('[tv] ' + SERIAL + ' 这台不像电视（characteristics 没有 tv），去找真正的电视');
        return findTV(msg);
      }
    }
    return msg;
  })().finally(() => { connecting = null; });
  return connecting;
}

// 断连自动重连后重试一次
async function devRetry(args, timeout, raw) {
  let r = await dev(args, timeout, raw);
  const s = String(r.stdout) + String(r.stderr);
  if (/not found|device offline|no devices|unauthorized|closed|error: device/i.test(s)) {
    if (Date.now() - lastConnect > 1500) await connect();
    r = await dev(args, timeout, raw);
  }
  return r;
}

/* ================= 索尼 IP 控制（IRCC）================= */

/** 电视 80 端口的 JSON-RPC / SOAP，超时 5s，任何异常都折叠成 {status:0} */
function sonyPost(pathname, body, soapAction) {
  return new Promise((resolve) => {
    const data = Buffer.from(body, 'utf8');
    const headers = {
      'Content-Type': soapAction ? 'text/xml; charset=UTF-8' : 'application/json',
      'Content-Length': data.length,
    };
    if (SONY.psk) headers['X-Auth-PSK'] = SONY.psk;
    if (soapAction) headers.SOAPACTION = '"' + soapAction + '"';
    const req = http.request(
      { host: SONY.host, port: 80, path: pathname, method: 'POST', headers, timeout: 5000 },
      (res) => {
        const bufs = [];
        res.on('data', (c) => bufs.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(bufs).toString('utf8') }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.write(data);
    req.end();
  });
}

/** 问电视要按键码表（这个方法不需要密钥，白拿；缓存 1 小时）
 *  失败也缓存 10 秒：否则电视那边一抽风，每一次按键都要多跑一趟取码表 */
async function irccCodes() {
  if (SONY.codes && Date.now() - SONY.at < 3600e3) return SONY.codes;
  if (Date.now() - SONY.badAt < 10000) return SONY.codes;
  const r = await sonyPost('/sony/system', JSON.stringify({
    method: 'getRemoteControllerInfo', id: 1, params: [], version: '1.0',
  }));
  try {
    const j = JSON.parse(r.body);
    const map = {};
    for (const it of (j.result && j.result[1]) || []) if (it && it.name) map[it.name] = it.value;
    if (Object.keys(map).length) {
      SONY.codes = map;
      SONY.at = Date.now();
      return map;
    }
  } catch (e) {}
  SONY.badAt = Date.now();
  return SONY.codes;
}

/** Android keycode → 电视 IRCC 功能名（只列我们界面用到的）
 *
 *  值是**候选数组**：不同固件对同一个键的叫法不一样。按顺序取电视真正报出来的
 *  第一个，缺一个还能退到下一个；都不对就用 IRCC_KEYS 环境变量覆盖（见 CFG.irccKeys）。
 *
 *  2026-10-25 在这台电视上用 logcat 反查了「IRCC 键名 → 电视收到的 keyCode」，
 *  结论是 mapped 得住，只有语音键是坑：
 *    Return→4、Up→19、Confirm→23（就是 OK）、DpadCenter→23、Enter→228、
 *    Display→165、Assists→84（搜索/助手）
 *    MicPressedFromUnpairedRC→**0（未知键）**，而且会让电视弹「遥控器配对」界面
 *    —— 所以语音键改成优先 Assists，别再用那个 unpaired 的。
 */
const IRCC_KEY = {
  3: ['Home'], 4: ['Return', 'Exit'],
  19: ['Up'], 20: ['Down'], 21: ['Left'], 22: ['Right'],
  23: ['DpadCenter', 'Confirm', 'Enter'],
  24: ['VolumeUp'], 25: ['VolumeDown'], 26: ['TvPower'],
  66: ['Confirm', 'Enter', 'DpadCenter'],
  /* 82 = KEYCODE_MENU（菜单）。这里必须用 AndroidMenu，不能用 Options：
     实测这台电视 Options / ActionMenu 弹的是 QuickSettingsWindowImpl，
     也就是电视自己的"设置"面板 —— 用户按"菜单"却跳设置，就是它干的。
     AndroidMenu 发出去是 keyCode 82，才是应用菜单键。 */
  82: ['AndroidMenu'], 85: ['PlayPause'], 164: ['Mute'],
  178: ['TvInput', 'Input'],
  219: ['Assists', 'MicPressedFromUnpairedRC'],
};

async function irccKey(code) {
  const codes = await irccCodes();
  let names = IRCC_KEY[code];
  const over = CFG.irccKeys[code] || CFG.irccKeys[String(code)];
  if (over) names = [over].concat(names || []);
  if (!names || !names.length) return { ok: false, msg: '这个按键没有 IP 控制码（用 adb 才能发）' };
  const name = names.find((n) => codes && codes[n]);
  if (!name) return { ok: false, msg: '电视没报出 ' + names.join('/') + ' 的按键码' };
  return irccName(name);
}

/** 按 IRCC 键名直接发。irccKey 按 Android 键码转发到这里；appControl 之外的
    个别功能（如 GoogleDashboard）没有对应 Android 键码，直接按名调用 */
async function irccName(name) {
  /* 不再硬性要求 SONY_PSK：电视的 IP 控制设成「普通」时压根不需要密钥。
     真没权限的话下面这次请求会拿到 403，报错信息比这里拦一下更有用 */
  const codes = await irccCodes();
  const irc = codes && codes[name];
  if (!irc) return { ok: false, msg: '电视没报出 ' + name + ' 的按键码' };
  const xml =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    '<u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1">' +
    '<IRCCCode>' + irc + '</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>';
  const r = await sonyPost('/sony/IRCC', xml, 'urn:schemas-sony-com:service:IRCC:1#X_SendIRCC');
  SONY.lastOk = r.status === 200;
  if (r.status === 200) return { ok: true, msg: '已发送（IP 控制 ' + name + '）', via: 'ircc' };
  return {
    ok: false,
    via: 'ircc',
    msg: r.status === 403 ? 'IP 控制被拒绝：检查电视里的预共享密钥是否和 SONY_PSK 一致' : 'IP 控制失败（' + (r.status || r.body) + '）',
  };
}

/* ---------- appControl：纯 IP 通道启动应用 ----------
   IRCC 只能发遥控器按键码，发不了"启动 Activity"；但索尼 IP 控制还有 appControl
   服务（getApplicationList / setActiveApp），可以直接拉起应用——设置、应用列表
   都能走这条路。实测这台电视该服务存在，只是要 PSK 鉴权。 */
async function ipAppList() {
  if (SONY.apps && Date.now() - SONY.appsAt < 300000) return SONY.apps;
  const r = await sonyPost('/sony/appControl', JSON.stringify({
    method: 'getApplicationList', id: 1, params: [], version: '1.0',
  }));
  const fail = (msg) => ({ ok: false, msg });
  if (r.status !== 200) return fail('getApplicationList 失败（' + (r.status || r.body) + '）');
  let j;
  try { j = JSON.parse(r.body); } catch (e) { return fail('getApplicationList 返回无法解析'); }
  if (j && j.error) return fail('getApplicationList 被拒（' + j.error[0] + ' ' + (j.error[1] || '') + '）');
  const apps = [];
  // 返回是嵌套数组 [[{title,uri,icon,data}]]，深度遍历把带 uri 的对象都收进来
  (function walk(x) {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x && typeof x === 'object' && typeof x.uri === 'string') apps.push(x);
  })(j.result);
  const list = apps.map((x) => {
    /* uri 有两种形态：
       ① 部分固件：intent:#Intent;component=包名/活动;end —— 能直接抠出包名
       ② 这台 BRAVIA：com.sony.dtv.<包名>.<活动名>
          两段里都带点号，**没法可靠还原包名**——活动名不一定以包名开头，例如
          银河奇异果 = com.gitvdemo.video + com.gala.video.app.epg.HomeActivity。
          硬拆会把包名拆错（拆成 com.gitvdemo.video.com.gala.video.app.epg），
          所以这里干脆不猜：包名留空，启动一律按电视自己给的 uri 走。
          这也是"点应用打不开"的根因：上一版按 component= 解析，索尼这种格式
          一个都解析不出来，前端列表里包名全空，启动时只能拼出错误 intent。 */
    const m = /component=([A-Za-z][\w.]*)\/([\w.]*)/.exec(x.uri);
    return {
      pkg: m ? m[1] : '',
      act: m ? m[2] : '',
      title: x.title || x.label || '',
      uri: x.uri,
      icon: x.icon || '',
    };
  });
  const res = list.length ? { ok: true, apps: list } : { ok: false, msg: '电视没返回应用列表' };
  if (res.ok) { SONY.apps = res; SONY.appsAt = Date.now(); }
  return res;
}

async function ipAppLaunch(uri) {
  const r = await sonyPost('/sony/appControl', JSON.stringify({
    method: 'setActiveApp', id: 1, params: [{ uri }], version: '1.0',
  }));
  if (r.status !== 200) {
    return {
      ok: false,
      msg: r.status === 403 ? 'IP 控制被拒绝：检查电视预共享密钥与 SONY_PSK 是否一致' : 'setActiveApp 失败（' + (r.status || r.body) + '）',
    };
  }
  try {
    const j = JSON.parse(r.body);
    if (j && j.error) return { ok: false, msg: 'setActiveApp 被拒（' + j.error[0] + ' ' + (j.error[1] || '') + '）' };
  } catch (e) {}
  return { ok: true, msg: '已启动（IP 控制）', via: 'ircc' };
}

/**
 * 纯 IP 通道启动应用。
 * 顺序：电视给过的 uri（最稳）→ 列表里按包名/uri 找 → 自己拼 intent URI 碰运气。
 * 注意索尼只放行它自己列表里的那 24 个应用，自己拼的 intent 基本都会被
 * 41401 Failed to Launch 挡回来，所以 uri 是主路，后两条只是兜底。
 */
async function ipLaunchPkg(pkg, act, uri) {
  if (uri) {
    const r = await ipAppLaunch(uri);
    if (r.ok) return r;
  }
  const l = await ipAppList();
  if (l.ok) {
    const hit = l.apps.find((a) => (uri && a.uri === uri) || (pkg && a.pkg === pkg));
    if (hit && hit.uri !== uri) return ipAppLaunch(hit.uri);
  }
  if (!pkg) return { ok: false, msg: '这个应用没有可用的启动地址（IP 通道只能打开电视应用列表里的应用）' };
  const tries = [];
  if (act) tries.push('intent:#Intent;component=' + pkg + '/' + act + ';end');
  tries.push('intent:#Intent;component=' + pkg + '/;end');
  let last = '';
  for (const u of tries) {
    const r = await ipAppLaunch(u);
    if (r.ok) return r;
    last = r.msg;
  }
  return { ok: false, msg: last || 'IP 通道启动失败' };
}

/** 打开电视端的应用抽屉：这条路不需要 adb，也不需要问应用列表 */
async function ipAppDrawer() {
  const a = await irccName('ApplicationLauncher');
  if (a.ok) return { ok: true, msg: '已打开电视的应用面板，用方向键挑吧', via: 'ircc' };
  const h = await irccName('Home');
  if (h.ok) return { ok: true, msg: '这固件没有应用面板键，已回到桌面（当贝桌面铺的就是应用）', via: 'ircc' };
  return { ok: false, msg: '这台电视既没有 ApplicationLauncher 键，IP 通道也不通' };
}

/**
 * 纯 IP 通道打开设置。
 *
 * 2026-10-25 在这台 BRAVIA 上把每条路都试了一遍，结论记下来免得再走弯路：
 *   ✅ IRCC `Options`  → 弹出 QuickSettingsWindowImpl，就是电视的"设置"面板
 *                        （画质/声音/网络/系统设置都在里面）—— 这条路最快最稳
 *   ❌ `GoogleDashboard` → 开的是 TvNotificationPanelActivity，屏幕上明明白白
 *                        写着"通知"。上一版拿它兜底，用户反馈"按设置弹出通知"就是它
 *   ❌ setActiveApp 拉 com.android.tv.settings → 一律 41401 Failed to Launch：
 *                        索尼这份白名单只放行桌面里的那 24 个应用，系统设置不在其中
 *                        （intent:#Intent;... 和索尼 uri 两种写法都试过，全拒）
 * 所以顺序改成：先按 Options，不行再从应用列表里碰运气。
 */
async function ipOpenSettings() {
  const o = await irccName('Options');
  if (o.ok) {
    /* 只发 Options，**绝不自动补 OK**。
       遥控器上的设置键对应 IRCC Options，弹出的是屏幕下方的选项条：第一项是
       「设置」，往下还有别的东西。之前为了让"按一次就能在预览里看到设置页"
       自动补过一次 OK，但那是有害的——焦点不一定停在第一项（比如从别的界面
       弹出来时），这时自动按 OK 等于替用户误触了别的选项，可能直接改了电视
       的某项设置或误开功能。这类"替用户点头"的动作不能由服务端擅自做。
       现在的行为：只弹菜单，由用户看清楚后自己按 OK。
       补发的关键帧只是为了让预览别停在旧画面上（选项条本身抓不到，但底下的
       界面在变化时需要新帧），不影响任何按键语义。 */
    setTimeout(castRequestKey, 250);
    setTimeout(castRequestKey, 700);
    return { ok: true, msg: '已弹出电视选项', via: 'ircc' };
  }

  const l = await ipAppList();
  if (l.ok) {
    const hit = l.apps.find((a) => /设置|settings/i.test(a.title) || /settings/i.test(a.uri));
    if (hit) return ipAppLaunch(hit.uri);
  }
  for (const u of ['com.android.tv.settings', 'com.android.settings']) {
    const r = await ipAppLaunch(u);
    if (r.ok) return r;
  }
  return { ok: false, msg: 'IP 通道打不开设置：Options 键没反应，应用列表里也没有设置' };
}

/* ================= 状态 ================= */
let MODEL = null;
/* adb 断开时 out() 会把 stderr 也拼进来（"error: device 'x:5555' not found"），
   一旦被当成型号写进 MODEL 就会被永久缓存 —— 即使 adb 恢复，顶栏也一直挂着这串报错。
   所以型号必须过白名单才认可。 */
const BAD_MODEL = /error|not found|offline|unauthorized|no devices|closed|unknown|daemon/i;
function looksLikeModel(s) {
  return !!s && s.length <= 40 && !BAD_MODEL.test(s) && /^[\w\s.\-+()/]+$/.test(s);
}
async function getModel() {
  if (MODEL) return MODEL;
  const raw = out(await devRetry(['shell', 'getprop ro.product.model']));
  if (looksLikeModel(raw)) { MODEL = raw; return MODEL; }
  // 拿不到就先用上次成功记录的型号，都没有才用兜底名；**不缓存**，下次仍会重试
  const cached = readState().tvModel;
  return looksLikeModel(cached) ? cached : 'Android TV';
}

/* adb 当前挂着的设备列表（排障用：一眼看出有没有连歪）。结果缓存 10s */
let DEV_CACHE = { at: 0, lines: [] };
async function adbDevices() {
  if (Date.now() - DEV_CACHE.at < 10000) return DEV_CACHE.lines;
  const r = await run(['devices', '-l'], 6000);
  const lines = out(r).split(/\r?\n/).slice(1)
    .map((s) => s.trim().replace(/\s+transport_id:\d+/, ''))
    .filter(Boolean);
  DEV_CACHE = { at: Date.now(), lines };
  return lines;
}

async function getStatus() {
  let ptxt = '', wtxt = '', model = '', adbOnline = false;

  /* adb 已知不在线时**一条 adb 命令都不发**：界面每 5 秒轮询一次状态，
     每次都去等 adb 超时的话，状态栏会一直卡着，按键也被拖累。
     这种情况改用 Sony 的 getPowerStatus（免密、10ms）判断开待机。 */
  if (!adbIsDown() && (await adbPortOpen())) {
    const [p, w, m] = await Promise.all([
      devRetry(['shell', 'dumpsys power'], 3000),
      devRetry(['shell', 'dumpsys activity activities | grep -m1 ResumedActivity'], 3000),
      getModel(),
    ]);
    ptxt = String(p.stdout);
    wtxt = String(w.stdout);
    model = m;
    adbOnline = !p.err && !/not found|offline|no devices|unauthorized/i.test(out(p));
    if (!adbOnline) CTRL.adbDownAt = Date.now();
  } else {
    CTRL.adbDownAt = CTRL.adbDownAt || Date.now();
  }

  let awake = 'unknown';
  if (adbOnline) {
    const wm = /mWakefulness=(\w+)/.exec(ptxt);
    awake = wm ? wm[1].toLowerCase() : 'unknown';
  } else {
    const r = await sonyPost('/sony/system', JSON.stringify({
      method: 'getPowerStatus', id: 1, params: [], version: '1.0',
    }));
    try {
      const st = JSON.parse(r.body).result[0].status;
      awake = st === 'active' ? 'awake' : 'asleep';
    } catch (e) {}
  }
  const am = /ResumedActivity:.*?u0\s+([\w.]+)\//.exec(wtxt);
  if (!model) model = readState().tvModel || 'BRAVIA';
  const ipOk = adbOnline ? false : await ipReady();
  return {
    model,
    awake,
    online: adbOnline,
    pkg: am ? am[1] : '',
    tv: SERIAL,
    /* 排障用：adb 眼里现在挂着哪些设备。局域网有模拟器/别的盒子开 5555 时，
       这里能直接看出拿错的是谁（型号不对就说明连歪了）。缓存 10s 避免每次轮询都跑 adb */
    devices: await adbDevices(),
    /* 控制通道：adb 优先；adb 断了但索尼 IP 通道通 → ircc。
       注意现在 ircc 不止能发按键：appControl 还能拉应用列表、按 intent 启动应用 */
    ctrl: adbOnline ? 'adb' : (ipOk ? 'ircc' : 'none'),
    ircc: {
      psk: !!SONY.psk, host: SONY.host,
      keys: SONY.codes ? Object.keys(SONY.codes).length : 0,
      ok: adbOnline || ipOk,
      err: ipOk ? '' : SONY.lastErr,
    },
    asr: !!process.env.ASR_URL,
    /* 电视端 App 有没有在推流。前端靠它决定「IP 控制模式下能不能开预览」：
       App 在线就不需要 ADB（见 startCastServer）。 */
    pvApp: PV.src === 'app' ? { size: PV.appSize, up: Math.round((Date.now() - PV.appAt) / 1000) } : null,
    /* adb 不在线时输入法状态一定是"不能用"，没必要再去问他（会白等两轮超时） */
    ime: adbOnline
      ? await imeState().catch(() => ({ installed: false, active: false }))
      : { installed: false, active: false, offline: true },
  };
}

/* ================= 按键 / 文本 ================= */

/**
 * 通道记忆。踩过的坑，写清楚免得再犯：
 *
 * 按键走 adb 要执行 `input keyevent`。电视一旦待机，或者 USB 调试被关掉，
 * 这条命令**不会报错，而是一直挂着**——实测电视待机时要等 10.2 秒才返回，
 * 端口不通时等满超时。老代码更糟：超时分支直接 return「已发送（电视响应慢）」，
 * **根本没走到 IP 兜底**，这一次按键等于丢了；而前端长按每 150ms 再发一条，
 * 几秒堆起几十个请求，等你松手这些按键才排队涌到电视上——
 * 表现就是"延迟特别大、按键像是错位了"。
 *
 * 现在分两个窗口，别混用：
 *   adbDownAt  确认 adb 真的不在线（端口不通/明确报错）→ 状态页据此显示"IP 控制"
 *   skipAt     只是"按键先别试 adb"→ 不影响状态页和输入法判断
 * 这样待机时按一下方向键走了 IP，不会把界面切成 ircc-only（否则文字输入会灰掉）。
 */
const CTRL = { adbDownAt: 0, skipAt: 0, skipTtl: 0, kickAt: 0 };
const ADB_DOWN_TTL = 30000;

function adbIsDown() {
  return CTRL.adbDownAt > 0 && Date.now() - CTRL.adbDownAt < ADB_DOWN_TTL;
}
/** 接下来这段时间按键直接走 IP，不再碰 adb */
function skipAdbFor(ms) {
  CTRL.skipAt = Date.now();
  CTRL.skipTtl = ms;
}
function adbSkipped() {
  return CTRL.skipAt > 0 && Date.now() - CTRL.skipAt < CTRL.skipTtl;
}

/** 只看 5555 通不通（十毫秒级），比让 adb 干等 10 秒便宜得多 */
async function adbPortOpen() {
  const m = /^([^:]+):(\d+)$/.exec(String(SERIAL));
  const host = m ? m[1] : SERIAL;
  const port = m ? Number(m[2]) : 5555;
  return probe(host, port, 400);
}

/** adb 失败后补一次重连——但放到后台，绝不让按键等它 */
function kickReconnect() {
  if (Date.now() - CTRL.kickAt < ADB_DOWN_TTL) return;
  CTRL.kickAt = Date.now();
  connect().catch(() => {});
}

async function sendKey(code) {
  if (!/^\d{1,4}$/.test(String(code))) return { ok: false, msg: '按键码非法' };
  const n = Number(code);
  /* 每按一次键就向电视要一个关键帧。
     screenrecord 那条路做不到这件事（要关键帧 = 重开录制 = 黑 450ms），
     App 通道下一个 IDR 只是「下一帧编成 I 帧」，几乎零成本。
     效果：按键后的第一个画面是自包含的，不依赖前面任何参考帧——
     「某些位置按方向键画面不刷新」这类小 P 帧被解码器吞掉的问题直接消失。 */
  castRequestKey();

  /* 1) 刚确认过 adb 指望不上：直接走 IP 控制（实测 15~21ms） */
  if (adbSkipped()) {
    const k = await irccKey(n);
    return k.ok ? k : { ok: false, msg: k.msg };
  }

  /* 2) 5555 都没开就别调 adb 了（会白等满超时） */
  if (!(await adbPortOpen())) {
    CTRL.adbDownAt = Date.now();
    skipAdbFor(ADB_DOWN_TTL);
    kickReconnect();
    const k = await irccKey(n);
    return k.ok ? k : { ok: false, msg: k.msg };
  }

  /* 3) adb 在：正常发。超时给 1.5s——局域网里正常设备 300ms 内一定回，
        回不来基本就是电视待机（实测 10 秒）或 adbd 卡住，没必要等下去 */
  const r = await dev(['shell', 'input', 'keyevent', String(n)], 1500);
  const s = out(r);
  if (!r.err && !/not found|offline|no devices|unauthorized|closed|error: device/i.test(s)) {
    return { ok: true, msg: s || '已发送', via: 'adb' };
  }

  /* 4) adb 不行 → 真兜底（老代码在超时分支直接返回成功，这一步永远到不了）。
        超时只影响按键（8 秒内不再试 adb），不改状态：可能只是电视待机，
        状态页仍然如实显示 adb 在线，输入法也不会被误判成不可用。 */
  const notFound = /not found|no devices|offline|unauthorized|closed|error: device/i.test(s) || !!r.err && !/timeout/i.test(r.err.message || '');
  if (notFound) { CTRL.adbDownAt = Date.now(); skipAdbFor(ADB_DOWN_TTL); }
  else skipAdbFor(8000);
  kickReconnect();
  const k = await irccKey(n);
  return k.ok ? k : { ok: false, msg: k.msg };
}

/* 打开电视设置。三条路，按通道能力依次尝试：
   1) adb 在线：am start 直接拉 com.android.tv.settings 的入口页。这台电视上
      KEYCODE_SETTINGS(176) 发出去毫无反应，只能拉 activity。
   2) adb 断了但 IP 通道通：走 ipOpenSettings()——实测 IRCC `Options` 就是电视
      的设置面板（详见那个函数的注释）。
   3) 最后才试设置按键本身。
   注意第 1 步用单次 dev 而不是 devRetry：电视关了调试时 devRetry 会先花十几秒
   重连 adb，白等很久才轮到 IP 兜底。 */
async function openSettings() {
  /* 和 sendKey 一样先要一个关键帧。
     2026-10-27 用户实测反馈：IP 控制下点「设置」，电视上其实已经弹出了系统
     设置面板，但预览画面纹丝不动，得再按一次 OK 才刷出来。根因不是设置没
     生效（也不是受保护画面），而是**这条链路绕过了 sendKey，从来没请求过
     关键帧**——面板弹出那一帧被编成了 P 帧，浏览器解码器没有可参考的 I 帧，
     就停在旧画面上。sendKey 在 .22 那轮加过 castRequestKey，设置走的是
     /api/settings 这条路，漏掉了。 */
  castRequestKey();

  const r = await dev(['shell', 'am', 'start', '-a', 'android.settings.SETTINGS'], 8000);
  const s = out(r);
  const adbDown = !!r.err || /not found|offline|no devices|unauthorized|closed/i.test(s);
  if (!adbDown && !/Error|Exception|does not exist/i.test(s)) return { ok: true, msg: '已打开设置' };

  /* 第 1 步用单次 dev：电视关了调试时 devRetry 会先花十几秒重连 adb，白等很久才轮到 IP 兜底。
     第 2 步判断能不能走 IP：不看 SONY_PSK 有没有填，而是看 ipReady() 的真探测结果——
     电视把 IP 控制设成「普通」时根本不需要密钥，只看有没有 PSK 会把这条路堵死。 */
  if (adbDown && (await ipReady())) {
    const a = await ipOpenSettings();
    if (a.ok) return a;
    return { ok: false, msg: a.msg };
  }

  const k = await sendKey(176);
  return k.ok
    ? { ok: true, msg: '已发送设置键（备用）', via: 'keyevent' }
    : { ok: false, msg: k.msg || '打不开设置' };
}

const B64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

function shEsc(s) {
  return String(s).replace(/([\\'"`$&|<>();*?[\]{}!#~^])/g, '\\$1');
}

async function sendText(text) {
  const t = String(text == null ? '' : text);
  if (!t) return { ok: false, msg: '内容为空' };
  const st = await imeState().catch(() => ({}));

  // 1) ADBKeyboard 已启用 → 广播注入，中文 / emoji 全支持
  if (st.active) {
    const r = await devRetry(
      ['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', B64(t)],
      8000
    );
    const ok = !r.err && !/Error|Exception/i.test(out(r));
    return { ok, msg: ok ? '已发送' : out(r), via: 'adbkeyboard' };
  }

  // 2) 纯 ASCII → input text
  if (/^[\x20-\x7E]*$/.test(t)) {
    const r = await devRetry(['shell', 'input', 'text', shEsc(t.replace(/ /g, '%s'))], 6000);
    if (r.err && /timeout/i.test(r.err.message || '')) return { ok: true, msg: '已发送（电视响应慢）', via: 'input' };
    return { ok: !r.err, msg: out(r), via: 'input' };
  }

  // 3) 中文但输入法没启用
  return {
    ok: false,
    needIme: true,
    msg: st.installed ? '请先点“启用中文输入”' : '请先安装中文输入法',
  };
}

/* ================= 语音识别（可选，交给外部 whisper 服务） ================= */
/**
 * 为什么语音要绕这么一圈：
 * Android 的语音助手（含索尼原装的“我在听呢，请说…”）只吃电视/遥控器麦克风的音频，
 * ADB 没有任何办法把手机的录音喂进电视的麦克风通道（那是 HFP/蓝牙音频层，需要 root 改音频路由）。
 * 所以网页上的“语音”只能走：手机录音 → 转成文字 → 用输入法通道把文字送进电视。
 * 文字通道是现成的（ADBKeyboard），这里只解决“录音怎么变成文字”。
 */
async function asrTranscribe(buf, mime) {
  const base = String(process.env.ASR_URL || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, needAsr: true, msg: '未配置语音识别服务' };
  if (!buf || buf.length < 600) return { ok: false, msg: '录音太短了' };

  const url = /\/v1\/audio\/transcriptions$/.test(base)
    ? base
    : base + '/v1/audio/transcriptions';
  const m = String(mime || '').toLowerCase();
  const ext = m.indexOf('wav') >= 0 ? 'wav'
    : m.indexOf('mp4') >= 0 || m.indexOf('m4a') >= 0 ? 'm4a'
    : m.indexOf('ogg') >= 0 ? 'ogg' : 'webm';

  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'audio/webm' }), 'speech.' + ext);
  fd.append('model', process.env.ASR_MODEL || 'whisper-1');
  fd.append('language', 'zh');

  const headers = {};
  if (process.env.ASR_KEY) headers.Authorization = 'Bearer ' + process.env.ASR_KEY;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 40000);
  try {
    const r = await fetch(url, { method: 'POST', headers, body: fd, signal: ctl.signal });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) {}
    if (!r.ok) {
      const msg = (j && ((j.error && j.error.message) || j.msg || j.message)) || txt.slice(0, 200);
      return { ok: false, msg: '识别失败：' + msg };
    }
    const text = String((j && (j.text || j.result || j.transcription)) || '').trim();
    if (!text) return { ok: false, msg: '没听清，再说一次' };
    return { ok: true, text, msg: '已识别' };
  } catch (e) {
    const m2 = String((e && e.message) || e);
    return { ok: false, msg: /abort/i.test(m2) ? '识别超时' : '识别服务不可用：' + m2 };
  } finally {
    clearTimeout(timer);
  }
}

/* ================= 语音搜片（关键词直达搜索结果页） ================= */
/**
 * 电视上的搜索框多半是 App 自绘键盘（当贝 / NewTV 都是），ADB 输入法根本注入不进去。
 * 但桌面本身的搜索页接受带关键词的 intent —— 一句话直接跳到结果页，比模拟打字靠谱得多。
 * 没装这个桌面 / action 不存在时，自动退化成把文字打进当前输入框。
 */
const SEARCH_ACTION = process.env.SEARCH_ACTION || 'com.dangbei.intent.search';

async function searchTV(q) {
  const t = String(q == null ? '' : q).trim();
  if (!t) return { ok: false, msg: '搜索词为空' };
  const quoted = t.replace(/'/g, "'\\''");
  const r = await devRetry(['shell', `am start -a ${SEARCH_ACTION} --es keyword '${quoted}'`], 9000);
  const o = out(r);
  if (/Error|Exception|not found|Unable|does not exist/i.test(o)) {
    const fb = await sendText(t);
    return Object.assign({ via: 'text' }, fb);
  }
  const m = /Starting:\s*Intent/.test(o);
  if (!m) {
    const fb = await sendText(t);
    return Object.assign({ via: 'text' }, fb);
  }
  return { ok: true, msg: '已搜索：' + t, via: 'search', q: t };
}

/* ================= 应用列表 / 启动 ================= */
/**
 * 读电视上装了哪些能启动的应用：
 *   cmd package query-activities --brief  -a MAIN -c LEANBACK_LAUNCHER / LAUNCHER
 * 这一条命令就能拿到「包名/入口 Activity」，比 pm list packages 再逐个 resolve 快得多。
 * 老系统没有该命令时退化成 pm list packages -3，靠 monkey 拉起。
 */
const APP_LABELS = {
  'com.sony.dtv.tv': '电视',
  'com.sony.dtv.sonyselect': 'Sony Select',
  'com.android.tv.settings': '设置',
  'com.android.settings': '设置',
  'com.google.android.tvlauncher': '桌面',
  'com.dangbei.tvlauncher': '当贝桌面',
  'com.netflix.ninja': 'Netflix',
  'com.google.android.youtube.tv': 'YouTube',
  'com.google.android.youtube': 'YouTube',
  'com.amazon.amazonvideo.livingroom': 'Prime Video',
  'com.disney.disneyplus': 'Disney+',
  'com.apple.atve.androidtv.appletv': 'Apple TV',
  'com.spotify.tv.android': 'Spotify',
  'com.plexapp.android': 'Plex',
  'tv.emby.embyatv': 'Emby',
  'org.jellyfin.androidtv': 'Jellyfin',
  'com.kodi': 'Kodi',
  'org.xbmc.kodi': 'Kodi',
  'com.tencent.qqlive': '腾讯视频',
  'com.ktcp.video': '云视听极光',
  'com.qiyi.video': '爱奇艺',
  'com.gitvdemo.video': '银河奇异果',
  'com.youku.phone': '优酷',
  'com.taihe.youku.tv': '优酷TV',
  'com.cctv.yangshipin.app.androidtv': '央视频TV',
  'com.hunantv.imgo.activity': '芒果TV',
  'com.mgtv.tv': '芒果TV',
  'com.sohu.sohuvideo': '搜狐视频',
  'tv.danmaku.bili': '哔哩哔哩',
  'com.bilibili.tv': '云视听小电视',
  'com.ss.android.ugc.aweme.tv': '抖音TV',
  'com.ss.android.ugc.aweme': '抖音',
  'com.smile.gifmaker': '快手',
  'com.dangbei.xinxiaoyuan': '当贝影视',
  'com.js.smart.youtube': 'Smart YouTube',
  'com.android.chrome': 'Chrome',
  'com.google.android.apps.tv.launcherx': 'Google TV',
  'com.google.android.videos': 'Google TV 影视',
  'com.google.android.apps.youtube.music': 'YouTube Music',
  'com.dts.freefireth': 'Free Fire',
  'com.sony.dtv.osat.spotify': 'Spotify',
  'com.sony.dtv.videoplayer': '视频播放器',
  /* ---- 本机这台电视实际装的（名字 / 图标都直接从 APK 的 resources.arsc 里读出来，
     不是猜的；换电视后想补名字，可以照这个格式加 ---- */
  'com.newtv.cboxtv': '央视频TV',
  'com.ktcp.tvvideo': 'NewTV极光',
  'com.ktkid.video': 'NewTV少儿',
  'com.cibn.tv': 'CIBN酷喵',
  'com.iptv.live': '电视直播',
  'com.github.mytv.android.x5offline': '电视直播',
  'cc.zztv.tvbox': '昭昭TV',
  'com.sony.dtv.osat.music': '音乐',
  'com.sony.dtv.timers': '计时器和时钟',
  'io.github.zwkit.flowcast': '无感投屏',
  'io.github.zwkit.flowrec': '无感录屏',
  /* ---- 2026-10-24 全量核对（24 个启动器应用，中文名取自各自 arsc 的 zh-CN）---- */
  'com.sony.dtv.tvx': '电视',
  'com.sony.dtv.smartmediaapp': '媒体播放器',
  'com.sony.dtv.smarthelp': '帮助',
  'com.sony.dtv.appassistant': '应用助手',
  'com.sony.dtv.ecodashboard': '节能控制面板',
  'com.sony.dtv.livingfit': '生活空间装饰',
  'com.sony.dtv.mysony': '会员尊享',
  'com.sony.dtv.notificationcenter': 'BRAVIA 通知',
  'com.dangbei.TVHomeLauncher': '桌面',
  'com.dangbei.tvlauncher': '当贝桌面',
  'cn.miguvideo.migutv': '咪视界',
  'com.netease.filmlytv': '网易爆米花',
  'com.trim.tv': '飞牛TV',
  'com.xiaodianshi.tv.yst': '云视听小电视',
  'com.google.android.tv.remote.service': 'Android TV 遥控服务',
};

function prettyLabel(pkg) {
  const seg = String(pkg || '').split('.').filter(Boolean).pop() || String(pkg || '');
  const s = seg.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : String(pkg || '');
}

/** 给人看的应用名：先查手写表，再查应用列表缓存（名字是从 APK 里读的），最后才猜 */
function appName(pkg) {
  if (!pkg) return '';
  if (APP_LABELS[pkg]) return APP_LABELS[pkg];
  const hit = (APPS_CACHE.list || []).find((a) => a && a.pkg === pkg);
  if (hit && hit.label) return hit.label;
  const disk = readAppsFile().find((a) => a && a.pkg === pkg);
  if (disk && disk.label) return disk.label;
  return prettyLabel(pkg);
}

let APPS_CACHE = { at: 0, list: [], src: 'adb' };
const APPS_FILE = () => path.join(CFG.dataDir, 'apps.json');

/** adb 顺手把应用名单落盘。ADB 关掉之后，IP 通道还能照着这份名单 + 本地图标
    继续给用户一份完整列表（pkg/act 都在，setActiveApp 就是按这两个启动的） */
function saveApps(list) {
  try { fs.writeFileSync(APPS_FILE(), JSON.stringify({ at: Date.now(), apps: list })); } catch (e) {}
}
function readAppsFile() {
  try {
    const j = JSON.parse(fs.readFileSync(APPS_FILE(), 'utf8'));
    return Array.isArray(j && j.apps) ? j.apps : [];
  } catch (e) { return []; }
}

async function adbAppList() {
  const map = new Map(); // pkg -> 入口 activity（可能为空）
  const cats = ['android.intent.category.LEANBACK_LAUNCHER', 'android.intent.category.LAUNCHER'];
  const results = await Promise.all(cats.map((cat) => devRetry(
    ['shell', 'cmd', 'package', 'query-activities', '--brief',
      '-a', 'android.intent.action.MAIN', '-c', cat], 12000)));
  for (const r of results) {
    const txt = out(r);
    // 注意 Activity 可能是相对名（pkg/.MainActivity），[A-Za-z] 开头会把索尼
    // 那一堆系统应用全漏掉，必须允许以 . 开头
    const re = /^\s*([A-Za-z][\w.]*)\/([.\w]+)\s*$/gm;
    let m;
    while ((m = re.exec(txt))) {
      if (!map.has(m[1])) map.set(m[1], m[2]);
    }
  }
  // 当前桌面（HOME）不一定声明 LEANBACK_LAUNCHER（当贝桌面就不声明），单独解析补上
  {
    const r = await devRetry(['shell', 'cmd', 'package', 'resolve-activity', '--brief',
      '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME'], 12000);
    const m = /^\s*([A-Za-z][\w.]*)\/([.\w]+)\s*$/m.exec(out(r).replace(/\r/g, ''));
    if (m && !map.has(m[1])) map.set(m[1], m[2]);
  }
  if (!map.size) {
    const r = await devRetry(['shell', 'pm', 'list', 'packages', '-3'], 12000);
    for (const line of out(r).split(/\r?\n/)) {
      const m = /^package:([A-Za-z][\w.]*)$/.exec(line.trim());
      if (m) map.set(m[1], '');
    }
  }
  const apps = [...map].map(([pkg, act]) => ({
    pkg,
    act,
    label: APP_LABELS[pkg] || prettyLabel(pkg),
    icon: '/api/icon/' + encodeURIComponent(pkg),
  })).sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
  return apps;
}

/**
 * 应用列表三级回退：
 *   1) adb（最全，能拿到所有带启动器的包）
 *   2) 索尼 appControl.getApplicationList —— ADB 关了但 IP 控制开着时能问到，
 *      电视直接给出应用名 + intent + 图标地址
 *   3) 上次 adb 拉到的名单（data/apps.json，图标也在本地 data/icons 里）
 * 返回 src 让前端知道这份列表是哪来的（cache 那份可能是旧的，值得提示一下）。
 */
async function listApps(force) {
  if (!force && APPS_CACHE.list.length && Date.now() - APPS_CACHE.at < 120000) {
    return { ok: true, apps: APPS_CACHE.list, src: APPS_CACHE.src };
  }
  /* ADB 关掉时**一条 adb 命令都别发**：adbAppList 有 3 条命令，每条都要挂满 12 秒
     超时，抽屉要转 7 秒以上才出名单。先探 5555 端口（≤400ms）再决定。 */
  const adbUsable = !adbIsDown() && (await adbPortOpen());
  const adbList = adbUsable ? await adbAppList() : [];
  if (adbList.length) {
    APPS_CACHE = { at: Date.now(), list: adbList, src: 'adb' };
    saveApps(adbList);
    if (force) prefetchIcons(adbList.map((a) => a.pkg));   // 刷新时后台补图标缓存
    return { ok: true, apps: adbList, src: 'adb' };
  }
  if (await ipReady()) {
    const l = await ipAppList();
    if (l.ok) {
      const apps = l.apps.map((a) => ({
        pkg: a.pkg, act: a.act, uri: a.uri,
        label: a.title || APP_LABELS[a.pkg] || prettyLabel(a.pkg || a.uri),
        // 电视给的是 http 图标地址，走我们自己的代理（手机不一定能直连电视）
        icon: a.icon ? '/api/ipicon?u=' + encodeURIComponent(Buffer.from(a.icon, 'utf8').toString('base64'))
          : (a.pkg ? '/api/icon/' + encodeURIComponent(a.pkg) : ''),
        // 这份列表没有包名，但每个都带 uri —— 前端点击时把 uri 原样回传即可启动。
        // 所以过滤条件改成"有包名或有 uri"，不能再按包名把所有应用滤掉。
      })).filter((a) => a.pkg || a.uri).sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
      if (apps.length) {
        APPS_CACHE = { at: Date.now(), list: apps, src: 'ip' };
        return { ok: true, apps, src: 'ip' };
      }
    }
  }
  const cached = readAppsFile();
  if (cached.length) {
    APPS_CACHE = { at: Date.now(), list: cached, src: 'cache' };
    return { ok: true, apps: cached, src: 'cache', stale: true };
  }
  return { ok: false, apps: [], msg: '读不到应用列表：adb 不在线，索尼 IP 控制也没授权' };
}

async function launchApp(pkg, act, uri, label) {
  pkg = String(pkg == null ? '' : pkg).trim();
  act = String(act == null ? '' : act).trim();
  uri = String(uri == null ? '' : uri).trim();
  /* 包名可以没有（索尼那份列表给的是自家格式的 uri，还原不出包名），
     只要电视给过 uri 就能启动 —— 别因为"包名非法"就把请求打回去 */
  if (!/^[A-Za-z][\w.]*$/.test(pkg)) pkg = '';
  if (!pkg && !uri) return { ok: false, msg: '这条应用没带包名也没带启动地址，开不了' };
  /* 显示名：IP 列表里没有包名，前端把电视给的标题一起带回来，提示语才不会变成"已打开 应用" */
  const name = String(label || '').trim().slice(0, 24) || APP_LABELS[pkg] || (pkg ? prettyLabel(pkg) : '应用');

  /* 跟 sendKey / openSettings 一样：启动应用是整屏切换，画面变化极大，
     没有 I 帧预览就会停在旧画面（用户只能再按一次键才刷出来）。 */
  castRequestKey();

  const viaIp = async () => {
    const r = await ipLaunchPkg(pkg, act, uri);
    /* 应用冷启动要几百毫秒才画出来，补两枪保证预览能跟上 */
    if (r.ok) { setTimeout(castRequestKey, 300); setTimeout(castRequestKey, 900); }
    return r.ok
      ? { ok: true, msg: '已打开 ' + name + '（IP 控制）', via: 'ircc' }
      : { ok: false, msg: r.msg };
  };

  /* ADB 已知不在线时一条 adb 命令都别发：am start 要等 9 秒、monkey 再等 12 秒，
     点个应用要卡 20 多秒才轮到 IP 兜底，用户只会觉得"点了没反应"。
     先探 5555 端口（≤400ms）判断要不要碰 adb。 */
  const adbUsable = !adbIsDown() && pkg && (await adbPortOpen());
  if (!adbUsable) {
    if (await ipReady()) return viaIp();
    return { ok: false, msg: 'adb 不在线，IP 控制也没通，开不了应用' };
  }

  const tries = [];
  if (act && /^[A-Za-z][\w.]*$/.test(act)) tries.push(pkg + '/' + act);
  const hit = (APPS_CACHE.list || []).find((a) => a.pkg === pkg);
  if (hit && hit.act && hit.act !== act) tries.push(pkg + '/' + hit.act);
  for (const comp of tries) {
    const r = await devRetry(['shell', 'am', 'start', '-n', comp], 9000);
    const o = out(r);
    if (!/Error|Exception|not found|does not exist|Unable|Permission/i.test(o)) {
      return { ok: true, msg: '已打开 ' + name };
    }
  }
  const r2 = await devRetry(
    ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], 12000);
  const o2 = out(r2);
  if (/Events injected|injected:/i.test(o2)) return { ok: true, msg: '已打开 ' + name };

  // adb 这条走不通（多半是关了调试）→ 改走索尼 appControl，按电视给的 uri 启动
  if (await ipReady()) return viaIp();
  const why = o2.split(/\r?\n/).filter(Boolean).slice(-1)[0] || '未知原因';
  return { ok: false, msg: '打开失败：' + why.slice(0, 120) };
}

/* ================= 应用图标 =================
 * 图标不在 /api/apps 里同步返回（那样列表要等全部解析完），而是：
 *   前端 <img src="/api/icon/包名"> 懒加载 → 服务端按队列逐个解析 → 落盘缓存
 * 解析逻辑在 apkicon.js：AXML 清单拿图标资源 ID → ARSC 解析成文件路径 →
 * unzip -p 取图片字节；自适应/矢量图标转成 SVG。详见该文件注释。 */
const ICON_DIR = path.join(CFG.dataDir, 'icons');
try { fs.mkdirSync(ICON_DIR, { recursive: true }); } catch (e) {}

const ICON_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
const ICON_MISS = new Map();     // pkg -> 上次失败时间（5 分钟内不重试）
const ICON_INFLIGHT = new Map(); // pkg -> Promise（合并并发请求）
let ICON_QUEUE = Promise.resolve();

function iconPath(pkg) {
  for (const ext of ['png', 'webp', 'jpg', 'svg']) {
    const f = path.join(ICON_DIR, pkg + '.' + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** 读取已缓存的图标；没有则返回 null */
function readIconCache(pkg) {
  const f = iconPath(pkg);
  if (!f) return null;
  try {
    const data = fs.readFileSync(f);
    const ext = path.extname(f).slice(1);
    if (data.length) return { data, ext, type: ICON_TYPES[ext] || 'application/octet-stream' };
  } catch (e) {}
  return null;
}

/** 串行队列：同时只允许一个提取任务跑，保护电视不被打爆 */
function enqueueIcon(pkg) {
  if (ICON_INFLIGHT.has(pkg)) return ICON_INFLIGHT.get(pkg);
  const p = ICON_QUEUE.then(async () => {
    const r = await extractIcon(pkg, { adb: CFG.adb, serial: SERIAL });
    if (r.ok) {
      const ext = r.ext === 'svg' ? 'svg' : (r.ext || 'png');
      const f = path.join(ICON_DIR, pkg + '.' + ext);
      const bytes = r.data !== undefined ? r.data : Buffer.from(r.svg || '', 'utf8');
      fs.writeFileSync(f, bytes);
      ICON_MISS.delete(pkg);
      return { data: bytes, ext, type: ICON_TYPES[ext] || 'application/octet-stream' };
    }
    ICON_MISS.set(pkg, Date.now());
    return null;
  }).finally(() => { ICON_INFLIGHT.delete(pkg); });
  ICON_INFLIGHT.set(pkg, p);
  ICON_QUEUE = p.catch(() => {});
  return p;
}

/* 自绘图标覆盖：这两个「电视直播」的原始图标不能用——
   ① mytv 那个电视只占画面一半，跟邻居图标风格完全不搭；
   ② iptv.live 那个电视根本不给图标（DIAL 返回 404）。
   索尼桌面/列表两处（ipicon 代理、/api/icon 提取）都优先返回自绘版。
   想换样式：直接替换 assets/icon-livetv.png，并同步更新下方内嵌的 base64 副本。 */
const ICON_OVERRIDES = ['com.github.mytv.android.x5offline', 'com.iptv.live'];
/* assets/icon-livetv.png 的内嵌副本：assets 目录没挂进容器（老容器没这卷）时兜底。
   更新样式请把 assets/icon-livetv.png 转成 base64 后替换到这里。 */
const ICON_LIVETV_PNG_B64 = [
  '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'
].join('');

function iconOverride(pkg) {
  /* 子串匹配：DIAL 的图标 URL 里包名后面还挂着 .MainActivity 之类的后缀 */
  if (!pkg || !ICON_OVERRIDES.some((s) => pkg.includes(s))) return null;
  try {
    const p = path.join(__dirname, 'assets', 'icon-livetv.png');
    return { data: fs.readFileSync(p), type: 'image/png' };
  } catch (e) { /* 没有文件就用内嵌副本，别让图标退回原样 */ }
  try {
    return { data: Buffer.from(ICON_LIVETV_PNG_B64, 'base64'), type: 'image/png' };
  } catch (e2) { return null; }
}

/** 供 /api/icon 使用：缓存优先，其次提取 */
function getIcon(pkg) {
  const ov = iconOverride(pkg);
  if (ov) return Promise.resolve(ov);
  const hit = readIconCache(pkg);
  if (hit) return Promise.resolve(hit);
  const miss = ICON_MISS.get(pkg);
  if (miss && Date.now() - miss < 300000) return Promise.resolve(null);   // 失败过，5 分钟后再试
  return enqueueIcon(pkg);
}

/** 后台预热（/api/apps?refresh=1 时调用），不阻塞响应 */
function prefetchIcons(pkgs) {
  for (const pkg of pkgs || []) {
    if (readIconCache(pkg)) continue;
    const miss = ICON_MISS.get(pkg);
    if (miss && Date.now() - miss < 300000) continue;
    setTimeout(() => { enqueueIcon(pkg).catch(() => {}); }, 0);
  }
}

/* ================= 中文输入法（ADBKeyboard） ================= */
const STATE_FILE = () => path.join(CFG.dataDir, 'state.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch (e) { return {}; }
}
function writeState(patch) {
  const s = Object.assign(readState(), patch);
  try { fs.writeFileSync(STATE_FILE(), JSON.stringify(s, null, 2)); } catch (e) {}
  return s;
}

let IME_CACHE = { at: 0, val: null };

async function imeState(force) {
  if (!force && IME_CACHE.val && Date.now() - IME_CACHE.at < 5000) return IME_CACHE.val;
  const [lst, cur] = await Promise.all([
    devRetry(['shell', 'pm', 'list', 'packages', IME_PKG], 6000),
    devRetry(['shell', 'settings', 'get', 'secure', 'default_input_method'], 6000),
  ]);
  const installed = new RegExp('package:' + IME_PKG.replace(/\./g, '\\.')).test(out(lst));
  const current = out(cur).replace(/^.*\n/, '').trim();
  const val = { installed, current, active: current.indexOf(IME_PKG) >= 0 };
  IME_CACHE = { at: Date.now(), val };
  return val;
}

async function imeInstall() {
  if (!fs.existsSync(APK)) return { ok: false, msg: '缺少 vendor/ADBKeyboard.apk' };
  const r = await run(['-s', SERIAL, 'install', '-r', APK], 120000);
  const msg = out(r);
  if (/Failure|Error/i.test(msg) && !/Success/i.test(msg)) return { ok: false, msg };
  await devRetry(['shell', 'ime', 'enable', IME_ID], 8000);
  await imeState(true);
  return { ok: true, msg: '已安装并注册中文输入法' };
}

async function imeActivate() {
  const st = await imeState(true);
  if (!st.installed) return { ok: false, msg: '尚未安装中文输入法' };
  if (st.active) return { ok: true, msg: '已是当前输入法' };
  if (st.current) writeState({ originalIme: st.current });
  await devRetry(['shell', 'ime', 'enable', IME_ID], 8000);
  const r = await devRetry(['shell', 'ime', 'set', IME_ID], 8000);
  const now = await imeState(true);
  return { ok: now.active, msg: now.active ? '中文输入已启用' : (out(r) || '切换失败，请重试') };
}

async function imeRestore() {
  const s = readState();
  const target = s.originalIme && s.originalIme.indexOf(IME_PKG) < 0 ? s.originalIme : '';
  if (!target) return { ok: false, msg: '没有记录到原输入法' };
  await devRetry(['shell', 'ime', 'set', target], 8000);
  const st = await imeState(true);
  return { ok: !st.active, msg: st.active ? '恢复失败' : '已恢复原输入法' };
}

/* ================= HTTP ================= */
/* ---------- 色彩范围修正（原本是 h264fix.js，现内联） ----------
 *
 * 实测（索尼/MTK 这台）：screenrecord 送出的 YUV 是 **全范围(0~255)**——Y 最小值能到 8，
 * limited 永远不会低于 16——但 SPS 的 VUI 里 video_full_range_flag 写的是 0（limited）。
 * 于是所有解码器（ffmpeg、Chrome 同一套规则）都按 16~235 再拉伸一次，暗部被压黑、
 * 对比过强，看上去就是「颜色不正常」。
 *
 * 做法：把 SPS 里那 1 个 bit 翻成 1，其余字节原样保留（改完重新做防竞争字节转义）。
 * 内联的原因见文件顶部 require 处的注释：少一个文件 = 少一个「忘了 COPY/挂载就起不来」的坑。
 */

/** RBSP 去防竞争字节（00 00 03 → 00 00） */
function pvUnescapeRbsp(n) {
  const o = Buffer.allocUnsafe(n.length);
  let p = 0, z = 0;
  for (let i = 0; i < n.length; i++) {
    if (z >= 2 && n[i] === 3) { z = 0; continue; }
    o[p++] = n[i];
    z = n[i] === 0 ? z + 1 : 0;
  }
  return o.subarray(0, p);
}

/** 重新插入防竞争字节 */
function pvEscapeRbsp(n) {
  const out = [];
  let z = 0;
  for (let i = 0; i < n.length; i++) {
    const v = n[i];
    if (z >= 2 && v <= 3) { out.push(3); z = 0; }
    out.push(v);
    z = v === 0 ? z + 1 : 0;
  }
  return Buffer.from(out);
}

/** 按比特读 SPS 的 Exp-Golomb 解析器 */
function pvReader(b) {
  let p = 0;
  const bits = (k) => {
    let v = 0;
    for (let i = 0; i < k; i++) {
      v = (v << 1) | ((b[p >> 3] >> (7 - (p & 7))) & 1);
      p++;
    }
    return v;
  };
  return {
    pos: () => p,
    u: bits,
    ue: () => {
      let lz = 0;
      while (p < b.length * 8 && ((b[p >> 3] >> (7 - (p & 7))) & 1) === 0) { p++; lz++; }
      p++;                                     // 跳过停止位
      return (1 << lz) - 1 + (lz ? bits(lz) : 0);
    },
  };
}

/**
 * 找到 SPS 里 video_full_range_flag 的比特位置。
 * 返回 -1 = 没有 VUI 或没有 video_signal_type 段（无法就地翻转）。
 */
function pvFindFullRangeBit(sps) {
  const rbsp = pvUnescapeRbsp(sps.subarray(1));
  const r = pvReader(rbsp);
  const profile = r.u(8);
  r.u(8); r.u(8);                       // constraint flags + level
  r.ue();                               // sps_id
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const chroma = r.ue();
    if (chroma === 3) r.u(1);
    r.ue(); r.ue();                     // bit_depth luma/chroma
    r.u(1);                             // qpprime
    if (r.u(1)) {                       // seq_scaling_matrix
      const cnt = chroma === 3 ? 12 : 8;
      for (let i = 0; i < cnt; i++) {
        if (r.u(1)) {
          let last = 8, next = 8;
          const sz = i < 6 ? 16 : 64;
          for (let j = 0; j < sz; j++) {
            if (next !== 0) {
              const d = r.ue();
              const s = (d & 1) ? (d + 1) / 2 : -(d / 2);
              next = (last + s + 256) % 256;
            }
            last = next === 0 ? last : next;
          }
        }
      }
    }
  }
  r.ue();                               // log2_max_frame_num
  const poc = r.ue();
  if (poc === 0) r.ue();
  else if (poc === 1) { r.u(1); r.ue(); r.ue(); const n = r.ue(); for (let i = 0; i < n; i++) r.ue(); }
  r.ue();                               // max_num_ref_frames
  r.u(1);                               // gaps_in_frame_num
  r.ue(); r.ue();                       // pic_width / pic_height
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1);
  r.u(1);                               // direct_8x8
  if (r.u(1)) { r.ue(); r.ue(); r.ue(); r.ue(); }   // frame_cropping
  if (!r.u(1)) return -1;               // 没有 VUI

  // ---- VUI ----
  if (r.u(1)) {                         // aspect_ratio_info_present
    if (r.u(8) === 255) { r.u(16); r.u(16); }
  }
  if (r.u(1)) r.u(1);                   // overscan
  if (!r.u(1)) return -1;               // 没有 video_signal_type → 没有这个 bit 可改
  r.u(3);                               // video_format
  return r.pos();                       // ← video_full_range_flag 从这个比特开始
}

/**
 * 把 SPS 的 video_full_range_flag 置 1。改不了就原样返回。
 * @param {Buffer} sps 含 1 字节 NAL 头的 SPS
 * @returns {{sps: Buffer, fixed: boolean}}
 */
function fixSpsRange(sps) {
  if (!sps || !sps.length || (sps[0] & 0x1f) !== 7) return { sps, fixed: false };
  let bitPos;
  try { bitPos = pvFindFullRangeBit(sps); } catch (e) { return { sps, fixed: false }; }
  if (bitPos < 0) return { sps, fixed: false };

  const rbsp = Buffer.from(pvUnescapeRbsp(sps.subarray(1)));
  const i = bitPos >> 3;
  const mask = 1 << (7 - (bitPos & 7));
  if (i >= rbsp.length) return { sps, fixed: false };
  if (rbsp[i] & mask) return { sps, fixed: false };       // 已经是 full range
  rbsp[i] |= mask;
  return { sps: Buffer.concat([Buffer.from([sps[0]]), pvEscapeRbsp(rbsp)]), fixed: true };
}

/* ================= 画面预览（480p，零依赖）=================
 *
 * 做法：电视端 `screenrecord --output-format=h264` 把裸流喷到 stdout，
 * 服务端只做 Annex-B 拆帧，原样转给浏览器，由浏览器的 WebCodecs 解码画到 canvas。
 * 不用 ffmpeg、不用 fMP4，镜像不用变大。
 *
 * 为什么必须有「黑屏 + 标题」这套：BRAVIA 把视频层交给硬件侧通道合成
 * （SurfaceFlinger 里是 composition=SIDEBAND），screencap / screenrecord 都
 * 拿不到电影画面，只能拿到黑色的 UI 层（实测 4K 与 720p 一致）。所以一旦检测到
 * 画面全黑，就不是「坏了」，而是「正在放视频」，前端改显示当前播放的标题。
 *
 * 开销（实测，4 核机）：480p 预览约 1.7 核；关掉开关就彻底停止 screenrecord。
 * PREVIEW_SIZE / PREVIEW_BITRATE 可覆盖。
 */
const PV = {
  /* 尺寸必须是 16 的倍数。实测 854x480 会让电视端补出 16 行/若干列的 padding，
     解码后就是一条粗绿条（YUV 全 0 = 绿）；848x480 干净（同批实测）。 */
  size: process.env.PREVIEW_SIZE || '848x480',
  bitrate: Number(process.env.PREVIEW_BITRATE || 2500000),
  /* 电视端 screenrecord 写的是全范围(0~255) YUV，却在 SPS 里标成 limited，
     所有解码器都会把暗部压黑一档（详见下面的 fixSpsRange）。这里默认纠正，
     换到行为正常的电视时可以 PREVIEW_RANGE=limited 关掉。 */
  rangeFix: process.env.PREVIEW_RANGE !== 'limited',
  clients: new Set(),
  child: null,
  sps: null,
  pps: null,
  startedAt: 0,
  fails: 0,
  kickT: null,
  /* 最近一段从 IDR 起的码流（治「打开预览黑屏」，见 pvCacheGop） */
  gop: [],
  gopBytes: 0,
  gopBroken: false,
  gopAt: 0,
  /* 采集源：'' = 没有；'adb' = screenrecord；'app' = 电视端 App 直连（见 startCastServer） */
  src: '',
  app: null,
  appSize: '',
  appAt: 0,
  appFail: '',
  lastErr: '',
  // 1 秒滑窗的出口统计，给 /api/health 看「发出去多少、堵没堵」
  stat: { at: Date.now(), frames: 0, bytes: 0, fps: 0, kbps: 0 },
  /* 最后一帧到达的时刻。看门狗靠它判断「有人在看着，但电视那头不出帧了」 */
  lastFrameAt: 0,
};

/** 帧协议：[1 字节类型][4 字节大端长度][负载]，类型 2 = 一个 H.264 access unit（Annex-B）
 *  头和体拼成一次 write：一帧 5KB 拆两次写会多出一个 TCP 小包，而屏幕一动起来
 *  就是成簇吐帧（实测 100ms 内 17 帧），小包开销会成倍放大。 */
function pvSend(client, buf) {
  const out = Buffer.allocUnsafe(5 + buf.length);
  out[0] = 2;
  out.writeUInt32BE(buf.length, 1);
  buf.copy(out, 5);
  try {
    // 返回 false = 对端内核缓冲已满。记下来，/api/health 能看到是不是网络在拖。
    if (client.res.write(out) === false) client.bp = (client.bp || 0) + 1;
    const q = client.res.writableLength || 0;
    if (q > (client.qPeak || 0)) client.qPeak = q;
  } catch (e) { /* 对端已断，交给 close 事件收尾 */ }
}

/** 把一帧里的若干 NAL 用 4 字节起始码拼起来（浏览器端再拆，不用管 3/4 字节混用） */
function pvBroadcast(nalus) {
  if (!nalus.length) return;
  PV.lastFrameAt = Date.now();
  let size = 0;
  for (const n of nalus) size += 4 + n.length;
  const out = Buffer.allocUnsafe(size);
  let p = 0;
  let key = false;
  for (const n of nalus) {
    if ((n[0] & 0x1f) === 5) key = true;
    out[p] = 0; out[p + 1] = 0; out[p + 2] = 0; out[p + 3] = 1;
    p += 4;
    n.copy(out, p);
    p += n.length;
  }
  pvCacheGop(out, key);
  if (!PV.clients.size) return;   // 没人看也照样更新缓存，下一个人进来就能补上
  for (const c of PV.clients) pvSend(c, out);
  PV.fails = 0;   // 有帧在走就说明这一路是健康的
  PV.stat.frames++;
  PV.stat.bytes += out.length;
}

/* 最近一段「从 IDR 开始」的码流缓存 —— 治「打开预览黑屏、按一下键才出图」。
 *
 * 病根：service 端 screenrecord 的关键帧间隔实测能到 24 秒。新观众接上时如果
 * 编码会话已经在跑，他只能拿到 SPS/PPS（见 pvAttach），却等不到 IDR；解码器
 * 有参数集没有参考帧，一帧也解不出来，画面就这么一直黑着，直到用户按键让
 * 画面变化、编码器刚好吐出一个 IDR —— 这正是「操作一下才出画面」的成因。
 * （实测复现：第 2 个客户端 10 秒只收到 35B 的 [SPS PPS]，零个 IDR。）
 *
 * 解法：把「上一个 IDR + 之后的每一帧」留着，新观众一接上就按顺序补给他。
 * 他能从完整的 GOP 一路解到当前画面，**立刻出图**，也不用为他把编码会话
 * 重开一遍（重开会闪别人半秒）。静止画面时这段就是一张 40KB 的 IDR，很轻。
 *
 * 上限 3MB / 300 帧：超过就把缓存清掉并标记 broken，等下个 IDR 重新起头；
 * 这中间的观众走 pvKickSession（重开会话）这条路兜底。
 */
const GOP_MAX_BYTES = 3 * 1024 * 1024;
const GOP_MAX_FRAMES = 300;

function pvCacheGop(out, key) {
  if (key) {
    PV.gop = [out];
    PV.gopBytes = out.length;
    PV.gopBroken = false;
    PV.gopAt = Date.now();
    return;
  }
  if (PV.gopBroken || !PV.gop.length) return;   // 没有起头的 IDR，留着也没用
  PV.gop.push(out);
  PV.gopBytes += out.length;
  PV.gopAt = Date.now();
  if (PV.gopBytes > GOP_MAX_BYTES || PV.gop.length > GOP_MAX_FRAMES) {
    PV.gop = [];
    PV.gopBytes = 0;
    PV.gopBroken = true;
  }
}

/* 把缓存里的「参数集 + 关键帧」再发一遍。
 *
 * 治的是「打开预览一直黑、随便按个键才出图」：
 * 手机的硬件 H.264 解码器经常把 configure() 之后的第一帧**吃掉**——
 * 有输入、没输出，不报错。画面静止时编码器不出新帧（这台电视的编码器
 * 不支持补帧，见 flowrec/CastService 的注释），下一帧要等用户按键让画面
 * 变化才来，于是解码器就一直空着，预览黑到人按键为止。
 * 同一个 IDR 再喂一次，解码器就有第二次机会把画面吐出来，代价只有几十 KB。
 *
 * 返回是否真的发了（缓存不可用时调用方可以据此决定别的兜底）。 */
function pvResendKey() {
  if (!PV.clients.size || PV.gopBroken || !PV.gop.length) return false;
  const head = (PV.sps && PV.pps)
    ? Buffer.concat([Buffer.from([0, 0, 0, 1]), PV.sps, Buffer.from([0, 0, 0, 1]), PV.pps])
    : null;
  for (const c of PV.clients) {
    if (head) pvSend(c, head);
    pvSend(c, PV.gop[0]);
  }
  return true;
}

/** 出口侧滑窗统计 + 拥塞情况（/api/health 里能看到「发得快不快、堵没堵」） */
function pvStatNow() {
  const s = PV.stat, now = Date.now(), dt = now - s.at;
  if (dt >= 500) {
    s.fps = Math.round((s.frames * 1000) / dt);
    s.kbps = Math.round((s.bytes * 8) / dt);
    s.frames = 0; s.bytes = 0; s.at = now;
  }
  let q = 0, bp = 0;
  for (const c of PV.clients) {
    q = Math.max(q, c.res.writableLength || 0);
    bp += c.bp || 0;
  }
  return { fps: s.fps, kbps: s.kbps, queue: q, backpressure: bp };
}

function pvStop() {
  const c = PV.child;
  PV.child = null;
  if (c) { try { c.kill('SIGKILL'); } catch (e) {} }
}

/**
 * 起一路 screenrecord。**全局只允许一路**：重复起会让电视同时编码多条流，
 * 多点一个开关就多烧一个核。多个浏览器共用这一路。
 */
function pvStart() {
  if (PV.child || !PV.clients.size) return;
  if (PV.src === 'app') return;    // 电视端 App 在推流，别再起一路 screenrecord（同时只能有一路）

  const args = ['-s', SERIAL, 'exec-out', 'screenrecord', '--output-format=h264',
    '--size', PV.size, '--bit-rate', String(PV.bitrate), '--time-limit', '180', '-'];
  let child;
  try {
    child = spawn(CFG.adb, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    PV.lastErr = e.message;
    pvStop();
    return;
  }
  PV.child = child;
  PV.startedAt = Date.now();
  PV.sps = null;
  PV.pps = null;
  /* 新会话必然是新的 SPS/PPS/IDR 起头，旧的 GOP 缓存立刻作废——
     留着会让新观众先看到上一段时间的画面。 */
  PV.gop = [];
  PV.gopBytes = 0;
  PV.gopBroken = false;

  let buf = Buffer.alloc(0);
  let au = [];           // 当前 access unit 里的 NAL
  let hasVCL = false;    // 这一帧有没有图像数据（只有参数的帧不能单独送）
  let flushT = null;
  let idleT = null;
  let cutAtEof = false;  // 上一次是等不到下一帧、硬切的尾巴，下一块数据要跳到起始码

  const flush = () => {
    if (flushT) { clearTimeout(flushT); flushT = null; }
    if (!hasVCL || !au.length) { au = []; return; }
    const list = au;
    au = [];
    hasVCL = false;
    pvBroadcast(list);
  };

  const handleNal = (nal) => {
    const type = nal[0] & 0x1f;
    let out = nal;
    if (type === 7) {
      // 把 SPS 的「全范围」标记补上，否则浏览器解码出来偏暗（见 fixSpsRange）
      if (PV.rangeFix) out = fixSpsRange(nal).sps;
      PV.sps = out;
    } else if (type === 8) PV.pps = nal;
    if (type >= 1 && type <= 5) {
      if (hasVCL) flush();                    // 一帧只有一个图像 NAL
      au.push(out);
      hasVCL = true;
      if (flushT) clearTimeout(flushT);
      // 画面静止时不会有下一帧，靠这个收尾。25ms ≈ 一帧多一点：
      // 光等下一帧会白拖一帧的时间，用户按一下键就能感觉到。
      flushT = setTimeout(flush, 25);
    } else {
      if (hasVCL) flush();                    // 参数集/SEI 算下一帧的头
      au.push(out);
    }
  };

  /* 静态画面只有一个关键帧，后面不会再有起始码——不主动收尾的话这一帧
     会一直卡在缓冲里，用户打开预览看到的就是一片黑（实测 3.5s 零帧）。
     静默 180ms 就当这一帧结束；万一真是传了一半被切断，下一块数据
     会从下一个起始码重新开始，最多坏一帧。 */
  const SC = Buffer.from([0, 0, 1]);
  const idleFlush = () => {
    idleT = null;
    if (!buf.length) return;
    const i = buf.indexOf(SC);
    if (i < 0) { buf = Buffer.alloc(0); return; }
    let s = i + 3;
    let e = buf.length;
    while (e > s && buf[e - 1] === 0) e--;
    const nal = Buffer.from(buf.subarray(s, e));
    buf = Buffer.alloc(0);
    cutAtEof = true;
    if (nal.length) handleNal(nal);
    flush();
  };
  const armIdle = () => {
    if (idleT) clearTimeout(idleT);
    idleT = setTimeout(idleFlush, 180);
  };

  const feed = (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    if (cutAtEof) {
      const i = buf.indexOf(SC);
      if (i < 0) { if (buf.length > 4) buf = Buffer.alloc(0); return; }
      buf = buf.subarray(i);
      cutAtEof = false;
    }
    const starts = [];
    for (let i = 0; i + 3 < buf.length; i++) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) { starts.push(i); i += 2; }
    }
    if (starts.length < 2) {
      // 单个超大 NAL 还没收完，别把缓冲撑爆
      if (buf.length > 8 * 1024 * 1024) buf = buf.subarray(buf.length - 1024);
      return;
    }
    const keepFrom = starts[starts.length - 1]; // 最后一个 NAL 可能还没收完，留到下一轮
    for (let k = 0; k + 1 < starts.length; k++) {
      const s = starts[k] + 3;
      let e = starts[k + 1];
      while (e > s && buf[e - 1] === 0) e--;    // 4 字节起始码多带的一个 0
      if (e <= s) continue;
      handleNal(Buffer.from(buf.subarray(s, e)));
    }
    buf = buf.subarray(keepFrom);
  };

  child.stdout.on('data', (d) => { feed(d); armIdle(); });
  child.stderr.on('data', (d) => { PV.lastErr = String(d).slice(0, 200); });
  child.on('error', (e) => { PV.lastErr = e.message; });
  child.on('close', () => {
    if (flushT) clearTimeout(flushT);
    if (idleT) clearTimeout(idleT);
    if (PV.child === child) PV.child = null;
    if (!PV.clients.size) return;
    /* 一秒内就退出 = 没起来（电视待机 / 端口不通）。别每 300ms 重试刷 adb，
       连续失败几次就直接结束响应，让浏览器显示「预览已停止」，别再空转烧 CPU。 */
    PV.fails = Date.now() - PV.startedAt < 1200 ? (PV.fails || 0) + 1 : 0;
    if (PV.fails >= 4) {
      for (const c of PV.clients) { try { c.res.end(); } catch (e) {} }
      PV.clients.clear();
      PV.fails = 0;
      return;
    }
    /* --time-limit 最长 180s（系统硬限），到点必然断一次，断流空窗越短越好：
       正常结束立刻重起；起不来（待机/掉线）才慢一点，免得狂刷 adb。
       App 通道在线时不重起（pvStart 里也会挡一道）——电视端只允许一路采集。 */
    if (PV.src === 'app') return;
    setTimeout(() => pvStart(), PV.fails ? 1500 : 80);
  });
}

/** 一个浏览器接上：先补发参数集，第二个观众才不会等下一个关键帧 */
function pvAttach(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Preview': PV.src === 'app' && PV.appSize ? PV.appSize : PV.size,
  });
  // 每帧就几 KB，攒包只会白加延迟
  try { res.socket.setNoDelay(true); } catch (e) {}
  const client = { res };
  PV.clients.add(client);
    if (PV.src === 'app') {
    /* 只要有人在就看就发 R（不看是不是「第一个」）。
       踩过的坑：以前写成 size === 1，结果一旦有一条没关干净的连接占着数，
       新观众进来 size 变成 2，R 就发不出去，电视一直停在「没人看」的
       暂停态——表现为打开预览一片黑、怎么按都不出画面。R 是幂等的，
       多发一次只是让电视重新挂一下虚拟显示，成本可以忽略。 */
    if (PV.clients.size >= 1) castSend('R');
    /* App 通道：编码器在电视上跑着，不用起 screenrecord。
       这里**只补一个 IDR**（不是整段 GOP）——锁 30fps 之后一个 GOP 有 30 帧，
       全补过去浏览器要连续解 30 帧，画面会「快进」一秒才追上，白添几百毫秒。
       补一个 IDR 让人立刻有画面（最多旧 1 秒），紧接着向电视要最新关键帧，
       几十毫秒后就是当前画面了。screenrecord 那一路才需要整段补，
       因为它的关键帧可能 24 秒才来一个。 */
    if (PV.gop.length && !PV.gopBroken) {
      if (PV.sps && PV.pps) {
        pvSend(client, Buffer.concat([Buffer.from([0, 0, 0, 1]), PV.sps, Buffer.from([0, 0, 0, 1]), PV.pps]));
      }
      pvSend(client, PV.gop[0]);
      /* 同一个关键帧再补两枪（250ms / 700ms）。
         手机硬解常把 configure 之后的第一帧吃掉（有输入没输出、不报错），
         而静止画面又没有下一帧来救——这就是「打开预览一直黑，按一下键才
         出图」的由来。补发让解码器有第二次机会；一帧几十 KB，局域网无感。 */
      for (const ms of [250, 700]) {
        setTimeout(() => {
          if (!PV.clients.has(client) || PV.gopBroken || !PV.gop.length) return;
          pvSend(client, PV.gop[0]);
        }, ms);
      }
    }
    castRequestKey();
  } else if (PV.clients.size === 1) {
    pvStart();
  } else if (PV.gop.length && !PV.gopBroken) {
    /* 有人在看的时候又来了一个：把「上一个 IDR 起的整段帧」补给他，
       他能立刻解到当前画面（详见 pvCacheGop 的注释）。先给参数集，
       有些解码器要求 SPS/PPS 先于 IDR 出现。 */
    if (PV.sps && PV.pps) {
      pvSend(client, Buffer.concat([Buffer.from([0, 0, 0, 1]), PV.sps, Buffer.from([0, 0, 0, 1]), PV.pps]));
    }
    for (const au of PV.gop) pvSend(client, au);
  } else {
    /* 缓存不可用（超过 3MB 被清掉了，或者这一路刚开始还没有 IDR）：
       只能把编码会话重开一次，让所有人 450ms 内都拿到新的 [SPS/PPS/IDR]。 */
    pvKickSession();
  }

  let done = false;
  const bye = () => {
    if (done) return;
    done = true;
    PV.clients.delete(client);
    if (!PV.clients.size) {
      pvStop();                          // screenrecord 那一路：立刻杀掉
      /* App 那一路**不发 P**（试过，已回滚）：反复摘挂虚拟显示的 Surface 会把
         编码器输入源的补帧机制打坏——第一次恢复还正常，几轮之后就只剩
         「接上时突发出一串帧、然后死掉」，只能靠看门狗不停重建。
         而硬件编码器空转 848x480@30fps 的开销很小（几个百分点），
         完全不值得为省它引入这个状态机。App 源在这里什么都不用做。 */
    }
  };
  req.on('close', bye);
  req.on('aborted', bye);
  res.on('error', bye);
  res.on('close', bye);
}

/* 重开编码会话（拿一个新的 IDR）。合并 250ms 内的多次请求：
   手机上「切前台 + 点开关」可能同时触发两次 attach，不合并会连着重启两遍。 */
function pvKickSession() {
  if (PV.kickT) return;
  PV.kickT = setTimeout(() => {
    PV.kickT = null;
    if (!PV.clients.size) return;
    if (PV.src === 'app') { castRequestKey(); return; }
    PV.fails = 0;                 // 主动重开不算「起不来」
    pvStop();                     // child 的 close 回调会在 80ms 后自动 pvStart()
  }, 250);
}

/* 采集源换人了（比如电视端 App 连上/掉线）：分辨率、profile 可能全变，
   浏览器那头的解码器是按旧参数配好的，继续喂会直接报错。
   发一个「类型 3」的空帧通知它重建解码器，不用断开连接。 */
function pvResetAll() {
  for (const c of PV.clients) {
    try { c.res.write(Buffer.from([3, 0, 0, 0, 0])); } catch (e) {}
  }
}

/* ================== 电视端 App 直连通道 ==================
 *
 * screenrecord 那条路有两个解不开的结：① 必须有 ADB（电视关掉 ADB 调试就
 * 整条断掉，只能走索尼 IP 控制，但那时没有预览）；② 关键帧间隔由系统说了算
 * （实测能到 24 秒），这是「打开预览黑屏」「某些区域按方向键画面不刷新」的根源。
 *
 * 解法是让电视自己推流：flowrec.apk 用 MediaProjection 采集 + MediaCodec 编码，
 * 主动连到本服务的 CAST_PORT。于是——
 *   · 不依赖 ADB，**IP 控制模式下照样有实时预览**；
 *   · 关键帧间隔我们自己定（1 秒），还能随时下发「立刻给个关键帧」；
 *   · 省掉 adb exec-out 那一层，延迟更低。
 * App 在线时优先用它；掉线自动退回 screenrecord（需要 ADB）。
 *
 * 协议（TCP，电视主动连过来）：
 *   电视 → 服务：第一行  `TVCAST1 <token> <宽>x<高>\n`
 *   电视 → 服务：`[4 字节大端长度][一个 Annex-B access unit]` ……
 *   服务 → 电视：`K\n` = 立刻要一个关键帧（新观众接上时发）
 */
const CAST_PORT = Number(process.env.CAST_PORT || 8790);
const CAST_TOKEN = process.env.CAST_TOKEN || CFG.token || '';

function castRequestKey() {
  if (!PV.app) return;
  try { PV.app.write('K\n'); } catch (e) { /* 写不进去就算了，下一个 IDR 自己会来 */ }
}

/* 电视一直在编码就一直在烧 CPU（screenrecord 那条路实测要 1.7 核）。
   没人看的时候让 App 把虚拟显示撤掉，有人接上再挂回去。 */
function castSend(cmd) {
  if (!PV.app) return;
  console.log('  [cast] -> ' + cmd + ' (clients=' + PV.clients.size + ' src=' + PV.src + ')');
  try { PV.app.write(cmd + '\n'); } catch (e) {}
}

/* 看门狗：**有人在看，电视那头却不出帧** —— 直接把采集挂回去并要一个关键帧。
   为什么会这样：虚拟显示偶尔会自己停（电视进屏保、系统收回、App 被省电策略掐一下），
   而服务端这边「观众」还在，没人会再去发 R。没有这条兜底，表现就是
   「预览突然定住，怎么按都不动，要重新开关一次才好」。 */
setInterval(() => {
  if (PV.src !== 'app' || !PV.app || !PV.clients.size) return;
  /* 注意 lastFrameAt 可能是 0（服务刚起、一帧都还没来过），那种情况也要救，
     所以判据用「连上之后一直没帧」而不是「上一帧很旧」。 */
  if (Date.now() - PV.lastFrameAt > 1500) {
    PV.lastFrameAt = Date.now();          // 别一秒刷十次
    castSend('R');
    castRequestKey();
  }
}, 1500);

function castSplitAu(au) {
  /* 把 access unit 拆成 NAL：起始码可能是 00 00 01 也可能是 00 00 00 01 */
  const list = [];
  let i = 0;
  while (i + 3 < au.length) {
    if (au[i] !== 0 || au[i + 1] !== 0) { i++; continue; }
    const sc = (au[i + 2] === 1) ? 3 : (au[i + 2] === 0 && au[i + 3] === 1 ? 4 : 0);
    if (!sc) { i++; continue; }
    const s = i + sc;
    let e = -1;
    for (let j = s; j + 2 < au.length; j++) {
      if (au[j] === 0 && au[j + 1] === 0 && (au[j + 2] === 1 || (j + 3 < au.length && au[j + 2] === 0 && au[j + 3] === 1))) { e = j; break; }
    }
    if (e < 0) e = au.length;
    while (e > s && au[e - 1] === 0) e--;
    if (e > s) list.push(au.subarray(s, e));
    i = e;
  }
  return list;
}

function castFrame(au) {
  const nalus = castSplitAu(au);
  if (!nalus.length) return;
  /* SPS：跟 screenrecord 那条路一样，虚拟显示出来的是全范围 YUV，
     编码器却在 SPS 里标成 limited —— 不纠正暗部会压黑一档。 */
  const list = nalus.map((n) => {
    if ((n[0] & 0x1f) === 7) {
      const sps = PV.rangeFix ? fixSpsRange(n).sps : n;
      PV.sps = sps;
      return sps;
    }
    if ((n[0] & 0x1f) === 8) PV.pps = n;
    return n;
  });
  /* 之后就和 screenrecord 那条路完全一样：广播 + GOP 缓存，浏览器端不用改 */
  pvBroadcast(list);
}

function castAccept(sock) {
  sock.setNoDelay(true);
  let hello = Buffer.alloc(0);
  let ready = false;
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    if (!ready) {
      hello = hello.length ? Buffer.concat([hello, d]) : d;
      const i = hello.indexOf(0x0a);
      if (i < 0) return;
      const line = hello.subarray(0, i).toString('utf8').trim();
      buf = hello.subarray(i + 1);
      hello = Buffer.alloc(0);
      const m = /^TVCAST1\s+(\S*)\s+(\d+)x(\d+)$/.exec(line);
      if (!m) { try { sock.destroy(); } catch (e) {} return; }
      if (CAST_TOKEN && m[1] !== CAST_TOKEN) {
        PV.appFail = 'token 不对';
        try { sock.destroy(); } catch (e) {}
        return;
      }
      PV.app = sock;
      PV.appSize = m[2] + 'x' + m[3];
      PV.appAt = Date.now();
      PV.appFail = '';
      /* 只能有一个采集源：App 上来了就把 screenrecord 停掉（Android 上
         同时只允许一路 MediaProjection，硬起会失败）。 */
      if (PV.src !== 'app') {
        const had = PV.clients.size > 0;
        PV.src = 'app';
        pvStop();
        if (had) pvResetAll();     // 让浏览器按新尺寸重新配解码器
      }
      console.log('  [cast] 电视端 App 已连接：' + PV.appSize + '（预览改走 App 通道）');
      ready = true;
      castRequestKey();
      return;
    }
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len <= 0 || len > 8 * 1024 * 1024) { try { sock.destroy(); } catch (e) {} return; }
      if (buf.length < 4 + len) break;
      castFrame(Buffer.from(buf.subarray(4, 4 + len)));
      buf = buf.subarray(4 + len);
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => {
    if (PV.app === sock) {
      PV.app = null;
      PV.appSize = '';
      console.log('  [cast] 电视端 App 断开，预览退回 screenrecord（需要 ADB）');
      if (PV.src === 'app') {
        PV.src = '';
        /* 还有人在看 → 立刻起 screenrecord 顶上；没人看就算了 */
        if (PV.clients.size) { pvResetAll(); pvStart(); }
      }
    }
  });
}

function startCastServer() {
  if (!CAST_PORT) { console.log('  cast:   已关闭（CAST_PORT=0）'); return; }
  const srv = net.createServer((sock) => castAccept(sock));
  srv.on('error', (e) => {
    console.log('  [cast] 监听 ' + CAST_PORT + ' 失败：' + (e && e.message));
  });
  srv.listen(CAST_PORT, '0.0.0.0', () => {
    console.log('  cast:   电视端 App 通道已开 :' + CAST_PORT + '（ADB 关掉时也能预览）');
  });
}

/* ================= 当前播放内容（黑屏时给用户看的标题）=================
 *
 * 三个来源，按可靠性依次退：
 *   1. MediaSession 元数据 —— 第三方播放器（爱奇艺/腾讯/TVBox…）一般会写标题；
 *   2. 索尼自带播放器不写元数据，只能从 Activity 的 Intent 里取文件名；
 *      （试过 /sony/avContent getPlayingContentInfo：配了 PSK 也返回
 *        [7] Illegal State，对 App 播放无效，这条路走不通）
 *   3. 都拿不到就只报应用名，界面显示「正在播放」+ 应用名。
 */
const NP = { at: 0, data: null };

function npSessions(txt) {
  const list = [];
  let cur = null;
  for (const line of txt.split('\n')) {
    const m = /^ {4}(\S+)\s+(\S+)\/(\S+)\s+\(userId=/.exec(line);
    if (m) {
      cur = { tag: m[1], pkg: m[2], state: 0, title: '' };
      list.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^ {6}package=/.test(line)) {
      const v = line.split('=')[1].trim();
      if (v) cur.pkg = v;
    }
    const st = /^ {6}state=PlaybackState \{state=(\d+)/.exec(line);
    if (st) cur.state = Number(st[1]);
    const md = /^ {6}metadata: size=\d+, description=(.*)$/.exec(line);
    if (md) {
      // description 里是「标题, 副标题, 描述」，null 表示没填
      const parts = md[1].split(/\s*,\s*|\s*\|\s*/).map((s) => s.trim()).filter((s) => s && s !== 'null');
      if (parts.length) cur.title = parts[0];
    }
  }
  return list;
}

function npFileName(dat) {
  try {
    const u = new URL(dat);
    const base = decodeURIComponent((u.pathname || '').split('/').filter(Boolean).pop() || '');
    return base.replace(/\.(mp4|mkv|avi|mov|ts|m2ts|webm|flv|rmvb|wmv|mpg|mpeg)$/i, '');
  } catch (e) { return ''; }
}

async function nowPlaying() {
  if (NP.data && Date.now() - NP.at < 1500) return NP.data;
  const out = { playing: false, title: '', app: '', appLabel: '', src: '' };

  if (!adbIsDown() && (await adbPortOpen())) {
    // 一次 adb 往返拿三样东西：前台 Activity、带 data 的 Intent、媒体会话。
    // 注意 \r：adb shell 的输出是 CRLF，不剥掉后面所有按行解析都会失灵（踩过）。
    const r = await devRetry(['shell',
      'echo @R; dumpsys activity activities | grep -m1 ResumedActivity; '
      + "echo @I; dumpsys activity activities | grep -E 'intent=.*dat=' | head -8; "
      + 'echo @M; dumpsys media_session'], 8000);
    const txt = String(r.stdout || '').replace(/\r/g, '');
    const seg = (tag, next) => {
      const a = txt.indexOf('@' + tag + '\n');
      if (a < 0) return '';
      const b = next ? txt.indexOf('@' + next + '\n', a + 1) : txt.length;
      return txt.slice(a + tag.length + 2, b < 0 ? txt.length : b);
    };

    const pm = /ResumedActivity:.*?u0\s+([\w.]+)\/([\w.$]+)/.exec(seg('R', 'I'));
    if (pm) {
      out.app = pm[1];
      out.appLabel = appName(pm[1]);
    }

    const sessions = npSessions(seg('M', ''));
    const playing = sessions.filter((s) => s.state === 3);
    out.playing = playing.length > 0;

    const withTitle = playing.find((s) => s.title);
    if (withTitle) {
      out.title = withTitle.title;
      out.src = 'session';
      if (!out.app) {
        out.app = withTitle.pkg;
        out.appLabel = appName(withTitle.pkg);
      }
    } else if (out.playing) {
      /* 索尼自带播放器不写 MediaSession 元数据，只能退到 Intent 里的文件路径；
         只取「cmp 就是前台这个应用」的那条，否则历史任务里的旧 uri 会串味。
         （也试过 /proc/<pid>/fd：Android 12 上 shell 读不到别的 uid 的 fd） */
      const lines = seg('I', 'M').split('\n').filter(Boolean);
      const mine = lines.find((l) => out.app && l.indexOf('cmp=' + out.app + '/') >= 0)
        || (lines.length === 1 ? lines[0] : '');
      const dm = /dat=(\S+)/.exec(mine || '');
      if (dm) {
        const name = npFileName(dm[1]);
        if (name) { out.title = name; out.src = 'intent'; }
      }
    }
  }

  NP.at = Date.now();
  NP.data = out;
  return out;
}

function sendJSON(res, data, code) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}

function readJSON(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
  });
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(Buffer.alloc(0)); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

function authorized(req, url) {
  if (!CFG.token) return true;
  const t = req.headers['x-token'] || url.searchParams.get('t') || '';
  return String(t) === CFG.token;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // 页面本身不含敏感信息，允许直接打开（接口仍需 token）
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(HTML_FILE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        /* no-store + 版本头：curl -I 就能看出送达的是哪一版，不用翻浏览器 */
        'Cache-Control': 'no-store, must-revalidate',
        'Pragma': 'no-cache',
        'X-App-Ver': appVer(),
      });
      return res.end(html);
    }

    // 静态文件（图标 / 调试页），限制在 public 目录内
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const root = path.resolve(__dirname, 'public');
      const file = path.resolve(root, rel || 'index.html');
      if (file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        const type = ext === '.html' ? 'text/html; charset=utf-8'
          : ext === '.json' ? 'application/json; charset=utf-8'
          : ext === '.svg' ? 'image/svg+xml'
          : ext === '.png' ? 'image/png'
          : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(file));
      }
    }

    // 健康检查不鉴权，供 Docker HEALTHCHECK 使用
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJSON(res, {
        ok: true, tv: SERIAL,
        /* 界面版本 + 内容哈希 + 进程启动时间：和本地对不上就说明 NAS 跑的是旧镜像，
           进程启动时间很新但版本仍旧 → 说明新容器根本没起来（端口被旧容器占着） */
        ver: appVer(), ui: uiHash(), started: STARTED,
        /* 实时预览必须走 HTTPS（WebCodecs 只在安全上下文暴露），这个字段告诉前端
           该往哪个端口跳；0 = 这台的 HTTPS 没起来，那就只能靠 localhost 或反代。 */
        httpsPort: HTTPS_LISTENING,
        up: Math.round(process.uptime()) + 's',
        /* 预览链路出口：fps / kbps 是服务端实际推给浏览器的量，
           queue 是还没写进内核的字节（持续不归零 = 手机那头收得慢），
           backpressure 是 res.write 顶到上限的累计次数（0 最好）。 */
        /* 采集源：app = 电视端 App 直连（不依赖 ADB），adb = screenrecord */
        pvSrc: PV.src || (PV.child ? 'adb' : ''),
        pvApp: PV.src === 'app' ? { size: PV.appSize, up: Math.round((Date.now() - PV.appAt) / 1000) } : null,
        pv: PV.clients.size
          ? Object.assign({
            clients: PV.clients.size,
            size: PV.src === 'app' && PV.appSize ? PV.appSize : PV.size,
            /* 新观众靠这段缓存补帧（见 pvCacheGop）。broken=1 说明缓存被清空，
               下一个观众要等一次会话重开。 */
            gopFrames: PV.gop.length,
            gopKB: Math.round(PV.gopBytes / 1024),
            gopBroken: PV.gopBroken ? 1 : 0,
          }, pvStatNow())
          : null,
      });
    }

    if (!authorized(req, url)) return sendJSON(res, { ok: false, msg: 'unauthorized', needToken: true }, 401);

    /* 重开一次编码会话。用来救「画面定住」：screenrecord 的关键帧间隔实测能到
       几十秒，客户端一旦错过那一帧（解码失败 / 参考链断），就再也等不到 IDR，
       画面永远停在旧内容上——首页最近应用那种只变一两个小方块的地方最容易中。
       重开以后第一件事就是 SPS/PPS/IDR，浏览器端解码器遇到 IDR 会自己重新同步，
       所以不需要断开连接，最多闪半秒。 */
    if (req.method === 'POST' && url.pathname === '/api/preview/kick') {
      if (!PV.clients.size) return sendJSON(res, { ok: false, msg: '没有在看的客户端' });
      /* App 通道重开不了编码会话：编码器在电视上常驻，`pvStart()` 见
         src==='app' 会直接返回——以前这里等于什么都没做，前端「一直没画面
         就自救」的两道看门狗在 App 通道上是失效的。现在改成：把缓存里的
         关键帧重发一遍（解码器吃掉的帧就有第二次机会）+ 向电视再要一个。 */
      if (PV.src === 'app') {
        const resent = pvResendKey();
        castRequestKey();
        return sendJSON(res, { ok: true, clients: PV.clients.size, resent: resent ? 1 : 0 });
      }
      pvStop();
      pvStart();
      return sendJSON(res, { ok: true, clients: PV.clients.size });
    }

    /* 部署后重启进程。compose 里是 restart: unless-stopped，进程一退出就会被
       立刻拉起来，所以传完 server.js 打一条这个接口就完成部署，不用再去
       Container Manager 点「重启」（以前每次都要麻烦人点一下）。
       先回响应再退出，免得 curl 拿到的是连接重置。 */
    if (req.method === 'POST' && url.pathname === '/api/admin/restart') {
      sendJSON(res, { ok: true, msg: '进程重启中，约 3 秒后恢复', ver: appVer() });
      setTimeout(() => process.exit(0), 400);
      return;
    }

    if (req.method === 'GET') {
      if (url.pathname === '/api/status') return sendJSON(res, await getStatus());
      if (url.pathname === '/api/nowplaying') return sendJSON(res, await nowPlaying());
      // 长连接：H.264 裸流一直往外写，直到浏览器断开（关掉预览开关就断开）
      if (url.pathname === '/api/preview') return pvAttach(req, res);
      if (url.pathname === '/api/apps') return sendJSON(res, await listApps(url.searchParams.get('refresh') === '1'));
      // 电视 own给的应用图标（IP 通道拿到的应用列表用）。只代理电视自己的地址，
      // 顺带替手机绕开跨域——别写成任意 URL 代理，那样等于开了个中转站
      if (url.pathname === '/api/ipicon') {
        let href = '';
        try { href = Buffer.from(url.searchParams.get('u') || '', 'base64').toString('utf8'); } catch (e) {}
        let u = null, ok = false;
        try {
          u = new URL(href);
          ok = /^https?:$/.test(u.protocol) && u.hostname === SONY.host;
        } catch (e) {}
        if (!ok) return sendJSON(res, { ok: false, msg: '图标地址不合法' }, 400);
        /* 两个「电视直播」优先返回自绘图标（见 ICON_OVERRIDES 处的注释）。
           DIAL 图标 URL 里带包名，从这里能认出来。 */
        const pkgGuess = /\/icon\/([\w.]+)\.png$/.exec(u.pathname);
        if (pkgGuess) {
          const ov = iconOverride(pkgGuess[1]);
          if (ov) {
            res.writeHead(200, { 'Content-Type': ov.type, 'Cache-Control': 'public, max-age=86400' });
            return res.end(ov.data);
          }
        }
        const mod = u.protocol === 'https:' ? require('https') : http;
        try {
          const data = await new Promise((resolve, reject) => {
            const req2 = mod.get(u.href, (r2) => {
              if (r2.statusCode !== 200) return reject(new Error('HTTP ' + r2.statusCode));
              const bufs = [];
              r2.on('data', (c) => bufs.push(c));
              r2.on('end', () => resolve(Buffer.concat(bufs)));
              r2.on('error', reject);
            });
            req2.on('error', reject);
            req2.setTimeout(6000, () => { req2.destroy(new Error('timeout')); });
          });
          const type = u.pathname.match(/\.(\w+)$/) ? 'image/' + u.pathname.match(/\.(\w+)$/)[1].toLowerCase() : 'image/png';
          res.writeHead(200, { 'Content-Type': type === 'image/svg' ? 'image/svg+xml' : type, 'Cache-Control': 'public, max-age=86400' });
          return res.end(data);
        } catch (e) {
          res.writeHead(404, { 'Content-Type': 'image/svg+xml' });
          return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
        }
      }
      // 应用图标（懒加载 + 缓存，路径 /api/icon/<包名>）
      const iconM = /^\/api\/icon\/([A-Za-z][\w.]*)$/.exec(url.pathname);
      if (iconM) {
        const pkg = iconM[1];
        const hit = await getIcon(pkg);
        if (!hit) {
          res.writeHead(404, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
          return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
        }
        res.writeHead(200, {
          'Content-Type': hit.type,
          'Cache-Control': 'public, max-age=86400',
          'Content-Length': hit.data.length,
        });
        return res.end(hit.data);
      }
    }

    if (req.method === 'POST') {
      // 原始音频上传（不能走 readJSON，否则二进制会被破坏）
      if (url.pathname === '/api/asr') {
        const buf = await readBody(req, 20 * 1024 * 1024);
        return sendJSON(res, await asrTranscribe(buf, req.headers['content-type']));
      }
      const body = await readJSON(req);
      if (url.pathname === '/api/key') return sendJSON(res, await sendKey(body.code));
      if (url.pathname === '/api/text') return sendJSON(res, await sendText(body.text));
      if (url.pathname === '/api/search') return sendJSON(res, await searchTV(body.q || body.text));
      if (url.pathname === '/api/app') return sendJSON(res, await launchApp(body.pkg, body.act, body.uri, body.label));
      if (url.pathname === '/api/settings') return sendJSON(res, await openSettings());
      // 连列表都问不出来时的兜底：让电视自己把应用面板（抽屉）弹出来
      if (url.pathname === '/api/appdrawer') return sendJSON(res, await ipAppDrawer());
      if (url.pathname === '/api/connect') return sendJSON(res, { ok: true, msg: await connect() });
      if (url.pathname === '/api/ime/install') return sendJSON(res, await imeInstall());
      if (url.pathname === '/api/ime/activate') return sendJSON(res, await imeActivate());
      if (url.pathname === '/api/ime/restore') return sendJSON(res, await imeRestore());
    }
    sendJSON(res, { ok: false, msg: 'not found' }, 404);
  } catch (e) {
    sendJSON(res, { ok: false, msg: String((e && e.message) || e) }, 500);
  }
});

server.on('clientError', (err, socket) => { try { socket.destroy(); } catch (e) {} });

function lanIPs() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) list.push({ name, ip: a.address });
    }
  }
  return list;
}

/* 端口被占用时 Node 默认只吐一段 EADDRINUSE 堆栈，很容易被当成"没事"。
   这个场景在群晖上特别常见：重建镜像后新容器起不来（8787 还被上一个容器占着），
   浏览器继续打到旧容器，表现就是"重建了但界面一点没变"。这里把话说明白。 */
server.on('error', (e) => {
  const port = CFG.port;
  if (e && e.code === 'EADDRINUSE') {
    console.error('');
    console.error('  × 端口 ' + port + ' 已被占用，本容器没起来。');
    console.error('    群晖上最常见的原因：还有一个旧的 tv-remote 容器在跑，');
    console.error('    host 网络模式下新容器抢不到端口就直接退出，浏览器仍然连着旧容器。');
    console.error('');
    console.error('    处理（SSH 进 NAS）：');
    console.error('      docker ps --format "table {{.Names}}\\t{{.Image}}\\t{{.Status}}"');
    console.error('      docker compose down --remove-orphans');
    console.error('      docker compose up -d --build');
    console.error('      curl -s http://127.0.0.1:' + port + '/api/health');
    console.error('');
  } else {
    console.error('  × 服务启动失败：' + (e && e.message));
  }
  process.exit(1);
});

/* ── HTTPS（实时预览的前置条件）────────────────────────────────────────────
 * 浏览器只把「安全上下文」里的 WebCodecs 暴露出来：http://127.0.0.1 和 localhost 算
 * 安全，http://192.168.x.x 不算 —— 实测 Edge 156 与 Chrome 155 在这个地址下
 * window.VideoDecoder 都是 undefined（EncodedVideoChunk 反而存在，所以只看它不会报错）。
 * 于是遥控、应用列表这些用 HTTP 一点问题没有，唯独预览整块消失。
 *
 * 解决办法不是换浏览器，而是给同一份服务再挂一路 HTTPS：自签证书，浏览器会拦一次，
 * 点「高级 → 继续前往」之后 origin 变成 https，VideoDecoder 立刻回来（已实测）。
 * 证书放在 DATA_DIR/cert 里持久化，IP 变了或快过期时自动重签。
 */
function certIpSet() {
  const set = new Set(['127.0.0.1']);
  for (const n of lanIPs()) set.add(n.ip);
  return [...set];
}

function ensureCert() {
  const dir = path.join(CFG.dataDir, 'cert');
  const keyFile = path.join(dir, 'key.pem');
  const crtFile = path.join(dir, 'cert.pem');
  const ips = certIpSet();
  if (fs.existsSync(keyFile) && fs.existsSync(crtFile)) {
    try {
      const x = new crypto.X509Certificate(fs.readFileSync(crtFile));
      const san = x.subjectAltName || '';
      const miss = ips.filter((ip) => san.indexOf('IP Address:' + ip) < 0);
      const days = (new Date(x.validTo).getTime() - Date.now()) / 86400000;
      if (!miss.length && days > 7) {
        return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(crtFile), reused: true };
      }
      console.log('  HTTPS:  证书' + (miss.length ? ' 缺这些地址 ' + miss.join(',') : ' 快过期了') + '，重签一张');
    } catch (e) { /* 文件坏了就当没有，重新签 */ }
  }
  fs.mkdirSync(dir, { recursive: true });
  const alt = ips.map((ip) => 'IP:' + ip).concat('DNS:localhost').join(',');
  /* 397 天：超过 398 天的话，即使把证书导入系统信任库，Chrome/Edge 也会判
     ERR_CERT_VALIDITY_TOO_LONG。到期前 7 天会在下次重启时自动重签。 */
  const r = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', crtFile,
    '-days', '397', '-subj', '/CN=tv-remote',
    '-addext', 'subjectAltName=' + alt,
  ], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(r.error ? '找不到 openssl 命令' : String(r.stderr || '').trim().split('\n').pop());
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(crtFile), reused: false };
}

/* 真正在监听才报这个端口：前端拿它拼「改用 HTTPS 打开」的地址，
   报一个没起来的端口等于把人往墙上引。 */
let HTTPS_LISTENING = 0;

function startHttps() {
  if (!CFG.httpsPort) {
    console.log('  HTTPS:  已关闭（HTTPS_PORT=0），实时预览将只在 localhost 下可用');
    return;
  }
  let c;
  try { c = ensureCert(); } catch (e) {
    console.log('  HTTPS:  未启用（' + ((e && e.message) || e) + '）');
    console.log('          实时预览需要 HTTPS：给镜像装上 openssl，或把 8789 之类端口留给 HTTPS_PORT');
    return;
  }
  /* 复用 HTTP 那台的请求处理器（http.createServer(fn) 就是把 fn 挂到 'request' 事件上），
     路由只有一份，两条通道不会出现行为不一致。 */
  const srv = https.createServer({ key: c.key, cert: c.cert }, server.listeners('request')[0]);
  srv.on('error', (e) => {
    console.log('  HTTPS:  未启用（端口 ' + CFG.httpsPort + ' ' + ((e && e.code) || 'err') + '）');
    if (e && e.code === 'EADDRINUSE') console.log('          换个端口：环境变量 HTTPS_PORT=8789');
  });
  srv.listen(CFG.httpsPort, '0.0.0.0', () => {
    HTTPS_LISTENING = CFG.httpsPort;
    for (const n of lanIPs()) {
      console.log('  预览:   https://' + n.ip + ':' + CFG.httpsPort
        + (c.reused ? '' : '  ← 新签的证书'));
    }
    console.log('          实时预览必须走 https（WebCodecs 只在安全上下文可用）；');
    console.log('          证书是自签的，首次打开点「高级 → 继续前往 <IP>」即可。');
  });
}

server.listen(CFG.port, '0.0.0.0', async () => {
  console.log('');
  console.log('  电视遥控服务已启动');
  console.log('  电视:   ' + SERIAL);
  console.log('  界面:   ' + appVer() + ' / ' + uiHash());
  console.log('  鉴权:   ' + (CFG.token ? '已开启（URL 后加 ?t=你的令牌）' : '未开启'));
  for (const n of lanIPs()) console.log('  访问:   http://' + n.ip + ':' + CFG.port);
  startHttps();
  {
    const m = /^(\d+)x(\d+)$/.exec(PV.size);
    const warn = !m ? '格式不对，应该是 848x480 这样' : (
      (+m[1] % 16) || (+m[2] % 16)
        ? '宽高不是 16 的倍数，电视会补出绿边（854x480 就有 16 行绿条）'
        : ''
    );
    if (warn) console.log('  预览:   ' + PV.size + ' —— ' + warn);
  }
  startCastServer();
  console.log('');
  try {
    console.log('  连接中… ' + (await connect()));
    const st = await getStatus();
    console.log('  状态:   ' + st.model + ' · ' + st.awake);
    console.log('  输入法: ' + (st.ime.active ? 'ADBKeyboard 已启用' : st.ime.installed ? '已安装未启用' : '未安装（中文输入需安装）'));
  } catch (e) {
    console.log('  连接失败: ' + ((e && e.message) || e));
  }
  console.log('');
});

process.on('SIGINT', () => { pvStop(); process.exit(0); });
process.on('SIGTERM', () => { pvStop(); process.exit(0); });
process.on('exit', () => { pvStop(); });
