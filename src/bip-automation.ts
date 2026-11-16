import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { config, requireAutomationConfig } from './config.js';
import * as path from 'path';
import * as fs from 'fs';
import { normalizeSubsidy } from './subsidy.js';

// ── 可配置项（fill-config.json）──
let fillConfig: any = null;
function getFillConfig(): any {
  if (fillConfig) return fillConfig;
  const p = path.resolve(process.cwd(), 'fill-config.json');
  try { fillConfig = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { fillConfig = {}; }
  return fillConfig;
}

const SLEEP = (ms: number) => new Promise(r => setTimeout(r, ms));

const MAX_KEPT_AUTOMATION_RUNS = 20;

// 只清理 sessions/<会话>/automation-* 诊断目录（截图、诊断 JSON、trace），不碰上传材料。
export function pruneAutomationRuns(sessionsRoot: string, keep: number, currentDir?: string): string[] {
  const runs: { dir: string; mtime: number }[] = [];
  let sessionDirs: fs.Dirent[] = [];
  try { sessionDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { return []; }
  for (const session of sessionDirs) {
    if (!session.isDirectory()) continue;
    const sessionPath = path.join(sessionsRoot, session.name);
    let children: fs.Dirent[] = [];
    try { children = fs.readdirSync(sessionPath, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (!child.isDirectory() || !child.name.startsWith('automation-')) continue;
      const dir = path.join(sessionPath, child.name);
      try { runs.push({ dir, mtime: fs.statSync(dir).mtimeMs }); } catch {}
    }
  }
  runs.sort((a, b) => b.mtime - a.mtime);
  const current = currentDir ? path.resolve(currentDir) : '';
  const removed: string[] = [];
  let kept = 0;
  for (const run of runs) {
    if (path.resolve(run.dir) === current || kept < keep) {
      if (path.resolve(run.dir) !== current) kept++;
      continue;
    }
    try { fs.rmSync(run.dir, { recursive: true, force: true }); removed.push(run.dir); } catch {}
  }
  return removed;
}

export interface UploadReport {
  expected: number;
  uploaded: number;
  warnings: string[];
}

export interface AutomationReport {
  subsidyRows: number;
  invoices: UploadReport;
  attachments: UploadReport;
  attachmentCount: number;
  warnings: string[];
}

export const BIP_WORKFLOW_STAGES = [
  'fill_subsidy',
  'upload_flights_and_fill_new_rows',
  'upload_trains_and_fill_new_rows',
  'upload_lodging_and_fill_new_rows',
  'upload_other_invoices_and_fill_new_rows',
  'fill_attachment_count',
  'check_merge_payment',
  'save_draft_only',
  'upload_other_attachments',
] as const;

export function isDraftSaveLabel(label: string): boolean {
  return String(label || '').replace(/\s+/g, '') === '保存';
}

export function calculateAttachmentCount(invoiceCount: number, documentCount: number): number {
  const invoices = Number.isFinite(invoiceCount) ? Math.max(0, Math.floor(invoiceCount)) : 0;
  const documents = Number.isFinite(documentCount) ? Math.max(0, Math.floor(documentCount)) : 0;
  return invoices + documents;
}

export const INVOICE_UPLOAD_GROUPS = [
  { label: '机票', keys: ['机票'], sectionTitle: '交通费用', areaCode: 'arap_bxbusitem', toolbars: ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'], needPayee: true, lodging: false },
  { label: '高铁票', keys: ['高铁票'], sectionTitle: '交通费用', areaCode: 'arap_bxbusitem', toolbars: ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'], needPayee: true, lodging: false },
  { label: '住宿发票', keys: ['住宿发票'], sectionTitle: '住宿费用', areaCode: 'other', toolbars: ['other_card_body-button'], needPayee: true, lodging: true },
  { label: '其他发票', keys: ['其他发票'], sectionTitle: '其他费用', areaCode: 'zsitem', toolbars: ['zsitem_card_body-button'], needPayee: true, lodging: false },
] as const;

export const FIXED_SETTLEMENT_METHOD = '联动支付';
export const FIXED_SUBSIDY_TRANSPORT_TYPE = '交通费';
export const FIXED_SUBSIDY_MEAL_TYPE = '伙食费';
export const FIXED_EXPENSE_BUSINESS_ATTR = '管理费用';
export const FIXED_INVOICE_MERGE_TYPE = '发票间合并';
export const FIXED_INVOICE_EXPENSE_TYPE = '境内差旅费';
export const DEFAULT_LODGING_PERSON_LEVEL = '高速集团其他管理人员';

export interface LodgingDefaults {
  city: string;
  cityCandidates: string[];
  checkInDate: string;
  checkOutDate: string;
  days: number;
  people: number;
  payeeName: string;
}

export function calculateLodgingDays(startDate: string, endDate: string): number {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? Date.parse(startDate + 'T00:00:00Z') : NaN;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? Date.parse(endDate + 'T00:00:00Z') : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  // BIP 住宿分区的公式是“离店日期 - 入住日期”，即住宿晚数，不含离店日。
  return Math.floor((end - start) / 86400000);
}

export function getCitySearchCandidates(destination: string): string[] {
  const original = String(destination || '').trim();
  if (!original) return [];
  let city = original.split(/[、,，/]/)[0].replace(/\s+/g, '');
  const municipality = ['北京', '天津', '上海', '重庆'].find((item) => city.startsWith(item));
  if (municipality) {
    return Array.from(new Set([municipality, municipality + '市', original].filter(Boolean)));
  }
  const provincePrefixes = [
    '河北省', '山西省', '辽宁省', '吉林省', '黑龙江省', '江苏省', '浙江省', '安徽省', '福建省',
    '江西省', '山东省', '河南省', '湖北省', '湖南省', '广东省', '海南省', '四川省', '贵州省', '云南省',
    '陕西省', '甘肃省', '青海省', '台湾省',
    '内蒙古自治区', '广西壮族自治区', '西藏自治区', '宁夏回族自治区', '新疆维吾尔自治区',
    '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南',
    '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '内蒙古', '广西',
    '西藏', '宁夏', '新疆',
  ];
  const prefix = provincePrefixes.find((item) => city.startsWith(item) && city.length > item.length);
  if (prefix) city = city.slice(prefix.length);
  // “四川省宜宾市叙州区”应搜索“宜宾”，而不是把区县一起带入城市参照。
  const prefecture = city.match(/^(.{2,12}?)(?:市|自治州|地区|盟)/);
  city = prefecture?.[1] || city.replace(/市$/, '');
  return Array.from(new Set([city, city ? city + '市' : '', original].filter(Boolean)));
}

const REGION_SEARCH_PREFIXES: Array<[string, string]> = [
  ['北京市', '北京'], ['天津市', '天津'], ['上海市', '上海'], ['重庆市', '重庆'],
  ['内蒙古自治区', '内蒙古'], ['广西壮族自治区', '广西'], ['西藏自治区', '西藏'],
  ['宁夏回族自治区', '宁夏'], ['新疆维吾尔自治区', '新疆'],
  ['河北省', '河北'], ['山西省', '山西'], ['辽宁省', '辽宁'], ['吉林省', '吉林'],
  ['黑龙江省', '黑龙江'], ['江苏省', '江苏'], ['浙江省', '浙江'], ['安徽省', '安徽'],
  ['福建省', '福建'], ['江西省', '江西'], ['山东省', '山东'], ['河南省', '河南'],
  ['湖北省', '湖北'], ['湖南省', '湖南'], ['广东省', '广东'], ['海南省', '海南'],
  ['四川省', '四川'], ['贵州省', '贵州'], ['云南省', '云南'], ['陕西省', '陕西'],
  ['甘肃省', '甘肃'], ['青海省', '青海'], ['台湾省', '台湾'],
  ['北京', '北京'], ['天津', '天津'], ['上海', '上海'], ['重庆', '重庆'],
  ['内蒙古', '内蒙古'], ['广西', '广西'], ['西藏', '西藏'], ['宁夏', '宁夏'], ['新疆', '新疆'],
  ['河北', '河北'], ['山西', '山西'], ['辽宁', '辽宁'], ['吉林', '吉林'], ['黑龙江', '黑龙江'],
  ['江苏', '江苏'], ['浙江', '浙江'], ['安徽', '安徽'], ['福建', '福建'], ['江西', '江西'],
  ['山东', '山东'], ['河南', '河南'], ['湖北', '湖北'], ['湖南', '湖南'], ['广东', '广东'],
  ['海南', '海南'], ['四川', '四川'], ['贵州', '贵州'], ['云南', '云南'], ['陕西', '陕西'],
  ['甘肃', '甘肃'], ['青海', '青海'], ['台湾', '台湾'],
];

export function getRegionSearchKeyword(destination: string): string {
  const normalized = String(destination || '').trim().split(/[、,，/]/)[0].replace(/\s+/g, '');
  if (!normalized) return '';
  const matched = REGION_SEARCH_PREFIXES.find(([prefix]) => normalized.startsWith(prefix));
  if (matched) return matched[1];
  return getCitySearchCandidates(normalized)[0]?.replace(/市$/, '') || normalized;
}

export function buildLodgingDefaults(approval: any, invoice?: any): LodgingDefaults {
  const checkInDate = String(
    invoice?.check_in_date || invoice?.checkInDate || approval?.start_date || approval?.startDate || '',
  ).trim();
  const checkOutDate = String(
    invoice?.check_out_date || invoice?.checkOutDate || approval?.end_date || approval?.endDate || '',
  ).trim();
  const travelers = Array.isArray(approval?.travelers) ? approval.travelers.filter(Boolean) : [];
  const city = String(approval?.destination || '').trim();
  const invoiceDays = Number(invoice?.lodging_days ?? invoice?.lodgingDays);
  return {
    city,
    cityCandidates: getCitySearchCandidates(city),
    checkInDate,
    checkOutDate,
    days: Number.isFinite(invoiceDays) && invoiceDays > 0
      ? Math.floor(invoiceDays)
      : calculateLodgingDays(checkInDate, checkOutDate),
    people: Number(approval?.travelerCount) || travelers.length || 1,
    payeeName: String(travelers[0] || approval?.name || '').trim(),
  };
}

export function diffGeneratedRowKeys(before: string[], after: string[]): string[] {
  const existing = new Set(before.filter(Boolean));
  return Array.from(new Set(after.filter((rowkey) => rowkey && !existing.has(rowkey))));
}

function fingerprintInvoiceAmount(fingerprint: string): number | null {
  const amountParts = String(fingerprint || '').split('|').filter((part) => part.startsWith('vat_amount:'));
  const amounts = amountParts.flatMap((part) =>
    (part.slice('vat_amount:'.length).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/g) || [])
      .map(Number)
      .filter(Number.isFinite),
  );
  if (!amounts.length) return null;
  return amounts.reduce((best, value) => Math.abs(value) > Math.abs(best) ? value : best, amounts[0]);
}

function fingerprintHasNonZeroInvoiceAmount(fingerprint: string): boolean {
  const amount = fingerprintInvoiceAmount(fingerprint);
  return amount !== null && Math.abs(amount) > 0;
}

function invoiceAmountsMatch(expectedAmount: number, actualAmount: number): boolean {
  const roundingTolerance = Math.max(0.05, Math.abs(expectedAmount) * 0.000001);
  return Math.abs(actualAmount - expectedAmount) <= roundingTolerance;
}

export interface TableRowSnapshot {
  rowKeys: string[];
  rowCount: number;
  fingerprints?: string[];
  businessCount?: number | null;
  sectionTotal?: number | null;
  targetFound?: boolean;
  targetToken?: string;
  ownedColkeys?: string[];
}

export interface GeneratedRowExpectation {
  expectedRowCount?: number;
  expectedAmount?: number;
}

export interface IndexedTableRowSnapshot extends TableRowSnapshot {
  wrapperIdx: number;
  token: string;
  selectedRowIndexes: number[];
  focusedRowIndexes: number[];
}

export interface SubsidyTableChange {
  wrapperIdx: number;
  rowRef: string;
  before: TableRowSnapshot;
  after: TableRowSnapshot;
  matchedBy: 'token' | 'index' | 'new';
}

const TABLE_INDEX_ROW_PREFIX = '__bip_row_index__:';
type TableTargetRef = number | string;

export function makeTableIndexRowRef(index: number): string {
  return TABLE_INDEX_ROW_PREFIX + Math.max(0, Math.floor(index));
}

export function parseTableIndexRowRef(rowRef: string): number | null {
  if (!String(rowRef).startsWith(TABLE_INDEX_ROW_PREFIX)) return null;
  const index = Number(String(rowRef).slice(TABLE_INDEX_ROW_PREFIX.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

// “增行”会让 BIP 重绘卡片，标题、工具栏与表体不一定仍在同一个 DOM 外壳内。
// 因此点击后不再重新猜测“哪张表像补贴表”，而是只接受全页面唯一的行数 +1。
// DOM 节点仍存在时用临时 token 做稳定匹配；同时必须由新增行的 selected/focused
// 状态确认，避免把其它费用表的异步变化误当成补贴行。
export function resolveSubsidyTableChange(
  beforeTables: IndexedTableRowSnapshot[],
  afterTables: IndexedTableRowSnapshot[],
): SubsidyTableChange | null {
  const beforeByToken = new Map(beforeTables.filter((item) => item.token).map((item) => [item.token, item]));
  const beforeByIndex = new Map(beforeTables.map((item) => [item.wrapperIdx, item]));
  const sameVisibleTableCount = beforeTables.length === afterTables.length;
  const growths: Array<SubsidyTableChange & { countDelta: number; activeEvidence: boolean }> = [];
  let positiveTableChanges = 0;

  for (const after of afterTables) {
    let matchedBy: SubsidyTableChange['matchedBy'] = 'new';
    let before = beforeByToken.get(after.token);
    if (before) {
      matchedBy = 'token';
    } else if (sameVisibleTableCount) {
      before = beforeByIndex.get(after.wrapperIdx);
      if (before) matchedBy = 'index';
    }

    const prior: TableRowSnapshot = before || { rowKeys: [], rowCount: 0, fingerprints: [] };
    const countDelta = after.rowCount - prior.rowCount;
    if (countDelta > 0) positiveTableChanges += 1;
    const beforeActive = Array.from(new Set([
      ...(before?.selectedRowIndexes || []),
      ...(before?.focusedRowIndexes || []),
    ]));
    const afterActive = Array.from(new Set([
      ...after.selectedRowIndexes,
      ...after.focusedRowIndexes,
    ])).filter((index) => index >= 0 && index < after.rowCount);
    const newlyActive = afterActive.filter((index) => !beforeActive.includes(index));

    let rowRef = '';
    let activeEvidence = false;
    if (countDelta === 1) {
      const generatedRows = diffGeneratedRows(prior, after);
      if (generatedRows.length !== 1) continue;
      const generatedIndex = parseTableIndexRowRef(generatedRows[0]);
      // TableNext 可能在真实业务行前后保留占位/虚拟行；若本次恰有一个新激活行，
      // 它比“新增行一定在尾部”的推断更可靠。
      if (newlyActive.length === 1) {
        rowRef = makeTableIndexRowRef(newlyActive[0]);
        activeEvidence = true;
      } else {
        rowRef = generatedRows[0];
        activeEvidence = generatedIndex !== null && afterActive.includes(generatedIndex);
      }
    } else if (countDelta === 0 && newlyActive.length === 1) {
      // 空表可能已经渲染一个预留编辑槽。“增行”只是把该槽原地激活，DOM 行数不变。
      rowRef = makeTableIndexRowRef(newlyActive[0]);
      activeEvidence = true;
    } else {
      continue;
    }

    growths.push({
      wrapperIdx: after.wrapperIdx,
      rowRef,
      before: prior,
      after,
      matchedBy,
      countDelta,
      activeEvidence,
    });
  }

  // 唯一表格 0→1 / 1→2 本身就是“补贴专属增行按钮”造成的直接变化；
  // selected/focused 只作为预留槽原地激活（行数不变）的证据，不再作为唯一增长的硬门槛。
  const positiveCandidates = growths.filter((item) => item.countDelta === 1);
  let change: (typeof growths)[number] | undefined;
  if (positiveTableChanges === 1 && positiveCandidates.length === 1) {
    change = positiveCandidates[0];
  } else if (positiveTableChanges === 0) {
    const activatedSlots = growths.filter((item) => item.countDelta === 0 && item.activeEvidence);
    if (activatedSlots.length === 1) change = activatedSlots[0];
  }
  if (!change) return null;
  const { countDelta: _countDelta, activeEvidence: _activeEvidence, ...result } = change;
  return result;
}

// BIP 横向虚拟表格的新行有时暂时没有 rowkey，或重绘时会复用 rowkey。
// 优先使用稳定 rowkey；若行数确实增加但 rowkey 差集不可靠，则按新增的尾部逻辑行定位。
export function diffGeneratedRows(
  before: TableRowSnapshot,
  after: TableRowSnapshot,
  expectation: GeneratedRowExpectation = {},
): string[] {
  const expectedRowCount = Number.isInteger(expectation.expectedRowCount)
    ? Math.max(0, Number(expectation.expectedRowCount))
    : null;
  const hasBusinessCounts = Number.isInteger(before.businessCount) && Number.isInteger(after.businessCount);
  const businessCountDelta = hasBusinessCounts
    ? Number(after.businessCount) - Number(before.businessCount)
    : null;
  if (expectedRowCount !== null
    && businessCountDelta !== null
    && businessCountDelta !== expectedRowCount) return [];
  const exactBusinessCountEvidence = expectedRowCount !== null
    && businessCountDelta === expectedRowCount;

  const expectedAmount = Number(expectation.expectedAmount);
  const hasExpectedAmount = Number.isFinite(expectedAmount) && Math.abs(expectedAmount) > 0;
  if (hasExpectedAmount
    && Number.isFinite(before.sectionTotal)
    && Number.isFinite(after.sectionTotal)) {
    const actualDelta = Number(after.sectionTotal) - Number(before.sectionTotal);
    if (!invoiceAmountsMatch(expectedAmount, actualDelta)) return [];
  }

  const keyDiff = diffGeneratedRowKeys(before.rowKeys, after.rowKeys);
  const rawCountDelta = after.rowCount - before.rowCount;
  // 表体缩减表示虚拟列表重建、过滤或分页变化，不能把它解释成本次发票生成的新行。
  if (rawCountDelta < 0) return [];
  const countDelta = rawCountDelta;
  if (countDelta > 0) {
    if (expectedRowCount !== null && countDelta !== expectedRowCount) return [];
    // 即使新 rowkey 完整，也统一转换成逻辑行序号。真实 BIP 的固定列和右侧滚动列
    // 分属不同 tbody，右侧 tbody 经常没有左侧 rowkey，序号才能跨表体定位同一逻辑行。
    if (keyDiff.length === countDelta && after.rowKeys.length === after.rowCount) {
      const indexes = keyDiff.map((key) => after.rowKeys.indexOf(key));
      if (indexes.every((index) => index >= 0)) {
        if (hasExpectedAmount && indexes.length === 1 && after.fingerprints?.length === after.rowCount) {
          const amount = fingerprintInvoiceAmount(after.fingerprints[indexes[0]]);
          if (amount === null || !invoiceAmountsMatch(expectedAmount, amount)) return [];
        }
        return indexes.map(makeTableIndexRowRef);
      }
    }
    const fallbackIndexes = Array.from({ length: countDelta }, (_, offset) => before.rowCount + offset);
    if (hasExpectedAmount) {
      if (fallbackIndexes.length !== 1 || after.fingerprints?.length !== after.rowCount) return [];
      const amount = fingerprintInvoiceAmount(after.fingerprints[fallbackIndexes[0]]);
      if (amount === null || !invoiceAmountsMatch(expectedAmount, amount)) return [];
    }
    return fallbackIndexes.map(makeTableIndexRowRef);
  }
  // 逻辑行数不变时，虚拟列表可能只替换一个可见槽位，此时唯一的新 rowkey
  // 仍可安全定位。若多个/全部 rowkey 同时变化，更可能是整表重绘，无法判断哪行
  // 才是本次发票生成的明细，必须停止而不是误改旧行。
  const comparableFingerprints = before.rowCount === after.rowCount
    && before.rowCount > 0
    && before.fingerprints?.length === before.rowCount
    && after.fingerprints?.length === after.rowCount;
  if (keyDiff.length === 1) {
    const indexes = keyDiff.map((key) => after.rowKeys.indexOf(key));
    if (indexes.every((index) => index >= 0)) {
      if (comparableFingerprints) {
        const generated = indexes.filter((index) =>
          !fingerprintHasNonZeroInvoiceAmount(before.fingerprints![index])
          && fingerprintHasNonZeroInvoiceAmount(after.fingerprints![index]),
        );
        if (generated.length === 1 && hasExpectedAmount) {
          const amount = fingerprintInvoiceAmount(after.fingerprints![generated[0]]);
          if (amount === null || !invoiceAmountsMatch(expectedAmount, amount)) return [];
        }
        if (generated.length === 1) return generated.map(makeTableIndexRowRef);
        // 横向虚拟列尚未挂载时，指纹里可能看不到 vat_amount。此时只有“业务条数
        // 精确增加 + 唯一新 rowkey + 该槽业务内容确实改变”三项同时成立才接受。
        const changedNewKeys = indexes.filter((index) =>
          before.fingerprints![index] !== after.fingerprints![index],
        );
        if (exactBusinessCountEvidence && changedNewKeys.length === indexes.length) {
          return indexes.map(makeTableIndexRowRef);
        }
        return [];
      }
      if (hasExpectedAmount && indexes.length === 1) {
        const amount = fingerprintInvoiceAmount(after.fingerprints?.[indexes[0]] || '');
        if (amount === null || !invoiceAmountsMatch(expectedAmount, amount)) return [];
      }
      return indexes.map(makeTableIndexRowRef);
    }
  }
  // 有些 BIP 版本会预留空白费用行，发票回填时行数和 rowkey 都不变。
  // 只有恰好一个逻辑行的业务指纹发生变化时，才把该行视作本次生成行；多个变化仍停止猜测。
  if (comparableFingerprints) {
    const length = after.rowCount;
    const changed: number[] = [];
    for (let index = 0; index < length; index++) {
      if (before.fingerprints[index] !== after.fingerprints[index]) changed.push(index);
    }
    const generated = changed.filter((index) =>
      !fingerprintHasNonZeroInvoiceAmount(before.fingerprints![index])
      && fingerprintHasNonZeroInvoiceAmount(after.fingerprints![index]),
    );
    if (changed.length === 1 && generated.length === 1) {
      if (hasExpectedAmount) {
        const amount = fingerprintInvoiceAmount(after.fingerprints![generated[0]]);
        if (amount === null || !invoiceAmountsMatch(expectedAmount, amount)) return [];
      }
      return [makeTableIndexRowRef(generated[0])];
    }
    if (changed.length === 1 && exactBusinessCountEvidence && after.fingerprints![changed[0]]) {
      return [makeTableIndexRowRef(changed[0])];
    }
  }
  return [];
}

export class ReimbursementAutomation {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  page: Page | null = null;
  private progressCb: ((msg: string, pct: number) => void) | null = null;

  // 诊断文件目录。run() 会切换到本次填单专属目录，避免下一次出错覆盖上一次的现场。
  private diagnosticDir = path.resolve(process.cwd(), 'sessions');

  private ensureDiagnosticDir(): string {
    fs.mkdirSync(this.diagnosticDir, { recursive: true });
    return this.diagnosticDir;
  }

  private diagFile(name: string): string {
    return path.resolve(this.ensureDiagnosticDir(), name);
  }

  private diagLabel(name: string): string {
    return path.relative(process.cwd(), path.resolve(this.diagnosticDir, name)) || name;
  }

  onProgress(cb: (msg: string, pct: number) => void) { this.progressCb = cb; }
  private lastProgressPct = 0;
  private async p(msg: string, pct: number) {
    this.lastProgressPct = pct;
    this.progressCb?.(msg, pct);
  }

  private safeSleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

  // 主表单 iframe（录制时的链式定位）
  private mf() {
    return this.page!.locator('#forwardFrame').contentFrame().locator('#mainiframe').contentFrame();
  }

  // 全流程通用：检测"强制登录"弹窗并点确认
  private async checkForceLogin(): Promise<boolean> {
    if (!this.page || this.page.isClosed()) return false;
    try {
      const roots: any[] = [
        this.page.locator('body'),
        this.page.locator('#forwardFrame').contentFrame().locator('body'),
      ];
      for (const root of roots) {
        const force = root.getByText('强制登录').first();
        if (await force.isVisible().catch(() => false)) {
          console.log('检测到强制登录弹窗，点击确认');
          const btn = root.getByRole('button', { name: /确定|确认|OK/ }).first();
          await btn.waitFor({ state: 'visible', timeout: 3000 });
          await btn.click();
          await this.page!.waitForTimeout(1500);
          return true;
        }
      }
    } catch {}
    return false;
  }

  async start(): Promise<Page> {
    const useBundledChromium = process.env.REIMBURSEMENT_OFFLINE === '1'
      || Boolean(process.env.PLAYWRIGHT_BROWSERS_PATH?.trim());
    this.browser = await chromium.launch({
      headless: false,
      ...(useBundledChromium ? {} : { channel: 'chrome' as const }),
    });
    this.context = await this.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    // BIP 经常响应慢：未单独指定超时的点击/填写/等待默认放宽到 60 秒，页面跳转 120 秒。
    this.context.setDefaultTimeout(60000);
    this.context.setDefaultNavigationTimeout(120000);
    // 导航时 BIP 会新开页面，每个页面都注册弹窗处理。
    this.context.on('page', (page) => { void this.installPopupHandlers(page); });
    this.page = await this.context.newPage();
    return this.page;
  }

  // “强制登录”弹窗可能在任意一步出现并遮住目标元素。原先只在大步骤之间轮询检查，
  // 步骤中途弹出就会让点击超时。addLocatorHandler 会在每次操作前检查，出现时先关闭再继续。
  // 只匹配对话框容器内含“强制登录”的元素，避免页面上普通文字触发误点“确定”。
  private async installPopupHandlers(page: Page): Promise<void> {
    const roots = [
      page.locator('body'),
      page.locator('#forwardFrame').contentFrame().locator('body'),
      page.locator('#forwardFrame').contentFrame().locator('#mainiframe').contentFrame().locator('body'),
    ];
    const dialogSelector = ':is([role="dialog"], [role="alertdialog"], [class*="modal"], [class*="dialog"], '
      + '[class*="message-box"], [class*="popconfirm"], [class*="confirm"]):visible';
    for (const root of roots) {
      const dialog = root.locator(dialogSelector).filter({ hasText: '强制登录' }).last();
      try {
        await page.addLocatorHandler(dialog, async () => {
          try {
            console.log('检测到强制登录弹窗（操作前自动处理），点击确认');
            await dialog.getByRole('button', { name: /确定|确认|OK/ }).first().click({ timeout: 3000 });
          } catch (error) {
            console.log('自动处理强制登录弹窗失败:', (error as Error).message.slice(0, 160));
          }
        }, { noWaitAfter: true });
      } catch (error) {
        console.log('注册强制登录弹窗处理失败:', (error as Error).message.slice(0, 160));
      }
    }
  }

  // ── 登录 ──
  async login() {
    await this.p('正在打开BIP登录页...', 8);
    // 不用 networkidle：BIP 有持续轮询，网络慢时可能永远等不到“空闲”。等页面结构加载，
    // 再由下面填写用户名时自动等待输入框出现（默认超时已放宽到 60 秒）。
    await this.page!.goto(config.bipUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await this.p('正在输入账号密码...', 12);
    const lf = this.page!.locator('#forwardFrame').contentFrame();
    await lf.getByRole('textbox', { name: '用户名' }).fill(config.bipUsername, { timeout: 90000 });
    await lf.getByRole('textbox', { name: '密码' }).fill(config.bipPassword);
    try { await lf.getByRole('checkbox', { name: /记住账号/ }).check(); } catch {}
    await this.p('正在登录...', 15);
    await lf.getByRole('button', { name: '登录' }).click();
    // 网络慢时登录要好一会儿才跳转：最多等 90 秒登录按钮消失，期间处理“强制登录”弹窗。
    // 旧逻辑 2 秒后按钮还在就判定失败，会把“登录慢”误报成“账号密码错误”。
    const loginButton = lf.getByRole('button', { name: '登录' });
    const loginDeadline = Date.now() + 90000;
    let loggedIn = false;
    let lastReport = 0;
    while (Date.now() < loginDeadline) {
      await this.handleForceLogin();
      if (!(await loginButton.isVisible().catch(() => false))) {
        // 按钮消失后再确认一次，避免页面重绘的瞬间被误判
        await this.safeSleep(800);
        if (!(await loginButton.isVisible().catch(() => false))) { loggedIn = true; break; }
      }
      const loginError = lf.getByText(/密码错误|用户名或密码|账号.*锁定|验证码/).first();
      if (await loginError.isVisible().catch(() => false)) {
        throw new Error('BIP 登录未成功：' + ((await loginError.textContent().catch(() => '')) || '').trim());
      }
      if (Date.now() - lastReport > 10000) {
        lastReport = Date.now();
        await this.p('正在登录，BIP 响应较慢，请稍候...', 15);
      }
      await this.safeSleep(1000);
    }
    if (!loggedIn) {
      throw new Error('BIP 登录 90 秒仍未完成，请检查账号、密码、网络或登录页提示');
    }
    await this.p('登录成功', 20);
  }

  // 处理"强制登录"弹窗：页面级或登录 iframe 内查找并点确认
  private async handleForceLogin(): Promise<boolean> {
    const roots: any[] = [
      this.page!.locator('body'),
      this.page!.locator('#forwardFrame').contentFrame().locator('body'),
    ];
    for (const root of roots) {
      try {
        const force = root.getByText('强制登录').first();
        if (await force.isVisible().catch(() => false)) {
          console.log('检测到强制登录弹窗，点击确认');
          const btn = root.getByRole('button', { name: /确定|确认|OK/ }).first();
          await btn.waitFor({ state: 'visible', timeout: 3000 });
          await btn.click();
          await this.page!.waitForTimeout(1500);
          return true;
        }
      } catch {}
    }
    return false;
  }

  // ── 导航到差旅费用报账单（自制新单）──
  // 在页面所有 frame 中找按钮并点击
  private async clickButtonAnywhere(page: Page, text: string) {
    for (let round = 0; round < 5; round++) {
      await this.checkForceLogin();
      for (const f of page.frames()) {
        const btn = f.locator('button').filter({ hasText: text }).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 5000 });
          return;
        }
        const txt = f.getByText(text, { exact: true }).first();
        if (await txt.isVisible().catch(() => false)) {
          await txt.click({ timeout: 5000 });
          return;
        }
      }
      await this.page!.waitForTimeout(2500);
    }
    await page.locator('#forwardFrame').contentFrame().locator('#mainiframe').contentFrame().getByRole('button', { name: text }).click({ timeout: 10000 });
  }

  // 在页面所有 frame 中找文本并点击
  private async clickTextAnywhere(page: Page, text: string) {
    for (let round = 0; round < 5; round++) {
      await this.checkForceLogin();
      for (const f of page.frames()) {
        const el = f.getByText(text).first();
        if (await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 5000 });
          return;
        }
        const btn = f.locator('button').filter({ hasText: text }).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 5000 });
          return;
        }
      }
      await this.page!.waitForTimeout(2500);
    }
    await page.locator('#forwardFrame').contentFrame().locator('#mainiframe').contentFrame().getByText(text).click({ timeout: 10000 });
  }

  // 在所有页面/iframe 中找按钮或文本并点击（处理导航时新开页面的情况）
  // 按时间而不是固定轮数重试：网络慢时列表页要很久才显示“新增”。
  private async clickTextInAnyPage(text: string, timeout = 60000): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      this.ensurePage();
      await this.checkForceLogin();
      const pages = this.context!.pages().filter((p: any) => !p.isClosed());
      for (const p of pages) {
        for (const f of p.frames()) {
          const btn = f.locator('button').filter({ hasText: text }).first();
          if (await btn.isVisible().catch(() => false)) {
            await btn.click({ timeout: 5000 });
            return true;
          }
          const el = f.getByText(text, { exact: true }).first();
          if (await el.isVisible().catch(() => false)) {
            await el.click({ timeout: 5000 });
            return true;
          }
        }
      }
      await this.safeSleep(2000);
    }
    return false;
  }

  // 页面任一 frame 是否在显示 BIP 的加载层 / 转圈 / “加载中”文字（默认检查当前页）。
  private async isBipBusy(page: Page | null = this.page): Promise<boolean> {
    if (!page || page.isClosed()) return false;
    for (const frame of page.frames()) {
      // evaluate 内不定义具名函数：tsx/esbuild 会注入浏览器端不存在的 __name。
      const busy = await frame.evaluate(() => {
        const selectors = '.wui-loading-mask, .wui-spin-spinning, .next-loading-tip, .next-loading-indicator, '
          + '.loading-mask, [aria-busy="true"], .nc-loading, .u-loading, .ant-spin-spinning';
        const candidates = Array.from(document.querySelectorAll(selectors));
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = (node.textContent || '').trim();
          if (text && text.length <= 8 && /^(加载中|处理中|保存中|正在加载)[.…。]*$/.test(text) && node.parentElement) {
            candidates.push(node.parentElement);
          }
        }
        for (const el of candidates) {
          const style = window.getComputedStyle(el as HTMLElement);
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
            && rect.width > 0 && rect.height > 0) return true;
        }
        return false;
      }).catch(() => false);
      if (busy) return true;
    }
    return false;
  }

  // BIP 网络经常响应慢：等到所有 frame 的加载层消失并稳定一小段时间再继续。
  // 慢时持续向页面报告等待进度；超时不抛错，由后续步骤的具体检查决定成败。
  private async waitForBipReady(label: string, timeout = 120000, page: Page | null = this.page): Promise<boolean> {
    const started = Date.now();
    let idleSince = 0;
    let lastReport = 0;
    while (Date.now() - started < timeout) {
      if (await this.isBipBusy(page)) {
        idleSince = 0;
        const waited = Math.round((Date.now() - started) / 1000);
        if (waited >= 5 && Date.now() - lastReport >= 5000) {
          lastReport = Date.now();
          console.log(`  BIP 响应较慢，${label}，已等待 ${waited} 秒...`);
          this.progressCb?.(`BIP 响应较慢，${label}，已等待 ${waited} 秒...`, this.lastProgressPct);
        }
      } else {
        if (!idleSince) idleSince = Date.now();
        if (Date.now() - idleSince >= 800) return true;
      }
      await this.safeSleep(400);
    }
    console.log(`  ${label}：等待 ${Math.round(timeout / 1000)} 秒后页面仍在加载，继续尝试`);
    return false;
  }

  // locator.isVisible() 会忽略 timeout 立即返回；需要“最多等多久”时用这个。
  private async waitVisible(locator: any, timeout: number): Promise<boolean> {
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return true;
    } catch {
      return false;
    }
  }

  // 点击后 BIP 可能新开页面，也可能在当前页打开；等到新页面就切过去，否则留在当前页。
  private async clickAndFollowPage(trigger: () => Promise<void>): Promise<Page> {
    const pagePromise = this.context!.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    await trigger();
    return (await pagePromise) || this.page!;
  }

  // 用方向键把下拉框的高亮项移到目标应用后回车；高亮项文字不对时绝不回车，避免打开别的应用。
  private async selectSearchResultByKeyboard(lf: any, search: any, appName: string): Promise<Page | null> {
    const option = lf.locator('.ant-select-dropdown:visible :is(li[role="option"], .ant-select-dropdown-menu-item)')
      .filter({ hasText: appName }).first();
    if (!await this.waitVisible(option, 5000)) {
      await search.fill('').catch(() => {});
      await search.fill(appName).catch(() => {});
      if (!await this.waitVisible(option, 15000)) return null;
    }
    const active = lf.locator(
      '.ant-select-dropdown:visible :is(.ant-select-dropdown-menu-item-active, [aria-selected="true"], .ant-select-item-option-active)',
    ).first();
    for (let step = 0; step < 15; step++) {
      const text = ((await active.textContent().catch(() => '')) || '').replace(/\s+/g, '');
      if (text === appName) {
        try {
          return await this.clickAndFollowPage(() => search.press('Enter'));
        } catch {
          return null;
        }
      }
      await search.press('ArrowDown').catch(() => {});
      await this.safeSleep(150);
    }
    return null;
  }

  // 打开“差旅费用报账单”应用。不能点“首页第一个应用图标”：工作台的常用应用会被调整
  // （例如只剩“我的单据”），点错应用后就找不到“新增”。按以下顺序找：
  // 1) 首页常用应用里标题就是差旅费用报账单的图标；2) 顶部“请输入应用名称”搜索；
  // 3) 首页“全员业务平台”图标（进入后再点差旅费用报账单）。
  private async openTravelExpenseApp(): Promise<Page> {
    const lf = this.page!.locator('#forwardFrame').contentFrame();
    const appName = '差旅费用报账单';

    // 登录后首页还在加载；先等到搜索框或任一应用图标出现，再逐项判断。
    // 注意 isVisible({ timeout }) 不会等待，必须用 waitFor。
    await this.waitVisible(lf.locator('input[placeholder="请输入应用名称"], .app-group-item').first(), 30000);

    const directTile = lf.locator(`.app-group-item[title="${appName}"]`).first();
    if (await this.waitVisible(directTile, 2000)) {
      console.log('导航：点击首页常用应用“' + appName + '”');
      return this.clickAndFollowPage(() => directTile.click());
    }

    const search = lf.locator('input[placeholder="请输入应用名称"]').first();
    const hasSearch = await this.waitVisible(search, 5000);
    if (hasSearch) {
      console.log('导航：在顶部应用搜索中查找“' + appName + '”');
      // 搜索结果是 Ant Design 下拉框。网络慢时结果会边加载边重绘，下拉框可能在点击瞬间
      // 正在动画或被收起；短超时点击，失败就重新输入再试，最后用键盘选中后回车。
      const option = lf.locator(
        '.ant-select-dropdown:visible :is(li[role="option"], .ant-select-dropdown-menu-item, [class*="option"])',
      ).filter({ hasText: appName }).first();
      for (let attempt = 1; attempt <= 3; attempt++) {
        await search.click().catch(() => {});
        await search.fill('').catch(() => {});
        await search.fill(appName);
        if (!await this.waitVisible(option, 20000)) {
          console.log(`导航：第 ${attempt} 次搜索未列出“${appName}”`);
          continue;
        }
        await this.safeSleep(800); // 等下拉动画和结果重绘稳定
        try {
          return await this.clickAndFollowPage(() => option.click({ timeout: 5000 }));
        } catch {
          console.log(`导航：第 ${attempt} 次点击搜索结果失败（下拉框在重绘或已收起），改用键盘选择`);
        }
        const viaKeyboard = await this.selectSearchResultByKeyboard(lf, search, appName);
        if (viaKeyboard) return viaKeyboard;
      }
      console.log('导航：应用搜索 3 次都没能打开“' + appName + '”');
    }

    const platformTile = lf.locator('.app-group-item[title*="全员业务平台"], .app-group-item[title*="共享服务"]').first();
    if (await this.waitVisible(platformTile, 2000)) {
      console.log('导航：点击首页“全员业务平台”');
      return this.clickAndFollowPage(() => platformTile.click());
    }

    if (hasSearch) {
      // 最后一招：部分版本在搜索框回车即打开第一条匹配结果；能否进入由后续“新增”步骤确认。
      console.log('导航：在应用搜索框按回车打开第一条结果');
      return this.clickAndFollowPage(() => search.press('Enter'));
    }

    const tiles = await lf.locator('.app-group-item[title]').evaluateAll(
      (items) => items.map((item) => item.getAttribute('title') || ''),
    ).catch(() => [] as string[]);
    throw new Error(
      '无法打开“' + appName + '”：首页常用应用中没有它（现有：' + (tiles.join('、') || '无') + '），'
      + '顶部应用搜索也没有找到。请在 BIP 首页把“' + appName + '”加入常用应用后重试',
    );
  }

  async navigateToForm() {
    await this.p('正在导航到差旅费用报账单...', 25);
    const workPage = await this.openTravelExpenseApp();
    await this.waitForBipReady('正在打开差旅费用报账单', 120000, workPage);
    await this.checkForceLogin();

    // 点差旅费用报账单（可能开新页，也可能在 iframe 内打开）
    try {
      await workPage.locator('#forwardFrame').contentFrame().locator('#mainiframe').contentFrame().getByText('差旅费用报账单').first().click({ timeout: 8000 });
      await this.waitForBipReady('正在打开差旅费用报账单列表', 120000, workPage);
    } catch {}
    await this.checkForceLogin();

    // 新增（扫描所有页面/iframe，网络慢时最多找 60 秒）
    const addOk = await this.clickTextInAnyPage('新增');
    if (!addOk) throw new Error('60 秒内未找到“新增”按钮，无法新建报账单（BIP 可能仍在加载）');
    await this.safeSleep(1000);
    await this.checkForceLogin();

    // 自制
    const selfOk = await this.clickTextInAnyPage('自制');
    if (!selfOk) throw new Error('60 秒内未找到“自制”入口，无法进入报账单表单（BIP 可能仍在加载）');
    await this.checkForceLogin();

    // 表单可能在新页面打开，也可能很久才加载完：在所有页面里找“报账事由”输入框，
    // 找到的那一页才是表单页。不再固定等几秒后直接取“最后一个页面”。
    const formPage = await this.waitForFormPage(150000);
    if (!formPage) {
      throw new Error('点击“自制”后 150 秒内报账单表单仍未加载出来（BIP 网络较慢），请稍后重试');
    }
    this.page = formPage;
    await this.waitForBipReady('正在加载报账单表单', 60000);
    await this.p('已进入报账单表单', 30);
  }

  // 在所有打开的页面中查找已经加载出“报账事由”输入框的报账单表单页。
  private async waitForFormPage(timeout: number): Promise<Page | null> {
    const started = Date.now();
    let lastReport = 0;
    while (Date.now() - started < timeout) {
      const pages = this.context!.pages().filter((p) => !p.isClosed()).reverse();
      for (const page of pages) {
        const summaryInput = page.locator('#forwardFrame').contentFrame()
          .locator('#mainiframe').contentFrame().locator('.form-item.zy input').first();
        if (await summaryInput.isVisible().catch(() => false)) return page;
      }
      const waited = Math.round((Date.now() - started) / 1000);
      if (waited >= 5 && Date.now() - lastReport >= 5000) {
        lastReport = Date.now();
        await this.p(`BIP 响应较慢，正在等待报账单表单加载，已等待 ${waited} 秒...`, 28);
      }
      await this.checkForceLogin();
      await this.safeSleep(500);
    }
    return null;
  }

  // ── 基本信息（报销事由/结算方式/付款银行/预算项目）──
  async fillBasicInfo(summary: string) {
    await this.p('正在填写基本信息...', 32);
    const fc = getFillConfig();
    const mf = this.mf();

    // 报账事由（注意不是报账单位/报账部门；class=zy）
    let summaryFilled = false;
    try {
      await mf.locator('.form-item.zy input').first().fill(summary);
      summaryFilled = true;
    } catch (e) {
      console.log('报账事由输入框未命中:', e.message);
    }
    if (!summaryFilled) throw new Error('报账事由填写失败');
    await this.page!.waitForTimeout(300);

    // 报账人（class=jkbxr，点击触发）
    try { await mf.locator('.form-item.jkbxr').first().click(); await this.page!.waitForTimeout(500); } catch {}

    // 结算方式（class=jsfs）
    if (!await this.selectReferByItem('jsfs', '结算方式', FIXED_SETTLEMENT_METHOD)) {
      throw new Error('结算方式选择失败');
    }
    // 付款银行账户（class=fkyhzh，选银行后需点账号行）
    if (!await this.selectReferByItem('fkyhzh', '付款银行账户', fc.paymentBank || config.paymentBank, true)) {
      throw new Error('付款银行账户选择失败');
    }
    // 资金预算项目（class=zyx72，树形选择）
    if (!await this.selectBudget(fc.budgetItem || config.budgetItem)) {
      throw new Error('资金预算项目选择失败');
    }

    await this.p('基本信息填写完成', 40);
  }

  private async confirmPopup(): Promise<boolean> {
    const roots: any[] = [this.mf(), this.page!];
    for (const root of roots) {
      try {
        const exact = root.getByRole('button', { name: '确定(Y)' }).last();
        if (await this.waitVisible(exact, 1200)) {
          await exact.click();
          await this.page!.waitForTimeout(600);
          await this.waitForBipReady('正在回填所选内容', 60000);
          return true;
        }
        const broad = root.getByRole('button', { name: /确定|确认/ }).last();
        if (await this.waitVisible(broad, 1200)) {
          await broad.click();
          await this.page!.waitForTimeout(600);
          await this.waitForBipReady('正在回填所选内容', 60000);
          return true;
        }
      } catch {}
    }
    // 某些单选参照在点击结果后会自动关闭，不再要求额外确认。
    for (const root of roots) {
      const popup = root.locator('.refer-pop-window-show, .popup-window, .refer-popover, .wui-popup, .modal').last();
      if (await popup.isVisible().catch(() => false)) {
        console.log('confirmPopup: 参照弹窗仍可见，但确定按钮未找到');
        return false;
      }
    }
    return true;
  }

  private async clickOption(mf: any, optionText: string): Promise<boolean> {
    // a 标签优先（预算项目、付款银行）
    const optA = mf.locator('a').filter({ hasText: optionText }).first();
    if (await this.waitVisible(optA, 1500)) {
      if (await optA.click({ timeout: 10000 }).then(() => true, () => false)) return true;
    }
    // 精确文本（结算方式"联动支付"等）
    const optT = mf.getByText(optionText, { exact: true }).first();
    if (await this.waitVisible(optT, 1500)) {
      if (await optT.click({ timeout: 10000 }).then(() => true, () => false)) return true;
    }
    // 模糊文本
    const optC = mf.getByText(optionText).first();
    if (await this.waitVisible(optC, 1500)) {
      if (await optC.click({ timeout: 10000 }).then(() => true, () => false)) return true;
    }
    return false;
  }

  private async selectReferByItem(itemClass: string, stepName: string, optionText: string, withCell = false): Promise<boolean> {
    await this.p('正在选择' + stepName + ': ' + optionText, 34);
    const mf = this.mf();
    try {
      const icon = mf.locator('.form-item.' + itemClass + ' .icon-refer').first();
      await icon.waitFor({ state: 'visible', timeout: 5000 });
      await icon.click();
      // 等参照弹窗/下拉加载出目标选项再选，网络慢时固定 1.2 秒不够。
      if (!await this.waitForReferResult([optionText], 30000)) {
        console.log('selectReferByItem(' + stepName + '): 30 秒内未加载出选项 ' + optionText + '，仍尝试选择');
      }

      let clicked = await this.clickOption(mf, optionText);
      if (!clicked) {
        // 表格选择：第一行
        const cell1 = mf.getByRole('cell', { name: '1', exact: true }).first();
        if (await this.waitVisible(cell1, 2000)) {
          await cell1.click();
          clicked = true;
        }
      }
      await this.page!.waitForTimeout(500);

      // 付款银行账户：选中银行后，等待右侧"银行账户子户"表格加载并点第一行
      if (clicked && withCell) {
        let rowClicked = false;
        try {
          const row = mf.locator('.refer-pop-window-show .wui-table-body tr:visible, .popup-window .wui-table-body tr:visible, .wui-table-body tr:visible').first();
          await row.waitFor({ state: 'visible', timeout: 8000 });
          await row.click();
          await this.page!.waitForTimeout(500);
          rowClicked = true;
        } catch {}
        if (!rowClicked) {
          const cell1 = mf.getByRole('cell', { name: '1', exact: true }).first();
          if (await this.waitVisible(cell1, 3000)) { await cell1.click(); rowClicked = true; }
        }
        if (!rowClicked) {
          console.log('selectReferByItem(付款银行账户): 未找到子户表格行');
          return false;
        }
      }

      if (clicked) return await this.confirmPopup();
      console.log('selectReferByItem(' + stepName + '): 未找到选项 ' + optionText);
      return false;
    } catch (e) {
      console.log('selectReferByItem(' + stepName + ') 跳过:', e);
      return false;
    }
  }

  private async selectBudget(budgetText: string): Promise<boolean> {
    // 搜索关键词：去掉单位预算项目中可能存在的编号前缀。
    const keyword = String(budgetText || '').replace(/^[\d.\s]+/, '');
    await this.p('正在搜索资金预算项目: ' + keyword, 36);
    const mf = this.mf();
    try {
      const icon = mf.locator('.form-item.zyx72 .icon-refer').first();
      await icon.waitFor({ state: 'visible', timeout: 5000 });
      await icon.click();
      await this.page!.waitForTimeout(1200);

      const search = mf.getByPlaceholder('搜索资金预算项目');
      await search.waitFor({ state: 'visible', timeout: 5000 });
      await search.fill(keyword);
      await search.press('Enter');
      await this.page!.waitForTimeout(1500);

      const clicked = await this.clickOption(mf, keyword);
      await this.page!.waitForTimeout(400);
      if (clicked) return await this.confirmPopup();
      console.log('selectBudget: 未找到选项 ' + keyword);
      return false;
    } catch (e) {
      console.log('selectBudget 跳过:', e);
      return false;
    }
  }

  // ── 出差补助（按解析数据生成行）──
  async fillSubsidy(subsidy: any, reimbursementSummary?: string): Promise<number> {
    const { entries } = normalizeSubsidy(subsidy);
    await this.p('正在填写出差补助...', 45);
    const fc = getFillConfig();
    const summary = String(reimbursementSummary || '').trim();
    if (!summary) throw new Error('无法从上传材料解析报账事由，已停止自动填写');
    const bankAccount = fc.bankAccount || config.bankAccount || '';

    let rowIndex = 0;
    for (const e of entries) {
      const days = e.days;
      const people = e.people;
      const rowSummary = entries.length > 1 ? `${e.name}：${summary}` : summary;
      const mealTotal = e.meal_allowance || 0;      // 伙食总金额（费率×天数）
      const transportTotal = e.transport_allowance || 0; // 交通总金额
      // 每行一个费用类型：交通费 + 伙食费
      const rows = [
        { label: FIXED_SUBSIDY_TRANSPORT_TYPE, amount: transportTotal },
        { label: FIXED_SUBSIDY_MEAL_TYPE, amount: mealTotal },
      ];
      for (const r of rows) {
        if (r.amount <= 0) continue;
        await this.fillSubsidyRow(rowSummary, r.label, days, people, r.amount, bankAccount, rowIndex);
        rowIndex++;
      }
    }
    await this.p('出差补助填写完成', 55);
    return rowIndex;
  }

  private ensurePage() {
    if (!this.page || this.page.isClosed()) {
      const pages = this.context ? this.context.pages() : [];
      if (pages.length) this.page = pages[pages.length - 1];
    }
  }

  // 真实 BIP 中“出差补贴”标题、工具栏和表体并不总在同一个最内层容器：标题常是
  // 工具栏/表体共同容器的兄弟节点。这里分别用补助专属工具栏和补助专属列结构定位，
  // 不再要求最内层共同祖先同时包含标题，也不要求目标当前位于浏览器视口内。
  private async inspectSubsidyTarget(clickAdd: boolean): Promise<{
    wrapperIdx: number;
    clicked: boolean;
    buttonCount: number;
    structuralMatches: number[];
    tableCount: number;
  }> {
    const frame = this.mainFrame();
    return frame.evaluate(({ shouldClick }) => {
      const tables = Array.from(document.querySelectorAll('#hot-key-bzitem'));
      const renderedTables = tables.filter((element) => {
        let node: Element | null = element;
        while (node && node !== document.documentElement) {
          const style = window.getComputedStyle(node as HTMLElement);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
            || Number(style.opacity) === 0 || node.getAttribute('aria-hidden') === 'true') return false;
          node = node.parentElement;
        }
        const ownRect = (element as HTMLElement).getBoundingClientRect();
        if (ownRect.width > 0 && ownRect.height > 0) return true;
        // 部分 BIP 外壳使用 display:contents/零尺寸容器，但其表头或按钮仍正常渲染。
        return Array.from(element.querySelectorAll('button, th, td, input')).some((child) => {
          const rect = (child as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      });
      const structuralMatches = renderedTables.filter((table) => {
        const colkeys = new Set(
          Array.from(table.querySelectorAll('[colkey]'))
            .map((element) => element.getAttribute('colkey') || '')
            .filter(Boolean),
        );
        const signatureCount = ['pk_reimtype', 'defitem9', 'defitem5', 'vat_amount']
          .filter((key) => colkeys.has(key)).length;
        if (colkeys.has('pk_reimtype') && signatureCount >= 3) return true;
        const text = (table.textContent || '').replace(/\s+/g, '');
        return text.includes('补助类型') && text.includes('出差天数')
          && text.includes('出差人数') && text.includes('补助金额');
      });

      const toolbarNodes = Array.from(document.querySelectorAll('[class*="bzitem_card_body-button"]'));
      const addButtons: Element[] = [];
      for (const toolbar of toolbarNodes) {
        for (const button of Array.from(toolbar.querySelectorAll('button'))) {
          if ((button.textContent || '').replace(/\s+/g, '') !== '增行') continue;
          let rendered = true;
          let node: Element | null = button;
          while (node && node !== document.documentElement) {
            const style = window.getComputedStyle(node as HTMLElement);
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
              || Number(style.opacity) === 0 || node.getAttribute('aria-hidden') === 'true') {
              rendered = false;
              break;
            }
            node = node.parentElement;
          }
          const rect = (button as HTMLElement).getBoundingClientRect();
          if (rendered && rect.width > 0 && rect.height > 0 && !addButtons.includes(button)) addButtons.push(button);
        }
      }

      let targetTable: Element | null = structuralMatches.length === 1 ? structuralMatches[0] : null;
      // 兼容表头尚未完成虚拟渲染的页面：补助专属工具栏向上寻找其唯一的已渲染表体。
      if (!targetTable && addButtons.length === 1) {
        let node: Element | null = addButtons[0].parentElement;
        for (let depth = 0; depth < 18 && node; depth++, node = node.parentElement) {
          const inside = Array.from(node.querySelectorAll('#hot-key-bzitem')).filter((element) => {
            let ancestor: Element | null = element;
            while (ancestor && ancestor !== document.documentElement) {
              const style = window.getComputedStyle(ancestor as HTMLElement);
              if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
                || Number(style.opacity) === 0 || ancestor.getAttribute('aria-hidden') === 'true') return false;
              ancestor = ancestor.parentElement;
            }
            const rect = (element as HTMLElement).getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return true;
            return Array.from(element.querySelectorAll('th, td, input')).some((child) => {
              const childRect = (child as HTMLElement).getBoundingClientRect();
              return childRect.width > 0 && childRect.height > 0;
            });
          });
          if (inside.length === 1) {
            targetTable = inside[0];
            break;
          }
        }
      }

      if (targetTable) (targetTable as HTMLElement).scrollIntoView({ block: 'center' });
      else if (addButtons.length === 1) (addButtons[0] as HTMLElement).scrollIntoView({ block: 'center' });

      let clicked = false;
      if (shouldClick && addButtons.length === 1) {
        (addButtons[0] as HTMLElement).click();
        clicked = true;
      }
      return {
        wrapperIdx: targetTable ? tables.indexOf(targetTable) : -1,
        clicked,
        buttonCount: addButtons.length,
        structuralMatches: structuralMatches.map((table) => tables.indexOf(table)),
        tableCount: tables.length,
      };
    }, { shouldClick: clickAdd });
  }

  // 点击补助专属“增行”。工具栏类名使用包含匹配，以兼容 BIP 在类名前后增加前缀/后缀。
  private async clickSubsidyAddRow() {
    await this.waitForBipReady('正在等待出差补贴区域加载', 60000);
    let last: Awaited<ReturnType<ReimbursementAutomation['inspectSubsidyTarget']>> | null = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      last = await this.inspectSubsidyTarget(false).catch((error) => {
        console.log('  出差补贴增行预定位 evaluate 失败:', (error as Error).message.slice(0, 240));
        return null;
      });
      if (last?.buttonCount === 1) break;
      await this.page!.waitForTimeout(400);
    }
    if (last?.buttonCount === 1) {
      // 只执行一次真正点击；即使页面在点击瞬间重绘，也绝不重试以免重复增行。
      const clicked = await this.inspectSubsidyTarget(true).catch((error) => {
        console.log('  出差补贴增行点击 evaluate 失败:', (error as Error).message.slice(0, 240));
        return null;
      });
      if (clicked?.clicked) return;
    }
    console.log('  出差补贴增行定位诊断:', JSON.stringify(last));
    throw new Error('无法确认“出差补贴”专属增行按钮，已停止以避免修改其他费用区');
  }

  private mainFrame(): any {
    const frames = this.page!.frames();
    return frames.find((f: any) => f.name() === 'mainiframe') || frames[frames.length - 1];
  }

  // 优先通过补助专属列结构定位；表格在页面下方但未进入视口时仍然有效。
  private async getSubsidyWrapperIndex(): Promise<number> {
    await this.waitForBipReady('正在等待出差补贴区域加载', 60000);
    let last: Awaited<ReturnType<ReimbursementAutomation['inspectSubsidyTarget']>> | null = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      last = await this.inspectSubsidyTarget(false).catch((error) => {
        console.log('  出差补贴表格定位 evaluate 失败:', (error as Error).message.slice(0, 240));
        return null;
      });
      if (last && last.wrapperIdx >= 0) return last.wrapperIdx;
      await this.page!.waitForTimeout(400);
    }
    console.log('  出差补贴表格定位诊断:', JSON.stringify(last));
    return -1;
  }

  // 获取指定表格的逻辑行快照。横向固定列会复制 tbody，所以行数取各 tbody 的最大值，不能直接累加。
  private async getTableRowSnapshot(tableTarget: TableTargetRef): Promise<TableRowSnapshot> {
    try {
      const frame = this.mainFrame();
      return await frame.evaluate(({ idx, token }) => {
        const tables = Array.from(document.querySelectorAll('#hot-key-bzitem')) as HTMLElement[];
        const w = token
          ? document.querySelector(`[data-codex-table-token="${token}"]`) as HTMLElement | null
          : tables[idx];
        if (!w) return {
          rowKeys: [], rowCount: 0, fingerprints: [], targetFound: false, targetToken: token || undefined,
        };
        const helper = {
          owns(element: Element): boolean {
            if (!token) return element.closest('#hot-key-bzitem') === w;
            if (element.closest('[data-codex-table-token]') !== w) return false;
            const nestedWrapper = element.closest('#hot-key-bzitem');
            return !nestedWrapper || nestedWrapper === w || !w.contains(nestedWrapper);
          },
        };
        const bodies = Array.from(new Set(w.querySelectorAll('.table-next-body tbody, tbody'))).filter((element) => {
          if (!helper.owns(element)) return false;
          for (let node: Element | null = element; node && node !== w; node = node.parentElement) {
            const style = window.getComputedStyle(node as HTMLElement);
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
              || Number(style.opacity) === 0) return false;
          }
          const rect = (element as HTMLElement).getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return true;
          return Array.from(element.children).some((child) => {
            const childRect = (child as HTMLElement).getBoundingClientRect();
            return childRect.width > 0 && childRect.height > 0;
          });
        });

        const bodyRows = bodies.map((body) => Array.from(body.children).filter((child) => {
          if (child.tagName !== 'TR') return false;
          for (let node: Element | null = child; node && node !== body; node = node.parentElement) {
            const style = window.getComputedStyle(node as HTMLElement);
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
              || Number(style.opacity) === 0) return false;
          }
          const rect = (child as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }));
        let rowCount = bodyRows.reduce((maximum, rows) => Math.max(maximum, rows.length), 0);
        let fallbackRows: Element[] = [];
        if (!bodyRows.length) {
          fallbackRows = Array.from(new Set(w.querySelectorAll('.table-next-body tr, tbody > tr'))).filter((element) => {
            if (!helper.owns(element)) return false;
            const style = window.getComputedStyle(element as HTMLElement);
            return style.display !== 'none' && style.visibility !== 'hidden'
              && !!(element as HTMLElement).offsetParent;
          });
          rowCount = fallbackRows.length;
        }

        // 固定列与横向滚动列会把同一逻辑行复制到多个 tbody，且各窗格可能使用不同 rowkey。
        // rowkey 只能按逻辑序号从第一个有值的窗格取一个，绝不能用跨窗格 key 数量放大行数。
        const keys: string[] = [];
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
          const candidates = bodyRows.length
            ? bodyRows.map((rows) => rows[rowIndex]).filter(Boolean) as Element[]
            : [fallbackRows[rowIndex]].filter(Boolean) as Element[];
          let key = '';
          for (const row of candidates) {
            key = row.getAttribute('rowkey')
              || row.getAttribute('data-row-key')
              || row.getAttribute('data-rowkey')
              || row.querySelector('td[rowkey], td[data-row-key], td[data-rowkey]')?.getAttribute('rowkey')
              || row.querySelector('td[data-row-key]')?.getAttribute('data-row-key')
              || row.querySelector('td[data-rowkey]')?.getAttribute('data-rowkey')
              || '';
            if (key) break;
          }
          if (key && !keys.includes(key)) keys.push(key);
        }

        // 对同一逻辑序号合并所有固定/滚动窗格的业务值。真实 BIP 会预留空槽并在原地回填，
        // input.value、title/data-value 已变化时 textContent 仍可能为空，因此必须一并读取。
        // 收款人账号由后续步骤填写，刻意排除，避免把自己的写入误认成本次发票生成。
        const fingerprints: string[] = [];
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
          const candidates = bodyRows.length
            ? bodyRows.map((rows) => rows[rowIndex]).filter(Boolean) as Element[]
            : [fallbackRows[rowIndex]].filter(Boolean) as Element[];
          const rowParts: string[] = [];
          for (const row of candidates) {
            const cells = Array.from(row.querySelectorAll('td[colkey]:not([colkey="skyhzh"])'));
            for (const cell of cells) {
              const colkey = cell.getAttribute('colkey') || '';
              if (!colkey) continue;
              const values: string[] = [];
              const text = (cell.textContent || '').replace(/\s+/g, '').trim();
              if (text) values.push(text);
              const valueNodes = [cell, ...Array.from(cell.querySelectorAll(
                'input, textarea, select, [title], [aria-label], [aria-valuetext], '
                + '[data-value], [data-refname], [data-refcode], [data-display]',
              ))] as HTMLElement[];
              for (const valueNode of valueNodes) {
                let controlValue = '';
                if (valueNode instanceof HTMLInputElement
                  || valueNode instanceof HTMLTextAreaElement
                  || valueNode instanceof HTMLSelectElement) {
                  controlValue = String(valueNode.value || '').replace(/\s+/g, '').trim();
                }
                if (controlValue) values.push(controlValue);
                for (const attribute of [
                  'title', 'aria-label', 'aria-valuetext',
                  'data-value', 'data-refname', 'data-refcode', 'data-display',
                ]) {
                  const attributeValue = (valueNode.getAttribute(attribute) || '').replace(/\s+/g, '').trim();
                  if (attributeValue) values.push(attributeValue);
                }
              }
              const uniqueValues = Array.from(new Set(values)).sort();
              if (uniqueValues.length) rowParts.push(`${colkey}:${uniqueValues.join('~')}`);
            }
          }
          fingerprints.push(Array.from(new Set(rowParts)).sort().join('|'));
        }

        // 卡片标题给出的“共N条、合计M”是业务模型数量/金额，不受固定列、滚动列和预留 DOM 槽影响。
        // 只在仍然唯一包含当前最内层表格的祖先中解析，爬到含多张费用表的整页容器前立即停止。
        let businessCount: number | null = !token || w.dataset.codexSectionBusinessCount === undefined
          ? null : Number(w.dataset.codexSectionBusinessCount);
        let sectionTotal: number | null = !token || w.dataset.codexSectionTotal === undefined
          ? null : Number(w.dataset.codexSectionTotal);
        if (!Number.isFinite(businessCount)) businessCount = null;
        if (!Number.isFinite(sectionTotal)) sectionTotal = null;
        for (let node: Element | null = w.parentElement;
          businessCount === null && node && node !== document.documentElement;
          node = node.parentElement) {
          const inside = Array.from(node.querySelectorAll('#hot-key-bzitem')).filter((table) => {
            if (table.querySelector('#hot-key-bzitem')) return false;
            for (let ancestor: Element | null = table; ancestor && ancestor !== node; ancestor = ancestor.parentElement) {
              const style = window.getComputedStyle(ancestor as HTMLElement);
              if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
                || Number(style.opacity) === 0) return false;
            }
            return true;
          });
          if (inside.length > 1) break;
          if (inside.length !== 1 || inside[0] !== w) continue;
          const compactText = (node.textContent || '').replace(/\s+/g, '');
          const countMatch = compactText.match(/共(\d+)条/);
          if (!countMatch) continue;
          businessCount = Number(countMatch[1]);
          const totalMatch = compactText.match(/共\d+条[,，]?合计(?:金额)?[￥¥]?(-?[\d,]+(?:\.\d+)?)/);
          if (totalMatch) sectionTotal = Number(totalMatch[1].replace(/,/g, ''));
          break;
        }
        const ownedColkeys = Array.from(w.querySelectorAll('[colkey]'))
          .filter((element) => helper.owns(element))
          .map((element) => element.getAttribute('colkey') || '')
          .filter(Boolean);
        return {
          rowKeys: keys,
          rowCount,
          fingerprints,
          businessCount,
          sectionTotal,
          targetFound: true,
          targetToken: w.dataset.codexTableToken || token || undefined,
          ownedColkeys: Array.from(new Set(ownedColkeys)).sort(),
        };
      }, {
        idx: typeof tableTarget === 'number' ? tableTarget : -1,
        token: typeof tableTarget === 'string' ? tableTarget : '',
      });
    } catch {
      return {
        rowKeys: [], rowCount: 0, fingerprints: [], targetFound: false,
        targetToken: typeof tableTarget === 'string' ? tableTarget : undefined,
      };
    }
  }

  // 一次性采集所有已渲染费用表，避免逐表读取期间 React 重绘造成前后快照不一致。
  // data-codex-table-token 只用于本次浏览器会话内关联同一个 DOM 表节点，不修改任何业务数据。
  private async getAllTableRowSnapshots(): Promise<IndexedTableRowSnapshot[]> {
    const frame = this.mainFrame();
    return frame.evaluate(() => {
      const allTables = Array.from(document.querySelectorAll('#hot-key-bzitem'));
      const root = document.documentElement as HTMLElement;
      let sequence = Number(root.dataset.codexTableSequence || '0');
      const result: IndexedTableRowSnapshot[] = [];

      for (let wrapperIdx = 0; wrapperIdx < allTables.length; wrapperIdx++) {
        const table = allTables[wrapperIdx] as HTMLElement;
        // 真实 BIP 会在一个 #hot-key-bzitem 外壳内再嵌套同名的实际表格。外层查询会
        // 重复收集内层 tbody 和同一个焦点行；只保留不再包含同名 wrapper 的最内层表格。
        if (table.querySelector('#hot-key-bzitem')) continue;
        let tableAncestorsVisible = true;
        for (let node: Element | null = table; node && node !== document.documentElement; node = node.parentElement) {
          const style = window.getComputedStyle(node as HTMLElement);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
            || Number(style.opacity) === 0) {
            tableAncestorsVisible = false;
            break;
          }
        }
        if (!tableAncestorsVisible) continue;
        const tableRect = table.getBoundingClientRect();
        const activeElement = document.activeElement;
        const activeInsideTable = !!activeElement
          && activeElement !== document.body
          && activeElement !== document.documentElement
          && table.contains(activeElement);
        const tableRendered = activeInsideTable || (tableRect.width > 0 && tableRect.height > 0)
          || Array.from(table.querySelectorAll('button, th, td, input, textarea'))
            .some((child) => {
              let visible = true;
              for (let node: Element | null = child; node && node !== document.documentElement; node = node.parentElement) {
                const style = window.getComputedStyle(node as HTMLElement);
                if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
                  || Number(style.opacity) === 0) {
                  visible = false;
                  break;
                }
              }
              const rect = (child as HTMLElement).getBoundingClientRect();
              return visible && rect.width > 0 && rect.height > 0;
            });
        if (!tableRendered) continue;

        if (!table.dataset.codexTableToken) {
          sequence += 1;
          table.dataset.codexTableToken = `codex-table-${sequence}`;
        }
        const token = table.dataset.codexTableToken;
        const bodies = Array.from(table.querySelectorAll('.table-next-body tbody'))
          .filter((body) => {
            for (let node: Element | null = body; node && node !== document.documentElement; node = node.parentElement) {
              const style = window.getComputedStyle(node as HTMLElement);
              if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
                || Number(style.opacity) === 0) return false;
            }
            return true;
          });
        const bodyRows = bodies.map((body) => Array.from(body.children)
          .filter((child) => {
            if (child.tagName !== 'TR') return false;
            const rect = (child as HTMLElement).getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            for (let node: Element | null = child; node && node !== document.documentElement; node = node.parentElement) {
              const style = window.getComputedStyle(node as HTMLElement);
              if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
                || Number(style.opacity) === 0) return false;
            }
            return true;
          }) as HTMLElement[]);
        const looseRows = Array.from(table.querySelectorAll('.table-next-body tr'))
          .filter((row) => {
            const rect = (row as HTMLElement).getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            for (let node: Element | null = row; node && node !== document.documentElement; node = node.parentElement) {
              const style = window.getComputedStyle(node as HTMLElement);
              if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
                || Number(style.opacity) === 0) return false;
            }
            return true;
          }) as HTMLElement[];

        let rowCount = bodyRows.reduce((max, rows) => Math.max(max, rows.length), 0);
        if (!bodies.length) rowCount = looseRows.length;
        const rowKeys: string[] = [];
        for (const row of looseRows) {
          const key = row.getAttribute('rowkey')
            || row.getAttribute('data-row-key')
            || row.getAttribute('data-rowkey')
            || row.querySelector('td[rowkey], td[data-row-key], td[data-rowkey]')?.getAttribute('rowkey')
            || row.querySelector('td[data-row-key]')?.getAttribute('data-row-key')
            || row.querySelector('td[data-rowkey]')?.getAttribute('data-rowkey')
            || '';
          if (key && !rowKeys.includes(key)) rowKeys.push(key);
        }
        // 固定列与横向滚动列可能各自给同一逻辑行生成不同 rowkey；逻辑行数只能取
        // 各可见 tbody 直属行数的最大值，不能再由跨窗格 rowkey 数量放大。

        const selectedRowIndexes: number[] = [];
        const focusedRowIndexes: number[] = [];
        for (const rows of bodyRows) {
          rows.forEach((row, index) => {
            const className = String(row.className || '');
            const selected = row.getAttribute('aria-selected') === 'true'
              || /(^|[-_\s])(selected|current|active|focus|focused)([-_\s]|$)/i.test(className)
              || !!row.querySelector('[aria-selected="true"], .selected-row, .current-row, .active-row, .focus-row, .focused-row');
            const focused = !!activeElement
              && activeElement !== document.body
              && activeElement !== document.documentElement
              && row.contains(activeElement);
            if (selected && !selectedRowIndexes.includes(index)) selectedRowIndexes.push(index);
            if (focused && !focusedRowIndexes.includes(index)) focusedRowIndexes.push(index);
          });
        }

        const fingerprintBody = bodies.reduce<Element | null>((best, body) => {
          if (!best) return body;
          const bodyCells = body.querySelectorAll('td[colkey]:not([colkey="skyhzh"])').length;
          const bestCells = best.querySelectorAll('td[colkey]:not([colkey="skyhzh"])').length;
          return bodyCells > bestCells ? body : best;
        }, null);
        const fingerprints = fingerprintBody
          ? Array.from(fingerprintBody.children)
            .filter((child) => {
              if (child.tagName !== 'TR') return false;
              const rect = (child as HTMLElement).getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            })
            .map((row) => Array.from(row.querySelectorAll('td[colkey]:not([colkey="skyhzh"])'))
              .map((cell) => `${cell.getAttribute('colkey')}:${(cell.textContent || '').replace(/\s+/g, '')}`)
              .join('|'))
          : [];

        result.push({
          wrapperIdx,
          token,
          rowKeys,
          rowCount,
          fingerprints,
          selectedRowIndexes,
          focusedRowIndexes,
        });
      }
      root.dataset.codexTableSequence = String(sequence);
      return result;
    });
  }

  // 保留给补助填写和映射检查使用；发票新增行判断使用包含行数的完整快照。
  private async getTableRowKeys(wrapperIdx: number): Promise<string[]> {
    return (await this.getTableRowSnapshot(wrapperIdx)).rowKeys;
  }

  // 横向滚动指定表格，使目标 colkey 渲染出来（BIP 虚拟滚动只渲染可见列）。
  private async scrollTableToColumn(wrapperIdx: TableTargetRef, colkey: string): Promise<boolean> {
    const frame = this.mainFrame();
    const targetPayload = {
      idx: typeof wrapperIdx === 'number' ? wrapperIdx : -1,
      token: typeof wrapperIdx === 'string' ? wrapperIdx : '',
    };
    const targetVisible = async (): Promise<boolean> => frame.evaluate(({ idx, token, ck }) => {
        const tables = Array.from(document.querySelectorAll('#hot-key-bzitem')) as HTMLElement[];
        const w = token
          ? document.querySelector(`[data-codex-table-token="${token}"]`) as HTMLElement | null
          : tables[idx];
        if (!w) return false;
        const helper = { owns(element: Element): boolean {
          if (!token) return element.closest('#hot-key-bzitem') === w;
          if (element.closest('[data-codex-table-token]') !== w) return false;
          const nestedWrapper = element.closest('#hot-key-bzitem');
          return !nestedWrapper || nestedWrapper === w || !w.contains(nestedWrapper);
        } };
        const cells = Array.from(w.querySelectorAll('.table-next-body td[colkey="' + ck + '"]'))
          .filter((element) => helper.owns(element));
        if (token) {
          for (const cell of cells) {
            (cell as HTMLElement).dataset.codexOwnerToken = token;
            const body = cell.closest('tbody') as HTMLElement | null;
            if (body && helper.owns(body)) body.dataset.codexOwnerToken = token;
          }
        }
        return cells.some((element) => {
          const node = element as HTMLElement;
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden' || !node.offsetParent
            || rect.width <= 0 || rect.height <= 0) return false;
          let viewport = (w as HTMLElement).getBoundingClientRect();
          for (let ancestor = node.parentElement; ancestor && ancestor !== w; ancestor = ancestor.parentElement) {
            if (ancestor.clientWidth > 0 && ancestor.scrollWidth > ancestor.clientWidth) {
              viewport = ancestor.getBoundingClientRect();
              break;
            }
          }
          // 这里只判断横向虚拟列是否进入其表体视窗；整张表可能暂时在浏览器视口上方，
          // 后续 cell.scrollIntoViewIfNeeded 会负责纵向滚动，不能因此误判列未渲染。
          return rect.right > viewport.left && rect.left < viewport.right;
        });
      }, { ...targetPayload, ck: colkey });

    if (await targetVisible()) return true;
    // 真实录制中表头会保留全部 colkey，可直接按目标 th 的 offsetLeft 精确同步
    // 表体、表头和底部横向滚动条；这是账号列等中段虚拟列的首选定位方式。
    const headerGuided = await frame.evaluate(({ idx, token, ck }) => {
      const tables = Array.from(document.querySelectorAll('#hot-key-bzitem')) as HTMLElement[];
      const w = token
        ? document.querySelector(`[data-codex-table-token="${token}"]`) as HTMLElement | null
        : tables[idx];
      if (!w) return false;
      const helper = { owns(element: Element): boolean {
        if (!token) return element.closest('#hot-key-bzitem') === w;
        if (element.closest('[data-codex-table-token]') !== w) return false;
        const nestedWrapper = element.closest('#hot-key-bzitem');
        return !nestedWrapper || nestedWrapper === w || !w.contains(nestedWrapper);
      } };
      const header = Array.from(w.querySelectorAll('.table-next-header-wrapper th'))
        .filter((element) => helper.owns(element))
        .find((element) => element.getAttribute('colkey') === ck) as HTMLElement | undefined;
      if (!header) return false;
      const target = Math.max(0, header.offsetLeft - 140);
      const synchronized = Array.from(w.querySelectorAll(
        '.table-next-body-inner-wrapper, .table-next-body-wrapper, .table-next-body, '
        + '.table-next-header-wrapper, .horizontal-scroll-bar, [class*="horizontal-scroll"]',
      )).filter((element) => helper.owns(element)) as HTMLElement[];
      let moved = false;
      for (const node of synchronized) {
        if (node.clientWidth <= 0 || node.scrollWidth <= node.clientWidth) continue;
        node.scrollLeft = Math.min(node.scrollWidth - node.clientWidth, target);
        node.dispatchEvent(new Event('scroll', { bubbles: true }));
        moved = true;
      }
      return moved;
    }, { ...targetPayload, ck: colkey });
    if (headerGuided) {
      await this.page!.waitForTimeout(900);
      if (await targetVisible()) return true;
    }

    const scrollState = await frame.evaluate(({ idx, token }) => {
        const tables = Array.from(document.querySelectorAll('#hot-key-bzitem')) as HTMLElement[];
        const w = token
          ? document.querySelector(`[data-codex-table-token="${token}"]`) as HTMLElement | null
          : tables[idx];
        if (!w) return null;
        const helper = { owns(element: Element): boolean {
          if (!token) return element.closest('#hot-key-bzitem') === w;
          if (element.closest('[data-codex-table-token]') !== w) return false;
          const nestedWrapper = element.closest('#hot-key-bzitem');
          return !nestedWrapper || nestedWrapper === w || !w.contains(nestedWrapper);
        } };
        const owners = Array.from(w.querySelectorAll(
          '.table-next-body-inner-wrapper, .table-next-body, .table-next-body-wrapper, '
          + '.table-next-header-wrapper, .horizontal-scroll-bar, [class*="horizontal-scroll"]',
        )).filter((element) => helper.owns(element))
          .filter((element) => {
            const node = element as HTMLElement;
            const style = window.getComputedStyle(node);
            return style.display !== 'none' && style.visibility !== 'hidden' && !!node.offsetParent
              && node.clientWidth > 0 && node.scrollWidth > node.clientWidth;
          }) as HTMLElement[];
        const owner = owners.sort((a, b) => (b.scrollWidth - b.clientWidth) - (a.scrollWidth - a.clientWidth))[0];
        return owner ? {
          max: Math.max(0, owner.scrollWidth - owner.clientWidth),
          clientWidth: owner.clientWidth,
          current: owner.scrollLeft,
        } : null;
      }, targetPayload);
    if (!scrollState || scrollState.max <= 0) return false;

    // skyhzh 通常位于最右端之前；旧逻辑先跳到 max 后只继续向右，必然越过该虚拟列。
    // 以约 0.6 个视口为步长覆盖 0..max，保证每个横向区间至少进入一次可视窗。
    const steps = Math.min(40, Math.max(4, Math.ceil(scrollState.max / Math.max(240, scrollState.clientWidth * 0.6))));
    const positions = Array.from({ length: steps + 1 }, (_, index) => Math.round(scrollState.max * index / steps));
    for (const position of positions) {
      await frame.evaluate(({ idx, token, left }) => {
        const tables = Array.from(document.querySelectorAll('#hot-key-bzitem')) as HTMLElement[];
        const w = token
          ? document.querySelector(`[data-codex-table-token="${token}"]`) as HTMLElement | null
          : tables[idx];
        if (!w) return;
        const helper = { owns(element: Element): boolean {
          if (!token) return element.closest('#hot-key-bzitem') === w;
          if (element.closest('[data-codex-table-token]') !== w) return false;
          const nestedWrapper = element.closest('#hot-key-bzitem');
          return !nestedWrapper || nestedWrapper === w || !w.contains(nestedWrapper);
        } };
        const owners = Array.from(w.querySelectorAll(
          '.table-next-body-inner-wrapper, .table-next-body, .table-next-body-wrapper, '
          + '.table-next-header-wrapper, .horizontal-scroll-bar, [class*="horizontal-scroll"]',
        )).filter((element) => helper.owns(element))
          .filter((element) => {
            const node = element as HTMLElement;
            const style = window.getComputedStyle(node);
            return style.display !== 'none' && style.visibility !== 'hidden' && !!node.offsetParent
              && node.clientWidth > 0 && node.scrollWidth > node.clientWidth;
          }) as HTMLElement[];
        const owner = owners.sort((a, b) => (b.scrollWidth - b.clientWidth) - (a.scrollWidth - a.clientWidth))[0];
        if (!owner) return;
        const primaryMax = Math.max(1, owner.scrollWidth - owner.clientWidth);
        const ratio = Math.max(0, Math.min(1, left / primaryMax));
        for (const node of owners) {
          node.scrollLeft = Math.round(Math.max(0, node.scrollWidth - node.clientWidth) * ratio);
          node.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
      }, { ...targetPayload, left: position });
      await this.page!.waitForTimeout(400);
      if (await targetVisible()) return true;
    }
    return false;
  }

  // 按 rowkey + colkey 定位；若真实 BIP 新行没有 rowkey，则按目标列中的逻辑行序号定位。
  private tableCell(wrapperIdx: TableTargetRef, rowRef: string, colkey: string) {
    const wrapper = typeof wrapperIdx === 'string'
      ? this.mf().locator('[data-codex-table-token="' + wrapperIdx + '"]').first()
      : this.mf().locator('#hot-key-bzitem').nth(wrapperIdx);
    const ownedCell = 'td[colkey="' + colkey + '"]';
    const ownedBody = typeof wrapperIdx === 'string'
      ? '.table-next-body:visible tbody[data-codex-owner-token="' + wrapperIdx + '"]:visible'
      : '.table-next-body:visible tbody:visible';
    const rowIndex = parseTableIndexRowRef(rowRef);
    if (rowIndex !== null) {
      // 固定列/滚动列可能分属不同 tbody；只接受当前可见、包含目标列的那一个表体。
      return wrapper
        .locator(ownedBody + ':has(' + ownedCell + ':visible)')
        .first()
        .locator(':scope > tr:visible')
        .nth(rowIndex)
        .locator(ownedCell).first();
    }
    return wrapper
      .locator(
        ownedBody + ' > tr[rowkey="' + rowRef + '"], '
        + ownedBody + ' > tr[data-row-key="' + rowRef + '"], '
        + ownedBody + ' > tr[data-rowkey="' + rowRef + '"], '
        + ownedBody + ' > tr:has(td[rowkey="' + rowRef + '"]), '
        + ownedBody + ' > tr:has(td[data-row-key="' + rowRef + '"]), '
        + ownedBody + ' > tr:has(td[data-rowkey="' + rowRef + '"])',
      ).filter({ visible: true })
      .locator(ownedCell).first();
  }

  // 填文本列（摘要）
  private async fillTableText(wrapperIdx: TableTargetRef, rowkey: string, colkey: string, text: string): Promise<boolean> {
    if (!await this.scrollTableToColumn(wrapperIdx, colkey)) return false;
    let cell = this.tableCell(wrapperIdx, rowkey, colkey);
    try { await cell.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch {}
    try { await cell.click({ timeout: 5000 }); } catch {
      await this.scrollTableToColumn(wrapperIdx, colkey);
      cell = this.tableCell(wrapperIdx, rowkey, colkey);
      try { await cell.locator('.table-cell').click({ force: true, timeout: 3000 }); } catch {}
    }
    await this.page!.waitForTimeout(400);
    let input = cell.locator('input').first();
    if (!(await this.waitVisible(input, 1500))) {
      try { await cell.locator('.table-cell').click({ timeout: 3000 }); } catch {}
      await this.page!.waitForTimeout(400);
      input = cell.locator('input').first();
    }
    if (await this.waitVisible(input, 2000)) {
      await input.fill(text);
      await input.press('Tab').catch(() => {});
      await this.page!.waitForTimeout(500);
      const persisted = (await this.getTableCellValue(wrapperIdx, rowkey, colkey)).replace(/\s+/g, '');
      return persisted === text.replace(/\s+/g, '') || persisted.includes(text.replace(/\s+/g, ''));
    } else {
      console.log('fillTableText(' + colkey + '): 输入框未找到');
      return false;
    }
  }

  // 填数字列（天数/人数/补助金额）
  private async fillTableNumber(wrapperIdx: TableTargetRef, rowkey: string, colkey: string, value: number): Promise<boolean> {
    if (!await this.scrollTableToColumn(wrapperIdx, colkey)) return false;
    let cell = this.tableCell(wrapperIdx, rowkey, colkey);
    try { await cell.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch {}
    try { await cell.click({ timeout: 4000 }); } catch {
      // 重试：重新滚动并点击单元格内部
      await this.scrollTableToColumn(wrapperIdx, colkey);
      cell = this.tableCell(wrapperIdx, rowkey, colkey);
      try { await cell.locator('.table-cell').click({ force: true, timeout: 3000 }); } catch {}
    }
    await this.page!.waitForTimeout(500);
    let input = cell.locator('input').first();
    if (!(await this.waitVisible(input, 1500))) {
      try { await cell.locator('.table-cell').click({ force: true, timeout: 3000 }); } catch {}
      await this.page!.waitForTimeout(500);
      input = cell.locator('input').first();
    }
    if (await this.waitVisible(input, 2000)) {
      await input.fill(String(value));
      await input.press('Tab').catch(() => {});
      await this.page!.waitForTimeout(500);
      const actual = Number((await this.getTableCellValue(wrapperIdx, rowkey, colkey)).replace(/,/g, ''));
      return Number.isFinite(actual) && actual === Number(value);
    } else {
      console.log('fillTableNumber(' + colkey + '): 输入框未找到');
      return false;
    }
  }

  // 点开参照后，等到弹窗出现并加载出目标选项（或可搜索的输入框）。轮询而不是固定等待：
  // 快时立刻继续，慢时最多等 timeout。texts 为空时只要求弹窗出现。
  private async waitForReferResult(texts: string[], timeout: number): Promise<boolean> {
    const popupSelector = '.refer-pop-window-show, .popup-window, .refer-popover, .wui-popup, .modal, '
      + '[role="dialog"], .wui-modal';
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const root of [this.mf(), this.page!] as any[]) {
        try {
          const popup = root.locator(popupSelector).last();
          if (!(await popup.isVisible().catch(() => false))) continue;
          if (!texts.length) return true;
          const content = ((await popup.textContent().catch(() => '')) || '').replace(/\s+/g, '');
          if (texts.some((t) => content.includes(t.replace(/\s+/g, '')))) return true;
          // 账号/城市等参照需先搜索才出结果：出现搜索框也算加载完成。
          if (await popup.locator('input:visible').first().isVisible().catch(() => false)
            && /搜索|查询|账号|账户|城市/.test(content + (await popup.locator('input:visible').first().getAttribute('placeholder').catch(() => '') || ''))) {
            return true;
          }
        } catch {}
      }
      // 部分参照是下拉列表而非弹窗：目标文字直接出现在页面上也算就绪。
      for (const t of texts) {
        if (await this.mf().getByText(t, { exact: true }).first().isVisible().catch(() => false)) return true;
      }
      await this.safeSleep(250);
    }
    return false;
  }

  // 点 refer 列（业务属性/补助类型/收款人账号），成功选择并确认返回 true
  private async selectTableRefer(
    wrapperIdx: TableTargetRef,
    rowkey: string,
    colkey: string,
    text: string,
    extraCandidates: string[] = [],
    selectFirstAfterSearch = false,
  ): Promise<boolean> {
    if (!await this.scrollTableToColumn(wrapperIdx, colkey)) {
      console.log('selectTableRefer(' + colkey + '): 目标列未滚动到可见区域');
      return false;
    }
    let cell = this.tableCell(wrapperIdx, rowkey, colkey);
    try { await cell.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch {}
    await this.page!.waitForTimeout(300);
    // refer 图标是 hover-icon，先悬停单元格让其显示
    try { await cell.hover({ timeout: 2000 }); } catch {}
    await this.page!.waitForTimeout(300);
    let icon = cell.locator('.iconfont, .icon-refer').first();
    let iconClicked = false;
    try { await icon.click({ timeout: 3000 }); iconClicked = true; } catch {}
    if (!iconClicked) {
      try { await icon.click({ force: true, timeout: 3000 }); iconClicked = true; } catch {}
    }
    if (!iconClicked) {
      // 重试一次：重新滚动、重建 locator 后再点
      await this.scrollTableToColumn(wrapperIdx, colkey);
      cell = this.tableCell(wrapperIdx, rowkey, colkey);
      try { await cell.hover({ timeout: 2000 }); } catch {}
      await this.page!.waitForTimeout(300);
      icon = cell.locator('.iconfont, .icon-refer').first();
      try { await icon.click({ timeout: 3000 }); iconClicked = true; } catch {}
      if (!iconClicked) {
        try { await icon.click({ force: true, timeout: 3000 }); iconClicked = true; } catch {}
      }
      if (!iconClicked) {
        console.log('selectTableRefer(' + colkey + '): 图标点击失败');
        return false;
      }
    }
    const candidates = Array.from(new Set([text, ...extraCandidates].filter(Boolean)));
    if (text === '伙食费') candidates.push('伙食');
    if (text.endsWith('费') && text.length > 1) candidates.push(text.slice(0, -1));
    // 参照弹窗及其数据是异步加载的，网络慢时 1 秒还没出来；等到弹窗出现且有选项或搜索框再继续。
    if (!await this.waitForReferResult(selectFirstAfterSearch ? [] : candidates, 30000)) {
      console.log('selectTableRefer(' + colkey + '): 30 秒内参照弹窗未出现或未加载出选项，仍尝试选择');
    }
    const clicked = selectFirstAfterSearch
      ? await this.selectFirstReferSearchResult(text)
      : await this.selectReferOption(candidates);
    await this.page!.waitForTimeout(400);
    if (clicked) {
      return await this.confirmPopup();
    }
    try {
      const popup = this.mf().locator('.refer-pop-window-show, .popup-window, .refer-popover, .wui-popup').last();
      if (await popup.isVisible().catch(() => false)) {
        const txt = (await popup.textContent().catch(() => '')) || '';
        console.log('  refer弹窗(' + colkey + ') 内容: ' + txt.replace(/\s+/g, ' ').slice(0, 260));
      }
    } catch {}
    console.log('selectTableRefer(' + colkey + '): 未找到选项 ' + text);
    return false;
  }

  // 城市参照的行政区名称可能带省/市/区层级，系统显示文字不一定与搜索词完全相同。
  // 按用户流程：只输入具体出差城市，等待页面自己的慢速检索完成；在区县节点
  // 真正出现之前不按键、不点搜索按钮，也不从未过滤的全国行政区划树中盲选。
  private async selectFirstReferSearchResult(query: string): Promise<boolean> {
    const roots: any[] = [this.mf(), this.page!];
    let popup: any = null;
    for (const root of roots) {
      let candidatePopup = root.locator(
        '[role="dialog"], .wui-modal, .modal, .popup-window',
      ).filter({ hasText: '行政区划' }).last();
      if (!(await candidatePopup.isVisible().catch(() => false))) {
        candidatePopup = root.locator(
          '.refer-pop-window-show, .popup-window, .refer-popover, .wui-popup, .modal',
        ).last();
      }
      if (await this.waitVisible(candidatePopup, 600)) {
        popup = candidatePopup;
        break;
      }
    }
    if (!popup) return false;

    let search = popup.locator(
      'input[placeholder*="城市"], input[placeholder*="搜索"], input[placeholder*="查询"]',
    ).first();
    if (!(await this.waitVisible(search, 800))) {
      search = popup.locator('input:visible').first();
    }
    if (!(await this.waitVisible(search, 800))) return false;
    await search.fill(query);

    const normalizedQuery = query.replace(/\s+/g, '');
    const isMatchingDistrict = async (option: any): Promise<boolean> => {
      if (!(await option.isVisible().catch(() => false))) return false;
      const content = ((await option.textContent().catch(() => '')) || '').replace(/\s+/g, '');
      return content.includes(normalizedQuery)
        && content.length <= 60
        && /(?:区|县|旗)$/.test(content);
    };

    // 行政区划参照主要展示为树，少数版本展示为表格/列表。所有候选都必须
    // 同时满足“包含查询城市”和“区/县/旗节点”，市级文件夹不算检索完成。
    const resultGroups = [
      popup.locator('.wui-tree-title'),
      popup.locator('[class*="tree-title"]'),
      popup.locator('.wui-tree-node-content-wrapper'),
      popup.locator('[class*="tree-node-content"]'),
      popup.locator('[role="treeitem"]'),
      popup.locator('tbody > tr'),
      popup.locator('[role="option"]'),
      popup.locator('[role="row"]:not([aria-rowindex="1"])'),
      popup.locator('li'),
      popup.locator('a'),
    ];
    const findFirstMatchingDistrict = async (): Promise<any | null> => {
      for (const rawGroup of resultGroups) {
        // 全国树可能有数千节点，先在 DOM 级别过滤搜索词，禁止逐节点等待。
        const group = rawGroup.filter({ hasText: query });
        const count = Math.min(await group.count(), 50);
        for (let index = 0; index < count; index++) {
          const option = group.nth(index);
          if (await isMatchingDistrict(option)) return option;
        }
      }
      return null;
    };

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (!(await popup.isVisible().catch(() => false))) return false;
      const currentValue = await search.inputValue().catch(() => '');
      if (currentValue.replace(/\s+/g, '') !== normalizedQuery) {
        console.log('  行政区划搜索词被页面改写，停止等待，当前值=' + currentValue);
        return false;
      }
      const option = await findFirstMatchingDistrict();
      if (option) {
        // 节点已经出现才进行搜索输入后的第一次界面操作。
        const firstCell = option.locator('td, [role="gridcell"], [role="cell"]').first();
        const clickTarget = await firstCell.isVisible().catch(() => false)
          ? firstCell
          : option;
        try {
          await clickTarget.click({ timeout: 2500 });
        } catch {
          await clickTarget.click({ force: true, timeout: 1500 });
        }
        return true;
      }
      await this.page!.waitForTimeout(500);
    }
    console.log('  行政区划检索等待120秒仍未出现区县节点，搜索词=' + query
      + '，输入框当前值=' + await search.inputValue().catch(() => ''));
    return false;
  }

  // 在 refer 弹窗中找选项，必要时用弹窗搜索框过滤
  private async selectReferOption(optionTexts: string[]): Promise<boolean> {
    const roots: any[] = [this.mf(), this.page!];
    const tryText = async (popup: any, text: string): Promise<boolean> => {
      if (!(await popup.isVisible().catch(() => false))) return false;
      const optA = popup.locator('a').filter({ hasText: text }).first();
      if (await optA.isVisible().catch(() => false)) { if (await optA.click({ timeout: 10000 }).then(() => true, () => false)) return true; }
      const optT = popup.getByText(text, { exact: true }).first();
      if (await optT.isVisible().catch(() => false)) { if (await optT.click({ timeout: 10000 }).then(() => true, () => false)) return true; }
      const optTitle = popup.getByTitle(text).first();
      if (await optTitle.isVisible().catch(() => false)) { if (await optTitle.click({ timeout: 10000 }).then(() => true, () => false)) return true; }
      const cell = popup.getByRole('cell', { name: text, exact: true }).first();
      if (await cell.isVisible().catch(() => false)) { if (await cell.click({ timeout: 10000 }).then(() => true, () => false)) return true; }
      const row = popup.locator('tr').filter({ hasText: text }).first();
      if (await row.isVisible().catch(() => false)) { if (await row.click({ timeout: 10000 }).then(() => true, () => false)) return true; }
      const anyT = popup.getByText(text).first();
      if (await anyT.isVisible().catch(() => false)) { if (await anyT.click({ timeout: 10000 }).then(() => true, () => false)) return true; }
      return false;
    };
    for (const root of roots) {
      const popup = root.locator('.refer-pop-window-show, .popup-window, .refer-popover, .wui-popup, .modal').last();
      for (const t of optionTexts) {
        if (await tryText(popup, t)) return true;
      }
      // 账号/城市弹窗可能必须先搜索；只选择匹配目标文本的结果，不盲选第一行。
      let search = popup.locator('input[placeholder*="个人银行账户"], input[placeholder*="账号"], input[placeholder*="城市"], input[placeholder*="搜索"]').first();
      if (!(await this.waitVisible(search, 800))) {
        search = popup.locator('input:visible').first();
      }
      if (await this.waitVisible(search, 800)) {
        for (const query of optionTexts) {
          await search.fill(query);
          await search.press('Enter');
          await this.page!.waitForTimeout(1200);
          for (const t of optionTexts) {
            if (await tryText(popup, t)) return true;
          }
        }
      }
    }
    return await this.clickOption(this.mf(), optionTexts[0]) || await this.clickOption(this.page!, optionTexts[0]);
  }

  private async fillSubsidyRow(summary: string, label: string, days: number, people: number, amount: number, bankAccount: string, idx: number) {
    await this.checkForceLogin();
    this.ensurePage();
    const mf = this.mf();
    await this.p('补助行' + (idx+1) + ': ' + label + ' ' + amount.toFixed(2), 48 + idx);

    // BIP 点击“增行”后会重绘补贴卡片，标题、工具栏和表体可能不再共享原来的 DOM 外壳。
    // 先一次性记录全页面表格，点击后直接用唯一的行数变化锁定新增行，不能再按标题重新猜表。
    const tablesBeforeAdd = await this.getAllTableRowSnapshots();
    await this.clickSubsidyAddRow();
    await this.waitForBipReady('正在新增补助行', 60000);
    let resolved: SubsidyTableChange | null = null;
    let lastTablesAfterAdd: IndexedTableRowSnapshot[] = [];
    let previousSignature = '';
    let stableMatches = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      await this.page!.waitForTimeout(attempt === 0 ? 250 : 300);
      this.ensurePage();
      lastTablesAfterAdd = await this.getAllTableRowSnapshots().catch(() => []);
      const candidate = resolveSubsidyTableChange(tablesBeforeAdd, lastTablesAfterAdd);
      if (!candidate) {
        previousSignature = '';
        stableMatches = 0;
        continue;
      }
      const signature = `${candidate.wrapperIdx}|${candidate.rowRef}`;
      stableMatches = signature === previousSignature ? stableMatches + 1 : 1;
      previousSignature = signature;
      if (stableMatches >= 2) {
        resolved = candidate;
        break;
      }
    }
    if (!resolved) {
      const compact = (items: IndexedTableRowSnapshot[]) => items.map((item) => ({
        i: item.wrapperIdx,
        n: item.rowCount,
        s: item.selectedRowIndexes,
        f: item.focusedRowIndexes,
        t: item.token,
      }));
      console.log('  补助增行全表快照:', JSON.stringify({
        before: compact(tablesBeforeAdd),
        after: compact(lastTablesAfterAdd),
      }));
      try {
        fs.writeFileSync(this.diagFile('subsidy-diagnostic.json'), JSON.stringify({
          time: new Date().toISOString(),
          before: tablesBeforeAdd,
          after: lastTablesAfterAdd,
        }, null, 2), 'utf8');
      } catch {}
      throw new Error('补助增行已触发，但无法从全页面表格中唯一确认新增补贴行');
    }
    const wrapperIdx = resolved.wrapperIdx;
    const rowkey = resolved.rowRef;
    console.log('  补助行' + (idx+1) + ': 表格=' + wrapperIdx + ' 新行=' + rowkey);
    console.log('  补助行' + (idx+1) + ': 填摘要');
    if (!await this.fillTableText(wrapperIdx, rowkey, 'defitem14', summary)) throw new Error(`补助行${idx+1}摘要填写失败`);

    console.log('  补助行' + (idx+1) + ': 选业务属性');
    if (!await this.selectTableRefer(wrapperIdx, rowkey, 'defitem69', FIXED_EXPENSE_BUSINESS_ATTR)) throw new Error(`补助行${idx+1}业务属性选择失败`);

    console.log('  补助行' + (idx+1) + ': 选补助类型 ' + label);
    if (!await this.selectTableRefer(wrapperIdx, rowkey, 'pk_reimtype', label)) throw new Error(`补助行${idx+1}补助类型选择失败`);

    console.log('  补助行' + (idx+1) + ': 填出差天数 ' + days);
    if (!await this.fillTableNumber(wrapperIdx, rowkey, 'defitem9', days)) throw new Error(`补助行${idx+1}出差天数填写失败`);

    console.log('  补助行' + (idx+1) + ': 填出差人数 ' + people);
    if (!await this.fillTableNumber(wrapperIdx, rowkey, 'defitem5', people)) throw new Error(`补助行${idx+1}出差人数填写失败`);

    console.log('  补助行' + (idx+1) + ': 填补助金额 ' + amount);
    if (!await this.fillTableNumber(wrapperIdx, rowkey, 'vat_amount', amount)) throw new Error(`补助行${idx+1}补助金额填写失败`);

    // 收款对象/收款人走系统默认，只选收款人账号（账号弹窗内搜索后选默认那一个）
    if (bankAccount) {
      console.log('  补助行' + (idx+1) + ': 选收款人账号');
      if (!await this.fillTablePayeeAccount(wrapperIdx, rowkey, bankAccount)) throw new Error(`补助行${idx+1}收款人账号选择失败`);
    }
    await this.page!.waitForTimeout(800);
  }

  // 只选收款人账号；失败时仅重试账号本身，绝不改写 BIP 自动生成的收款人。
  private async fillTablePayeeAccount(wrapperIdx: TableTargetRef, rowkey: string, bankAccount: string): Promise<boolean> {
    if (!bankAccount) {
      console.log('  收款人账号未配置，无法选择');
      return false;
    }
    const verifySelected = async (): Promise<boolean> => {
      await this.waitForBipReady('正在保存收款人账号', 60000);
      for (let attempt = 0; attempt < 30; attempt++) {
        await this.page!.waitForTimeout(attempt === 0 ? 700 : 400);
        const value = (await this.getTableCellValue(wrapperIdx, rowkey, 'skyhzh')).replace(/\s+/g, '');
        if (!value || /^(请选择|选择|--|-)$/.test(value)) continue;
        const expectedDigits = bankAccount.replace(/\D/g, '');
        const actualDigits = value.replace(/\D/g, '');
        // BIP 可能显示完整账号、掩码账号或“银行名称+尾号”，但至少必须能回读到
        // 配置账号的尾号。仅显示“已选择/银行名称”等非数字文本不能证明选对账号。
        if (expectedDigits && actualDigits) {
          const suffix = expectedDigits.slice(-Math.min(4, expectedDigits.length));
          if (actualDigits.includes(suffix)) return true;
        }
      }
      return false;
    };

    let ok = await this.selectTableRefer(wrapperIdx, rowkey, 'skyhzh', bankAccount);
    if (ok && await verifySelected()) return true;
    if (ok) console.log('  收款人账号弹窗已确认，但费用行尚未回填，准备重试');
    ok = await this.selectTableRefer(wrapperIdx, rowkey, 'skyhzh', bankAccount);
    if (ok && await verifySelected()) return true;
    console.log('  收款人账号未成功写入费用行: ' + bankAccount);
    return false;
  }

  private async getTableCellValue(wrapperIdx: TableTargetRef, rowkey: string, colkey: string): Promise<string> {
    if (!await this.scrollTableToColumn(wrapperIdx, colkey)) return '';
    const cell = this.tableCell(wrapperIdx, rowkey, colkey);
    const input = cell.locator('input').first();
    if (await input.isVisible().catch(() => false)) {
      const value = await input.inputValue().catch(() => '');
      if (value.trim()) return value.trim();
    }
    const text = ((await cell.textContent().catch(() => '')) || '').replace(/\s+/g, '').trim();
    if (text) return text;
    const titled = cell.locator('[title]').first();
    if (await titled.count().catch(() => 0)) {
      const title = (await titled.getAttribute('title').catch(() => '')) || '';
      if (title.trim()) return title.trim();
    }
    return ((await cell.getAttribute('title').catch(() => '')) || '').trim();
  }

  private async fillLodgingDetails(
    wrapperIdx: TableTargetRef,
    rowkey: string,
    approval: any,
    bankAccount: string,
    invoice?: any,
  ): Promise<string[]> {
    const lodging = buildLodgingDefaults(approval, invoice);
    const warnings: string[] = [];
    if (!lodging.cityCandidates.length) warnings.push('住宿发票: 出差审批单缺少目的地，无法填写入住城市');
    if (!lodging.checkInDate || !lodging.checkOutDate || lodging.days <= 0) {
      warnings.push('住宿发票: 出差审批单缺少有效起止日期，无法填写入住/离店日期和住宿天数');
    }
    if (warnings.length) return warnings;

    const level = DEFAULT_LODGING_PERSON_LEVEL;
    const currentLevel = (await this.getTableCellValue(wrapperIdx, rowkey, 'defitem21')).replace(/\s+/g, '');
    if (currentLevel !== level.replace(/\s+/g, '')) {
      console.log('  住宿发票: 选择人员级别 ' + level);
      if (!await this.selectTableRefer(wrapperIdx, rowkey, 'defitem21', level)) {
        warnings.push('住宿发票: 人员级别选择失败');
        return warnings;
      }
    }

    const cityQuery = lodging.cityCandidates[0];
    console.log('  住宿发票: 搜索入住城市并选择第一条结果 ' + cityQuery);
    if (!await this.selectTableRefer(wrapperIdx, rowkey, 'defitem4', cityQuery, [], true)) {
      warnings.push('住宿发票: 入住城市选择失败');
      return warnings;
    }
    console.log('  住宿发票: 填写入住日期 ' + lodging.checkInDate);
    if (!await this.fillTableText(wrapperIdx, rowkey, 'defitem1', lodging.checkInDate)) {
      warnings.push('住宿发票: 入住日期填写失败');
      return warnings;
    }
    console.log('  住宿发票: 填写离店日期 ' + lodging.checkOutDate);
    if (!await this.fillTableText(wrapperIdx, rowkey, 'defitem2', lodging.checkOutDate)) {
      warnings.push('住宿发票: 离店日期填写失败');
      return warnings;
    }
    console.log('  住宿发票: 填写住宿天数 ' + lodging.days);
    if (!await this.fillTableNumber(wrapperIdx, rowkey, 'defitem9', lodging.days)) {
      warnings.push('住宿发票: 住宿天数填写失败');
    }
    console.log('  住宿发票: 填写住宿人数 ' + lodging.people);
    if (!await this.fillTableNumber(wrapperIdx, rowkey, 'defitem5', lodging.people)) {
      warnings.push('住宿发票: 住宿人数填写失败');
    }
    await this.page!.waitForTimeout(800);
    const persistedCheckIn = await this.getTableCellValue(wrapperIdx, rowkey, 'defitem1');
    const persistedCheckOut = await this.getTableCellValue(wrapperIdx, rowkey, 'defitem2');
    const persistedDays = Number((await this.getTableCellValue(wrapperIdx, rowkey, 'defitem9')).replace(/,/g, ''));
    const persistedPeople = Number((await this.getTableCellValue(wrapperIdx, rowkey, 'defitem5')).replace(/,/g, ''));
    if (!persistedCheckIn.includes(lodging.checkInDate)) warnings.push('住宿发票: 入住日期失焦后未正确保存');
    if (!persistedCheckOut.includes(lodging.checkOutDate)) warnings.push('住宿发票: 离店日期失焦后未正确保存');
    if (persistedDays !== lodging.days) warnings.push('住宿发票: 住宿天数失焦后与审批单不一致');
    if (persistedPeople !== lodging.people) warnings.push('住宿发票: 住宿人数失焦后与审批单不一致');
    let standardAmount = '';
    await this.waitForBipReady('正在计算住宿标准金额', 60000);
    for (let attempt = 0; attempt < 30; attempt++) {
      standardAmount = await this.getTableCellValue(wrapperIdx, rowkey, 'defitem13');
      if (Number(standardAmount.replace(/,/g, '')) > 0) break;
      await this.page!.waitForTimeout(500);
    }
    if (!(Number(standardAmount.replace(/,/g, '')) > 0)) {
      warnings.push('住宿发票: 人员级别、城市和日期填写后，住宿标准总金额仍未自动计算');
    }
    console.log('  住宿发票: 选择收款人账号');
    if (!bankAccount || !await this.fillTablePayeeAccount(wrapperIdx, rowkey, bankAccount)) {
      warnings.push('住宿发票: 收款人账号选择失败');
    }
    return warnings;
  }

  // 费用卡片与补助卡片使用同一套 TableNext 组件。真实 BIP 既可能使用纯外壳+内层表，
  // 也可能让外层拥有自己的费用表体，同时在其后嵌入另一张补贴表。这里只统计 wrapper
  // 自己拥有的表头/表体，并用“专属工具栏 + 分区标题 + 列结构”绑定，绝不按序号猜测。
  private async inspectExpenseTarget(
    sectionTitle: string,
    areaCode: string,
    toolbars: readonly string[],
    expectedTarget: TableTargetRef | -1 = -1,
    clickUpload = false,
  ): Promise<{
    wrapperIdx: number;
    targetToken: string;
    clicked: boolean;
    toolbarNodeCount: number;
    uploadButtonCount: number;
    bindingWrapperIndexes: number[];
    innermostTableIndexes: number[];
    tableCount: number;
    toolbarClasses: string[];
    areaCode: string;
    ownedColkeys: string[];
    businessCount: number | null;
    sectionTotal: number | null;
    scopeText: string;
    schemaMatched: boolean;
    headerTexts: string[];
    targetRootTag: string;
  }> {
    const frame = this.mainFrame();
    return frame.evaluate(({ title, area, toolbarCandidates, expectedIndex, expectedToken, shouldClick }) => {
      const tables = Array.from(document.querySelectorAll('#hot-key-bzitem')) as HTMLElement[];
      const rejectedSubsidyToolbar = toolbarCandidates.some((candidate: string) =>
        candidate.includes('bzitem_card_body-button'),
      );

      const helper = {
        isRendered(element: Element): boolean {
          for (let node: Element | null = element; node && node !== document.documentElement; node = node.parentElement) {
            const style = window.getComputedStyle(node as HTMLElement);
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
              || Number(style.opacity) === 0) return false;
          }
          const rect = (element as HTMLElement).getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return true;
          return Array.from(element.querySelectorAll('button, th, td, input, textarea')).some((child) => {
            const childRect = (child as HTMLElement).getBoundingClientRect();
            return childRect.width > 0 && childRect.height > 0;
          });
        },
        owns(table: Element, element: Element): boolean {
          return element.closest('#hot-key-bzitem') === table;
        },
        colkeysFor(table: Element): string[] {
          return Array.from(table.querySelectorAll('[colkey]'))
            .filter((element) => helper.owns(table, element))
            .map((element) => element.getAttribute('colkey') || '')
            .filter(Boolean);
        },
        colkeysWithin(root: Element): string[] {
          return Array.from(root.querySelectorAll('[colkey]'))
            .filter((element) => {
              if (!helper.isRendered(element)) return false;
              const nestedWrapper = element.closest('#hot-key-bzitem');
              if (nestedWrapper && nestedWrapper !== root && root.contains(nestedWrapper)) return false;
              const nestedTokenRoot = element.closest('[data-codex-table-token]');
              return !nestedTokenRoot || nestedTokenRoot === root || !root.contains(nestedTokenRoot);
            })
            .map((element) => element.getAttribute('colkey') || '')
            .filter(Boolean);
        },
        headerTextsWithin(root: Element): string[] {
          return Array.from(root.querySelectorAll(
            'th, [role="columnheader"], .table-next-header-cell, [class*="header-cell"]',
          ))
            .filter((element) => {
              if (!helper.isRendered(element)) return false;
              const nestedWrapper = element.closest('#hot-key-bzitem');
              if (nestedWrapper && nestedWrapper !== root && root.contains(nestedWrapper)) return false;
              const nestedTokenRoot = element.closest('[data-codex-table-token]');
              return !nestedTokenRoot || nestedTokenRoot === root || !root.contains(nestedTokenRoot);
            })
            .map((element) => (element.textContent || '').replace(/\s+/g, '').trim())
            .filter(Boolean);
        },
        matchesAreaSchema(root: Element): boolean {
          const colkeys = new Set(helper.colkeysWithin(root));
          const headerText = helper.headerTextsWithin(root).join('|');
          const subsidy = (colkeys.has('pk_reimtype') && colkeys.has('defitem9') && colkeys.has('defitem5'))
            || (/出差天数/.test(headerText) && /出差人数/.test(headerText) && /补助/.test(headerText));
          const lodging = (colkeys.has('defitem21') && colkeys.has('defitem4')
            && colkeys.has('defitem1') && colkeys.has('defitem2'))
            || (/入住日期/.test(headerText) && /离店日期/.test(headerText)
              && /入住城市|住宿天数/.test(headerText));
          const transport = (colkeys.has('defitem1') && colkeys.has('vat_amount') && !lodging)
            || (/出发日期/.test(headerText) && /价税合计/.test(headerText) && !lodging);
          if (subsidy) return false;
          // Horizontal virtualization may temporarily unmount the signature columns after
          // a section was already bound. Preserve that exact DOM root's affinity unless
          // the currently rendered columns positively identify a conflicting section.
          if ((root as HTMLElement).dataset.codexExpenseArea === area
            && (root as HTMLElement).dataset.codexTableToken) {
            if (area === 'arap_bxbusitem') return !lodging;
            if (area === 'other') return !transport || lodging;
            if (area === 'zsitem') return !lodging && !transport;
          }
          if (area === 'arap_bxbusitem') return transport;
          if (area === 'other') return lodging;
          if (area === 'zsitem') {
            return (!lodging && !transport && colkeys.has('vat_amount'))
              || (!lodging && !transport && /价税合计/.test(headerText));
          }
          return false;
        },
      };
      // A real BIP wrapper owns its header/body nodes. A shell which only contains another
      // #hot-key-bzitem does not. This also supports builds where a traffic wrapper owns its
      // own table while a later subsidy wrapper is nested below it in the DOM.
      const logicalTables = tables.filter((table) => {
        if (!helper.isRendered(table)) return false;
        return Array.from(table.querySelectorAll(
          '.table-next-header-wrapper th[colkey], .table-next-body tbody, .table-next-body td[colkey]',
        )).some((element) => helper.owns(table, element));
      });
      const candidateTables = logicalTables.filter((table) => {
        const colkeys = new Set(helper.colkeysFor(table));
        const subsidy = colkeys.has('pk_reimtype') && colkeys.has('defitem9') && colkeys.has('defitem5');
        const lodging = colkeys.has('defitem21') && colkeys.has('defitem4')
          && colkeys.has('defitem1') && colkeys.has('defitem2');
        const transport = colkeys.has('defitem1') && colkeys.has('vat_amount') && !lodging;
        // After the first strict semantic bind, keep the same DOM node usable when horizontal
        // virtualization temporarily unmounts signature columns. Explicit evidence that the node
        // has become another section always wins over the old affinity token.
        if (table.dataset.codexExpenseArea === area && table.dataset.codexTableToken) {
          if (subsidy) return false;
          if (area === 'other') return !transport || lodging;
          return !lodging;
        }
        if (area === 'arap_bxbusitem') {
          return transport && !subsidy;
        }
        if (area === 'other') return lodging;
        if (area === 'zsitem') return colkeys.has('vat_amount') && !subsidy && !lodging;
        return false;
      });
      const toolbarNodes = Array.from(document.querySelectorAll('[class]')).filter((element) => {
        const className = element.getAttribute('class') || '';
        return toolbarCandidates.some((candidate: string) => className.includes(candidate));
      });
      const uploadButtons: HTMLElement[] = [];
      if (!rejectedSubsidyToolbar) {
        for (const toolbar of toolbarNodes) {
          for (const button of Array.from(toolbar.querySelectorAll('button, a, [role="button"]')) as HTMLElement[]) {
            if ((button.textContent || '').replace(/\s+/g, '') !== '发票上传') continue;
            const buttonRect = button.getBoundingClientRect();
            if (!helper.isRendered(button) || buttonRect.width <= 0 || buttonRect.height <= 0 || uploadButtons.includes(button)) continue;
            uploadButtons.push(button);
          }
        }
      }

      const expenseToolbarFragments = [
        'arap_bxbusitem_card_body-button', 'arap_bxbusitem-button',
        'other_card_body-button', 'zsitem_card_body-button',
      ];
      const allVisibleUploadButtons = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .filter((element) => {
          if ((element.textContent || '').replace(/\s+/g, '') !== '发票上传' || !helper.isRendered(element)) return false;
          for (let node: Element | null = element.parentElement; node; node = node.parentElement) {
            const className = node.getAttribute('class') || '';
            if (expenseToolbarFragments.some((fragment) => className.includes(fragment))) return true;
            if (node.id === 'hot-key-bzitem') break;
          }
          return false;
        });
      const bindings: Array<{ button: HTMLElement; table: HTMLElement; scope: Element }> = [];
      for (const button of uploadButtons) {
        for (let node: Element | null = button.parentElement; node && node !== document.documentElement; node = node.parentElement) {
          const inside = candidateTables.filter((table) => node!.contains(table));
          if (!inside.length) continue;
          const topLevel = inside.filter((table) => !inside.some((other) => other !== table && other.contains(table)));
          if (topLevel.length !== 1) break;
          const uploadButtonsInside = allVisibleUploadButtons.filter((item) => node!.contains(item));
          if (uploadButtonsInside.length !== 1 || uploadButtonsInside[0] !== button) break;
          const text = (node.textContent || '').replace(/\s+/g, '');
          if (text.includes(title)) {
            bindings.push({ button, table: topLevel[0], scope: node });
            break;
          }
        }
        if (bindings.some((binding) => binding.button === button)) continue;

        // Newer BIP builds use one outer #hot-key-bzitem for several expense cards.
        // In that layout the semantic table root is the smallest card ancestor which
        // contains the exact title, the area-specific toolbar, and the area's columns.
        // Requiring one and only one visible expense upload button keeps this fallback
        // fail-closed and prevents the page-level container or subsidy card from matching.
        for (let node: Element | null = button.parentElement; node && node !== document.documentElement; node = node.parentElement) {
          const text = (node.textContent || '').replace(/\s+/g, '');
          if (!text.includes(title)) continue;
          const uploadButtonsInside = allVisibleUploadButtons.filter((item) => node!.contains(item));
          if (uploadButtonsInside.length !== 1 || uploadButtonsInside[0] !== button) break;
          if (!helper.matchesAreaSchema(node)) continue;
          bindings.push({ button, table: node as HTMLElement, scope: node });
          break;
        }
      }

      const uniqueBindings: Array<{ button: HTMLElement; table: HTMLElement; scope: Element }> = [];
      for (const binding of bindings) {
        if (!uniqueBindings.some((item) => item.button === binding.button && item.table === binding.table)) {
          uniqueBindings.push(binding);
        }
      }
      const nonTableRoots = Array.from(new Set(uniqueBindings
        .map((binding) => binding.table)
        .filter((root) => tables.indexOf(root) < 0)));
      const matchingBindings = uniqueBindings.filter((binding) => {
        const tableIndex = tables.indexOf(binding.table);
        const index = tableIndex >= 0 ? tableIndex : tables.length + nonTableRoots.indexOf(binding.table);
        if (expectedToken) return binding.table.dataset.codexTableToken === expectedToken;
        return expectedIndex < 0 || index === expectedIndex;
      });
      const wrapperIndexes = Array.from(new Set(uniqueBindings.map((binding) => {
        const tableIndex = tables.indexOf(binding.table);
        return tableIndex >= 0 ? tableIndex : tables.length + nonTableRoots.indexOf(binding.table);
      }).filter((index) => index >= 0)));
      const resolved = matchingBindings.length === 1 && wrapperIndexes.length === 1 ? matchingBindings[0] : null;

      let targetToken = '';
      let ownedColkeys: string[] = [];
      let businessCount: number | null = null;
      let sectionTotal: number | null = null;
      let scopeText = '';
      let clicked = false;
      let schemaMatched = false;
      let headerTexts: string[] = [];
      let targetRootTag = '';
      if (resolved) {
        const root = document.documentElement as HTMLElement;
        let sequence = Number(root.dataset.codexTableSequence || '0');
        if (!resolved.table.dataset.codexTableToken) {
          sequence += 1;
          resolved.table.dataset.codexTableToken = `codex-table-${sequence}`;
          root.dataset.codexTableSequence = String(sequence);
        }
        targetToken = resolved.table.dataset.codexTableToken;
        ownedColkeys = Array.from(new Set(
          tables.includes(resolved.table) ? helper.colkeysFor(resolved.table) : helper.colkeysWithin(resolved.table),
        )).sort();
        schemaMatched = helper.matchesAreaSchema(resolved.table);
        headerTexts = helper.headerTextsWithin(resolved.table).slice(0, 30);
        targetRootTag = resolved.table.tagName.toLowerCase()
          + (resolved.table.id ? '#' + resolved.table.id : '')
          + (resolved.table.className ? '.' + String(resolved.table.className).trim().replace(/\s+/g, '.') : '');
        const compact = (resolved.scope.textContent || '').replace(/\s+/g, '');
        const titleIndex = compact.indexOf(title);
        let sectionText = titleIndex >= 0 ? compact.slice(titleIndex) : compact;
        for (const boundary of ['交通费用', '住宿费用', '其他费用', '出差补贴']) {
          if (boundary === title) continue;
          const boundaryIndex = sectionText.indexOf(boundary, title.length);
          if (boundaryIndex > 0) sectionText = sectionText.slice(0, boundaryIndex);
        }
        scopeText = sectionText.slice(0, 320);
        const countMatch = sectionText.match(/共(\d+)条/);
        const totalMatch = sectionText.match(/共\d+条.*?合计(?:金额)?[￥¥]?(-?[\d,]+(?:\.\d+)?)/);
        if (countMatch) businessCount = Number(countMatch[1]);
        if (totalMatch) sectionTotal = Number(totalMatch[1].replace(/,/g, ''));
        if (businessCount !== null && Number.isFinite(businessCount)) {
          resolved.table.dataset.codexSectionBusinessCount = String(businessCount);
        } else delete resolved.table.dataset.codexSectionBusinessCount;
        if (sectionTotal !== null && Number.isFinite(sectionTotal)) {
          resolved.table.dataset.codexSectionTotal = String(sectionTotal);
        } else delete resolved.table.dataset.codexSectionTotal;
        resolved.table.dataset.codexExpenseArea = area;
        if (shouldClick) {
          resolved.button.scrollIntoView({ block: 'center' });
          resolved.button.click();
          clicked = true;
        }
      }
      return {
        wrapperIdx: resolved
          ? (tables.indexOf(resolved.table) >= 0
            ? tables.indexOf(resolved.table)
            : tables.length + nonTableRoots.indexOf(resolved.table))
          : -1,
        targetToken,
        clicked,
        toolbarNodeCount: toolbarNodes.length,
        uploadButtonCount: uploadButtons.length,
        bindingWrapperIndexes: wrapperIndexes,
        innermostTableIndexes: logicalTables.map((table) => tables.indexOf(table)),
        tableCount: tables.length,
        toolbarClasses: toolbarNodes.map((node) => node.getAttribute('class') || ''),
        areaCode: area,
        ownedColkeys,
        businessCount,
        sectionTotal,
        scopeText,
        schemaMatched,
        headerTexts,
        targetRootTag,
      };
    }, {
      title: sectionTitle,
      area: areaCode,
      toolbarCandidates: Array.from(toolbars),
      expectedIndex: typeof expectedTarget === 'number' ? expectedTarget : -1,
      expectedToken: typeof expectedTarget === 'string' ? expectedTarget : '',
      shouldClick: clickUpload,
    });
  }

  // 只允许点击费用分区专属工具栏中的“发票上传”。真正点击只执行一次；校验失败即停止，
  // 不再按纵向距离、标题近似或全页按钮序号兜底，避免把发票传入出差补贴。
  private async clickInvoiceUpload(
    sectionTitle: string,
    areaCode: string,
    toolbars: readonly string[],
    expectedTarget: TableTargetRef | -1 = -1,
  ): Promise<boolean> {
    const result = await this.inspectExpenseTarget(
      sectionTitle,
      areaCode,
      toolbars,
      expectedTarget,
      true,
    ).catch((error: Error) => {
      console.log('clickInvoiceUpload evaluate失败:', error.message.slice(0, 180));
      return null;
    });
    if (result?.clicked) return true;
    console.log('clickInvoiceUpload: 未找到或无法验证“' + sectionTitle + '”分区的发票上传按钮，诊断:', JSON.stringify(result));
    return false;
  }

  // 表单可能处于查看态，上传前先点"修改"（若可见）
  private async clickModifyIfNeeded() {
    try {
      const mf = this.mf();
      const btn = mf.getByRole('button', { name: '修改', exact: true }).first();
      if (await this.waitVisible(btn, 1500)) {
        await btn.click();
        await this.safeSleep(1500);
        this.ensurePage();
        console.log('  已点击修改，进入编辑态');
      }
    } catch {}
  }

  // 在"明细调整"弹窗中点确认（参考 browserAuto）
  private async confirmDetailDialog(timeout = 10000): Promise<boolean> {
    // “去报销”后明细调整弹窗是异步弹出的；轮询等待，不能只在调用瞬间数一次。
    const deadline = Date.now() + timeout;
    try {
      while (true) {
        const mf = this.mf();
        const dialogs = mf.locator('[role="dialog"]:visible, .wui-modal:visible, .modal:visible, .dialog:visible, .popup-window:visible');
        for (let index = (await dialogs.count()) - 1; index >= 0; index--) {
          const dialog = dialogs.nth(index);
          const content = ((await dialog.textContent().catch(() => '')) || '').replace(/\s+/g, '');
          if (!/明细调整|发票间合并|费用类型/.test(content)) continue;
          const buttons = dialog.getByRole('button', { name: /^(确认|确认\(Y\)|确\s*定)$/ });
          for (let buttonIndex = 0; buttonIndex < await buttons.count(); buttonIndex++) {
            const button = buttons.nth(buttonIndex);
            if (await button.isVisible().catch(() => false)) {
              await button.click();
              return true;
            }
          }
        }
        if (Date.now() >= deadline) return false;
        await this.safeSleep(300);
      }
    } catch {
      return false;
    }
  }

  private visibleInvoiceUploadRoot() {
    const mf = this.mf();
    return mf.locator(
      '[role="dialog"]:visible:has(button:has-text("上传票据")), '
      + '.wui-modal:visible:has(button:has-text("上传票据")), '
      + '.modal:visible:has(button:has-text("上传票据")), '
      + '[class*="upload-invoice"]:visible',
    ).last();
  }

  // 读取发票上传弹窗中的票据列表状态。wui-table 的固定列会把同一行渲染进多个 tbody，
  // 因此优先按 data-row-key 去重，没有行键时取各 tbody 中最大的有效行数。
  private async readInvoiceUploadList(uploadRoot: ReturnType<ReimbursementAutomation['visibleInvoiceUploadRoot']>) {
    // evaluate 内不定义任何具名函数：tsx/esbuild 会注入浏览器端不存在的 __name。
    return uploadRoot.evaluate((root: Element) => {
      const keys = new Set<string>();
      const checkedKeys = new Set<string>();
      const rowTexts: string[] = [];
      let maxRows = 0;
      let maxChecked = 0;
      let hasRowCheckboxes = false;
      for (const tbody of Array.from(root.querySelectorAll('tbody'))) {
        let rowsInBody = 0;
        let checkedInBody = 0;
        for (const tr of Array.from(tbody.children)) {
          if (tr.tagName !== 'TR' || !tr.querySelector('td')) continue;
          const compact = (tr.textContent || '').replace(/\s+/g, '');
          const checkbox = tr.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
          // 只找真正的勾选框控件；单元格本身的 class 也含 checkbox（col-customer-checkbox），不能当成勾选框。
          const wrapper = tr.querySelector('label.wui-checkbox, .wui-checkbox, .nc-checkbox, [role="checkbox"]');
          if (!compact && !checkbox) continue;
          if (/暂无数据|NoData/i.test(compact)) continue;
          rowsInBody++;
          const key = tr.getAttribute('data-row-key') || tr.getAttribute('rowkey') || '';
          if (key) keys.add(key);
          const text = (tr.textContent || '').replace(/\s+/g, ' ').trim();
          if (text) rowTexts.push(text);
          if (checkbox || wrapper) hasRowCheckboxes = true;
          // 真实 BIP 用 label 上的 is-checked 表示已勾选，input.checked 仍为 false。
          const checked = Boolean(checkbox && checkbox.checked)
            || Boolean(tr.querySelector('.is-checked, .wui-checkbox-checked, .ant-checkbox-checked, [aria-checked="true"]'));
          if (checked) {
            checkedInBody++;
            if (key) checkedKeys.add(key);
          }
        }
        if (rowsInBody > maxRows) maxRows = rowsInBody;
        if (checkedInBody > maxChecked) maxChecked = checkedInBody;
      }

      const busySelectors = '.wui-spin-spinning, .wui-spin-dot, .wui-loading, .loading-container .loading, '
        + '[class*="spin-spinning"], [class*="uploading"], .wui-progress, [class*="progress-bar"]';
      let busyByElement = false;
      for (const el of Array.from(root.querySelectorAll(busySelectors))) {
        const style = window.getComputedStyle(el as HTMLElement);
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
          busyByElement = true;
          break;
        }
      }
      const busyRows = rowTexts.filter((text) => /上传中|解析中|识别中|处理中|查验中|校验中|加载中|排队中/.test(text));
      const failedRows = rowTexts.filter((text) =>
        /失败|错误|不支持|已存在|重复上传|已报销|(?<!无)异常/.test(text));
      return {
        rowCount: keys.size || maxRows,
        checkedCount: checkedKeys.size || maxChecked,
        hasRowCheckboxes,
        busy: busyByElement || busyRows.length > 0,
        busyRows: busyRows.slice(0, 5),
        failedRows: failedRows.slice(0, 5),
        rootText: (root.textContent || '').replace(/\s+/g, ' ').slice(0, 2000),
      };
    });
  }

  // 等待本批文件全部出现在上传弹窗并解析完毕。不能用固定秒数：8 张高铁票在 10 秒内
  // 只解析出 4 张，“全选 + 去报销”便只合并了一半金额，后续金额核对才拦截。
  private async waitForInvoiceUploadList(
    uploadRoot: ReturnType<ReimbursementAutomation['visibleInvoiceUploadRoot']>,
    baselineRows: number,
    fileCount: number,
    label: string,
  ): Promise<{ rowCount: number; structureKnown: boolean }> {
    const timeoutMs = Math.min(180000, 20000 + fileCount * 8000);
    const deadline = Date.now() + timeoutMs;
    const minWaitUntil = Date.now() + 3000;
    let stablePolls = 0;
    let lastRowCount = -1;
    let sawRows = false;
    let last: Awaited<ReturnType<ReimbursementAutomation['readInvoiceUploadList']>> | null = null;
    while (Date.now() < deadline) {
      await this.safeSleep(1000);
      this.ensurePage();
      last = await this.readInvoiceUploadList(uploadRoot).catch(() => null);
      if (!last) { stablePolls = 0; continue; }
      if (last.rowCount > 0) sawRows = true;
      const newRows = last.rowCount - baselineRows;
      await this.p(
        `等待${label}上传解析 (${Math.max(0, Math.min(newRows, fileCount))}/${fileCount})...`,
        62,
      );
      if (last.failedRows.length) {
        throw new Error(
          '上传发票(' + label + '): 上传弹窗中有票据失败，已在“去报销”前停止：' + last.failedRows.join('；'),
        );
      }
      const ready = newRows >= fileCount && !last.busy;
      if (ready && last.rowCount === lastRowCount) stablePolls++;
      else stablePolls = ready ? 1 : 0;
      lastRowCount = last.rowCount;
      // 连续两次读到相同的完整列表且没有加载状态，才认为解析完成。
      if (stablePolls >= 2 && Date.now() >= minWaitUntil) {
        console.log(`  上传发票(${label}): 弹窗已列出 ${newRows}/${fileCount} 张新票据`);
        return { rowCount: last.rowCount, structureKnown: true };
      }
    }

    try {
      const diagnosticDir = this.ensureDiagnosticDir();
      fs.writeFileSync(path.resolve(diagnosticDir, 'invoice-upload-diagnostic.json'), JSON.stringify({
        capturedAt: new Date().toISOString(),
        invoiceGroup: label,
        fileCount,
        baselineRows,
        timeoutMs,
        last,
        rootHtml: await uploadRoot.evaluate((root: Element) => root.outerHTML.slice(0, 20000)).catch(() => ''),
      }, null, 2));
    } catch {}

    if (!sawRows) {
      // 一次也没读到票据行，说明当前 BIP 版本的弹窗结构与预期不同，而不是上传不完整。
      // 保持原有行为继续，由后续“全选数量”和“费用行金额”核对兜底，并留下诊断文件便于调整。
      console.log(`  上传发票(${label}): 未能识别上传弹窗中的票据行，已写入 ${this.diagLabel('invoice-upload-diagnostic.json')}`);
      return { rowCount: 0, structureKnown: false };
    }
    const seen = Math.max(0, (last?.rowCount ?? 0) - baselineRows);
    throw new Error(
      '上传发票(' + label + '): 等待 ' + Math.round(timeoutMs / 1000) + ' 秒后上传弹窗仅列出 '
      + seen + '/' + fileCount + ' 张票据'
      + (last?.busy ? '，仍在解析中' : '')
      + (last?.busyRows.length ? '（' + last.busyRows.join('；') + '）' : '')
      + '。已在“去报销”前停止，避免只合并部分发票；诊断见 ' + this.diagLabel('invoice-upload-diagnostic.json'),
    );
  }

  // 从费用分区专属工具栏向上，只接受“标题 + 专属工具栏 + 唯一最内层费用表”同卡片绑定。
  // areaCode 仅保留用于日志/诊断；真实 BIP 不稳定地暴露 data-area-code，不能作为上传兜底。
  private async getExpenseTarget(sectionTitle: string, areaCode: string, toolbars: readonly string[]) {
    try {
      const result = await this.inspectExpenseTarget(sectionTitle, areaCode, toolbars);
      if (result.wrapperIdx >= 0 && result.targetToken && result.schemaMatched && result.ownedColkeys.length) return result;
      console.log('getExpenseTarget(' + sectionTitle + '/' + areaCode + ') 定位诊断:', JSON.stringify(result));
      return null;
    } catch (error) {
      console.log('getExpenseTarget(' + sectionTitle + '/' + areaCode + ') 失败:', (error as Error).message.slice(0, 240));
      return null;
    }
  }

  private async getExpenseWrapperIndex(sectionTitle: string, areaCode: string, toolbars: readonly string[]): Promise<number> {
    const result = await this.getExpenseTarget(sectionTitle, areaCode, toolbars);
    return result?.wrapperIdx ?? -1;
  }

  private async waitForGeneratedExpenseRows(
    sectionTitle: string,
    areaCode: string,
    toolbars: readonly string[],
    before: TableRowSnapshot,
    timeoutMs = 30000,
    expectation: GeneratedRowExpectation = {},
  ): Promise<{ wrapperIdx: number; targetToken: string; rowRefs: string[]; after: TableRowSnapshot }> {
    const startedAt = Date.now();
    let lastWrapperIdx = -1;
    let lastTargetToken = '';
    let lastSnapshot: TableRowSnapshot = { rowKeys: [], rowCount: 0 };
    let stableSignature = '';
    let stableMatches = 0;
    const amountColumnPrepared = new Set<string>();
    const needsAmount = Number.isFinite(expectation.expectedAmount)
      && Math.abs(expectation.expectedAmount!) > 0;
    while (Date.now() - startedAt < timeoutMs) {
      this.ensurePage();
      const target = await this.getExpenseTarget(sectionTitle, areaCode, toolbars);
      lastWrapperIdx = target?.wrapperIdx ?? -1;
      lastTargetToken = target?.targetToken ?? '';
      if (lastWrapperIdx >= 0 && lastTargetToken) {
        // 上一批填写账号后表格停在右侧，金额虚拟列可能已卸载。
        // 先让本分区的金额列重新渲染，再快照并校验金额；不以分区总额替代行金额。
        // React 重建表格获得新 token 时重新定位，避免沿用旧分区的滚动状态。
        if (needsAmount && !amountColumnPrepared.has(lastTargetToken)) {
          if (await this.scrollTableToColumn(lastTargetToken, 'vat_amount')) {
            amountColumnPrepared.add(lastTargetToken);
          }
        }
        lastSnapshot = await this.getTableRowSnapshot(lastTargetToken);
        if (!lastSnapshot.targetFound) {
          stableSignature = '';
          stableMatches = 0;
          await this.safeSleep(250);
          continue;
        }
        const rowRefs = diffGeneratedRows(before, lastSnapshot, expectation);
        if (rowRefs.length) {
          const rowIndexes = rowRefs.map(parseTableIndexRowRef).filter((index): index is number => index !== null);
          const signature = JSON.stringify({
            targetToken: lastTargetToken,
            rowRefs,
            fingerprints: rowIndexes.map((index) => lastSnapshot.fingerprints?.[index] || ''),
            businessCount: lastSnapshot.businessCount,
            sectionTotal: lastSnapshot.sectionTotal,
          });
          if (signature === stableSignature) stableMatches += 1;
          else {
            stableSignature = signature;
            stableMatches = 1;
          }
          // BIP 的公式和虚拟表会异步回填；连续两次得到完全相同的唯一候选后才允许写账号。
          if (stableMatches >= 2) return {
            wrapperIdx: lastWrapperIdx,
            targetToken: lastTargetToken,
            rowRefs,
            after: lastSnapshot,
          };
        } else {
          stableSignature = '';
          stableMatches = 0;
        }
      }
      await this.safeSleep(750);
    }
    return { wrapperIdx: lastWrapperIdx, targetToken: lastTargetToken, rowRefs: [], after: lastSnapshot };
  }

  // ── 发票上传（参考 browserAuto：机票/高铁分别批量传交通费，住宿、其他各自上传）──
  async uploadInvoices(invoices: any, approval?: any): Promise<UploadReport> {
    const groups = INVOICE_UPLOAD_GROUPS;
    const fc = getFillConfig();
    const regionKeyword = getRegionSearchKeyword(approval?.destination || '');
    let uploaded = 0;
    let expected = 0;
    const warnings: string[] = [];

    await this.clickModifyIfNeeded();

    for (const group of groups) {
      this.ensurePage();
      const mf = this.mf();
      const items: any[] = [];
      for (const key of group.keys) {
        const list = (invoices && invoices[key]) || [];
        for (const it of list) items.push({ ...it, catKey: key });
      }
      if (!items.length) continue;
      expected += items.length;
      const expectedBatchAmount = items.reduce((sum, item) => {
        const amount = Number(String(item?.amount ?? '').replace(/[￥¥,\s]/g, ''));
        return Number.isFinite(amount) ? sum + amount : sum;
      }, 0);

      // 只使用当前会话整理出的精确文件路径。禁止退回全局 ready_uploads，避免并发
      // 会话或同名文件串用其他报销人的材料。
      const files = items.map((item: any) => String(item.path || ''));
      const missingFiles = files.filter((file: string) => !file || !fs.existsSync(file));
      if (missingFiles.length) {
        throw new Error(
          `上传发票(${group.label}): ${missingFiles.length}/${items.length} 个当前会话文件不存在，已停止以避免串传或遗漏`,
        );
      }

      await this.p('正在上传' + group.label + ' (' + files.length + '张)...', 60 + Math.min(uploaded, 5));

      // Bind the semantic expense table to a DOM token before reading it. A numeric wrapper index
      // is diagnostic only: BIP can unmount a hidden wrapper between two evaluate calls and make
      // the same number point at the subsidy table.
      let targetBeforeUpload = await this.getExpenseTarget(group.sectionTitle, group.areaCode, group.toolbars);
      let rowsBeforeUpload = targetBeforeUpload
        ? await this.getTableRowSnapshot(targetBeforeUpload.targetToken)
        : { rowKeys: [], rowCount: 0, fingerprints: [], targetFound: false } as TableRowSnapshot;
      for (let attempt = 0; attempt < 4 && (!targetBeforeUpload || !rowsBeforeUpload.targetFound); attempt++) {
        await this.safeSleep(250);
        targetBeforeUpload = await this.getExpenseTarget(group.sectionTitle, group.areaCode, group.toolbars);
        rowsBeforeUpload = targetBeforeUpload
          ? await this.getTableRowSnapshot(targetBeforeUpload.targetToken)
          : { rowKeys: [], rowCount: 0, fingerprints: [], targetFound: false };
      }
      if (!targetBeforeUpload || !rowsBeforeUpload.targetFound) {
        const diagnostic = await this.inspectExpenseTarget(
          group.sectionTitle,
          group.areaCode,
          group.toolbars,
        ).catch((error: Error) => ({ evaluateError: error.message }));
        try {
          fs.writeFileSync(this.diagFile('expense-diagnostic.json'), JSON.stringify({
            capturedAt: new Date().toISOString(),
            invoiceGroup: group.label,
            sectionTitle: group.sectionTitle,
            areaCode: group.areaCode,
            diagnostic,
          }, null, 2));
        } catch {}
        const warning = '上传发票(' + group.label + '): 上传前无法确认“' + group.sectionTitle + '”费用表，已停止以避免传错位置';
        console.log(warning);
        throw new Error(warning);
      }
      const wrapperBeforeUpload = targetBeforeUpload.wrapperIdx;
      console.log(
        '  上传发票(' + group.label + '): 目标表token=' + targetBeforeUpload.targetToken
        + '，当前索引=' + wrapperBeforeUpload
        + '，上传前“' + group.sectionTitle + '”逻辑行数='
        + rowsBeforeUpload.rowCount + '，rowkey数=' + rowsBeforeUpload.rowKeys.length,
      );

      // 点击对应费用表的"发票上传"
      const clicked = await this.clickInvoiceUpload(
        group.sectionTitle,
        group.areaCode,
        group.toolbars,
        targetBeforeUpload.targetToken,
      );
      if (!clicked) {
        const warning = '上传发票(' + group.label + '): 未找到发票上传按钮';
        console.log(warning);
        throw new Error(warning);
      }
      await this.safeSleep(2000);
      this.ensurePage();
      const uploadRoot = this.visibleInvoiceUploadRoot();
      if (!await this.waitVisible(uploadRoot, 30000)) {
        throw new Error('上传发票(' + group.label + '): 未出现当前分区的可见发票上传窗口');
      }

      // 优先直接写入隐藏文件输入。新版 BIP 弹窗会同时渲染桌面/响应式两个同名
      // “上传票据”按钮，直接 click 会触发 Playwright strict mode；input 本身才是唯一
      // 稳定的上传入口。老版本没有可写 input 时再回退到 filechooser。
      // 弹窗可能保留上一批或票夹中的票据，先记下基线，只等待本批新增的行。
      const listBeforeUpload = await this.readInvoiceUploadList(uploadRoot).catch(() => null);
      const baselineRows = listBeforeUpload?.rowCount ?? 0;
      let setOk = false;
      try {
        const dialogInput = uploadRoot.locator('input[type="file"]').first();
        await dialogInput.setInputFiles(files, { timeout: 30000 });
        setOk = true;
      } catch (e) {
        console.log('上传发票(' + group.label + '): 直接写入方式失败:', (e as Error).message.slice(0, 150));
      }
      if (!setOk) {
        // 兼容老版本：监听 filechooser，并将同名按钮收敛为一个可操作节点。
        try {
          const [chooser] = await Promise.all([
            this.page!.waitForEvent('filechooser', { timeout: 12000 }),
            uploadRoot.getByRole('button', { name: '上传票据', exact: true }).last().click(),
          ]);
          await chooser.setFiles(files);
          setOk = true;
        } catch (e) {
          console.log('上传发票(' + group.label + '): filechooser 方式失败:', (e as Error).message.slice(0, 200));
        }
      }
      if (!setOk) {
        throw new Error('上传发票(' + group.label + '): 文件未能写入上传控件');
      }

      // 等待本批每张票据都出现在弹窗中且解析完成，再全选（按张数放宽超时，不再固定等 10 秒）。
      await this.p('等待' + group.label + '上传解析...', 62 + Math.min(uploaded, 5));
      const uploadList = await this.waitForInvoiceUploadList(uploadRoot, baselineRows, files.length, group.label);
      if (!uploadList.structureKnown) await this.safeSleep(10000);
      this.ensurePage();

      // 全选所有已上传发票（表头复选框）
      let checked = false;
      try {
        const cb = uploadRoot.locator('th input[type="checkbox"], .wui-table-thead input[type="checkbox"]').first();
        if (await this.waitVisible(cb, 3000)) {
          await cb.check();
          checked = await cb.isChecked().catch(() => false);
        }
      } catch {}
      if (!checked) {
        try {
          const label = uploadRoot.locator('.wui-checkbox.wui-checkbox-inverse.wui-checkbox-primary.base-checkbox-hotkey-wrapper.nc-checkbox.table-checkbox > .wui-checkbox-label').first();
          await label.click();
          const state = label.locator('input[type="checkbox"]').first();
          checked = await state.isChecked().catch(() => false);
        } catch {}
      }
      if (!checked) throw new Error('上传发票(' + group.label + '): 未能确认本批发票已经全选');
      await this.safeSleep(800);
      this.ensurePage();
      if (uploadList.structureKnown) {
        const selection = await this.readInvoiceUploadList(uploadRoot).catch(() => null);
        if (selection?.hasRowCheckboxes && selection.checkedCount < baselineRows + files.length) {
          throw new Error(
            '上传发票(' + group.label + '): 全选后仅勾选 ' + selection.checkedCount + ' 张，'
            + '本批应有 ' + files.length + ' 张，已在“去报销”前停止',
          );
        }
        if (selection && baselineRows > 0) {
          console.log(`  上传发票(${group.label}): 弹窗中另有 ${baselineRows} 张既有票据也被全选，后续金额核对将拦截不一致`);
        }
      }

      // 去报销
      let goClicked = false;
      try {
        const goBtn = uploadRoot.getByRole('button', { name: '去报销', exact: true });
        if (await this.waitVisible(goBtn, 30000)) {
          await goBtn.click();
          goClicked = true;
          await this.safeSleep(1200);
          this.ensurePage();
        }
      } catch {}
      if (!goClicked) {
        throw new Error('上传发票(' + group.label + '): 上传后未出现“去报销”按钮');
      }
      await this.safeSleep(500);
      this.ensurePage();

      // 行政区划从审批单的出差地点提取，不读取本地固定配置。
      const mf2 = this.mf();
      const regionInput = mf2.getByRole('textbox', { name: '搜索行政区划' });
      if (await this.waitVisible(regionInput, 2500)) {
        if (!regionKeyword) throw new Error('上传发票(' + group.label + '): 无法从出差审批单解析行政区划');
        await regionInput.fill(regionKeyword);
        await this.safeSleep(900);
        const opt = mf2.locator('a, tr, li').filter({ hasText: regionKeyword }).first();
        if (!await this.waitVisible(opt, 2500)) {
          throw new Error('上传发票(' + group.label + '): 未找到行政区划 ' + regionKeyword);
        }
        await opt.click();
        await this.safeSleep(400);
        await this.confirmPopup();
      }

      // 发票间合并
      try {
        const mf2 = this.mf();
        const merge = mf2.getByRole('radio', { name: FIXED_INVOICE_MERGE_TYPE });
        if (await this.waitVisible(merge, 2000)) await merge.check();
      } catch {}
      await this.safeSleep(400);
      this.ensurePage();

      // 费用类型（境内差旅费）
      try {
        const mf2 = this.mf();
        const refIcon = mf2.locator('.demoPadding > .refer-wrapper > .wui-col-xs-12 > .icon-refer').first();
        if (await this.waitVisible(refIcon, 2000)) {
          await refIcon.click();
          await this.safeSleep(600);
          const opt = mf2.locator('a').filter({ hasText: FIXED_INVOICE_EXPENSE_TYPE }).first();
          if (await this.waitVisible(opt, 2500)) { await opt.click(); await this.confirmPopup(); }
        }
      } catch {}
      await this.safeSleep(400);
      this.ensurePage();

      // 明细调整弹窗"确认"（参考 browserAuto）
      await this.waitForBipReady('正在生成报销明细', 120000);
      if (!await this.confirmDetailDialog(30000)) {
        throw new Error('上传发票(' + group.label + '): 明细调整确认失败');
      }
      await this.safeSleep(2000);
      this.ensurePage();

      // 在刚生成的费用明细行中填写收款账号；住宿行同时补齐审批单对应的住宿字段。
      let payeeReady = true;
      const bankAccount = fc.bankAccount || config.bankAccount || '';
      try {
        const generated = await this.waitForGeneratedExpenseRows(
          group.sectionTitle,
          group.areaCode,
          group.toolbars,
          rowsBeforeUpload,
          90000,
          {
            // 用户流程要求机票、高铁、住宿和其他发票各批次均生成一条费用明细。
            expectedRowCount: 1,
            expectedAmount: Math.abs(expectedBatchAmount) > 0 ? expectedBatchAmount : undefined,
          },
        );
        const { wrapperIdx, targetToken, rowRefs: generatedRows, after: rowsAfterUpload } = generated;
        if (wrapperIdx < 0 || !targetToken || !generatedRows.length) {
          try {
            fs.writeFileSync(this.diagFile('expense-row-diagnostic.json'), JSON.stringify({
              capturedAt: new Date().toISOString(),
              invoiceGroup: group.label,
              sectionTitle: group.sectionTitle,
              expectedGeneratedRows: 1,
              expectedBatchAmount,
              itemAmounts: items.map((item) => Number(item?.amount) || 0),
              wrapperIdx,
              targetToken,
              targetBeforeUpload,
              before: rowsBeforeUpload,
              after: rowsAfterUpload,
            }, null, 2));
          } catch {}
          throw new Error(
            '上传发票(' + group.label + '): 未识别到“' + group.sectionTitle + '”中新生成的费用明细行'
            + '（上传前行数=' + rowsBeforeUpload.rowCount
            + '，上传后行数=' + rowsAfterUpload.rowCount
            + '，上传前rowkey=' + rowsBeforeUpload.rowKeys.length
            + '，上传后rowkey=' + rowsAfterUpload.rowKeys.length
            + '，业务条数=' + String(rowsBeforeUpload.businessCount ?? '未知')
            + '→' + String(rowsAfterUpload.businessCount ?? '未知')
            + '，分区合计=' + String(rowsBeforeUpload.sectionTotal ?? '未知')
            + '→' + String(rowsAfterUpload.sectionTotal ?? '未知') + '）',
          );
        } else {
          const verifiedTarget = await this.inspectExpenseTarget(
            group.sectionTitle,
            group.areaCode,
            group.toolbars,
            targetToken,
          );
          if (verifiedTarget.targetToken !== targetToken || verifiedTarget.wrapperIdx < 0) {
            throw new Error('上传发票(' + group.label + '): 填写前费用表身份已变化，已停止以避免写入其他分区');
          }
          console.log(
            '  上传发票(' + group.label + '): 新增明细行=' + generatedRows.join(',')
            + '，目标token=' + targetToken + '，准备横向滚动并填写右侧字段',
          );
          for (const rowkey of generatedRows) {
            if (group.lodging) {
              const lodgingWarnings = await this.fillLodgingDetails(
                targetToken, rowkey, approval, bankAccount, items[0],
              );
              warnings.push(...lodgingWarnings);
              if (lodgingWarnings.length) payeeReady = false;
            } else if (group.needPayee) {
              console.log('  上传发票(' + group.label + '): 在新增行补选收款人账号');
              const accountOk = await this.fillTablePayeeAccount(targetToken, rowkey, bankAccount);
              if (!accountOk) {
                warnings.push('上传发票(' + group.label + '): 新增行收款人账号选择失败');
                payeeReady = false;
              }
            }
          }
        }
      } catch (e) {
        console.log('  填写发票明细失败:', (e as Error).message.slice(0, 120));
        throw new Error('上传发票(' + group.label + '): 费用明细填写失败：' + (e as Error).message);
      }

      if (!payeeReady) {
        throw new Error('上传发票(' + group.label + '): 新增行信息未全部填写，已停止后续发票上传');
      }
      uploaded += files.length;
    }
    await this.p(`发票上传完成 (${uploaded}/${expected})`, 70);
    return { expected, uploaded, warnings };
  }

  private getDeclaredAttachmentItems(documents: any): any[] {
    const items: any[] = [];
    const docKeys = ['出差审批单', '出差补助单', '税额计算表', '其他凭证'];
    for (const key of docKeys) {
      const list = (documents && documents[key]) || [];
      for (const item of list) items.push(item);
    }
    return items;
  }

  private getAttachmentFiles(documents: any): string[] {
    return this.getDeclaredAttachmentItems(documents)
      .map((item: any) => item?.path)
      .filter((file: string) => file && fs.existsSync(file));
  }

  private async uploadFilesInScanPage(scanPage: Page, files: string[]): Promise<UploadReport> {
    const warnings: string[] = [];
    let imported = 0;
    const batchSize = 5;

    const clickFirstVisible = async (
      locator: any,
      timeout = 5000,
      closedAfterClickMeansSuccess = false,
    ): Promise<boolean> => {
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index++) {
        const candidate = locator.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        try {
          await candidate.click({ timeout });
          return true;
        } catch {
          // 影像系统保存成功后可能由自身立即关闭窗口，导致 click 在事件已送达后
          // 收到 Target closed。此规则只允许用于最终“保存”，不能用于导入阶段。
          if (closedAfterClickMeansSuccess && scanPage.isClosed()) return true;
        }
      }
      return false;
    };

    const visibleFailure = async (): Promise<string> => {
      const failure = scanPage.locator(
        '[role="alert"], .message, .toast, .notification, .wui-message, [class*="error"]',
      ).filter({ hasText: /失败|错误|超限|不支持|异常/ }).last();
      if (!(await failure.isVisible().catch(() => false))) return '';
      return ((await failure.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    };

    for (let start = 0; start < files.length; start += batchSize) {
      const batch = files.slice(start, start + batchSize);
      const range = `${start + 1}-${start + batch.length}`;
      console.log(`  影像附件第 ${range} 个：${batch.map((file) => path.basename(file)).join('、')}`);

      const importButtons = scanPage.getByText('本地导入', { exact: true });
      if (!await clickFirstVisible(importButtons)) {
        warnings.push(`附件第 ${range} 个：未找到可见“本地导入”`);
        break;
      }
      await scanPage.waitForTimeout(600);

      let filesSet = false;
      const input = scanPage.locator('#importFile, input[type="file"]').first();
      if (await input.count().catch(() => 0)) {
        try {
          await input.setInputFiles(batch, { timeout: 30000 });
          const selectedCount = await input.evaluate((element: HTMLInputElement) => element.files?.length || 0);
          filesSet = selectedCount === batch.length;
          if (!filesSet) warnings.push(`附件第 ${range} 个：文件控件仅接收 ${selectedCount}/${batch.length} 个文件`);
        } catch (error) {
          console.log(`  影像附件第 ${range} 个直接写入失败:`, (error as Error).message.slice(0, 180));
        }
      }
      if (!filesSet) {
        try {
          const chooserTrigger = scanPage.getByRole('img', {
            name: /上传普通文件.*附件入口.*禁止上传发票/,
          }).last();
          const [chooser] = await Promise.all([
            scanPage.waitForEvent('filechooser', { timeout: 10000 }),
            chooserTrigger.click({ timeout: 5000 }),
          ]);
          await chooser.setFiles(batch);
          filesSet = true;
        } catch (error) {
          console.log(`  影像附件第 ${range} 个 filechooser 失败:`, (error as Error).message.slice(0, 180));
        }
      }
      if (!filesSet) {
        warnings.push(`附件第 ${range} 个：未能写入影像上传控件`);
        break;
      }

      await scanPage.waitForTimeout(1500);
      const importConfirm = scanPage.getByRole('button', { name: /^确\s*定$/ });
      if (!await clickFirstVisible(importConfirm)) {
        warnings.push(`附件第 ${range} 个：导入确认按钮未出现`);
        break;
      }
      await scanPage.waitForTimeout(1500);
      const importError = await visibleFailure();
      if (importError) {
        warnings.push(`附件第 ${range} 个：影像系统提示${importError}`);
        break;
      }
      imported += batch.length;
    }

    if (imported !== files.length) {
      return { expected: files.length, uploaded: 0, warnings };
    }

    const saveCandidates = scanPage.getByRole('button', { name: '保存', exact: true })
      .or(scanPage.locator('button, div, span').filter({ hasText: /^保存$/ }));
    if (!await clickFirstVisible(saveCandidates, 8000, true)) {
      warnings.push('附件保存按钮未找到或点击失败');
      return { expected: files.length, uploaded: 0, warnings };
    }
    const completed = (): UploadReport => ({ expected: files.length, uploaded: imported, warnings });
    if (scanPage.isClosed()) {
      console.log('  影像附件保存后窗口已自动关闭，按保存成功处理');
      return completed();
    }
    await scanPage.waitForTimeout(1000).catch((error) => {
      if (!scanPage.isClosed()) throw error;
    });
    if (scanPage.isClosed()) {
      console.log('  影像附件保存后窗口已自动关闭，按保存成功处理');
      return completed();
    }

    // 部分影像版本保存后需要二次确认，另一些版本直接完成；有按钮则必须点击。
    const saveConfirm = scanPage.getByRole('button', { name: /^确\s*定$/ });
    await clickFirstVisible(saveConfirm, 5000, true);
    if (scanPage.isClosed()) {
      console.log('  影像附件确认保存后窗口已自动关闭，按保存成功处理');
      return completed();
    }
    await scanPage.waitForTimeout(1500).catch((error) => {
      if (!scanPage.isClosed()) throw error;
    });
    if (scanPage.isClosed()) {
      console.log('  影像附件确认保存后窗口已自动关闭，按保存成功处理');
      return completed();
    }
    const saveError = await visibleFailure();
    if (saveError) {
      warnings.push('附件保存失败：' + saveError);
      return { expected: files.length, uploaded: 0, warnings };
    }
    return completed();
  }

  // ── 附件上传（报销单已经精确点击“保存”后，才进入影像扫描）──
  async uploadAttachments(documents: any): Promise<UploadReport> {
    const files = this.getAttachmentFiles(documents);
    if (!files.length) return { expected: 0, uploaded: 0, warnings: [] };
    const warnings: string[] = [];
    await this.p('正在上传附件(' + files.length + '个)...', 80);

    const mf = this.mf();

    // 必须从当前报销单点击“影像扫描”，由 BIP 带出单据关联参数。禁止直接打开
    // scanUrl，否则文件可能进入未绑定当前单据的空影像会话。
    let scanPage: Page | null = null;
    try {
      const exact = mf.getByRole('button', { name: '影像扫描', exact: true }).first();
      const fallback = mf.locator('button').filter({ hasText: /^影像扫描$/ }).first();
      const trigger = await this.waitVisible(exact, 3000) ? exact : fallback;
      if (!await this.waitVisible(trigger, 2000)) {
        return { expected: files.length, uploaded: 0, warnings: ['当前单据未找到“影像扫描”按钮'] };
      }
      [scanPage] = await Promise.all([
        this.context!.waitForEvent('page', { timeout: 25000 }),
        trigger.click({ timeout: 8000 }),
      ]);
    } catch (error) {
      console.log('打开影像扫描页面失败:', (error as Error).message.slice(0, 220));
    }
    if (!scanPage) {
      return { expected: files.length, uploaded: 0, warnings: ['点击“影像扫描”后未打开关联影像页面'] };
    }
    try {
      await scanPage.waitForLoadState('domcontentloaded', { timeout: 90000 }).catch(() => {});
      const localImport = scanPage.getByText('本地导入', { exact: true }).first();
      await localImport.waitFor({ state: 'visible', timeout: 20000 });
      const report = await this.uploadFilesInScanPage(scanPage, files);
      if (report.uploaded !== report.expected) {
        try {
          const diagnosticDir = this.ensureDiagnosticDir();
          fs.writeFileSync(path.resolve(diagnosticDir, 'attachment-diagnostic.json'), JSON.stringify({
            capturedAt: new Date().toISOString(),
            url: scanPage.url(),
            expectedFiles: files.map((file) => path.basename(file)),
            report,
            pageText: ((await scanPage.locator('body').textContent().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 3000),
          }, null, 2));
          await scanPage.screenshot({ path: path.resolve(diagnosticDir, 'attachment-error.png'), fullPage: true });
        } catch {}
      }
      await this.p(`附件上传完成 (${report.uploaded}/${files.length})`, 90);
      return report;
    } catch (error) {
      warnings.push('影像扫描页面未就绪：' + (error as Error).message.slice(0, 160));
      return { expected: files.length, uploaded: 0, warnings };
    } finally {
      try { await scanPage.close(); } catch {}
    }
  }

  // ── 附件张数 ──
  async fillAttachmentCount(count: number): Promise<boolean> {
    await this.page!.keyboard.press('Home');
    await this.page!.waitForTimeout(400);
    const mf = this.mf();
    const candidates: any[] = [
      mf.locator('.form-item.fjzs input').first(),
      mf.getByRole('spinbutton', { name: /附件张数/ }).first(),
      mf.getByRole('textbox', { name: /附件张数/ }).first(),
      mf.getByLabel(/附件张数/).first(),
    ];
    for (const input of candidates) {
      try {
        if (!await this.waitVisible(input, 800)) continue;
        await input.fill(String(count));
        if (Number(await input.inputValue()) === count) return true;
      } catch {}
    }
    return false;
  }

  // 在最终保存前勾选“是否合并支付”；只在未选中时操作，避免反向取消。
  async ensureMergePaymentChecked(): Promise<boolean> {
    await this.page!.keyboard.press('Home');
    await this.page!.waitForTimeout(400);
    const mf = this.mf();
    const candidates: any[] = [
      mf.locator('.form-item.zyx25 input[type="checkbox"]').first(),
      mf.locator('.form-item.zyx25').getByRole('checkbox').first(),
      mf.getByRole('checkbox', { name: /是否合并支付/ }).first(),
      mf.getByLabel(/是否合并支付/).first(),
    ];
    for (const checkbox of candidates) {
      try {
        if (await checkbox.count() === 0) continue;
        if (!await checkbox.isChecked().catch(() => false)) {
          await checkbox.check({ force: true, timeout: 4000 });
          await this.page!.waitForTimeout(400);
        }
        if (await checkbox.isChecked().catch(() => false)) return true;
      } catch {}
    }
    return false;
  }

  // 只允许点击表单顶部精确名称为“保存”的可见按钮，绝不匹配“保存提交”。
  async saveDraftOnly(): Promise<boolean> {
    const mf = this.mf();
    const statusRoots: any[] = [mf, this.page!];
    const modal = mf.locator('[role="dialog"]:visible, .wui-modal:visible, .modal:visible, .dialog:visible').last();
    if (await modal.isVisible().catch(() => false)) {
      console.log('保存报销单前仍有可见弹窗，拒绝点击可能属于弹窗的“保存”');
      return false;
    }
    const billNo = mf.locator('.form-item.djbh input').first();
    const beforeBillNo = await billNo.inputValue().catch(() => '');
    const beforeModifyVisible = await mf.getByRole('button', { name: '修改', exact: true }).first()
      .isVisible().catch(() => false);
    const buttons = mf.getByRole('button', { name: '保存', exact: true });
    let saveButton: any = null;
    const count = await buttons.count();
    for (let index = 0; index < count; index++) {
      const candidate = buttons.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        const label = (await candidate.textContent().catch(() => '')) || '';
        if (isDraftSaveLabel(label)) { saveButton = candidate; break; }
      }
    }
    if (!saveButton) return false;

    const visibleStatusText = async (pattern: RegExp): Promise<string> => {
      for (const root of statusRoots) {
        const status = root.locator(
          '[role="alert"], .wui-message, .toast, .notification, .next-message, [class*="message"]',
        ).filter({ hasText: pattern }).last();
        if (await status.isVisible().catch(() => false)) {
          return ((await status.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        }
      }
      return '';
    };
    const isSaveBusy = async (): Promise<boolean> => {
      for (const root of statusRoots) {
        const masks = root.locator(
          '.wui-loading-mask:visible, .wui-spin-spinning:visible, '
          + '.next-loading-tip:visible, .next-loading-indicator:visible, '
          + '.loading-mask:visible, [aria-busy="true"]:visible',
        );
        if (await masks.count().catch(() => 0)) return true;
        const text = root.getByText(/^\s*(?:加载中|处理中|保存中)[.…]*\s*$/).last();
        if (await text.isVisible().catch(() => false)) return true;
      }
      return false;
    };

    await saveButton.click();

    // BIP 保存接口有时需要几十秒，旧逻辑约 6 秒就结束校验，页面仍显示“加载中”时
    // 会误判失败。这里持续观察并锁存一闪而过的成功信号，且加载层消失前绝不继续。
    const deadline = Date.now() + 120000;
    let sawBusy = false;
    let successObserved = false;
    let lastBusyLogAt = 0;
    while (Date.now() < deadline) {
      const busy = await isSaveBusy();
      sawBusy ||= busy;

      const successText = await visibleStatusText(/保存成功|操作成功|处理成功|保存完成/);
      if (successText) successObserved = true;

      let currentBillNo = '';
      if (await billNo.isVisible().catch(() => false)) {
        currentBillNo = (await billNo.inputValue().catch(() => '')).trim();
      }
      const modifyVisible = await mf.getByRole('button', { name: '修改', exact: true }).first()
        .isVisible().catch(() => false);

      const billNumberCreated = Boolean(currentBillNo)
        && (!beforeBillNo.trim() || currentBillNo !== beforeBillNo.trim());
      const enteredSavedView = !beforeModifyVisible && modifyVisible;
      // 编辑已有草稿时单据编号不会变化；完整的加载周期结束且未出现错误也可确认保存。
      const existingDraftCompleted = Boolean(beforeBillNo.trim()) && sawBusy && !busy;

      const errorText = await visibleStatusText(/保存失败|操作失败|处理失败|错误|必填|异常/);
      if (errorText) {
        console.log('保存报销单失败提示:', errorText.slice(0, 240));
        return false;
      }
      if (!busy && (successObserved || billNumberCreated || enteredSavedView || existingDraftCompleted)) {
        console.log('保存报销单已确认:', currentBillNo || successText || '页面已进入保存完成状态');
        return true;
      }
      if (busy && Date.now() - lastBusyLogAt >= 10000) {
        console.log('  报销单仍在保存加载中，继续等待...');
        lastBusyLogAt = Date.now();
      }
      await this.page!.waitForTimeout(500);
    }

    try {
      const diagnosticDir = this.ensureDiagnosticDir();
      fs.writeFileSync(path.resolve(diagnosticDir, 'save-diagnostic.json'), JSON.stringify({
        capturedAt: new Date().toISOString(),
        beforeBillNo,
        currentBillNo: await billNo.inputValue().catch(() => ''),
        sawBusy,
        successObserved,
        pageText: ((await mf.locator('body').textContent().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 4000),
      }, null, 2));
    } catch {}
    console.log('保存报销单等待120秒后仍无法确认，已写入 ' + this.diagLabel('save-diagnostic.json'));
    return false;
  }

  // ── 主流程 ──
  async run(sessionData: any): Promise<AutomationReport> {
    requireAutomationConfig();
    const fc = getFillConfig();
    const requiredFillValues: Record<string, unknown> = {
      bankAccount: fc.bankAccount || config.bankAccount,
      paymentBank: fc.paymentBank || config.paymentBank,
      budgetItem: fc.budgetItem || config.budgetItem,
    };
    const missingFillValues = Object.entries(requiredFillValues)
      .filter(([, value]) => !String(value || '').trim())
      .map(([key]) => key);
    if (missingFillValues.length) {
      throw new Error(
        `缺少本单位填单配置: ${missingFillValues.join(', ')}。`
        + '请复制 fill-config.example.json 为 fill-config.json，并填写本单位对应选项',
      );
    }
    const summary = String(sessionData.summary || '').trim();
    if (!summary) {
      throw new Error('无法从上传材料解析报账事由，已停止自动填写');
    }
    const subsidyData = sessionData.subsidy ? normalizeSubsidy(sessionData.subsidy) : null;
    this.useRunDiagnosticDir(sessionData.session_id);
    await this.start();
    let tracing = false;
    try {
      await this.login();
      // 登录后再开始录制，避免账号密码的输入动作被写进 trace。
      tracing = await this.startTracing();
      await this.checkForceLogin();
      await this.navigateToForm();
      await this.checkForceLogin();
      await this.fillBasicInfo(summary);
      await this.checkForceLogin();
      const subsidyRows = subsidyData ? await this.fillSubsidy(subsidyData, summary) : 0;
      await this.checkForceLogin();
      const invoiceReport = await this.uploadInvoices(sessionData.invoices, sessionData.approval);
      if (invoiceReport.uploaded !== invoiceReport.expected) {
        throw new Error(`发票仅完成 ${invoiceReport.uploaded}/${invoiceReport.expected} 张，请根据日志检查上传步骤`);
      }

      // 所有发票新增行都完成后，先计算待上传附件，填写张数并勾选合并支付。
      const declaredAttachments = this.getDeclaredAttachmentItems(sessionData.documents);
      const attachmentFiles = this.getAttachmentFiles(sessionData.documents);
      if (attachmentFiles.length !== declaredAttachments.length) {
        throw new Error(`其他附件仅找到 ${attachmentFiles.length}/${declaredAttachments.length} 个文件，未保存报销单`);
      }
      const attachmentCount = calculateAttachmentCount(invoiceReport.uploaded, attachmentFiles.length);
      await this.p('正在填写附件张数...', 72);
      if (!await this.fillAttachmentCount(attachmentCount)) throw new Error('附件张数填写失败');
      await this.p('正在勾选是否合并支付...', 74);
      if (!await this.ensureMergePaymentChecked()) throw new Error('“是否合并支付”勾选失败，未保存报销单');

      // 只能保存草稿；saveDraftOnly 使用 exact:true，永远不会匹配“保存提交”。
      await this.p('正在保存报销单（不提交）...', 76);
      if (!await this.saveDraftOnly()) throw new Error('未能确认报销单“保存”成功，未上传其他附件');

      // 报销单保存成功后才允许进入影像扫描并上传审批单等其他附件。
      await this.checkForceLogin();
      const attachmentReport = await this.uploadAttachments(sessionData.documents);
      if (attachmentReport.uploaded !== attachmentReport.expected) {
        const details = attachmentReport.warnings.filter(Boolean).join('；');
        throw new Error(
          `附件仅完成 ${attachmentReport.uploaded}/${attachmentReport.expected} 份`
          + (details ? `：${details}` : '，请根据日志检查影像扫描步骤'),
        );
      }
      const report: AutomationReport = {
        subsidyRows,
        invoices: invoiceReport,
        attachments: attachmentReport,
        attachmentCount,
        warnings: [...invoiceReport.warnings, ...attachmentReport.warnings],
      };
      await this.p('正在执行最终校验...', 99);
      return report;
    } catch (err: any) {
      await this.p('执行出错: ' + err.message, 0);
      try { await this.page?.screenshot({ path: this.diagFile('error.png'), fullPage: true }); } catch {}
      try {
        const pages = this.context ? this.context.pages() : [];
        console.log('[debug] context pages:', pages.length, pages.map((pg: any) => pg.url()).join(' | '));
      } catch {}
      console.log('[诊断] 本次填单的截图、诊断文件和 trace 保存在 ' + this.diagLabel(''));
      throw err;
    } finally {
      if (tracing) await this.stopTracing();
    }
  }

  // 每次填单使用 sessions/<会话>/automation-<时间> 目录，并只保留最近若干次，避免 trace 无限占用磁盘。
  private useRunDiagnosticDir(sessionId: unknown): void {
    const sessionsRoot = path.resolve(process.cwd(), 'sessions');
    const safeSession = String(sessionId || 'unknown').replace(/[^\w-]/g, '').slice(0, 64) || 'unknown';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.diagnosticDir = path.resolve(sessionsRoot, safeSession, 'automation-' + stamp);
    this.ensureDiagnosticDir();
    pruneAutomationRuns(sessionsRoot, MAX_KEPT_AUTOMATION_RUNS, this.diagnosticDir);
  }

  private async startTracing(): Promise<boolean> {
    if (!this.context || process.env.REIMBURSEMENT_TRACE === '0') return false;
    try {
      await this.context.tracing.start({ screenshots: true, snapshots: true, title: '报销自动填单' });
      return true;
    } catch (error) {
      console.log('[诊断] 无法开启 Playwright trace:', (error as Error).message.slice(0, 160));
      return false;
    }
  }

  private async stopTracing(): Promise<void> {
    try {
      const tracePath = this.diagFile('trace.zip');
      await this.context?.tracing.stop({ path: tracePath });
      console.log('[诊断] trace 已保存，可用 npx playwright show-trace "' + this.diagLabel('trace.zip') + '" 回放');
    } catch (error) {
      console.log('[诊断] 保存 trace 失败:', (error as Error).message.slice(0, 160));
    }
  }

  async close() { await this.browser?.close(); }
}
