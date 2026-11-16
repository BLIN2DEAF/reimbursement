// 启动前检查（由 start.bat / 2-启动系统.bat 调用）。
// 用普通 Node 脚本代替 PowerShell：批处理里调用隐藏窗口的 PowerShell、绕过执行策略
// 是木马常见写法，会被杀毒软件（如火绒）误报并删除启动脚本。
//
// 退出码：0 = 端口空闲，可以启动；10 = 本服务已在运行；
//        22 = 端口被其他程序占用；23/24 = 本项目残留进程无法清理；
//        30 = Node 版本低于 20.6（批处理改用 npm start）。

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pidFilePath = path.join(projectRoot, 'sessions', '.server.pid');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 6)) process.exit(30);

function readEnv() {
  let host = '127.0.0.1';
  let port = 8080;
  try {
    for (const line of fs.readFileSync(path.join(projectRoot, '.env'), 'utf8').split(/\r?\n/)) {
      const hostMatch = line.match(/^\s*HOST\s*=\s*["']?([^\s#"']+)/);
      const portMatch = line.match(/^\s*PORT\s*=\s*["']?(\d+)/);
      if (hostMatch) host = hostMatch[1];
      if (portMatch) port = Number(portMatch[1]);
    }
  } catch {}
  return { host, port };
}

const { host, port } = readEnv();
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.log(`[ERROR] Invalid PORT in .env: ${port}`);
  process.exit(20);
}
const anyHost = ['0.0.0.0', '::', '[::]'].includes(host);
const probeHost = anyHost ? '127.0.0.1' : host;
const baseUrl = `http://${probeHost}:${port}`;

// Windows 的端口列表不可靠：被结束的进程可能留下 PID 0 的“幽灵”监听，
// 某些系统版本又会把真实监听的状态显示为空。实际绑定一次才是准确结论。
function portIsFree() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: anyHost ? undefined : probeHost, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function isOurService() {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    const health = await response.json();
    return health?.service === 'reimbursement-automation' && health?.status === 'ok';
  } catch {
    return false;
  }
}

function removePidFile() {
  try { fs.rmSync(pidFilePath, { force: true }); } catch {}
}

function processName(pid) {
  try {
    const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const match = out.match(/^"([^"]+)","(\d+)"/m);
    return match && Number(match[2]) === pid ? match[1] : '';
  } catch {
    return '';
  }
}

function listeningPids() {
  const pids = new Set();
  try {
    const out = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[0] === 'TCP' && parts[1].endsWith(`:${port}`) && parts[3] === 'LISTENING') {
        const pid = Number(parts[4]);
        if (pid > 0) pids.add(pid);
      }
    }
  } catch {}
  return pids;
}

function recordedPid() {
  try {
    const pid = Number(JSON.parse(fs.readFileSync(pidFilePath, 'utf8')).pid);
    return pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (await portIsFree()) {
  removePidFile();
  process.exit(0);
}

if (await isOurService()) {
  console.log(`[INFO] Reimbursement service is already running at ${baseUrl}.`);
  process.exit(10);
}

// 端口被占用且健康检查失败。只有 sessions/.server.pid 里记录的、仍在运行的 node.exe
// 才视为本项目上次没退出的服务；其他程序只报告，绝不结束。
const ourPid = recordedPid();
const ourName = ourPid ? processName(ourPid) : '';
if (ourPid && ourName.toLowerCase() === 'node.exe') {
  console.log(`[INFO] Found a leftover reimbursement service from a previous run (PID ${ourPid}). Stopping it...`);
  try {
    process.kill(ourPid);
  } catch (error) {
    console.log(`[ERROR] Could not stop PID ${ourPid}: ${error.message}`);
    process.exit(23);
  }
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (await portIsFree()) {
      removePidFile();
      console.log('[INFO] Leftover service stopped. Starting a fresh one.');
      process.exit(0);
    }
  }
  console.log(`[ERROR] The leftover service was stopped but port ${port} is still busy. Try again in a few seconds.`);
  process.exit(24);
}

const others = [...listeningPids()]
  .filter((pid) => pid !== ourPid)
  .map((pid) => `${processName(pid) || 'unknown'} (PID ${pid})`);
console.log(`[ERROR] ${probeHost}:${port} is occupied by ${others.length ? others.join(', ') : 'another program'}.`);
console.log('Close that program or change PORT in .env, then run the start script again.');
process.exit(22);
