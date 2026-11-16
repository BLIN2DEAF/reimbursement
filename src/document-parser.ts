import fs from "fs";
import os from "os";
import path from "path";
import OpenAI from "openai";
import { createRequire } from "module";
import { execFile } from "child_process";
import { createHash } from "crypto";
import { promisify } from "util";
import { config, requireVisionConfig } from "./config.js";
import { extractPdfTextLocally } from "./pdf-text.js";
import { normalizeSubsidy, reconcileSubsidyTable, SUBSIDY_EXTRACTION_PROMPT } from "./subsidy.js";

const execFileAsync = promisify(execFile);

var _client: any = null;
function getOpenAI(): any {
  if (!_client) _client = new OpenAI({
    apiKey: config.mimoApiKey,
    baseURL: config.mimoBaseUrl,
    // 视觉模型实测单次响应可达 50 多秒，多个文件同时识别时更慢；60 秒会超时导致材料转为其他附件。
    timeout: 150000,
    maxRetries: 2,
  });
  return _client;
}

var _pdfParse: any = null;
function getPdfParse(): any {
  if (!_pdfParse) { var req = createRequire(import.meta.url); _pdfParse = req("pdf-parse"); }
  return _pdfParse;
}

var _pdfJs: any = null;
function getPdfJs(): any {
  if (!_pdfJs) {
    // pdf-parse 1.x bundles PDF.js but does not expose attachments through its
    // high-level API. Railway e-tickets embed an authoritative XBRL/XML file,
    // so use the bundled PDF.js API instead of adding another PDF dependency.
    (globalThis as any).PDFJS ||= {};
    var req = createRequire(import.meta.url);
    _pdfJs = req("pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js");
    _pdfJs.disableWorker = true;
  }
  return _pdfJs;
}

async function extractFileText(fp: string): Promise<string> {
  var ext = fp.toLowerCase().split(".").pop();
  if (ext === "pdf") {
    let buffer: Buffer;
    let text: string;
    try {
      buffer = fs.readFileSync(fp);
      const parsed = await getPdfParse()(buffer);
      text = (parsed.text || "").trim();
    } catch { return "(pdf extraction failed)"; }
    // 有发票表头但读不到金额时，先用本地兼容引擎恢复字体文字，不扩大视觉外传范围。
    if (needsLocalInvoiceTextRepair(text)) {
      try {
        const repaired = await extractPdfTextLocally(buffer);
        if (findAmount(repaired) !== 0) text = repaired;
      } catch {
        // 保留原始文本供后续判断；无法恢复金额的发票由提取步骤转为其他附件。
      }
    }
    return text.slice(0, 5000);
  }
  if (ext && ["jpg","jpeg","png","webp"].includes(ext)) {
    var buf = fs.readFileSync(fp);
    var b64 = buf.toString("base64");
    var mime = "image/" + (ext === "jpg" ? "jpeg" : ext);
    return "[IMAGE:" + b64.length + ":" + mime + "]" + path.basename(fp);
  }
  return "[UNKNOWN: " + path.basename(fp) + "]";
}

export function findAmount(s: string): number {
  // 增值税发票可能先排“价税合计（大写）”，隔着整段中文大写金额后才出现
  // “（小写）¥2249.82”。必须锚定小写金额，不能回退成金额栏的不含税合计。
  var m = s.match(/价\s*税\s*合\s*计[\s\S]{0,180}?[（(]\s*小\s*写\s*[）)]\s*[:：]?\s*[¥￥]?\s*([\d,]+(?:\.\d{1,2})?)(?![\dA-Za-z.])/i);
  if (m) return parseFloat(m[1].replace(/,/g, ''));
  // pdf-parse 有时把整页标签先输出、数值后输出，形成：
  // “价税合计（大写）（小写） ... ¥不含税金额 ¥税额 ... ¥价税合计”。
  // 在票面确有价税合计标签时，寻找满足“金额 + 税额 = 含税总额”的连续币种值。
  if (/价\s*税\s*合\s*计/.test(s)) {
    const currencyValues = Array.from(s.matchAll(/[¥￥]\s*(-?[\d,]+(?:\.\d{1,2})?)/g))
      .map((match) => Number(match[1].replace(/,/g, '')))
      .filter(Number.isFinite);
    for (let index = 0; index + 2 < currencyValues.length; index++) {
      const netAmount = currencyValues[index];
      const taxAmount = currencyValues[index + 1];
      const grossAmount = currencyValues[index + 2];
      if (Math.abs(netAmount + taxAmount - grossAmount) <= 0.05) return grossAmount;
    }
  }
  // 兼容没有“大写/小写”行、直接显示“价税合计：￥...”的票面。
  m = s.match(/价\s*税\s*合\s*计(?:\s*金\s*额)?\s*[:：]?\s*[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (m) return parseFloat(m[1].replace(/,/g, ''));
  // Priority after VAT total: itinerary total > generic amount > CNY.
  m = s.match(/合计[\s\S]{0,20}?CNY\s*([\d,]+\.?\d*)/i);
  if (m) return parseFloat(m[1].replace(/,/g, ''));
  m = s.match(/[:\s]\s?([1-9]\d{2,5}\.\d{2})[\s\n]/);
  if (m) return parseFloat(m[1]);
  m = s.match(/CNY\s+([\d,]+\.?\d*)/i);
  if (m) return parseFloat(m[1].replace(/,/g, ''));
  m = s.match(/\u00a5\s*([\d,]+\.?\d*)/);
  if (m) return parseFloat(m[1].replace(/,/g, ''));
  return 0;
}

export function needsLocalInvoiceTextRepair(text: string): boolean {
  return /价\s*税\s*合\s*计|增值税[\s\S]{0,12}发票/.test(text) && findAmount(text) === 0;
}

export function findDate(s: string): string {
  // 中文日期优先（如 2026年07月19日）
  var m = s.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  if (m) return m[1]+"-"+m[2].padStart(2,"0")+"-"+m[3].padStart(2,"0");
  m = s.match(/(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return m[1]+"-"+m[2].padStart(2,"0")+"-"+m[3].padStart(2,"0");
  // 8位紧凑日期，限定月/日合法性，避免匹配发票号等数字串
  m = s.match(/(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
  if (m) return m[1]+"-"+m[2]+"-"+m[3];
  return "";
}

export interface LodgingStayDetails {
  check_in_date: string;
  check_out_date: string;
  lodging_days: number;
  stay_periods: Array<{ check_in_date: string; check_out_date: string }>;
}

export function extractLodgingStayDetails(text: string): LodgingStayDetails {
  const source = String(text || '');
  const issueYear = Number(source.match(/(20\d{2})年\s*\d{1,2}月\s*\d{1,2}日/)?.[1]) || 0;
  const periods: LodgingStayDetails['stay_periods'] = [];
  // 不要删除所有空白：pdf-parse 会把上一行的“11”紧挨下一行“8月”，全量压缩会
  // 变成“118月”并误读月份。这里只在日期标记内部容忍排版空格。
  const pattern = /(?:(20\d{2})年\s*)?(\d{1,2})月\s*(\d{1,2})日\s*(入\s*住|离\s*店)/g;
  let match: RegExpExecArray | null;
  let pendingCheckIn: { year: number; month: number; day: number } | null = null;
  while ((match = pattern.exec(source)) !== null) {
    const token = {
      year: Number(match[1]) || issueYear,
      month: Number(match[2]),
      day: Number(match[3]),
    };
    const action = match[4].replace(/\s+/g, '');
    if (action === '入住') {
      pendingCheckIn = token;
      continue;
    }
    if (!pendingCheckIn) continue;
    let endYear = token.year || pendingCheckIn.year;
    if (!match[1] && token.month < pendingCheckIn.month) endYear += 1;
    const checkIn = `${pendingCheckIn.year}-${String(pendingCheckIn.month).padStart(2, '0')}-${String(pendingCheckIn.day).padStart(2, '0')}`;
    const checkOut = `${endYear}-${String(token.month).padStart(2, '0')}-${String(token.day).padStart(2, '0')}`;
    pendingCheckIn = null;
    if (!Number.isFinite(Date.parse(checkIn + 'T00:00:00Z'))
      || !Number.isFinite(Date.parse(checkOut + 'T00:00:00Z'))) continue;
    periods.push({ check_in_date: checkIn, check_out_date: checkOut });
  }
  const explicitNights = Number(source.match(/共\s*(\d+)\s*晚/)?.[1]) || 0;
  // 票面未写入住区间时，仅接受单个住宿项目以“天/晚”计量的数量。
  const lodgingRows = source.split(/\r?\n/).filter((line) => /住宿服务|住宿费|房费/.test(line));
  const quantity = lodgingRows.length === 1
    ? Number(lodgingRows[0].match(/(?:住宿服务|住宿费|房费)[^\r\n]{0,50}?\s(?:天|晚)\s+(\d+(?:\.\d+)?)\s/)?.[1])
    : 0;
  const itemNights = Number.isInteger(quantity) && quantity > 0 ? quantity : 0;
  const calculatedNights = periods.reduce((total, period) => {
    const start = Date.parse(period.check_in_date + 'T00:00:00Z');
    const end = Date.parse(period.check_out_date + 'T00:00:00Z');
    return total + Math.max(0, Math.floor((end - start) / 86400000));
  }, 0);
  return {
    check_in_date: periods[0]?.check_in_date || '',
    check_out_date: periods.at(-1)?.check_out_date || '',
    lodging_days: explicitNights || calculatedNights || itemNights,
    stay_periods: periods,
  };
}

function findByLabel(s: string, label: string): string {
  // 转义正则特殊字符
  var esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 1) 带冒号/空格分隔（如 "出差日期：2026-07-19"）
  var m = s.match(new RegExp(esc + '[:：\\s]+([^\\n\\r]{1,100})'));
  if (m) return m[1].trim();
  // 2) 无分隔符（如 "出差日期2026-07-19"、"出差事由参加..."）
  m = s.match(new RegExp(esc + '([^\\n\\r]{1,100})'));
  return m ? m[1].replace(/^[:：\s]+/, "").trim() : "";
}

function findAllLabels(s: string, label: string): string[] {
  var results: string[] = [];
  var esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var regex = new RegExp(esc + '[:：\\s]*([^\\n\\r]{1,100})', 'g');
  var m;
  while ((m = regex.exec(s)) !== null) results.push(m[1].trim());
  return results;
}


function isImage(fp: string): boolean {
  var ext = fp.toLowerCase().split(".").pop();
  return ext ? ["jpg","jpeg","png","webp"].includes(ext) : false;
}

export function parseMimoNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const normalized = String(value ?? '')
    .replace(/[,，\s]/g, '')
    .replace(/[￥¥元%]/g, '')
    .replace(/[^\d.+-]/g, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isPdf(fp: string): boolean {
  return path.extname(fp).toLowerCase() === '.pdf';
}

async function renderPdfFirstPage(fp: string): Promise<{ buffer: Buffer; mime: string }> {
  // Never write beside the source PDF: callers may provide a read-only file.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-pdf-'));
  const outputPrefix = path.join(tempDir, 'page-1');
  const output = outputPrefix + '.png';
  try {
    await execFileAsync('pdftoppm', ['-f', '1', '-singlefile', '-png', '-r', '144', fp, outputPrefix], {
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { buffer: fs.readFileSync(output), mime: 'image/png' };
  } catch (error: any) {
    throw new Error(`扫描 PDF 无文本且首页转图片失败：${error?.message || String(error)}`);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

async function getImageData(fp: string): Promise<{ b64: string; mime: string }> {
  if (isPdf(fp)) {
    const rendered = await renderPdfFirstPage(fp);
    return { b64: rendered.buffer.toString('base64'), mime: rendered.mime };
  }
  var buf = fs.readFileSync(fp);
  var ext = fp.toLowerCase().split(".").pop() || "jpg";
  const compressed = await shrinkImageForVision(buf);
  if (compressed) return { b64: compressed.toString("base64"), mime: "image/jpeg" };
  return { b64: buf.toString("base64"), mime: "image/" + (ext === "jpg" ? "jpeg" : ext) };
}

const VISION_MAX_EDGE = 2000;
const VISION_MAX_BYTES = 1.5 * 1024 * 1024;

// 手机照片常有几 MB，原图 base64 上传和模型解码都慢。超过 2000px 或 1.5MB 时按 EXIF
// 转正后缩到长边 2000px 的 JPEG；票面文字在这个尺寸下仍清晰。失败时返回 null，发送原图。
export async function shrinkImageForVision(buf: Buffer): Promise<Buffer | null> {
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(buf).metadata();
    const longEdge = Math.max(meta.width || 0, meta.height || 0);
    if (longEdge <= VISION_MAX_EDGE && buf.length <= VISION_MAX_BYTES) return null;
    return await sharp(buf)
      .rotate()
      .resize({ width: VISION_MAX_EDGE, height: VISION_MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  } catch (error: any) {
    console.warn("[Vision] 图片压缩失败，改为发送原图：" + (error?.message || String(error)));
    return null;
  }
}

async function callMimoVision(prompt: string, fp: string): Promise<string> {
  try {
    requireVisionConfig();
    var img = await getImageData(fp);
    var resp = await getOpenAI().chat.completions.create({
      model: config.mimoModel,
      // 某些视觉模型默认开启深度思考，思考 token 与最终答案共用上限。旧的
      // max_tokens=1024 可能在思考阶段耗尽额度，导致 message.content 为空。
      // 图片 OCR/结构化提取不需要深度思考，因此显式关闭并使用新版上限字段。
      max_completion_tokens: 4096,
      extra_body: { thinking: { type: "disabled" } },
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: "data:" + img.mime + ";base64," + img.b64 } },
        { type: "text", text: prompt + "\n/no_think" }
      ]}]
    });
    const choice = resp.choices[0];
    const content = choice?.message?.content || "";
    if (!content.trim()) {
      throw new Error(
        `MiMo 返回空内容（finish_reason=${choice?.finish_reason || 'unknown'}）。`
        + '请确认所配置模型支持图片输入，并保持 thinking=disabled。',
      );
    }
    return content;
  } catch(e: any) {
    const detail = e?.error?.message || e?.message || String(e);
    const status = e?.status ? `HTTP ${e.status}: ` : '';
    console.error(`[Mimo Vision] ${status}${detail}`);
    throw new Error(`Mimo 图片识别请求失败：${status}${detail}`);
  }
}

function extractJson(s: string): any {
  s = String(s || '').replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  var start = s.indexOf("{");
  var end = s.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(s.slice(start, end+1)); } catch { return null; }
}

async function callMimoJson(prompt: string, fp: string, documentName: string): Promise<any> {
  const response = await callMimoVision(prompt, fp);
  const parsed = extractJson(response);
  if (!parsed) throw new Error(`Mimo ${documentName}识别结果不是有效 JSON`);
  return parsed;
}

const invoiceTypes = new Set(['机票', '高铁票', '住宿发票', '其他发票']);
const documentTypes = new Set(['出差审批单', '出差补助单', '税额计算表', '其他凭证']);

export function isValidClassification(category: string, type: string): boolean {
  if (category === 'invoice') return invoiceTypes.has(type);
  if (category === 'document') return documentTypes.has(type);
  return category === 'unknown' && type === '其他';
}

function looksLikeExtractedPdfText(text: string): boolean {
  const normalized = String(text || '').replace(/\s+/g, '');
  if (!normalized || normalized === '(pdfextractionfailed)') return false;
  const meaningful = normalized.replace(/[\u0000-\u001f\u007f-\u009f�]/g, '');
  return meaningful.length >= 20;
}

function decodeXmlEntities(value: string): string {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function readXmlLocalName(xml: string, localName: string): string {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(xml || '').match(
    new RegExp('<(?:[A-Za-z_][\\w.-]*:)?' + escaped + '\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?' + escaped + '>', 'i'),
  );
  return match ? decodeXmlEntities(match[1].replace(/<[^>]+>/g, '')) : '';
}

export interface RailwayTicketDetails {
  name: string;
  date: string;
  amount: number;
  invoice_number: string;
  vendor: string;
  type: '高铁票';
  issue_date: string;
  departure_station: string;
  destination_station: string;
  train_number: string;
  departure_time: string;
  seat_class: string;
  carriage: string;
  seat: string;
  ticket_number: string;
  purchaser: string;
  tax_amount: number;
  is_refund: boolean;
}

export function parseRailwayTicketXbrl(xml: string): RailwayTicketDetails | null {
  const invoiceNumber = readXmlLocalName(xml, 'ElectronicInvoiceRailwayETicketNumber');
  const trainNumber = readXmlLocalName(xml, 'TrainNumber');
  const travelDate = readXmlLocalName(xml, 'TravelDate');
  const departure = readXmlLocalName(xml, 'DepartureStation');
  const destination = readXmlLocalName(xml, 'DestinationStation');
  // 航空电子客票附件也可能包含通用日期和起讫地点字段，不能仅凭这些字段当成
  // 铁路票。内嵌数据至少要给出铁路电子客票号或车次这一项铁路专属身份。
  if (!invoiceNumber && !trainNumber) return null;

  const refunded = parseMimoNumber(readXmlLocalName(xml, 'AmountRefunded'));
  const businessType = readXmlLocalName(xml, 'TypeOfBusiness');
  return {
    name: readXmlLocalName(xml, 'Name') || '未知',
    date: travelDate,
    amount: parseMimoNumber(readXmlLocalName(xml, 'Fare')),
    invoice_number: invoiceNumber,
    vendor: '',
    type: '高铁票',
    issue_date: readXmlLocalName(xml, 'DateOfIssue'),
    departure_station: departure.replace(/站$/, ''),
    destination_station: destination.replace(/站$/, ''),
    train_number: trainNumber.toUpperCase(),
    departure_time: readXmlLocalName(xml, 'DepartureTime'),
    seat_class: readXmlLocalName(xml, 'SeatLevel'),
    carriage: readXmlLocalName(xml, 'Carriage'),
    seat: readXmlLocalName(xml, 'Seat'),
    ticket_number: readXmlLocalName(xml, 'ETicketNumber'),
    purchaser: readXmlLocalName(xml, 'NameOfPurchaser'),
    tax_amount: parseMimoNumber(readXmlLocalName(xml, 'TaxAmount')),
    is_refund: refunded > 0 || /退|红/.test(businessType),
  };
}

async function extractRailwayTicketAttachment(fp: string): Promise<RailwayTicketDetails | null> {
  if (!isPdf(fp)) return null;
  let document: any = null;
  try {
    document = await getPdfJs().getDocument(fs.readFileSync(fp));
    const attachments = await document.getAttachments();
    for (const attachment of Object.values(attachments || {}) as any[]) {
      const filename = String(attachment?.filename || '').toLowerCase();
      if (!filename.endsWith('.xml')) continue;
      const xml = Buffer.from(attachment.content || []).toString('utf8');
      const parsed = parseRailwayTicketXbrl(xml);
      if (parsed) return parsed;
    }
  } catch {
    // Not every PDF exposes attachments correctly. Text/OCR fallbacks below
    // remain available, so attachment parsing is intentionally best-effort.
  } finally {
    try { await document?.destroy?.(); } catch {}
  }
  return null;
}

function parseDateValue(value: unknown): string {
  const raw = String(value || '').trim();
  return findDate(raw) || (/^20\d{2}-\d{2}-\d{2}$/.test(raw) ? raw : '');
}

function normalizeRailwayVisionData(data: any): RailwayTicketDetails {
  return {
    name: String(data?.name || '').trim() || '未知',
    date: parseDateValue(data?.date || data?.travel_date),
    amount: parseMimoNumber(data?.amount || data?.fare),
    invoice_number: String(data?.invoice_number || '').trim(),
    vendor: String(data?.vendor || '').trim(),
    type: '高铁票',
    issue_date: parseDateValue(data?.issue_date),
    departure_station: String(data?.departure_station || data?.origin || '').trim().replace(/站$/, ''),
    destination_station: String(data?.destination_station || data?.destination || '').trim().replace(/站$/, ''),
    train_number: String(data?.train_number || '').trim().toUpperCase(),
    departure_time: String(data?.departure_time || '').trim(),
    seat_class: String(data?.seat_class || '').trim(),
    carriage: String(data?.carriage || '').trim(),
    seat: String(data?.seat || '').trim(),
    ticket_number: String(data?.ticket_number || '').trim(),
    purchaser: String(data?.purchaser || '').trim(),
    tax_amount: parseMimoNumber(data?.tax_amount),
    is_refund: Boolean(data?.is_refund),
  };
}

async function extractRailwayTicket(fp: string): Promise<RailwayTicketDetails> {
  const embedded = await extractRailwayTicketAttachment(fp);
  if (embedded) return embedded;

  const localText = isPdf(fp) ? await extractFileText(fp) : '';
  if (isImage(fp) || (isPdf(fp) && !looksLikeExtractedPdfText(localText))) {
    const data = await callMimoJson(
      '识别这张中国铁路电子客票或火车票。只返回 JSON，不要解释：'
      + '{"name":"旅客姓名","travel_date":"YYYY-MM-DD","amount":票价数字,"invoice_number":"发票号码",'
      + '"issue_date":"YYYY-MM-DD","departure_station":"出发站，不含站字","destination_station":"到达站，不含站字",'
      + '"train_number":"车次","departure_time":"HH:mm","seat_class":"席别，如二等座",'
      + '"carriage":"车厢号","seat":"座位号","ticket_number":"电子客票号","purchaser":"购买方名称",'
      + '"tax_amount":税额数字,"is_refund":是否为退票或红字票布尔值}。'
      + '出行日期与开票日期必须分开；amount 必须取票价，不要取不含税金额或税额；看不清的字段填空字符串或 0，不要猜测。',
      fp,
      '铁路电子客票',
    );
    return normalizeRailwayVisionData(data);
  }

  const fn = path.basename(fp, path.extname(fp));
  const route = localText.match(/([一-鿿]{2,12})站?\s*([DGCKTZ]\d{1,5})\s*([一-鿿]{2,12})站?/i);
  const travel = localText.match(/(20\d{2}年\d{1,2}月\d{1,2}日)\s*(\d{1,2}:\d{2})开/);
  const seat = localText.match(/(\d{1,2})车\s*(\d{1,3}[A-F]?)号?/i);
  const filenameParts = fn.split(/[_—]/);
  return normalizeRailwayVisionData({
    name: findByLabel(localText, '旅客姓名') || filenameParts.find((part) => /^[一-鿿]{2,4}$/.test(part)),
    travel_date: travel ? travel[1] : findByLabel(localText, '乘车日期'),
    amount: (localText.match(/票价[:：\s]*[¥￥]?\s*([\d,.]+)/)?.[1]) || findAmount(localText),
    invoice_number: findByLabel(localText, '发票号码') || fn.match(/发票号(\d{8,30})/)?.[1],
    departure_station: route?.[1],
    train_number: route?.[2] || localText.match(/\b[DGCKTZ]\d{1,5}\b/i)?.[0],
    destination_station: route?.[3],
    departure_time: travel?.[2],
    seat_class: localText.match(/(商务座|特等座|一等座|二等座|软卧|硬卧|硬座|无座)/)?.[1],
    carriage: seat?.[1] ? seat[1].padStart(2, '0') + '车' : '',
    seat: seat?.[2] ? seat[2] + '号' : '',
    ticket_number: findByLabel(localText, '电子客票号'),
  });
}

// Classification - keyword-based, tested with real files
export async function classifyFile(fp: string): Promise<{category:string; type:string}> {
  var text = await extractFileText(fp);
  var fn = path.basename(fp).replace(/\.[^.]+$/,"");
  var ct = text + " " + fn;
  
  // Document types (check FIRST - these have distinctive keywords)
  if (/审批表|审批单|审批编号|审批流程/i.test(ct)) return {category:"document", type:"出差审批单"};
  if (ct.includes("出差审批") || ct.includes("审批表") || ct.includes("审批编号")) return {category:"document", type:"出差审批单"};
  if (ct.includes("补助") || ct.includes("补贴") || /subsidy|allowance/i.test(ct)) return {category:"document", type:"出差补助单"};

  // 退票、改签、退改手续费属于“其他费用”；必须先于飞机/铁路关键词判断。
  if (/退票|改签|退改|手续费|refund|change/i.test(ct)) return {category:"invoice", type:"其他发票"};

  // 新版铁路电子客票通常是扫描外观，但内嵌财政部 XBRL/XML 数据。
  // 优先本地读取该数据，避免把可精确解析的票据交给视觉模型猜测。
  const embeddedRailwayTicket = await extractRailwayTicketAttachment(fp);
  if (embeddedRailwayTicket) {
    return { category: 'invoice', type: embeddedRailwayTicket.is_refund ? '其他发票' : '高铁票' };
  }

  // Train: D1705, G1234, etc.
  if (/\b[DGCKTZ]\d{3,4}\b/i.test(ct)) return {category:"invoice", type:"高铁票"};
  if (ct.includes("高铁") || ct.includes("火车") || ct.includes("动车") || ct.includes("铁路")) return {category:"invoice", type:"高铁票"};
  
  // Flight: MU1234, CA1234, 3U8957, etc.
  if (/\b(MU|CA|CZ|ZH|HU|3U|FM|MF|SC|GS|KY|EU|GJ|NS|PN|BK|DR|QW|9C|8L|TV)\d{3,4}\b/i.test(ct)) return {category:"invoice", type:"机票"};
  if (ct.includes("航空运输") || ct.includes("电子客票") || ct.includes("行程单") || ct.includes("承运人") || ct.includes("航班号")) return {category:"invoice", type:"机票"};
  if (ct.includes("机票") || /flight|airline/i.test(ct)) return {category:"invoice", type:"机票"};
  
  // Hotel: contains 住宿费 in text
  if (ct.includes("住宿费") || ct.includes("住宿") || ct.includes("酒店") || ct.includes("宾馆") || ct.includes("旅馆") || /hotel|accom/i.test(ct)) return {category:"invoice", type:"住宿发票"};
  
  // 税额计算表必须有明确表名/汇总特征。普通增值税发票同样包含“税额、税率”，
  // 这些通用税务字段绝不能单独把发票改分为附件文档。
  if (/税额计算表|税额汇总表|税额明细表|进项税额计算/i.test(ct)) {
    return {category:"document", type:"税额计算表"};
  }

  const requiresVision = isImage(fp) || (isPdf(fp) && !looksLikeExtractedPdfText(text));

  // Generic invoice. 对图片而言，“发票.jpg”等名称只能说明它是一张票据，不能判断
  // 应进入交通、住宿还是其他费用，必须继续交给 MiMo 看图分类。
  if (!requiresVision && /发票号码|发票代码|开票日期|购买方|销售方|价税合计|增值税.*发票|invoice|receipt/i.test(ct)) {
    return {category:"invoice", type:"其他发票"};
  }
  if (!requiresVision && ct.includes("发票")) return {category:"invoice", type:"其他发票"};

  // 文件名/本地文本无法可靠分类的图片或扫描 PDF，调用 MiMo 视觉分类。
  if (requiresVision && config.mimoApiKey) {
    const parsed = await callMimoJson(
      '识别这张中国报销材料图片。只返回 JSON，不要解释：{"category":"invoice|document|unknown","type":"机票|高铁票|住宿发票|其他发票|出差审批单|出差补助单|税额计算表|其他凭证|其他"}。飞机票和正常高铁票分别归机票、高铁票；退票费、改签费、退改手续费和独立保险费票据归其他发票，但正常机票正文中附带出现保险字样时仍归机票。category 必须是三个英文值之一，type 必须是列出的中文值之一。',
      fp,
      '图片分类',
    );
    if (parsed && isValidClassification(parsed.category, parsed.type)) {
      return { category: parsed.category, type: parsed.type };
    }
    throw new Error(`MiMo 返回了不合法的材料分类组合：${String(parsed?.category || '')}/${String(parsed?.type || '')}`);
  }

  if (requiresVision && !config.mimoApiKey) {
    throw new Error('该图片或扫描 PDF 需要视觉识别，但未配置 MIMO_API_KEY');
  }
  
  return {category:"unknown", type:"其他"};
}

// Invoice extraction. Transport tickets use dedicated schemas because an air
// itinerary and a railway e-ticket expose different business fields.
export async function extractInvoice(fp: string, invoiceType = '其他发票'): Promise<any> {
  if (invoiceType === '高铁票') return extractRailwayTicket(fp);

  const localText = isPdf(fp) ? await extractFileText(fp) : '';
  if (isImage(fp) || (isPdf(fp) && !looksLikeExtractedPdfText(localText))) {
    const prompt = invoiceType === '机票'
      ? '识别这张中国航空运输电子客票行程单。只返回 JSON，不要解释：'
        + '{"name":"旅客姓名","date":"乘机日期 YYYY-MM-DD","amount":合计金额数字,"invoice_number":"电子客票号码或发票号码",'
        + '"vendor":"承运人或销售方","flight_number":"航班号","departure_station":"出发机场或城市",'
        + '"destination_station":"到达机场或城市","departure_time":"起飞时间 HH:mm"}。'
        + '乘机日期不要取填开日期；amount 必须取票价及税费后的合计，不要只取票价、税额或民航发展基金；看不清不要猜测。'
      : '识别这张中国报销发票图片。只返回 JSON，不要解释：'
        + '{"name":"报销人姓名，无法确定则空字符串","date":"消费日期 YYYY-MM-DD","amount":价税合计数字,'
        + '"invoice_number":"发票号码","vendor":"销售方名称","check_in_date":"住宿首次入住日期 YYYY-MM-DD",'
        + '"check_out_date":"住宿最后离店日期 YYYY-MM-DD","lodging_days":票面住宿总晚数数字}。'
        + '金额必须取价税合计或实付总额，不能把税额或单价当作总金额；非住宿发票的住宿字段留空或填0。';
    const data = await callMimoJson(
      prompt,
      fp,
      invoiceType === '机票' ? '航空行程单' : '发票图片',
    );
    return {
      name: String(data.name || '').trim() || '未知',
      date: parseDateValue(data.date),
      amount: parseMimoNumber(data.amount),
      invoice_number: String(data.invoice_number || '').trim(),
      vendor: String(data.vendor || '').trim(),
      type: invoiceType,
      flight_number: invoiceType === '机票' ? String(data.flight_number || '').trim().toUpperCase() : '',
      departure_station: invoiceType === '机票' ? String(data.departure_station || '').trim() : '',
      destination_station: invoiceType === '机票' ? String(data.destination_station || '').trim() : '',
      departure_time: invoiceType === '机票' ? String(data.departure_time || '').trim() : '',
      check_in_date: invoiceType === '住宿发票' ? parseDateValue(data.check_in_date) : '',
      check_out_date: invoiceType === '住宿发票' ? parseDateValue(data.check_out_date) : '',
      lodging_days: invoiceType === '住宿发票' ? Math.max(0, Math.floor(parseMimoNumber(data.lodging_days))) : 0,
    };
  }
  var text = await extractFileText(fp);
  var fn = path.basename(fp).replace(/\.[^.]+$/,"");
  var isFlight = invoiceType === '机票' || /航空运输|电子客票|行程单|航班号|承运人/.test(text);
  
  var name = findByLabel(text, "购买方名称") || findByLabel(text, "旅客姓名") || "";
  // 机票的“购买方名称”通常是公司，报销人姓名应从脱敏后的身份证号邻近文本提取。
  if (isFlight || !name || /公司|集团|有限/.test(name)) {
    var pn = text.match(/([一-龥]{2,4})[\dXx*]{12,20}/);
    if (pn) name = pn[1];
  }
  if (name && /公司|集团|有限/.test(name)) name = "";
  var date = findDate(text);
  if (isFlight) {
    // 行程单中填开日期在前、航班日期在后，取最后一个中文日期作为出行日期
    var dts = text.match(/20\d{2}年\d{1,2}月\d{1,2}日/g);
    if (dts && dts.length) {
      var last = dts[dts.length-1].replace(/年/g,'-').replace(/月/g,'-').replace(/日/g,'');
      var dp = last.split('-');
      if (dp.length === 3) date = dp[0]+"-"+dp[1].padStart(2,"0")+"-"+dp[2].padStart(2,"0");
    }
  }
  var amount = findAmount(text);
  const lodgingStay = invoiceType === '住宿发票'
    ? extractLodgingStayDetails(text)
    : { check_in_date: '', check_out_date: '', lodging_days: 0, stay_periods: [] };
  if (invoiceType === '住宿发票' && lodgingStay.check_in_date) date = lodgingStay.check_in_date;
  if (isFlight) {
    // 机票合计是最后一个 CNY 值（票价/税费/民航发展基金之后），而非票价
    var amts: number[] = [];
    var re = /CNY\s*([\d,]+\.?\d*)/g;
    var mm;
    while ((mm = re.exec(text)) !== null) amts.push(parseFloat(mm[1].replace(/,/g, '')));
    if (amts.length) amount = amts[amts.length-1];
  }
  
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error('无法从发票中提取有效总金额，已保留原件供附件上传');
  }

  // Fallback from filename: 张三-出发站-到达站-20260628-110.0
  if (!name) {
    var parts = fn.split(/[-_—]/);
    for (var p of parts) {
      if (/^[一-鿿]{2,3}$/.test(p) && !/公司|酒店|有限|发展|产业|高速|山东|四川|集团|飞猪|订单|发票|住宿票|凭证/.test(p)) { name = p; break; }
    }
  }
  if (!date && fn.match(/(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/)) {
    var fm = fn.match(/(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/)!;
    date = fm[1]+"-"+fm[2]+"-"+fm[3];
  }
  
  return {
    name: name || "未知", date, amount,
    invoice_number: findByLabel(text, "发票号码") || "",
    vendor: findByLabel(text, "销售方名称") || findByLabel(text, "名称") || "",
    type: invoiceType,
    ...lodgingStay,
    flight_number: isFlight ? (text.match(/\b(?:MU|CA|CZ|ZH|HU|3U|FM|MF|SC|GS|KY|EU|GJ|NS|PN|BK|DR|QW|9C|8L|TV)\d{3,4}\b/i)?.[0] || '').toUpperCase() : '',
  };
}

// Approval extraction
export async function extractApproval(fp: string): Promise<any> {
  const localText = isPdf(fp) ? await extractFileText(fp) : '';
  if (isImage(fp) || (isPdf(fp) && !looksLikeExtractedPdfText(localText))) {
    const data = await callMimoJson(
      '识别这张中国出差审批单图片。只返回 JSON，不要解释：{"travelers":["出差人员姓名"],"start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","destination":"出差地点","purpose":"出差事由","department":"部门"}。看不清的文本用空字符串，不要猜测姓名或日期。',
      fp,
      '出差审批单图片',
    );
    return {
      travelers: Array.isArray(data.travelers) ? data.travelers.map(String).filter(Boolean) : [],
      start_date: String(data.start_date || '').trim(),
      end_date: String(data.end_date || '').trim(),
      destination: String(data.destination || '').trim(),
      purpose: String(data.purpose || '').trim(),
      department: String(data.department || '').trim(),
    };
  }
  var text = await extractFileText(fp);
  
  var travelers = findByLabel(text, "出差人员（自选）") || findByLabel(text, "出差人员");
  travelers = (travelers||"").replace(/^（[^）]*）/,"");
  var travelerList = travelers ? travelers.split(/[,，、\s]+/).filter((s:string)=>s.length>1) : [];
  if (!travelerList.length) {
    var allNames = findAllLabels(text, "出差人员");
    for (var n of allNames) { var n2 = n.replace(/^（[^）]*）/,""); for (var p of n2.split(/[,，、\s]+/)) { if (p.length>1 && !travelerList.includes(p)) travelerList.push(p); } }
  }
  if (!travelerList.length && text.includes("创建人")) {
    var creator = findByLabel(text, "创建人");
    if (creator && creator.length > 1) travelerList = [creator];
  }
  
  var startDate = findDate(findByLabel(text, "出差日期")) || findDate(text);
  var endDate = findDate(findByLabel(text, "结束日期"));
  if (!endDate) {
    var dates = text.match(/20\d{2}[-\/]\d{1,2}[-\/]\d{1,2}/g);
    if (dates && dates.length > 1) { for (var d of dates) { if (d !== startDate) { endDate = d; break; } } }
  }
  
  return {
    travelers: travelerList,
    start_date: startDate,
    end_date: endDate,
    destination: findByLabel(text, "出差地点"),
    purpose: findByLabel(text, "出差事由"),
    department: findByLabel(text, "创建人部门") || findByLabel(text, "部门")
  };
}

// Subsidy extraction
export async function extractSubsidy(fp: string): Promise<any> {
  // 补助单无论是图片、扫描 PDF 还是文字 PDF，都按人员逐行识别。旧的文字 PDF 分支取全文
  // 第一个 2～30 的数字当天数、找不到默认 2 天再按标准推算金额，日期或序号会被误当天数，
  // 扣减和明确的 0 元也会被覆盖。缺失的天数或金额交给 normalizeSubsidy 拦截，由人工核对。
  const data = await callMimoJson(
    SUBSIDY_EXTRACTION_PROMPT,
    fp,
    isPdf(fp) ? '补助单 PDF' : '补助单图片',
  );
  // 模型只抄录单元格原值；交通费、伙食费是每日标准还是应领金额，由行合计和合计行核对后确定。
  return normalizeSubsidy(reconcileSubsidyTable(data));
}

export async function extractTax(fp: string): Promise<any> {
  const localText = isPdf(fp) ? await extractFileText(fp) : '';
  if (isImage(fp) || (isPdf(fp) && !looksLikeExtractedPdfText(localText))) {
    const data = await callMimoJson(
      '识别这张中国税额计算表图片。只返回 JSON，不要解释：{"total_amount":含税总金额数字,"tax_rate":税率百分比数字,"tax_amount":税额数字,"notes":"必要备注"}。金额和税率必须是数字。',
      fp,
      '税额计算表图片',
    );
    return {
      total_amount: parseMimoNumber(data.total_amount),
      tax_rate: parseMimoNumber(data.tax_rate),
      tax_amount: parseMimoNumber(data.tax_amount),
      notes: String(data.notes || '').trim(),
    };
  }
  var text = await extractFileText(fp);
  const money = (label: string): number => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(escaped + '[:：\\s]*[¥￥]?\\s*([\\d,]+(?:\\.\\d{1,2})?)'));
    return match ? Number(match[1].replace(/,/g, '')) : 0;
  };
  const totalAmount = money('价税合计') || money('合计金额') || money('总金额') || findAmount(text);
  const taxAmount = money('税额') || money('税款');
  const rateMatch = text.match(/(?:税率|征收率)[:：\s]*(\d+(?:\.\d+)?)\s*%/);
  return {
    total_amount: totalAmount,
    tax_rate: rateMatch ? Number(rateMatch[1]) : 0,
    tax_amount: taxAmount,
    notes: text.slice(0, 200),
  };
}

// Batch processing
// 修改识别提示词或提取规则时加一，使旧缓存失效。
const VISION_CACHE_VERSION = 2;
const VISION_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type FileKind = 'invoice' | 'approval' | 'subsidy' | 'tax' | 'document';
interface FileOutcome {
  cls: { category: string; type: string };
  kind: FileKind;
  record?: any;
  error?: string;
}

function visionCacheDir(): string {
  return path.resolve(config.sessionDir, '.cache', 'vision');
}

function visionCacheKey(fp: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(fp));
  hash.update('\0' + VISION_CACHE_VERSION + '\0' + config.mimoModel + '\0' + path.extname(fp).toLowerCase());
  return hash.digest('hex');
}

function readVisionCache(key: string): FileOutcome | null {
  if (!config.visionCache) return null;
  try {
    const file = path.join(visionCacheDir(), key + '.json');
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > VISION_CACHE_MAX_AGE_MS) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function writeVisionCache(key: string, outcome: FileOutcome): void {
  if (!config.visionCache || outcome.error) return;
  try {
    fs.mkdirSync(visionCacheDir(), { recursive: true });
    const { filepath: _filepath, ...record } = outcome.record || {};
    fs.writeFileSync(path.join(visionCacheDir(), key + '.json'),
      JSON.stringify({ ...outcome, record: outcome.record ? record : undefined }));
  } catch {}
}

// 只删除超过 30 天的识别缓存（缓存内含票据信息，不长期保留）。
export function pruneVisionCache(now = Date.now()): number {
  let removed = 0;
  let names: string[] = [];
  try { names = fs.readdirSync(visionCacheDir()); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(visionCacheDir(), name);
    try {
      if (now - fs.statSync(file).mtimeMs > VISION_CACHE_MAX_AGE_MS) { fs.rmSync(file, { force: true }); removed++; }
    } catch {}
  }
  return removed;
}

async function processOneFile(fp: string): Promise<FileOutcome> {
  const fn = path.basename(fp);
  const started = Date.now();
  let cacheKey = '';
  try { cacheKey = visionCacheKey(fp); } catch {}
  const cached = cacheKey ? readVisionCache(cacheKey) : null;
  if (cached) {
    console.log(`[Vision] ${fn}: 命中识别缓存 (${cached.cls.type})`);
    return cached;
  }
  let outcome: FileOutcome;
  let classifyMs = 0;
  try {
    let cls = await classifyFile(fp);
    classifyMs = Date.now() - started;
    if (cls.category === 'invoice') {
      outcome = { cls, kind: 'invoice', record: { ...(await extractInvoice(fp, cls.type)), type: cls.type } };
    } else if (cls.type === '出差审批单') {
      outcome = { cls, kind: 'approval', record: await extractApproval(fp) };
    } else if (cls.type === '出差补助单') {
      outcome = { cls, kind: 'subsidy', record: await extractSubsidy(fp) };
    } else if (cls.type === '税额计算表') {
      outcome = { cls, kind: 'tax', record: await extractTax(fp) };
    } else if (cls.category === 'document' && cls.type === '其他凭证') {
      outcome = { cls, kind: 'document' };
    } else {
      outcome = {
        cls: { category: 'document', type: '其他凭证' },
        kind: 'document',
        error: '无法识别文件类型，已保留为其他附件',
      };
    }
  } catch (e: any) {
    // 分类或字段提取失败时只保留一条附件分类，不能同时进入发票上传队列。
    outcome = { cls: { category: 'document', type: '其他凭证' }, kind: 'document', error: e?.message || String(e) };
  }
  const totalMs = Date.now() - started;
  console.log(`[Vision] ${fn}: ${outcome.cls.type}，分类 ${classifyMs}ms，提取 ${Math.max(0, totalMs - classifyMs)}ms，合计 ${totalMs}ms`
    + (outcome.error ? `，失败：${outcome.error.slice(0, 80)}` : ''));
  if (cacheKey) writeVisionCache(cacheKey, outcome);
  return outcome;
}

export async function processAllFiles(filepaths: string[], onProgress?: (msg:string, pct:number)=>void) {
  var classifications:any[]=[], invoices:any[]=[], approvals:any[]=[], subsidies:any[]=[], taxSheets:any[]=[], errors:any[]=[];
  const total = filepaths.length;
  const outcomes: FileOutcome[] = new Array(total);
  const concurrency = Math.min(config.visionConcurrency || 1, Math.max(1, total));
  let next = 0;
  let done = 0;
  onProgress?.(`正在识别 ${total} 个文件（同时处理 ${concurrency} 个）...`, 0);
  // 有上限的并发：模型调用是瓶颈，多个文件同时识别；结果按原顺序写回，后续整理顺序不变。
  const worker = async () => {
    while (next < total) {
      const index = next++;
      outcomes[index] = await processOneFile(filepaths[index]);
      done++;
      onProgress?.(`已识别 ${done}/${total}：${path.basename(filepaths[index])}`, Math.round(done / total * 70));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  for (let i = 0; i < total; i++) {
    const fp = filepaths[i];
    const outcome = outcomes[i];
    if (outcome.error) errors.push({ filepath: fp, filename: path.basename(fp), message: outcome.error });
    if (outcome.kind === 'invoice') invoices.push({ ...outcome.record, filepath: fp, type: outcome.cls.type });
    else if (outcome.kind === 'approval') approvals.push({ ...outcome.record, filepath: fp });
    else if (outcome.kind === 'subsidy') subsidies.push({ ...outcome.record, filepath: fp });
    else if (outcome.kind === 'tax') taxSheets.push({ ...outcome.record, filepath: fp });
    classifications.push({ filepath: fp, class: outcome.cls });
  }
  return {classifications, invoices, approvals, subsidies, taxSheets, errors};
}
