import { normalizeSubsidy } from './subsidy.js';
import { isValidIsoDate, LIST_SEPARATOR } from './trip-merge.js';

const MAX_SUMMARY_LENGTH = 200;
const MAX_DESTINATION_LENGTH = 60;
const MAX_PURPOSE_LENGTH = 200;
const MAX_TRAVELERS = 30;

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效`);
  const text = value.trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字`);
  return text;
}

function parseTravelers(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(LIST_SEPARATOR) : null;
  if (!raw) throw new Error('出差人员格式无效');
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error('出差人员格式无效');
    const name = item.trim();
    if (!name) continue;
    if (name.length > 20 || LIST_SEPARATOR.test(name)) throw new Error(`出差人员“${name}”格式无效，每格只能填一个姓名`);
    if (!names.includes(name)) names.push(name);
  }
  if (!names.length) throw new Error('出差人员不能为空');
  if (names.length > MAX_TRAVELERS) throw new Error(`出差人员不能超过 ${MAX_TRAVELERS} 人`);
  return names;
}

// 确认页只允许修改报账事由、补助明细，以及出差审批信息（人员、起止日期、目的地、事由）。
// 发票、附件路径、分类等仍以服务端识别和整理结果为准，避免浏览器发回的整份数据覆盖服务端状态。
// forConfirm=true 时还会检查开始填单前必须满足的条件。
export function applyReviewEdits(serverResult: any, edits: any, options: { forConfirm?: boolean } = {}): any {
  if (!serverResult) throw new Error('当前没有可确认的识别结果');
  const next = { ...serverResult };
  if (edits && typeof edits === 'object') {
    if (edits.summary !== undefined) {
      next.summary = requiredText(edits.summary, '报账事由', MAX_SUMMARY_LENGTH);
    }

    const approvalEdits = edits.approval;
    if (approvalEdits && typeof approvalEdits === 'object' && serverResult.approval) {
      const approval = { ...serverResult.approval };
      // 浏览器会发回整份审批信息；只校验真正改动过的字段，未识别出又没改的字段保持原样。
      const changed = (field: string) => approvalEdits[field] !== undefined
        && JSON.stringify(approvalEdits[field]) !== JSON.stringify(serverResult.approval[field]);
      if (changed('travelers')) approval.travelers = parseTravelers(approvalEdits.travelers);
      if (changed('destination')) {
        approval.destination = requiredText(approvalEdits.destination, '目的地', MAX_DESTINATION_LENGTH);
      }
      if (changed('purpose')) {
        approval.purpose = requiredText(approvalEdits.purpose, '出差事由', MAX_PURPOSE_LENGTH);
      }
      for (const [field, label] of [['start_date', '出发日期'], ['end_date', '返回日期']] as const) {
        if (!changed(field)) continue;
        const value = typeof approvalEdits[field] === 'string' ? approvalEdits[field].trim() : approvalEdits[field];
        if (!isValidIsoDate(value)) throw new Error(`${label}必须是 YYYY-MM-DD 格式的有效日期`);
        approval[field] = value;
      }
      if ((changed('start_date') || changed('end_date'))
        && isValidIsoDate(approval.start_date) && isValidIsoDate(approval.end_date)
        && approval.end_date < approval.start_date) {
        throw new Error('返回日期不能早于出发日期');
      }
      next.approval = approval;
      if (changed('travelers')) next.travelers = approval.travelers;
    }

    if (edits.subsidy !== undefined && serverResult.subsidy) {
      // 补助只能修改识别出的人员明细，合计由明细重新计算；不合法时整体拒绝。
      next.subsidy = normalizeSubsidy(edits.subsidy, next.travelers || []);
    } else if (next.subsidy && next.travelers !== serverResult.travelers) {
      // 人员名单变化后，按新名单重新校验补助明细。
      next.subsidy = normalizeSubsidy(next.subsidy, next.travelers || []);
    }
  }

  if (options.forConfirm && next.approval) {
    const sources = Array.isArray(next.approval.sources) ? next.approval.sources : [];
    // 合并多份审批单后，住宿城市和行政区划只能填一个地点。
    if (sources.length > 1 && LIST_SEPARATOR.test(String(next.approval.destination || ''))) {
      throw new Error('合并的审批单有多个出差地点，请先把“目的地”改成本次报销对应的一个地点');
    }
  }
  return next;
}
