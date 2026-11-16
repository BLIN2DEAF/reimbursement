import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { WebSocketServer, WebSocket } from "ws";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";

import { config } from "./config.js";
import { attachInvoiceDetails, classifyAndRename, ClassItem } from "./file-processor.js";
import { processAllFiles, pruneVisionCache } from "./document-parser.js";
import { ReimbursementAutomation } from "./bip-automation.js";
import { mergeApprovals, mergeSubsidies } from "./trip-merge.js";
import { applyReviewEdits } from "./review-edits.js";

// ---- dir setup ----
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "..", "frontend");
const uploadDir = (sid: string) => path.resolve(config.sessionDir, sid, "uploads");

function ensureDir(d: string) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function decodeOriginalName(name: string): string {
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  return decoded.includes("�") ? name : decoded;
}
ensureDir(config.sessionDir);
ensureDir(uploadDir("_tmp"));
pruneVisionCache();

// ---- express ----
const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use("/static", express.static(frontendDir));
app.use("/files", (req, res, next) => {
  const sid = req.path.split("/").filter(Boolean)[0] || "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{3}$/i.test(sid) || !sessions[sid]) {
    return res.status(404).json({ error: "session not found" });
  }
  res.setHeader("Cache-Control", "no-store");
  next();
}, express.static(config.sessionDir));

// ---- multer ----
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir("_tmp")),
  filename: (_req, file, cb) => {
    const decoded = decodeOriginalName(file.originalname);
    cb(null, `${uuidv4()}${path.extname(decoded).toLowerCase()}`);
  },
});
const allowedExtensions = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp"]);
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => {
    const decoded = decodeOriginalName(file.originalname);
    const ext = path.extname(decoded).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      cb(new Error(`不支持的文件类型 ${ext || '(无扩展名)'}：${decoded}。仅支持 PDF/JPG/JPEG/PNG/WebP`));
      return;
    }
    cb(null, true);
  },
});

// ---- ws ----
const wss = new WebSocketServer({ server });
type SessionPhase = 'ready' | 'processing' | 'review' | 'automating' | 'complete' | 'error';
interface SessionState {
  ws?: WebSocket;
  result?: any;
  timer?: NodeJS.Timeout;
  phase: SessionPhase;
  uploadRunning?: boolean;
  automationRunning?: boolean;
  automation?: ReimbursementAutomation;
  automationCloseTimer?: NodeJS.Timeout;
  lastMessage?: any;
}
const sessions: Record<string, SessionState> = {};

function touchSession(sid: string) {
  const session = sessions[sid];
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    try { session.ws?.close(1000, "session expired"); } catch {}
    if (session.automationCloseTimer) clearTimeout(session.automationCloseTimer);
    void session.automation?.close().catch(() => {});
    delete sessions[sid];
  }, config.sessionTtlMs);
}

function sendWS(sid: string, msg: any) {
  const session = sessions[sid];
  if (!session) return;
  if (!['ready', 'ack'].includes(msg?.type)) session.lastMessage = msg;
  const ws = session.ws;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ---- API routes ----

// 启动脚本用这个固定标识区分“已有报销服务”和“8080 被其他程序占用”。
app.get("/api/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ service: "reimbursement-automation", status: "ok", pid: process.pid });
});

// Session
app.post("/api/session", (_req, res) => {
  const sid = uuidv4().slice(0, 12);
  sessions[sid] = { phase: 'ready' };
  touchSession(sid);
  ensureDir(uploadDir(sid));
  res.json({ session_id: sid });
});

// Upload + process. The lock is acquired before multer writes any temporary files,
// so reconnects/double clicks cannot start a second pipeline that overwrites result.
app.post("/api/upload/:sid", (req, res, next) => {
  const sid = req.params.sid as string;
  res.locals.sessionId = sid;
  const session = sessions[sid];
  if (!session) return res.status(404).json({ error: "session not found" });
  if (session.uploadRunning || session.automationRunning || !['ready', 'error'].includes(session.phase)) {
    return res.status(409).json({ error: "当前会话正在识别、核对或填单，不能重复上传" });
  }
  if (session.automation) {
    return res.status(409).json({ error: "当前会话已经启动过 BIP 填单，请刷新页面创建新会话" });
  }
  session.uploadRunning = true;
  session.phase = 'processing';
  session.result = undefined;
  session.lastMessage = undefined;
  touchSession(sid);
  next();
}, upload.array("files", 50), async (req, res, next) => {
  const sid = req.params.sid as string;
  const session = sessions[sid];
  if (!session) return res.status(404).json({ error: "session not found" });
  const files = req.files as Express.Multer.File[];
  if (!files?.length) {
    session.uploadRunning = false;
    session.phase = 'error';
    return res.status(400).json({ error: "没有可处理的受支持文件" });
  }

  // Move files to session upload dir
  const targetDir = uploadDir(sid);
  const saved: string[] = [];
  try {
    ensureDir(targetDir);
    for (const f of files) {
      const original = decodeOriginalName(f.originalname);
      const ext = path.extname(original);
      const stem = path.basename(original, ext).replace(/[<>:"/\\|?*]/g, "").trim() || "upload";
      let dst = path.join(targetDir, `${stem}${ext.toLowerCase()}`);
      let suffix = 1;
      while (fs.existsSync(dst)) dst = path.join(targetDir, `${stem}_${suffix++}${ext.toLowerCase()}`);
      fs.renameSync(f.path, dst);
      saved.push(dst);
    }
  } catch (err) {
    session.uploadRunning = false;
    session.phase = 'error';
    return next(err);
  }
  touchSession(sid);

  res.json({ session_id: sid, count: saved.length });

  // Process files asynchronously
  console.log('[Upload] Processing ' + saved.length + ' files for ' + sid);
  await processPipeline(sid, saved);
});

// WS endpoint
app.get("/ws/:sid", (_req, res) => {
  res.status(426).json({ error: "use websocket" });
});

// Frontend
app.get("/", (_req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const sid = res.locals.sessionId as string | undefined;
  if (sid && sessions[sid]) {
    sessions[sid].uploadRunning = false;
    sessions[sid].phase = 'error';
  }
  console.error('[HTTP] ' + (err?.message || String(err)));
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? '单个文件不能超过 50MB' : err.message });
  }
  return res.status(400).json({ error: err?.message || '服务器处理请求失败' });
});

// ---- WebSocket ----
wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const sid = url.pathname.split("/").pop() || "";
  const session = sessions[sid];
  if (!session) {
    ws.close(1008, 'invalid session');
    return;
  }
  session.ws = ws;
  touchSession(sid);
  ws.send(JSON.stringify({
    type: 'ready',
    phase: session.phase,
    canUpload: (session.phase === 'ready' || session.phase === 'error') && !session.automation,
  }));
  if (session.lastMessage) ws.send(JSON.stringify(session.lastMessage));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      touchSession(sid);
      if (msg.action === "confirm" && session.result) {
        if (session.automationRunning || session.phase !== 'review') {
          sendWS(sid, { type: "error", message: "自动填单已经在运行，请勿重复点击" });
          return;
        }
        try {
          session.result = applyReviewEdits(session.result, msg.data, { forConfirm: true });
        } catch (error: any) {
          sendWS(sid, { type: "confirm_rejected", message: "确认信息有误：" + (error?.message || String(error)) });
          return;
        }
        session.automationRunning = true;
        session.phase = 'automating';
        sendWS(sid, { type: 'accepted', message: '自动填单请求已接受' });
        sendWS(sid, { type: "progress", message: "用户已确认，开始自动填单...", percent: 85 });
        void runAutomation(sid, session.result);
      } else if (msg.action === "update_data" && msg.data && session.phase === 'review' && session.result) {
        try {
          session.result = applyReviewEdits(session.result, msg.data);
          sendWS(sid, { type: "ack", message: "数据已更新" });
        } catch (error: any) {
          sendWS(sid, { type: "confirm_rejected", message: "修改未保存：" + (error?.message || String(error)) });
        }
      }
    } catch {}
  });

  ws.on("close", () => {
    if (sessions[sid]?.ws === ws) sessions[sid].ws = undefined;
  });
});

// ---- processing pipeline ----
async function processPipeline(sid: string, filepaths: string[]) {
  try {
  console.log('[Pipeline] Starting for ' + sid + ' with ' + filepaths.length + ' files');
  filepaths.forEach((f, i) => console.log('[Pipeline] File ' + (i+1) + ': ' + f));
  sendWS(sid, { type: "progress", message: `已收到 ${filepaths.length} 个文件，开始分类...`, percent: 5 });

  const result = await processAllFiles(filepaths, (msg, pct) => {
    sendWS(sid, { type: "progress", message: msg, percent: pct });
  });

  // 单文件识别失败已由解析器转为其他凭证，随草稿的影像附件一并上传。
  // 多份审批单 / 补助单合并成一张报账单；无法自动确定的部分（如多个出差地点）在确认页提示人工修改。
  const mergedApproval = mergeApprovals(result.approvals);

  sendWS(sid, { type: "progress", message: "正在整理文件...", percent: 75 });

  // Build classification items
  const items: ClassItem[] = [];
  for (const c of result.classifications) {
    const cls = c.class;
    const fp = c.filepath;
    // 查找该文件已提取的结构化数据，注入重命名
    var extRec = result.invoices.find(function(i){ return i.filepath === fp; })
      || result.approvals.find(function(i){ return i.filepath === fp; })
      || result.subsidies.find(function(i){ return i.filepath === fp; })
      || result.taxSheets.find(function(i){ return i.filepath === fp; })
      || null;
    var approvalRec = mergedApproval.approval;
    var travelerName = approvalRec && approvalRec.travelers[0] ? approvalRec.travelers[0] : "";
    items.push({
      filename: path.basename(fp),
      filepath: fp,
      category: cls.category || "",
      subcategory: cls.type || "",
      ext: path.extname(fp),
      name: (extRec && extRec.name && extRec.name !== "未知") ? extRec.name : (travelerName || ""),
      date: (extRec && (extRec.date || extRec.start_date)) || (approvalRec && approvalRec.start_date) || "",
      amount: (extRec && extRec.amount) || 0,
    });
  }

  // Rename & organize
  const sessionDir = path.resolve(config.sessionDir, sid);
  const renamed = classifyAndRename(sessionDir, items);

  // Merge structured data
  const approval = mergedApproval.approval;
  const tax = result.taxSheets[0] || null;

  // 逐人保留实际应领金额，合计由个人明细计算；不按全体人数重算或覆盖扣减/零金额。
  const mergedSubsidy = mergeSubsidies(result.subsidies, approval?.travelers || []);
  const subsidyData = mergedSubsidy.subsidy;
  const reviewWarnings = [...mergedApproval.warnings, ...mergedSubsidy.warnings];

  // Travelers
  const travelers = approval?.travelers || [];

  // Invoice list
  // 按原始文件路径索引，供 attachInvoiceDetails 与整理后的文件一一对应。
  const invoiceListBySource = new Map<string, any>();
  for (const inv of result.invoices) {
    // 发票上无个人姓名（如住宿发票）时，用报销人姓名兜底
    var invName = inv.name || "";
    if (!invName || invName === "未知") invName = travelers[0] || invName;
    // 保留交通票的车次/航班、路线、席位等结构化字段供确认页核对，
    // 但不要把服务器上的绝对文件路径发送到浏览器。
    const { filepath: _filepath, ...invoiceDetails } = inv;
    invoiceListBySource.set(inv.filepath, {
      ...invoiceDetails,
      name: invName,
      date: inv.date || "",
      amount: inv.amount || 0,
      type: inv.type || "其他发票",
    });
  }
  const invoiceList: any[] = Array.from(invoiceListBySource.values());
  // 确认页点击发票行时预览整理后的文件。只下发相对 sessions/ 的路径，经 /files 路由读取。
  for (const items of Object.values(renamed.invoices)) {
    for (const item of items as any[]) {
      const entry = invoiceListBySource.get(item.source);
      if (entry && item.path) {
        entry.preview_path = path.relative(config.sessionDir, item.path).split(path.sep).join("/");
        entry.renamed = item.renamed;
      }
    }
  }

  attachInvoiceDetails(renamed.invoices, invoiceListBySource);

  const summaryData = {
    session_id: sid,
    invoices: renamed.invoices,
    documents: renamed.documents,
    invoice_list: invoiceList,
    approval,
    subsidy: subsidyData,
    tax,
    extraction_errors: result.errors,
    review_warnings: reviewWarnings,
    travelers,
    summary: travelers.length ? `${travelers.join("、")}报销差旅费用` : "报销差旅费用",
  };

  console.log('[Pipeline] Results - invoices: ' + result.invoices.length + ' approvals: ' + result.approvals.length + ' subsidies: ' + result.subsidies.length);
  console.log('[Pipeline] Approval data: ' + JSON.stringify(approval));
  console.log('[Pipeline] Subsidy data: ' + JSON.stringify(subsidyData));
  console.log('[Pipeline] Invoice list: ' + JSON.stringify(invoiceList));
  
  sessions[sid].result = summaryData;
  sessions[sid].uploadRunning = false;
  sessions[sid].phase = 'review';
  sendWS(sid, { type: "progress", message: "文件处理完成", percent: 80 });
  sendWS(sid, { type: "result", data: summaryData });
  } catch(e: any) {
    console.error('[Pipeline] Error: ' + e.message);
    console.error(e.stack);
    if (sessions[sid]) {
      sessions[sid].uploadRunning = false;
      sessions[sid].phase = 'error';
    }
    sendWS(sid, { type: "error", message: "处理出错: " + e.message + " (检查服务器控制台日志)" });
  }
}

async function runAutomation(sid: string, data: any) {
  const auto = new ReimbursementAutomation();
  if (sessions[sid]) sessions[sid].automation = auto;
  auto.onProgress((msg, pct) => sendWS(sid, { type: "progress", message: msg, percent: pct }));
  try {
    const report = await auto.run(data);
    if (sessions[sid]) sessions[sid].phase = 'complete';
    sendWS(sid, {
      type: "complete",
      message: "报销单填写成功",
      report,
    });
  } catch (err: any) {
    if (sessions[sid]) sessions[sid].phase = 'error';
    const holdMinutes = Math.max(0, Math.round(config.errorBrowserTtlMs / 60000));
    const holdMessage = holdMinutes > 0 ? `；故障 BIP 页面将保留约 ${holdMinutes} 分钟供检查` : '';
    sendWS(sid, { type: "error", message: `自动填单出错: ${err.message}${holdMessage}` });
  } finally {
    // 成功时保留已填好的 BIP 页面供人工复核；失败时短暂保留现场，随后自动关闭。
    if (sessions[sid]?.phase === 'error') {
      const delay = Math.max(0, config.errorBrowserTtlMs);
      if (delay === 0) {
        await auto.close().catch(() => {});
      } else {
        const session = sessions[sid];
        if (session.automationCloseTimer) clearTimeout(session.automationCloseTimer);
        session.automationCloseTimer = setTimeout(() => {
          void auto.close().catch(() => {});
          if (sessions[sid]) sessions[sid].automationCloseTimer = undefined;
        }, delay);
      }
    }
    if (sessions[sid]) sessions[sid].automationRunning = false;
  }
}

// ---- start ----
let startupErrorHandled = false;
const handleStartupError = (error: NodeJS.ErrnoException) => {
  if (startupErrorHandled) return;
  startupErrorHandled = true;
  if (error.code === "EADDRINUSE") {
    console.error(`\n  [ERROR] http://${config.host}:${config.port} is already in use.`);
    console.error("  Run start.bat to reuse an existing reimbursement service, or change PORT in .env.\n");
    process.exitCode = 1;
    return;
  }
  console.error("\n  [ERROR] Failed to start reimbursement service:", error.message);
  process.exitCode = 1;
};
server.on("error", handleStartupError);
wss.on("error", handleStartupError);

// 启动脚本据此识别“本项目上次没有退出的服务”，与其他占用端口的程序区分开。
const pidFile = path.resolve(config.sessionDir, ".server.pid");
let pidFileWritten = false;

function removePidFile() {
  if (!pidFileWritten) return;
  try {
    const recorded = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    if (recorded?.pid === process.pid) fs.rmSync(pidFile, { force: true });
  } catch {}
  pidFileWritten = false;
}

server.listen(config.port, config.host, () => {
  try {
    fs.writeFileSync(pidFile, JSON.stringify({
      pid: process.pid,
      port: config.port,
      projectDir: path.resolve(__dirname, ".."),
      startedAt: new Date().toISOString(),
    }));
    pidFileWritten = true;
  } catch (error: any) {
    console.warn("  [WARN] 无法写入 sessions/.server.pid：" + (error?.message || String(error)));
  }
  console.log(`\n  🚀 报销自动化系统已启动`);
  console.log(`  📍 http://${config.host}:${config.port}`);
  console.log(`  ⏎ Ctrl+C 或关闭本窗口即可停止服务\n`);
  if (process.env.REIMBURSEMENT_OPEN_BROWSER === "1") openBrowser();
});

// 服务真正开始监听后再打开默认浏览器。由服务端负责，启动批处理里就不需要
// “隐藏窗口的 PowerShell 延时打开网页”这种容易被杀毒软件误报的写法。
function openBrowser() {
  const browserHost = ["0.0.0.0", "::", "[::]"].includes(config.host) ? "127.0.0.1" : config.host;
  const url = `http://${browserHost}:${config.port}`;
  try {
    const child = spawn("explorer.exe", [url], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => console.log(`  请手动在浏览器中打开 ${url}`));
    child.unref();
  } catch {
    console.log(`  请手动在浏览器中打开 ${url}`);
  }
}

// ---- shutdown ----
// 关闭窗口或 Ctrl+C 时，先关掉 Playwright 浏览器和 HTTP 服务再退出，避免残留进程继续占用端口。
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  收到 ${signal}，正在停止服务...`);
  const forceExit = setTimeout(() => {
    removePidFile();
    process.exit(0);
  }, 5000);
  forceExit.unref();

  const closing: Promise<unknown>[] = [];
  for (const session of Object.values(sessions)) {
    if (session.timer) clearTimeout(session.timer);
    if (session.automationCloseTimer) clearTimeout(session.automationCloseTimer);
    try { session.ws?.close(1001, "server shutdown"); } catch {}
    if (session.automation) closing.push(session.automation.close().catch(() => {}));
  }
  for (const client of wss.clients) {
    try { client.terminate(); } catch {}
  }
  closing.push(new Promise((resolve) => wss.close(() => resolve(undefined))));
  closing.push(new Promise((resolve) => server.close(() => resolve(undefined))));
  server.closeAllConnections?.();
  await Promise.allSettled(closing);
  removePidFile();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  process.on(signal, () => { void shutdown(signal); });
}
process.on("exit", removePidFile);


