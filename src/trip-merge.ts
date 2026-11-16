import path from 'path';
import { normalizeSubsidy, SubsidyData } from './subsidy.js';

// 一次报销可能附带多份出差审批单 / 补助单（例如多人各自审批的同一次出差）。
// 这里把它们合并成一张报账单所需的数据；无法自动确定的部分写入 warnings，由确认页人工核对。

export const LIST_SEPARATOR = /[、,，;；/／]+/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: unknown): boolean {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function uniqueTexts(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    const key = text.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

export interface MergedApproval {
  travelers: string[];
  start_date: string;
  end_date: string;
  destination: string;
  purpose: string;
  department: string;
  sources: { file: string; travelers: string[]; start_date: string; end_date: string; destination: string }[];
}

export function mergeApprovals(approvals: any[]): { approval: MergedApproval | null; warnings: string[] } {
  const list = (approvals || []).filter(Boolean);
  if (!list.length) return { approval: null, warnings: [] };
  const warnings: string[] = [];

  const travelers = uniqueTexts(list.flatMap((item) => Array.isArray(item.travelers) ? item.travelers : []));
  const starts = list.map((item) => item.start_date).filter(isValidIsoDate).sort();
  const ends = list.map((item) => item.end_date).filter(isValidIsoDate).sort();
  const destinations = uniqueTexts(list.map((item) => item.destination));
  const purposes = uniqueTexts(list.map((item) => item.purpose));
  const departments = uniqueTexts(list.map((item) => item.department));

  const approval: MergedApproval = {
    travelers,
    start_date: starts[0] || '',
    end_date: ends[ends.length - 1] || '',
    destination: destinations.join('、'),
    purpose: purposes.join('；'),
    department: departments.join('、'),
    sources: list.map((item) => ({
      file: item.filepath ? path.basename(item.filepath) : '',
      travelers: Array.isArray(item.travelers) ? item.travelers : [],
      start_date: String(item.start_date || ''),
      end_date: String(item.end_date || ''),
      destination: String(item.destination || ''),
    })),
  };

  if (list.length > 1) {
    warnings.push(`已合并 ${list.length} 份出差审批单：人员取并集，日期取最早出发和最晚返回，请核对。`);
    if (destinations.length > 1) {
      warnings.push(`各审批单出差地点不同（${destinations.join('、')}）。住宿城市和行政区划只能填一个，请把“目的地”改成本次报销对应的地点后再确认。`);
    }
    // 各审批期间之间有空档时提示核对（可能混入了另一趟出差的审批单）。
    const periods = list
      .filter((item) => isValidIsoDate(item.start_date) && isValidIsoDate(item.end_date))
      .map((item) => ({ start: item.start_date as string, end: item.end_date as string }))
      .sort((a, b) => a.start.localeCompare(b.start));
    let coveredUntil = periods[0]?.end || '';
    for (const period of periods.slice(1)) {
      if (dayDiff(coveredUntil, period.start) > 1) {
        warnings.push(`审批期间不连续（${coveredUntil} 之后到 ${period.start} 之间没有审批），请确认这些审批单属于同一次报销。`);
        break;
      }
      if (period.end > coveredUntil) coveredUntil = period.end;
    }
  }
  if (list.some((item) => !isValidIsoDate(item.start_date) || !isValidIsoDate(item.end_date))) {
    warnings.push('有审批单的出差日期没有识别出来，请在确认页核对出发和返回日期。');
  }
  return { approval, warnings };
}

function subsidySignature(subsidy: any): string {
  const entries = Array.isArray(subsidy?.entries) ? subsidy.entries : [];
  return entries
    .map((e: any) => [String(e.name || '').trim(), Number(e.days), Number(e.meal_allowance), Number(e.transport_allowance)].join('|'))
    .sort()
    .join('\n');
}

export function mergeSubsidies(subsidies: any[], travelers: string[]): { subsidy: SubsidyData | null; warnings: string[] } {
  const list = (subsidies || []).filter(Boolean);
  if (!list.length) return { subsidy: null, warnings: [] };
  if (list.length === 1) return { subsidy: normalizeSubsidy(list[0], travelers), warnings: [] };

  const warnings: string[] = [];
  const seen = new Set<string>();
  const entries: any[] = [];
  for (const item of list) {
    const signature = subsidySignature(item);
    // 明细完全相同的补助单视为同一张重复上传，只计一次。
    if (signature && seen.has(signature)) {
      warnings.push(`补助单 ${item.filepath ? path.basename(item.filepath) : ''} 与另一份内容完全相同，已按重复上传只计一次。`);
      continue;
    }
    seen.add(signature);
    entries.push(...(Array.isArray(item.entries) ? item.entries : []));
  }
  const names = entries.map((e) => String(e.name || '').trim()).filter(Boolean);
  const repeated = uniqueTexts(names.filter((name, index) => names.indexOf(name) !== index));
  if (repeated.length) {
    warnings.push(`补助明细中 ${repeated.join('、')} 出现多行，请确认不是同一期间重复领取。`);
  }
  warnings.unshift(`已合并 ${list.length} 份出差补助单的个人明细，合计按明细重新计算。`);
  return { subsidy: normalizeSubsidy({ entries }, travelers), warnings };
}
