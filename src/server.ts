import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";

import { config } from "./config.js";
import { classifyAndRename, ClassItem } from "./file-processor.js";
import { processAllFiles } from "./document-parser.js";
import { ReimbursementAutomation } from "./bip-automation.js";

// ---- dir setup ----
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "..", "frontend");
const uploadDir = (sid: string) => path.resolve(config.sessionDir, sid, "uploads");

function ensureDir(d: string) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
ensureDir(config.sessionDir);

// ---- express ----
const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use("/static", express.static(frontendDir));

// ---- multer ----
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir("_tmp")),
  filename: (_req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

// ---- ws ----
const wss = new WebSocketServer({ server });
const sessions: Record<string, { ws?: WebSocket; result?: any; timer?: NodeJS.Timeout }> = {};

function sendWS(sid: string, msg: any) {
  const ws = sessions[sid]?.ws;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ---- API routes ----

// Session
app.post("/api/session", (_req, res) => {
  const sid = uuidv4().slice(0, 12);
  sessions[sid] = {};
  ensureDir(uploadDir(sid));
  res.json({ session_id: sid });
});

// Upload + process
app.post("/api/upload/:sid", upload.array("files", 50), async (req, res) => {
  const sid = req.params.sid as string;
  const files = req.files as Express.Multer.File[];
  if (!files?.length) return res.status(400).json({ error: "no files" });

  // Move files to session upload dir
  const tmpDir = uploadDir("_tmp");
  const targetDir = uploadDir(sid);
  ensureDir(targetDir);
  const saved: string[] = [];
  for (const f of files) {
    const dst = path.join(targetDir, f.originalname);
    fs.renameSync(f.path, dst);
    saved.push(dst);
  }

  res.json({ session_id: sid, count: saved.length });

  // Process files asynchronously
  try {
    await processPipeline(sid, saved);
  } catch (err: any) {
    sendWS(sid, { type: "error", message: `处理出错: ${err.message}` });
  }
});

// WS endpoint
app.get("/ws/:sid", (_req, res) => {
  res.status(426).json({ error: "use websocket" });
});

// Frontend
app.get("/", (_req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

// ---- WebSocket ----
wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const sid = url.pathname.split("/").pop() || "";
  if (!sessions[sid]) sessions[sid] = {};
  sessions[sid].ws = ws;

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.action === "confirm" && sessions[sid]?.result) {
        sendWS(sid, { type: "progress", message: "用户已确认，开始自动填单...", percent: 85 });
        runAutomation(sid, sessions[sid].result!);
      } else if (msg.action === "update_data" && msg.data) {
        sessions[sid].result = msg.data;
        sendWS(sid, { type: "ack", message: "数据已更新" });
      }
    } catch {}
  });

  ws.on("close", () => {
    if (sessions[sid]) sessions[sid].ws = undefined;
  });
});

// ---- processing pipeline ----
async function processPipeline(sid: string, filepaths: string[]) {
  sendWS(sid, { type: "progress", message: `已收到 ${filepaths.length} 个文件，开始分类...`, percent: 5 });

  const result = await processAllFiles(filepaths, (msg, pct) => {
    sendWS(sid, { type: "progress", message: msg, percent: pct });
  });

  sendWS(sid, { type: "progress", message: "正在整理文件...", percent: 75 });

  // Build classification items
  const items: ClassItem[] = [];
  for (const c of result.classifications) {
    const cls = c.class;
    const fp = c.filepath;
    items.push({
      filename: path.basename(fp),
      filepath: fp,
      category: cls.category || "",
      subcategory: cls.type || "",
      ext: path.extname(fp),
    });
  }

  // Rename & organize
  const sessionDir = path.resolve(config.sessionDir, sid);
  const renamed = classifyAndRename(sessionDir, items);

  // Merge structured data
  const approval = result.approvals[0] || null;
  const subsidy = result.subsidies[0] || null;
  const tax = result.taxSheets[0] || null;

  // Format subsidy
  let subsidyData = null;
  if (subsidy) {
    const entries = subsidy.entries || [];
    const totalMeal = subsidy.total_meal || entries.reduce((s: number, e: any) => s + (e.days || 0) * (e.people || 1) * config.mealRate, 0);
    const totalTransport = subsidy.total_transport || entries.reduce((s: number, e: any) => s + (e.days || 0) * (e.people || 1) * config.transportRate, 0);
    subsidyData = { entries, total_meal: totalMeal, total_transport: totalTransport, total_amount: totalMeal + totalTransport };
  }

  // Travelers
  const travelers = approval?.travelers || [];

  // Invoice list
  const invoiceList: any[] = [];
  for (const inv of result.invoices) {
    invoiceList.push({
      name: inv.name || "",
      date: inv.date || "",
      amount: inv.amount || 0,
      type: inv.type || "其他发票",
    });
  }

  const summaryData = {
    session_id: sid,
    invoices: renamed.invoices,
    documents: renamed.documents,
    invoice_list: invoiceList,
    approval,
    subsidy: subsidyData,
    tax,
    travelers,
    summary: travelers.length ? `${travelers.join("、")}报销差旅费用` : "包洋报销差旅费用",
  };

  sessions[sid].result = summaryData;
  sendWS(sid, { type: "progress", message: "文件处理完成", percent: 80 });
  sendWS(sid, { type: "result", data: summaryData });
}

async function runAutomation(sid: string, data: any) {
  const auto = new ReimbursementAutomation();
  auto.onProgress((msg, pct) => sendWS(sid, { type: "progress", message: msg, percent: pct }));
  try {
    await auto.run(data);
    sendWS(sid, { type: "progress", message: "报销单填写完成", percent: 100 });
  } catch (err: any) {
    sendWS(sid, { type: "error", message: `自动填单出错: ${err.message}` });
  }
}

// ---- start ----
server.listen(config.port, () => {
  console.log(`\n  🚀 报销自动化系统已启动`);
  console.log(`  📍 http://localhost:${config.port}`);
  console.log(`  ⏎ Ctrl+C 停止服务\n`);
});

