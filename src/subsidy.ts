export interface SubsidyEntry {
  name: string;
  days: number;
  people: 1;
  meal_allowance: number;
  transport_allowance: number;
}

export interface SubsidyData {
  entries: SubsidyEntry[];
  total_meal: number;
  total_transport: number;
  total_amount: number;
}

export const SUBSIDY_EXTRACTION_PROMPT = `你是报销补助单抄录助手。请逐行抄录中国出差补助单表格中的原始数字，按人员分别输出，不要做任何计算。

抄录规则：
1. 先定位姓名列，再沿该人员所在行读取同一行的单元格，不能串行、串列。同一人在不同期间有多条明细时，保留多条记录。
2. 每条记录只对应一名明确的人员，name 只能有一个姓名，people 固定为 1。多人天数和金额相同也必须分别输出。
3. transport_cell、meal_cell：照抄该行“市内交通费”“伙食补助费”两列单元格里印着的数字。有的补助单这两列是每日标准，有的是应领金额，你都不要换算，照抄即可；写着 0 就填 0。
4. row_total：照抄该行“补助金额合计 / 小计 / 应领合计”等合计列的数字；没有这一列就填 null。
5. days：该行“补助有效天数 / 出差天数”列的数字。
6. “合计、总计、小计、汇总”等行不是人员，不得放入 entries；把合计行的数字分别照抄到顶层 table_total_transport、table_total_meal、table_total，没有合计行就填 null。
7. 看不清的数字填 null，不得猜测或借用其他行的值。只列多人合计、没有个人明细时，返回 entries=[]。

只返回下列结构的 JSON，不要 Markdown 或解释：
{"entries":[{"name":"张三","days":3,"people":1,"transport_cell":80,"meal_cell":100,"row_total":540}],"table_total_transport":240,"table_total_meal":300,"table_total":540}
示例中的姓名和数字只用于说明格式，实际输出必须以本次材料为准。`;

function optionalCents(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = typeof value === 'string' ? value.trim().replace(/[,，\s￥¥元]/g, '') : value;
  if ((typeof raw !== 'number' && typeof raw !== 'string') || !/^-?\d+(?:\.\d+)?$/.test(String(raw))) return null;
  const cents = Math.round(Number(raw) * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

// 模型只抄录单元格原值；“每日标准”还是“应领金额”由这里用行合计和合计行核对后确定。
// 两种解释都对不上、或缺少可核对的合计时停止，交给人工核对，不猜测。
export function reconcileSubsidyTable(raw: any): any {
  const rows = Array.isArray(raw?.entries) ? raw.entries : [];
  const usesCells = rows.some((row: any) => row && ('transport_cell' in row || 'meal_cell' in row || 'row_total' in row));
  if (!usesCells) return raw; // 旧格式（已是应领金额）原样交给 normalizeSubsidy 校验

  type Mode = 'amount' | 'daily';
  const parsed = rows.map((row: any, index: number) => {
    const label = `第 ${index + 1} 条${row?.name ? `（${String(row.name).trim()}）` : ''}`;
    const days = Number(row?.days);
    const transport = optionalCents(row?.transport_cell);
    const meal = optionalCents(row?.meal_cell);
    if (!Number.isFinite(days) || days <= 0) throw new Error(`补助明细${label}天数缺失或无法确认，请按人员核对原件`);
    if (transport === null || meal === null) throw new Error(`补助明细${label}市内交通费或伙食补助费缺失，请按人员核对原件`);
    const rowTotal = optionalCents(row?.row_total);
    let mode: Mode | null = null;
    if (rowTotal !== null) {
      if (transport + meal === rowTotal) mode = 'amount';
      else if (Math.round((transport + meal) * days) === rowTotal) mode = 'daily';
      else throw new Error(`补助明细${label}的交通费、伙食费与该行合计对不上，请核对原件`);
    }
    return { row, days, transport, meal, mode };
  });

  const amountsFor = (item: any, mode: Mode) => mode === 'daily'
    ? { transport: Math.round(item.transport * item.days), meal: Math.round(item.meal * item.days) }
    : { transport: item.transport, meal: item.meal };

  const undecided = parsed.filter((item: any) => !item.mode);
  if (undecided.length) {
    // 没有行合计时，用合计行判断：未定的行统一按一种解释，看哪一种与合计行吻合。
    const tableTransport = optionalCents(raw?.table_total_transport);
    const tableMeal = optionalCents(raw?.table_total_meal);
    const tableTotal = optionalCents(raw?.table_total);
    const fits = (mode: Mode) => {
      let t = 0;
      let m = 0;
      for (const item of parsed) {
        const amounts = amountsFor(item, item.mode || mode);
        t += amounts.transport;
        m += amounts.meal;
      }
      const checks = [
        tableTransport === null || tableTransport === t,
        tableMeal === null || tableMeal === m,
        tableTotal === null || tableTotal === t + m,
      ];
      return checks.every(Boolean);
    };
    const hasReference = optionalCents(raw?.table_total_transport) !== null
      || optionalCents(raw?.table_total_meal) !== null || optionalCents(raw?.table_total) !== null;
    const sameEitherWay = undecided.every((item: any) => item.days === 1);
    const candidates = (['amount', 'daily'] as Mode[]).filter(fits);
    let chosen: Mode | null = null;
    if (sameEitherWay) chosen = 'amount';
    else if (hasReference && candidates.length === 1) chosen = candidates[0];
    if (!chosen) {
      throw new Error('无法确认补助单上的交通费、伙食费是每日标准还是应领金额（缺少可核对的合计），请在确认页核对补助金额');
    }
    for (const item of undecided) item.mode = chosen;
  }

  const entries = parsed.map((item: any) => {
    const amounts = amountsFor(item, item.mode);
    return {
      name: item.row?.name ?? null,
      days: item.days,
      people: item.row?.people ?? 1,
      meal_allowance: amounts.meal / 100,
      transport_allowance: amounts.transport / 100,
    };
  });
  return { entries };
}

function readNumber(value: unknown, label: string): number {
  const raw = typeof value === 'string'
    ? value.trim().replace(/[,，\s￥¥元]/g, '') : value;
  if ((typeof raw !== 'number' && typeof raw !== 'string')
    || raw === '' || !/^-?\d+(?:\.\d+)?$/.test(String(raw))) {
    throw new Error(`补助明细${label}缺失或无法确认，请按人员核对原件`);
  }
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`补助明细${label}必须是有效的非负数`);
  }
  return number;
}

function toCents(value: unknown, label: string): number {
  const amount = readNumber(value, label);
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(cents - amount * 100) > 0.000001) {
    throw new Error(`补助明细${label}最多保留两位小数`);
  }
  return cents;
}

// 个人明细是唯一金额来源，服务端和填单端都不得按全体人数重新计算。
export function normalizeSubsidy(data: any, approvalTravelers: string[] = []): SubsidyData {
  if (!Array.isArray(data?.entries) || !data.entries.length) {
    throw new Error('补助识别结果缺少按人员分开的 entries 明细，不能使用多人合计替代');
  }
  const travelers = Array.from(new Set(approvalTravelers.map((name) => String(name).trim()).filter(Boolean)));
  let mealCents = 0;
  let transportCents = 0;
  const entries: SubsidyEntry[] = data.entries.map((entry: any, index: number) => {
    const label = `第 ${index + 1} 条`;
    let name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    // 旧版单人文本提取可用唯一审批人员补齐姓名；多人时绝不能默认使用第一个人。
    if (!name && data.entries.length === 1 && travelers.length === 1) name = travelers[0];
    if (!name || /[、，,;；/／&＆+＋\r\n]|(?:等|共)\s*\d+\s*人|^(?:合计|总计|小计|汇总)/.test(name)
      || /[\u4e00-\u9fff]{2,}\s+[\u4e00-\u9fff]{2,}/.test(name)) {
      throw new Error(`补助${label}必须对应一个明确姓名，不能混入多人或合计行`);
    }
    if (Number(entry?.people) !== 1) {
      throw new Error(`补助${label}（${name}）人数必须为 1，请按人员分别提供金额`);
    }
    const days = readNumber(entry.days, `${label}（${name}）天数`);
    if (days <= 0) throw new Error(`补助${label}（${name}）缺少有效天数`);
    const meal = toCents(entry.meal_allowance, `${label}（${name}）伙食补助`);
    const transport = toCents(entry.transport_allowance, `${label}（${name}）交通补助`);
    mealCents += meal;
    transportCents += transport;
    return { name, days, people: 1, meal_allowance: meal / 100, transport_allowance: transport / 100 };
  });
  const totals = { total_meal: mealCents, total_transport: transportCents, total_amount: mealCents + transportCents };
  for (const [field, cents] of Object.entries(totals)) {
    if (!Number.isSafeInteger(cents)) throw new Error('补助合计金额超出有效范围');
    if (data[field] != null && toCents(data[field], field) !== cents) {
      throw new Error(`补助${field}与个人明细之和不一致，请核对是否合并、遗漏或重复识别人员`);
    }
  }
  return { entries, total_meal: mealCents / 100, total_transport: transportCents / 100, total_amount: totals.total_amount / 100 };
}
