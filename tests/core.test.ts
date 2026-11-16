import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { config } from '../src/config.js';

// 测试默认关闭识别缓存，避免写入项目 sessions/ 或在用例之间复用结果。
config.visionCache = false;
import { extractPdfTextLocally } from '../src/pdf-text.js';
import { normalizeSubsidy, reconcileSubsidyTable, SUBSIDY_EXTRACTION_PROMPT } from '../src/subsidy.js';
import { applyReviewEdits } from '../src/review-edits.js';
import { mergeApprovals, mergeSubsidies } from '../src/trip-merge.js';
import sharp from 'sharp';

import {
  classifyFile,
  extractLodgingStayDetails,
  extractSubsidy,
  findAmount,
  findDate,
  isValidClassification,
  needsLocalInvoiceTextRepair,
  parseMimoNumber,
  parseRailwayTicketXbrl,
  processAllFiles,
  shrinkImageForVision,
} from '../src/document-parser.js';
import {
  BIP_WORKFLOW_STAGES,
  buildLodgingDefaults,
  calculateAttachmentCount,
  DEFAULT_LODGING_PERSON_LEVEL,
  diffGeneratedRowKeys,
  diffGeneratedRows,
  FIXED_EXPENSE_BUSINESS_ATTR,
  FIXED_INVOICE_EXPENSE_TYPE,
  FIXED_INVOICE_MERGE_TYPE,
  FIXED_SETTLEMENT_METHOD,
  FIXED_SUBSIDY_MEAL_TYPE,
  FIXED_SUBSIDY_TRANSPORT_TYPE,
  getCitySearchCandidates,
  getRegionSearchKeyword,
  INVOICE_UPLOAD_GROUPS,
  isDraftSaveLabel,
  makeTableIndexRowRef,
  pruneAutomationRuns,
  parseTableIndexRowRef,
  resolveSubsidyTableChange,
  ReimbursementAutomation,
} from '../src/bip-automation.js';
import {
  attachInvoiceDetails,
  classifyAndRename,
  docTypeFromText,
  genInvoiceFilename,
  invoiceTypeFromText,
  sanitize,
} from '../src/file-processor.js';

test('金额提取优先使用合计金额', () => {
  assert.equal(findAmount('票价 CNY 1000.00\n税费 CNY 100.00\n合计 CNY 1100.00'), 1100);
  assert.equal(findAmount('价税合计（小写） ￥1,400.00'), 1400);
  assert.equal(
    findAmount(
      '合 计 ¥2227.54 ¥22.28\n价税合计（大写）贰仟贰佰肆拾玖圆捌角贰分 （小写）¥2249.82',
    ),
    2249.82,
    '住宿专票必须取价税合计小写金额，不能取前面的不含税合计',
  );
  assert.equal(
    findAmount(
      '合计\n价税合计（大写）（小写）\n备\n注\n¥2227.54¥22.28\n贰仟贰佰肆拾玖圆 捌角贰分\n¥2249.82\n1%天2227.5422.28',
    ),
    2249.82,
    'pdf-parse 将标签和值分区输出时，也必须通过净额加税额核验价税合计',
  );
});

test('MiMo 数值支持千分位、人民币符号和百分号', () => {
  assert.equal(parseMimoNumber('￥1,400.00 元'), 1400);
  assert.equal(parseMimoNumber('13%'), 13);
  assert.equal(parseMimoNumber('not-a-number'), 0);
});

test('日期提取支持中文、短横线和紧凑格式', () => {
  assert.equal(findDate('出差日期 2026年7月9日'), '2026-07-09');
  assert.equal(findDate('2026/07/24'), '2026-07-24');
  assert.equal(findDate('文件日期20260719'), '2026-07-19');
});

test('铁路电子客票 XBRL 提取车次、路线、席位和金额', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <xbrl xmlns:rai="http://xbrl.mof.gov.cn/taxonomy/2021-11-30/rai">
      <rai:ElectronicInvoiceRailwayETicketNumber>12345678901234567890</rai:ElectronicInvoiceRailwayETicketNumber>
      <rai:DateOfIssue>2026-08-27</rai:DateOfIssue>
      <rai:TypeOfBusiness>蓝</rai:TypeOfBusiness>
      <rai:DepartureStation>始发站</rai:DepartureStation>
      <rai:DestinationStation>终到站</rai:DestinationStation>
      <rai:TrainNumber>g8536</rai:TrainNumber>
      <rai:TravelDate>2026-08-25</rai:TravelDate>
      <rai:DepartureTime>15:39</rai:DepartureTime>
      <rai:SeatLevel>二等座</rai:SeatLevel>
      <rai:Carriage>05车</rai:Carriage>
      <rai:Seat>11A号</rai:Seat>
      <rai:Fare>107.00</rai:Fare>
      <rai:ETicketNumber>4764362086082696158012026</rai:ETicketNumber>
      <rai:Name>测试旅客</rai:Name>
      <rai:TaxAmount>8.83</rai:TaxAmount>
      <rai:NameOfPurchaser>测试公司&amp;分部</rai:NameOfPurchaser>
    </xbrl>`;

  assert.deepEqual(parseRailwayTicketXbrl(xml), {
    name: '测试旅客',
    date: '2026-08-25',
    amount: 107,
    invoice_number: '12345678901234567890',
    vendor: '',
    type: '高铁票',
    issue_date: '2026-08-27',
    departure_station: '始发',
    destination_station: '终到',
    train_number: 'G8536',
    departure_time: '15:39',
    seat_class: '二等座',
    carriage: '05车',
    seat: '11A号',
    ticket_number: '4764362086082696158012026',
    purchaser: '测试公司&分部',
    tax_amount: 8.83,
    is_refund: false,
  });
});

test('仅含通用出行日期的航空附件不能误识别为铁路电子客票', () => {
  assert.equal(
    parseRailwayTicketXbrl('<Invoice><TravelDate>2026-07-19</TravelDate><Name>张三</Name></Invoice>'),
    null,
  );
});

test('文件类型分类覆盖主要报销材料', () => {
  assert.equal(invoiceTypeFromText('航空电子客票行程单'), '机票');
  assert.equal(invoiceTypeFromText('酒店住宿费'), '住宿发票');
  assert.equal(invoiceTypeFromText('高铁票退票费报销凭证'), '其他发票');
  assert.equal(invoiceTypeFromText('航空机票改签手续费'), '其他发票');
  assert.equal(docTypeFromText('出差审批表'), '出差审批单');
  assert.equal(docTypeFromText('差旅补助明细'), '出差补助单');
  assert.equal(invoiceTypeFromText('航空意外保险费发票'), '其他发票');
  assert.equal(invoiceTypeFromText('高铁出行保险发票'), '其他发票');
});

test('普通增值税发票不能因含税额税率被分成税额计算表', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-vat-test-'));
  try {
    const vatInvoice = path.join(root, '通行费发票_税额_税率.txt');
    fs.writeFileSync(vatInvoice, '普通增值税电子发票 发票号码 开票日期 购买方 销售方 价税合计 税率 税额');
    assert.deepEqual(await classifyFile(vatInvoice), { category: 'invoice', type: '其他发票' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('视觉分类必须同时满足 category 与 type 的合法组合', () => {
  assert.equal(isValidClassification('invoice', '机票'), true);
  assert.equal(isValidClassification('document', '出差审批单'), true);
  assert.equal(isValidClassification('document', '机票'), false);
  assert.equal(isValidClassification('invoice', '税额计算表'), false);
  assert.equal(isValidClassification('unknown', '其他'), true);
});

test('仅含航班号的文件也能识别为机票', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-flight-number-test-'));
  try {
    for (const filename of ['CA1234.png', '3U8957.jpg']) {
      const file = path.join(root, filename);
      fs.writeFileSync(file, 'not-a-real-image');
      assert.deepEqual(await classifyFile(file), { category: 'invoice', type: '机票' });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('退票改签材料在解析阶段优先进入其他费用', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-refund-test-'));
  try {
    const refund = path.join(root, '高铁票退票费报销凭证.pdf');
    fs.writeFileSync(refund, 'not-a-real-pdf');
    assert.deepEqual(await classifyFile(refund), { category: 'invoice', type: '其他发票' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BIP 发票分区映射与截图要求一致', () => {
  assert.deepEqual(
    INVOICE_UPLOAD_GROUPS.map(({ label, sectionTitle, areaCode, toolbars, needPayee, lodging }) => ({
      label, sectionTitle, areaCode, toolbars, needPayee, lodging,
    })),
    [
      { label: '机票', sectionTitle: '交通费用', areaCode: 'arap_bxbusitem', toolbars: ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'], needPayee: true, lodging: false },
      { label: '高铁票', sectionTitle: '交通费用', areaCode: 'arap_bxbusitem', toolbars: ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'], needPayee: true, lodging: false },
      { label: '住宿发票', sectionTitle: '住宿费用', areaCode: 'other', toolbars: ['other_card_body-button'], needPayee: true, lodging: true },
      { label: '其他发票', sectionTitle: '其他费用', areaCode: 'zsitem', toolbars: ['zsitem_card_body-button'], needPayee: true, lodging: false },
    ],
  );
});

test('附件张数等于发票文件和其他影像附件文件之和', () => {
  assert.equal(calculateAttachmentCount(3, 2), 5);
  assert.equal(calculateAttachmentCount(0, 4), 4);
  assert.equal(calculateAttachmentCount(-2, Number.NaN), 0);
});

test('住宿字段默认使用出差审批单的城市、日期、天数和人数', () => {
  assert.deepEqual(buildLodgingDefaults({
    destination: '山东济南',
    start_date: '2026-07-19',
    end_date: '2026-07-25',
    travelers: ['张三'],
  }), {
    city: '山东济南',
    cityCandidates: ['济南', '济南市', '山东济南'],
    checkInDate: '2026-07-19',
    checkOutDate: '2026-07-25',
    days: 6,
    people: 1,
    payeeName: '张三',
  });
  assert.deepEqual(
    getCitySearchCandidates('四川省宜宾市叙州区'),
    ['宜宾', '宜宾市', '四川省宜宾市叙州区'],
    '具体出差地点包含区县时，入住城市必须先搜索地级市',
  );
  const lodgingStay = extractLodgingStayDetails(
    '开票日期：2026年 08月28日\n8月9日入 住，8月14日离 店。'
    + '8月17日入 住，8月21日离 店。8月23日入 住，8月25日离 店。共 11晚',
  );
  assert.deepEqual(lodgingStay, {
    check_in_date: '2026-08-09',
    check_out_date: '2026-08-25',
    lodging_days: 11,
    stay_periods: [
      { check_in_date: '2026-08-09', check_out_date: '2026-08-14' },
      { check_in_date: '2026-08-17', check_out_date: '2026-08-21' },
      { check_in_date: '2026-08-23', check_out_date: '2026-08-25' },
    ],
  });
  assert.deepEqual(
    buildLodgingDefaults({
      destination: '四川省宜宾市叙州区',
      start_date: '2026-07-28',
      end_date: '2026-08-23',
      travelers: ['张三'],
    }, lodgingStay),
    {
      city: '四川省宜宾市叙州区',
      cityCandidates: ['宜宾', '宜宾市', '四川省宜宾市叙州区'],
      checkInDate: '2026-08-09',
      checkOutDate: '2026-08-25',
      days: 11,
      people: 1,
      payeeName: '张三',
    },
    '住宿明细日期和晚数必须优先取住宿发票备注，不能使用整段出差审批日期',
  );
});

test('行政区划关键词从审批单目的地提取', () => {
  assert.equal(getRegionSearchKeyword('山东济南'), '山东');
  assert.equal(getRegionSearchKeyword('四川省宜宾市叙州区'), '四川');
  assert.equal(getRegionSearchKeyword('北京市海淀区'), '北京');
  assert.equal(getRegionSearchKeyword('济南市'), '济南');
  assert.equal(getRegionSearchKeyword(''), '');
});

test('发行版 BIP 选项保持固定值', () => {
  assert.deepEqual({
    settlementMethod: FIXED_SETTLEMENT_METHOD,
    expenseTypeTransport: FIXED_SUBSIDY_TRANSPORT_TYPE,
    expenseTypeMeal: FIXED_SUBSIDY_MEAL_TYPE,
    expenseBusinessAttr: FIXED_EXPENSE_BUSINESS_ATTR,
    invoiceMergeType: FIXED_INVOICE_MERGE_TYPE,
    invoiceExpenseType: FIXED_INVOICE_EXPENSE_TYPE,
    personLevel: DEFAULT_LODGING_PERSON_LEVEL,
  }, {
    settlementMethod: '联动支付',
    expenseTypeTransport: '交通费',
    expenseTypeMeal: '伙食费',
    expenseBusinessAttr: '管理费用',
    invoiceMergeType: '发票间合并',
    invoiceExpenseType: '境内差旅费',
    personLevel: '高速集团其他管理人员',
  });
});

test('发票上传后只处理目标费用表中新生成的明细行', () => {
  assert.deepEqual(diffGeneratedRowKeys(['交通旧行', '补贴行不在本表'], ['交通旧行', '交通新行']), ['交通新行']);
  assert.deepEqual(diffGeneratedRowKeys([], ['住宿新行', '住宿新行']), ['住宿新行']);
  assert.deepEqual(diffGeneratedRowKeys(['旧行'], ['旧行']), []);
});

test('BIP 新行缺少或复用 rowkey 时按新增尾部逻辑行定位', () => {
  assert.deepEqual(
    diffGeneratedRows(
      { rowKeys: ['交通旧行'], rowCount: 1 },
      { rowKeys: ['交通旧行', '交通新行'], rowCount: 2 },
    ),
    [makeTableIndexRowRef(1)],
  );
  assert.deepEqual(
    diffGeneratedRows(
      { rowKeys: ['预留一', '预留二'], rowCount: 2, fingerprints: ['defitem14:旧行|vat_amount:100.00', ''] },
      { rowKeys: ['预留一', '预留二'], rowCount: 2, fingerprints: ['defitem14:旧行|vat_amount:100.00', 'defitem14:张三报销差旅费用|vat_amount:2210.00'] },
    ),
    [makeTableIndexRowRef(1)],
    '行数与 rowkey 不变时，必须通过唯一业务指纹变化定位原地回填的费用行',
  );
  assert.deepEqual(
    diffGeneratedRows(
      {
        rowKeys: ['预留一', '预留二'], rowCount: 2, fingerprints: ['defitem14:旧行|vat_amount:100.00', ''],
        businessCount: 0, sectionTotal: 0,
      },
      {
        rowKeys: ['预留一', '预留二'], rowCount: 2,
        fingerprints: ['defitem14:旧行|vat_amount:100.00', 'defitem14:张三报销差旅费用|vat_amount:2210.00'],
        businessCount: 1, sectionTotal: 2210,
      },
      { expectedRowCount: 1, expectedAmount: 2210 },
    ),
    [makeTableIndexRowRef(1)],
    '业务条数、分区合计和批次金额一致时才能确认原地回填行',
  );
  assert.deepEqual(
    diffGeneratedRows(
      {
        rowKeys: ['预留行'], rowCount: 1, fingerprints: [''], businessCount: 0, sectionTotal: 0,
      },
      {
        rowKeys: ['预留行'], rowCount: 1, fingerprints: ['vat_amount:2210.00'], businessCount: 0, sectionTotal: 2210,
      },
      { expectedRowCount: 1, expectedAmount: 2210 },
    ),
    [],
    '卡片业务条数没有增加时必须停止，即使预留槽金额发生变化',
  );
  assert.deepEqual(
    diffGeneratedRows(
      {
        rowKeys: ['预留行'], rowCount: 1, fingerprints: [''], businessCount: 0, sectionTotal: 0,
      },
      {
        rowKeys: ['预留行'], rowCount: 1, fingerprints: ['vat_amount:2210.00'], businessCount: 1, sectionTotal: 2200,
      },
      { expectedRowCount: 1, expectedAmount: 2210 },
    ),
    [],
    '分区合计增量与本批发票金额不符时必须停止',
  );
  assert.deepEqual(
    diffGeneratedRows(
      { rowKeys: [], rowCount: 0 },
      { rowKeys: [], rowCount: 1 },
    ),
    [makeTableIndexRowRef(0)],
  );
  assert.deepEqual(
    diffGeneratedRows(
      { rowKeys: ['复用行键'], rowCount: 1 },
      { rowKeys: ['复用行键'], rowCount: 2 },
    ),
    [makeTableIndexRowRef(1)],
  );
  assert.deepEqual(
    diffGeneratedRows(
      { rowKeys: ['旧行'], rowCount: 1 },
      { rowKeys: ['旧行', '新增一', '新增二'], rowCount: 3 },
    ),
    [makeTableIndexRowRef(1), makeTableIndexRowRef(2)],
    '同一批生成多行时必须逐一定位全部新增行',
  );
  assert.deepEqual(
    diffGeneratedRows(
      { rowKeys: ['旧行'], rowCount: 1 },
      { rowKeys: ['新行'], rowCount: 1 },
    ),
    [makeTableIndexRowRef(0)],
    '逻辑行数被虚拟列表限制时仍转换为当前可见逻辑行序号',
  );
  assert.deepEqual(
    diffGeneratedRows(
      { rowKeys: ['旧一', '旧二'], rowCount: 2 },
      { rowKeys: ['重绘一', '重绘二'], rowCount: 2 },
    ),
    [],
    '多行 rowkey 同时变化只能视为整表重绘，不能猜测新增行',
  );
  assert.deepEqual(
    diffGeneratedRows(
      { rowKeys: ['旧行', '预留行'], rowCount: 2, fingerprints: ['defitem14:旧行|vat_amount:100.00', ''] },
      { rowKeys: ['旧行'], rowCount: 1, fingerprints: ['defitem14:旧行|vat_amount:100.00'] },
    ),
    [],
    '表体缩减属于虚拟列表重建，不能误判为生成行',
  );
  assert.deepEqual(
    diffGeneratedRows(
      { rowKeys: ['旧行', '预留行'], rowCount: 2, fingerprints: ['defitem14:旧行|vat_amount:100.00'] },
      { rowKeys: ['旧行', '预留行'], rowCount: 2, fingerprints: ['defitem14:旧行|vat_amount:100.00', 'defitem14:新行|vat_amount:2210.00'] },
    ),
    [],
    '指纹没有覆盖相同逻辑行时必须停止，不能按不完整数组猜测',
  );
  assert.deepEqual(
    diffGeneratedRows(
      { rowKeys: ['旧行', '预留行'], rowCount: 2, fingerprints: ['defitem14:旧行|vat_amount:2100.00', ''] },
      { rowKeys: ['旧行', '预留行'], rowCount: 2, fingerprints: ['defitem14:旧行|vat_amount:2210.00', ''] },
    ),
    [],
    '旧费用行只有金额重算时不能误认为本次生成的新行',
  );
  assert.deepEqual(
    diffGeneratedRows(
      { rowKeys: ['旧行', '预留行'], rowCount: 2, fingerprints: ['defitem14:旧行|vat_amount:100.00', ''] },
      { rowKeys: ['旧行', '预留行'], rowCount: 2, fingerprints: ['defitem14:旧行重算|vat_amount:100.00', 'defitem14:新行|vat_amount:2210.00'] },
    ),
    [],
    '两条逻辑行同时变化时即使有一个预留行变成发票行也必须停止',
  );
  assert.equal(parseTableIndexRowRef(makeTableIndexRowRef(3)), 3);
  assert.equal(parseTableIndexRowRef('正常rowkey'), null);
});

test('补助增行通过全页面唯一行变化和当前选中行定位', () => {
  const snapshot = (
    wrapperIdx: number,
    token: string,
    rowCount: number,
    selectedRowIndexes: number[] = [],
    focusedRowIndexes: number[] = [],
  ) => ({
    wrapperIdx,
    token,
    rowCount,
    rowKeys: Array.from({ length: rowCount }, (_, index) => `${token}-row-${index}`),
    fingerprints: Array.from({ length: rowCount }, (_, index) => `${token}-fingerprint-${index}`),
    selectedRowIndexes,
    focusedRowIndexes,
  });

  const before = [
    snapshot(0, 'transport', 0),
    snapshot(1, 'lodging', 0),
    snapshot(2, 'other', 0),
    snapshot(3, 'subsidy', 0),
  ];
  const firstRow = resolveSubsidyTableChange(before, [
    snapshot(0, 'transport', 0),
    snapshot(1, 'lodging', 0),
    snapshot(2, 'other', 0),
    snapshot(3, 'subsidy', 1, [0], [0]),
  ]);
  assert.equal(firstRow?.wrapperIdx, 3);
  assert.equal(firstRow?.rowRef, makeTableIndexRowRef(0));

  const beforeSecond = [
    snapshot(0, 'transport', 0),
    snapshot(1, 'lodging', 0),
    snapshot(2, 'other', 0),
    snapshot(3, 'subsidy', 1, [0]),
  ];
  const secondRow = resolveSubsidyTableChange(beforeSecond, [
    snapshot(0, 'transport', 0),
    snapshot(1, 'lodging', 0),
    snapshot(2, 'other', 0),
    snapshot(3, 'subsidy', 2, [1], [1]),
  ]);
  assert.equal(secondRow?.rowRef, makeTableIndexRowRef(1));

  const redrawnTable = resolveSubsidyTableChange(before, [
    snapshot(0, 'transport', 0),
    snapshot(1, 'lodging', 0),
    snapshot(2, 'other', 0),
    snapshot(3, 'subsidy-redrawn', 1, [0], [0]),
  ]);
  assert.equal(redrawnTable?.matchedBy, 'index', 'BIP 替换整张补助表 DOM 后仍须由同位置焦点行确认');

  const reservedSlotBefore = [snapshot(3, 'subsidy-slot', 1)];
  const activatedReservedSlot = resolveSubsidyTableChange(reservedSlotBefore, [
    snapshot(3, 'subsidy-slot', 1, [0], [0]),
  ]);
  assert.equal(
    activatedReservedSlot?.rowRef,
    makeTableIndexRowRef(0),
    'BIP 预渲染的空白行被原地激活时，行数不变也必须识别为本次补助行',
  );

  assert.equal(
    resolveSubsidyTableChange(before, [
      snapshot(0, 'transport', 0),
      snapshot(1, 'lodging', 0),
      snapshot(2, 'other', 0),
      snapshot(3, 'subsidy', 1),
    ])?.rowRef,
    makeTableIndexRowRef(0),
    '补贴专属增行后全页面只有一张表增长时，无需依赖 BIP 不稳定的选中类名',
  );

  assert.equal(
    resolveSubsidyTableChange(before, [
      snapshot(0, 'transport', 1, [0], [0]),
      snapshot(1, 'lodging', 0),
      snapshot(2, 'other', 0),
      snapshot(3, 'subsidy', 1, [0], [0]),
    ]),
    null,
    '两张表同时增行时必须停止，不能猜测补助表',
  );

  assert.equal(
    resolveSubsidyTableChange(before, [
      snapshot(0, 'transport', 2),
      snapshot(1, 'lodging', 0),
      snapshot(2, 'other', 0),
      snapshot(3, 'subsidy', 1, [0], [0]),
    ]),
    null,
    '其它表即使一次增加多行，也必须视为并发变化并停止',
  );

  const lazyMounted = resolveSubsidyTableChange(before.slice(0, 3), [
    snapshot(0, 'transport', 0),
    snapshot(1, 'lodging', 0),
    snapshot(2, 'other', 0),
    snapshot(3, 'new-subsidy-node', 1, [0], [0]),
  ]);
  assert.equal(lazyMounted?.wrapperIdx, 3, '点击后才懒挂载的补助表也必须能定位');
});

test('BIP 主流程顺序固定为逐类发票、保存草稿、最后上传附件', () => {
  assert.deepEqual(BIP_WORKFLOW_STAGES, [
    'fill_subsidy',
    'upload_flights_and_fill_new_rows',
    'upload_trains_and_fill_new_rows',
    'upload_lodging_and_fill_new_rows',
    'upload_other_invoices_and_fill_new_rows',
    'fill_attachment_count',
    'check_merge_payment',
    'save_draft_only',
    'upload_other_attachments',
  ]);
});

test('保存按钮保护只接受精确的“保存”', () => {
  assert.equal(isDraftSaveLabel('保存'), true);
  assert.equal(isDraftSaveLabel(' 保 存 '), true);
  assert.equal(isDraftSaveLabel('保存提交'), false);
  assert.equal(isDraftSaveLabel('提交'), false);
});

test('文件名清理和生成保持统一格式', () => {
  assert.equal(sanitize('张:三?.pdf'), '张三.pdf');
  assert.equal(genInvoiceFilename('张三', '20260719', 1200, '机票', '.pdf'), '张三—2026-07-19—1200.00—机票.pdf');
});

test('分类整理只在当前会话内移动并保留可上传文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-test-'));
  try {
    const sessionDir = path.join(root, 'workspace', 'sessions', 'abc123');
    const sourceDir = path.join(sessionDir, 'uploads');
    fs.mkdirSync(sourceDir, { recursive: true });
    const source = path.join(sourceDir, 'ticket.pdf');
    fs.writeFileSync(source, 'fixture');

    const result = classifyAndRename(sessionDir, [{
      filename: 'ticket.pdf',
      filepath: source,
      category: 'invoice',
      subcategory: '机票',
      ext: '.pdf',
      name: '张三',
      date: '2026-07-19',
      amount: 1200,
    }]);

    const item = result.invoices['机票'][0];
    assert.equal(item.renamed, '张三—2026-07-19—1200.00—机票.pdf');
    assert.equal(fs.existsSync(item.path), true);
    assert.equal(
      fs.existsSync(path.join(root, 'workspace', 'ready_uploads', 'invoices', '机票', item.renamed)),
      false,
      '不得写入跨会话共享目录，避免同名发票覆盖或串传',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('分类未知、分类异常和字段提取失败均保留为可上传附件，并继续处理其他材料', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-fallback-'));
  const originalKey = config.mimoApiKey;
  try {
    // 禁止真实模型请求；缺少配置用于稳定触发识别/提取失败。
    config.mimoApiKey = '';
    const filenames = [
      '关于召开2026年度交通运输行业质量管理小组培训暨工作推进会的通知.pdf',
      '文件处理单.pdf',
      '出差审批单.png',
      '机票.png',
      '普通说明.txt',
      '税额计算表.txt',
    ];
    const files = filenames.map((filename) => {
      const file = path.join(root, filename);
      fs.writeFileSync(file, 'synthetic fixture');
      return file;
    });
    const progress: number[] = [];
    const result = await processAllFiles(files, (_message, percent) => progress.push(percent));
    assert.equal(result.classifications.length, files.length, '每个文件只能有一条最终分类');
    assert.equal(result.errors.length, 5);
    assert.equal(result.invoices.length, 0, '提取失败的机票不能同时进入发票队列');
    assert.equal(result.approvals.length, 0, '失败审批单不能用于生成填单数据');
    assert.equal(result.taxSheets.length, 1, '前面材料失败不影响后面的正常分类提取');
    assert.equal(progress.at(-1), 70, '失败文件也计入处理完成进度');
    for (const item of result.classifications.slice(0, 5)) {
      assert.deepEqual(item.class, { category: 'document', type: '其他凭证' });
    }
    const sessionDir = path.join(root, 'session');
    const organized = classifyAndRename(sessionDir, result.classifications.map((item) => ({
      filename: path.basename(item.filepath),
      filepath: item.filepath,
      category: item.class.category,
      subcategory: item.class.type,
      ext: path.extname(item.filepath),
    })));
    const fallbackItems = organized.documents['其他凭证'];
    assert.deepEqual(fallbackItems.map((item) => item.renamed), filenames.slice(0, 5));
    for (const item of fallbackItems) {
      assert.equal(fs.readFileSync(item.path, 'utf8'), 'synthetic fixture', '附件原始内容必须完整保留');
    }
    const automation = new ReimbursementAutomation();
    const declared = (automation as any).getDeclaredAttachmentItems(organized.documents);
    const uploadFiles = (automation as any).getAttachmentFiles(organized.documents);
    assert.equal(declared.length, files.length);
    assert.equal(uploadFiles.length, files.length, '最终影像上传清单包含全部正常和兜底附件');
    assert.equal(new Set(uploadFiles).size, files.length, '每个附件只能进入上传清单一次');
    assert.equal(calculateAttachmentCount(result.invoices.length, uploadFiles.length), files.length);
  } finally {
    config.mimoApiKey = originalKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('普通凭证保留原文件名，同名附件分别保留不覆盖', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-other-docs-'));
  try {
    const inputs = ['first', 'second'].map((contents) => {
      const dir = path.join(root, contents);
      fs.mkdirSync(dir);
      const file = path.join(dir, '文件处理单.pdf');
      fs.writeFileSync(file, contents);
      return {
        filename: '文件处理单.pdf', filepath: file,
        category: 'document', subcategory: '其他凭证', ext: '.pdf',
      };
    });
    const result = classifyAndRename(path.join(root, 'session'), inputs);
    const attachments = result.documents['其他凭证'];
    assert.deepEqual(attachments.map((item) => item.renamed), ['文件处理单.pdf', '文件处理单_1.pdf']);
    assert.deepEqual(attachments.map((item) => fs.readFileSync(item.path, 'utf8')), ['first', 'second']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('电子发票只有表头和税号时触发本地文字修复，正常含税金额不受影响', () => {
  const template = '电子发票（增值税专用发票）\n发票号码：\n开票日期：\n项目名称 数量 单价 金额\n合计\n价税合计（大写）（小写）\n91340000MA8TEST123';
  assert.equal(needsLocalInvoiceTextRepair(template), true);
  assert.equal(needsLocalInvoiceTextRepair(template + '\n¥1033.66 ¥10.34\n壹仟零肆拾肆圆整 ¥1044.00'), false);
  assert.equal(needsLocalInvoiceTextRepair('出差审批单 起止日期 2026-09-17 至 2026-09-20'), false);
});

test('单项住宿服务可从天或晚的数量提取住宿天数，不用开票日期推算入住日期', () => {
  const result = extractLodgingStayDetails(
    '开票日期：2026年09月20日\n*生产生活服务*住宿服务 天 3 344.5544554455 1033.66 1% 10.34',
  );
  assert.deepEqual(result, {
    check_in_date: '', check_out_date: '', lodging_days: 3, stay_periods: [],
  });
  assert.equal(extractLodgingStayDetails('住宿费 晚 2 300.00 600.00').lodging_days, 2);
  assert.equal(extractLodgingStayDetails('住宿服务 间 3 348.00 1044.00').lodging_days, 0);
  assert.equal(extractLodgingStayDetails('住宿服务 天 3 100.00\n住宿服务 天 4 100.00').lodging_days, 0);
  assert.equal(extractLodgingStayDetails('住宿服务 天 3 100.00\n备注：共 2 晚').lodging_days, 2);
});

test('本地兼容解析器读取无 ToUnicode 的中文字体并保留数量分隔', async () => {
  // 纯合成票面，不含真实报销材料。UniGB-UCS2-H 是本次问题票据使用的编码。
  const encode = (value: string) => {
    const bytes = Buffer.from(value, 'utf16le');
    bytes.swap16();
    return bytes.toString('hex');
  };
  const lines = ['电子发票（增值税专用发票）', '价税合计（小写） ￥1044.00', '住宿服务 天 3 344.55 1033.66'];
  const stream = lines.map((line, index) =>
    'BT /F1 12 Tf 40 ' + (750 - index * 30) + ' Td <' + encode(line) + '> Tj ET',
  ).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light-UniGB-UCS2-H /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 6 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  });
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  pdf += offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  const text = await extractPdfTextLocally(Buffer.from(pdf));
  assert.match(text, /住宿服务/);
  assert.equal(findAmount(text), 1044);
  assert.equal(extractLodgingStayDetails(text).lodging_days, 3);
});

test('机票后高铁新增行必须在金额列回读后确认，不能只凭分区合计放行', () => {
  const before = {
    rowKeys: ['flight-row'], rowCount: 1,
    fingerprints: ['INDEX:1|paytarget:员工'],
    businessCount: 1, sectionTotal: 2580,
  };
  const hidden = {
    rowKeys: ['flight-row', 'train-row'], rowCount: 2,
    fingerprints: ['INDEX:1|paytarget:员工', 'INDEX:2|paytarget:员工'],
    businessCount: 2, sectionTotal: 2640,
  };
  const expectation = { expectedRowCount: 1, expectedAmount: 60 };
  assert.deepEqual(diffGeneratedRows(before, hidden, expectation), [], '缺少行金额时应先恢复金额列，不得跳过金额检查');
  const visible = {
    ...hidden,
    fingerprints: ['INDEX:1|paytarget:员工|vat_amount:2580.00', 'INDEX:2|paytarget:员工|vat_amount:60.00'],
  };
  assert.deepEqual(diffGeneratedRows(before, visible, expectation), [makeTableIndexRowRef(1)]);
  assert.deepEqual(diffGeneratedRows(before, { ...visible, sectionTotal: 2650 }, expectation), []);
  assert.deepEqual(diffGeneratedRows(before, {
    ...visible, fingerprints: [visible.fingerprints[0], 'INDEX:2|vat_amount:61.00'],
  }, expectation), [], '新行金额与本批不符时仍须停止');
  assert.deepEqual(diffGeneratedRows(before, { ...visible, businessCount: 1 }, expectation), []);
});

test('补助逐人保留不同天数、实际扣减和零金额，合计只能来自个人明细', () => {
  const data = {
    entries: [
      { name: '测试甲', days: 4, people: 1, meal_allowance: 320, transport_allowance: 280 },
      { name: '测试乙', days: 2, people: 1, meal_allowance: 100, transport_allowance: 0 },
    ],
    total_meal: 420, total_transport: 280, total_amount: 700,
  };
  const result = normalizeSubsidy(data, ['测试甲', '测试乙']);
  assert.deepEqual(result, data);
  assert.notEqual(result.entries, data.entries, '核对时不修改原识别记录');
  assert.deepEqual(normalizeSubsidy({ entries: [
    { name: '测试甲', days: 1, people: 1, meal_allowance: '￥0.10', transport_allowance: 0 },
    { name: '测试乙', days: 1, people: 1, meal_allowance: 0.2, transport_allowance: 0 },
  ] }).total_meal, 0.3, '金额按分累加，不能出现浮点合计差异');
  const sameAmounts = normalizeSubsidy({ entries: [
    { name: '测试甲', days: 2, people: 1, meal_allowance: 150, transport_allowance: 80 },
    { name: '测试乙', days: 2, people: 1, meal_allowance: 150, transport_allowance: 80 },
    { name: '测试甲', days: 1, people: 1, meal_allowance: 50, transport_allowance: 0 },
  ] });
  assert.equal(sameAmounts.entries.length, 3, '同额人员和同人不同明细都不能自动合并');
});

test('补助拒绝多人合并、汇总行、缺失个人金额和不一致合计', () => {
  const entry = { name: '测试甲', days: 3, people: 1, meal_allowance: 200, transport_allowance: 0 };
  for (const name of ['测试甲、测试乙', '测试甲 测试乙', '合计', '总计']) {
    assert.throws(() => normalizeSubsidy({ entries: [{ ...entry, name }] }), /一个明确姓名/);
  }
  assert.throws(() => normalizeSubsidy({ entries: [{ ...entry, people: 2 }] }), /人数必须为 1/);
  assert.throws(() => normalizeSubsidy({ name: '测试甲', days: 3, people: 2, meal_total: 600 }), /entries/);
  assert.throws(() => normalizeSubsidy({ entries: [{ ...entry, meal_allowance: null }] }), /伙食补助缺失/);
  assert.throws(() => normalizeSubsidy({ entries: [entry], total_meal: 600 }), /个人明细之和不一致/);
  assert.throws(() => normalizeSubsidy({ entries: [{ ...entry, name: '' }] }, ['测试甲', '测试乙']), /一个明确姓名/);
  assert.equal(normalizeSubsidy({ entries: [{ ...entry, name: '' }] }, ['测试甲']).entries[0].name, '测试甲');
  assert.equal(normalizeSubsidy({ entries: [{ ...entry, meal_allowance: 0 }] }).total_amount, 0, '明确的双零金额不重算补贴');
});

test('图片识别使用逐人提示词并完整传递多人明细到填单，不合并或二次乘人数', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-person-subsidy-'));
  const originalConfig = { mimoApiKey: config.mimoApiKey, mimoBaseUrl: config.mimoBaseUrl, mimoModel: config.mimoModel };
  const expected = {
    entries: [
      { name: '测试甲', days: 4, people: 1, meal_allowance: 320, transport_allowance: 280 },
      { name: '测试乙', days: 2, people: 1, meal_allowance: 100, transport_allowance: 80 },
    ], total_meal: 420, total_transport: 360, total_amount: 780,
  };
  try {
    config.mimoApiKey = 'synthetic-test-key';
    config.mimoBaseUrl = 'http://127.0.0.1:9/v1';
    config.mimoModel = 'mimo-2.6-pro';
    // 完全替代 SDK 请求，不访问模型 API，也不读取真实材料。
    let calls = 0;
    t.mock.method(OpenAI.Chat.Completions.prototype, 'create', async (request: any) => {
      calls++;
      assert.equal(request.model, 'mimo-2.6-pro');
      const prompt = request.messages[0].content.find((item: any) => item.type === 'text').text;
      assert.equal(prompt, SUBSIDY_EXTRACTION_PROMPT + '\n/no_think');
      return { choices: [{ message: { content: JSON.stringify(expected) } }] };
    });
    const file = path.join(root, '出差补助单.png');
    fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64'));
    const extracted = await extractSubsidy(file);
    assert.deepEqual(extracted, expected);
    assert.equal(calls, 1);
    const normalized = normalizeSubsidy(extracted, ['测试甲', '测试乙']);
    const automation = new ReimbursementAutomation();
    const writes: any[][] = [];
    t.mock.method(automation as any, 'fillSubsidyRow', async (...args: any[]) => { writes.push(args); });
    const rows = await automation.fillSubsidy(normalized, '培训差旅费');
    assert.equal(rows, 4);
    assert.deepEqual(writes.map(([summary, label, days, people, amount, _account, index]) => ({ summary, label, days, people, amount, index })), [
      { summary: '测试甲：培训差旅费', label: FIXED_SUBSIDY_TRANSPORT_TYPE, days: 4, people: 1, amount: 280, index: 0 },
      { summary: '测试甲：培训差旅费', label: FIXED_SUBSIDY_MEAL_TYPE, days: 4, people: 1, amount: 320, index: 1 },
      { summary: '测试乙：培训差旅费', label: FIXED_SUBSIDY_TRANSPORT_TYPE, days: 2, people: 1, amount: 80, index: 2 },
      { summary: '测试乙：培训差旅费', label: FIXED_SUBSIDY_MEAL_TYPE, days: 2, people: 1, amount: 100, index: 3 },
    ]);
    writes.length = 0;
    await automation.fillSubsidy(normalizeSubsidy({ entries: expected.entries.map((entry) => ({ ...entry, transport_allowance: 0 })) }), '培训差旅费');
    assert.equal(writes.length, 2, '某类明确为零时不生成该类费用，也不补算金额');
    assert.deepEqual(writes.map((args) => args[4]), [320, 100]);
    writes.length = 0;
    await assert.rejects(automation.fillSubsidy({ entries: [{ ...expected.entries[0], people: 2 }] }, '培训差旅费'), /人数必须为 1/);
    assert.equal(writes.length, 0, '合并记录必须在增行前被拒绝');
  } finally {
    Object.assign(config, originalConfig);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('发票识别信息按原文件对应，前一张识别失败时不错位', () => {
  const invoices: Record<string, any[]> = {
    '住宿发票': [
      { renamed: 'a.pdf', path: '/s/a.pdf', source: '/up/hotel-a.pdf', amount: 0 },
      { renamed: 'b.pdf', path: '/s/b.pdf', source: '/up/hotel-b.pdf', amount: 0 },
    ],
    '机票': [{ renamed: 'c.pdf', path: '/s/c.pdf', source: '/up/flight.pdf', amount: 0 }],
  };
  // 第一张住宿票识别失败，只有第二张和机票有提取结果；Map 的顺序也与文件顺序不同。
  const details = new Map<string, any>([
    ['/up/flight.pdf', { amount: 1200, date: '2026-07-19', type: '机票' }],
    ['/up/hotel-b.pdf', { amount: 600, date: '2026-07-24', check_in_date: '2026-07-22', check_out_date: '2026-07-24', lodging_days: 2, type: '住宿发票' }],
  ]);
  attachInvoiceDetails(invoices, details);
  assert.equal(invoices['住宿发票'][0].amount, 0, '识别失败的住宿票不能拿到别的票的金额');
  assert.equal(invoices['住宿发票'][0].check_in_date, undefined);
  assert.equal(invoices['住宿发票'][1].amount, 600);
  assert.equal(invoices['住宿发票'][1].check_in_date, '2026-07-22');
  assert.equal(invoices['住宿发票'][1].lodging_days, 2);
  assert.equal(invoices['机票'][0].amount, 1200);
  for (const item of [...invoices['住宿发票'], ...invoices['机票']]) {
    assert.equal('source' in item, false, '原始路径只用于对应，不能发送到浏览器');
  }
});

test('分类整理记录原始路径，供识别信息按文件对应', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-source-'));
  try {
    const src = path.join(root, 'hotel.pdf');
    fs.writeFileSync(src, 'x');
    const result = classifyAndRename(root, [{
      filename: 'hotel.pdf', filepath: src, category: 'invoice', subcategory: '住宿发票', ext: '.pdf',
    }]);
    assert.equal(result.invoices['住宿发票'][0].source, src);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('补助单天数缺失时停止，不再默认 2 天或按标准推算金额', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-subsidy-missing-'));
  const originalConfig = { mimoApiKey: config.mimoApiKey, mimoBaseUrl: config.mimoBaseUrl, mimoModel: config.mimoModel };
  try {
    config.mimoApiKey = 'synthetic-test-key';
    config.mimoBaseUrl = 'http://127.0.0.1:9/v1';
    config.mimoModel = 'mimo-test';
    t.mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => ({
      choices: [{ message: { content: JSON.stringify({
        entries: [{ name: '测试甲', days: null, people: 1, meal_allowance: 300, transport_allowance: 240 }],
      }) } }],
    }));
    const file = path.join(root, '出差补助单.png');
    fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64'));
    await assert.rejects(extractSubsidy(file), /天数缺失或无法确认/);
  } finally {
    Object.assign(config, originalConfig);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('确认时只采纳事由和补助明细，发票与路径以服务端为准', () => {
  const server = {
    session_id: 'sid-1',
    summary: '测试甲报销差旅费用',
    travelers: ['测试甲'],
    invoices: { '机票': [{ path: '/server/a.pdf', amount: 1200 }] },
    documents: {},
    subsidy: normalizeSubsidy({ entries: [{ name: '测试甲', days: 2, people: 1, meal_allowance: 200, transport_allowance: 160 }] }),
  };
  const next = applyReviewEdits(server, {
    session_id: 'other',
    summary: '  参加培训差旅费  ',
    invoices: { '机票': [{ path: 'C:/Windows/system.ini', amount: 1 }] },
    subsidy: { entries: [{ name: '测试甲', days: 3, people: 1, meal_allowance: 300, transport_allowance: 0 }] },
  });
  assert.equal(next.summary, '参加培训差旅费');
  assert.equal(next.session_id, 'sid-1');
  assert.deepEqual(next.invoices, server.invoices, '浏览器不能替换发票路径和金额');
  assert.equal(next.subsidy.entries[0].days, 3);
  assert.equal(next.subsidy.total_amount, 300, '补助合计由明细重新计算');
  assert.equal(server.summary, '测试甲报销差旅费用', '不能就地修改服务端原结果');

  assert.throws(() => applyReviewEdits(server, { summary: '   ' }), /不能为空/);
  assert.throws(() => applyReviewEdits(server, { summary: 123 }), /格式无效/);
  assert.throws(() => applyReviewEdits(server, {
    subsidy: { entries: [{ name: '测试甲、测试乙', days: 2, people: 1, meal_allowance: 1, transport_allowance: 1 }] },
  }), /姓名/);
  const noSubsidy = applyReviewEdits({ ...server, subsidy: null }, {
    subsidy: { entries: [{ name: '测试甲', days: 9, people: 1, meal_allowance: 900, transport_allowance: 0 }] },
  });
  assert.equal(noSubsidy.subsidy, null, '服务端没有识别出补助单时不能由浏览器凭空添加');
});

test('诊断目录只保留最近若干次，且不删除当前目录和上传材料', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-prune-'));
  try {
    const dirs: string[] = [];
    for (let i = 0; i < 4; i++) {
      const dir = path.join(root, 'sid-' + i, 'automation-' + i);
      fs.mkdirSync(dir, { recursive: true });
      const time = new Date(Date.UTC(2026, 0, 1 + i));
      fs.utimesSync(dir, time, time);
      dirs.push(dir);
    }
    const uploads = path.join(root, 'sid-0', 'uploads');
    fs.mkdirSync(uploads);
    fs.writeFileSync(path.join(uploads, 'invoice.pdf'), 'x');
    const removed = pruneAutomationRuns(root, 1, dirs[0]);
    assert.deepEqual(removed.map((dir) => path.basename(dir)).sort(), ['automation-1', 'automation-2']);
    assert.ok(fs.existsSync(dirs[0]), '当前填单目录即使较旧也不能删除');
    assert.ok(fs.existsSync(dirs[3]), '保留最新的一次');
    assert.ok(fs.existsSync(path.join(uploads, 'invoice.pdf')), '不能删除上传材料');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('多份审批单合并：人员并集、最早出发最晚返回，地点不同和期间不连续时提示', () => {
  const { approval, warnings } = mergeApprovals([
    { travelers: ['测试甲'], start_date: '2026-07-19', end_date: '2026-07-22', destination: '山东济南', purpose: '集中学习', department: '工程部', filepath: '/up/a.pdf' },
    { travelers: ['测试乙', '测试甲'], start_date: '2026-07-21', end_date: '2026-07-25', destination: '山东济南', purpose: '集中学习', department: '工程部', filepath: '/up/b.pdf' },
  ]);
  assert.deepEqual(approval!.travelers, ['测试甲', '测试乙']);
  assert.equal(approval!.start_date, '2026-07-19');
  assert.equal(approval!.end_date, '2026-07-25');
  assert.equal(approval!.destination, '山东济南');
  assert.equal(approval!.purpose, '集中学习');
  assert.equal(approval!.sources.length, 2);
  assert.equal(approval!.sources[1].file, 'b.pdf');
  assert.equal(warnings.some((w) => /地点不同|不连续/.test(w)), false);

  const split = mergeApprovals([
    { travelers: ['测试甲'], start_date: '2026-07-01', end_date: '2026-07-03', destination: '成都', purpose: 'A' },
    { travelers: ['测试甲'], start_date: '2026-07-10', end_date: '2026-07-12', destination: '宜宾', purpose: 'B' },
  ]);
  assert.equal(split.approval!.destination, '成都、宜宾');
  assert.equal(split.approval!.purpose, 'A；B');
  assert.ok(split.warnings.some((w) => w.includes('出差地点不同')));
  assert.ok(split.warnings.some((w) => w.includes('不连续')));

  const single = mergeApprovals([{ travelers: ['测试甲'], start_date: '2026-07-01', end_date: '2026-07-03', destination: '成都' }]);
  assert.deepEqual(single.warnings, [], '只有一份审批单时不提示合并');
  assert.deepEqual(mergeApprovals([]), { approval: null, warnings: [] });
});

test('多份补助单合并个人明细，重复上传只计一次，合计重算', () => {
  const a = { entries: [{ name: '测试甲', days: 3, people: 1, meal_allowance: 300, transport_allowance: 240 }], filepath: '/up/a.png' };
  const b = { entries: [{ name: '测试乙', days: 2, people: 1, meal_allowance: 150, transport_allowance: 0 }], filepath: '/up/b.png' };
  const merged = mergeSubsidies([a, b, { ...a, filepath: '/up/a-copy.png' }], ['测试甲', '测试乙']);
  assert.deepEqual(merged.subsidy!.entries.map((e) => e.name), ['测试甲', '测试乙']);
  assert.equal(merged.subsidy!.total_meal, 450);
  assert.equal(merged.subsidy!.total_transport, 240);
  assert.equal(merged.subsidy!.total_amount, 690);
  assert.ok(merged.warnings.some((w) => w.includes('a-copy.png') && w.includes('只计一次')));
  assert.equal(mergeSubsidies([a], ['测试甲']).warnings.length, 0);
});

test('确认页可修改审批人员、日期、目的地和事由，并在服务端校验', () => {
  const server = {
    summary: '测试甲报销差旅费用',
    travelers: ['测试甲'],
    approval: {
      travelers: ['测试甲'], start_date: '2026-07-19', end_date: '2026-07-25',
      destination: '成都、宜宾', purpose: '', department: '工程部',
      sources: [{ file: 'a.pdf' }, { file: 'b.pdf' }],
    },
    subsidy: null,
  };
  // 浏览器原样发回未识别的空事由时不报错；只校验改动过的字段。
  const untouched = applyReviewEdits(server, { approval: { ...server.approval } });
  assert.equal(untouched.approval.purpose, '');

  const edited = applyReviewEdits(server, {
    approval: { ...server.approval, travelers: ['测试甲', '测试乙'], start_date: '2026-07-18', destination: '宜宾', purpose: '项目检查' },
  }, { forConfirm: true });
  assert.deepEqual(edited.approval.travelers, ['测试甲', '测试乙']);
  assert.deepEqual(edited.travelers, ['测试甲', '测试乙']);
  assert.equal(edited.approval.start_date, '2026-07-18');
  assert.equal(edited.approval.destination, '宜宾');
  assert.equal(edited.approval.department, '工程部', '不可修改的字段保持服务端值');

  assert.throws(() => applyReviewEdits(server, { approval: { ...server.approval } }, { forConfirm: true }), /多个出差地点/);
  assert.throws(() => applyReviewEdits(server, { approval: { ...server.approval, end_date: '2026-07-10' } }), /不能早于/);
  assert.throws(() => applyReviewEdits(server, { approval: { ...server.approval, start_date: '2026-02-30' } }), /有效日期/);
  assert.throws(() => applyReviewEdits(server, { approval: { ...server.approval, travelers: [] } }), /不能为空/);
  assert.throws(() => applyReviewEdits(server, { approval: { ...server.approval, travelers: ['测试甲、测试乙'] } }), /一个姓名/);
});

test('识别并发处理保持原文件顺序，同一文件再次上传命中缓存不再调用模型', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-vision-'));
  const original = {
    mimoApiKey: config.mimoApiKey, mimoBaseUrl: config.mimoBaseUrl, mimoModel: config.mimoModel,
    sessionDir: config.sessionDir, visionCache: config.visionCache, visionConcurrency: config.visionConcurrency,
  };
  try {
    Object.assign(config, {
      mimoApiKey: 'synthetic-test-key', mimoBaseUrl: 'http://127.0.0.1:9/v1', mimoModel: 'mimo-test',
      sessionDir: root, visionCache: true, visionConcurrency: 3,
    });
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    t.mock.method(OpenAI.Chat.Completions.prototype, 'create', async (request: any) => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const prompt = request.messages[0].content.find((item: any) => item.type === 'text').text;
      const image = request.messages[0].content.find((item: any) => item.type === 'image_url').image_url.url;
      // 第一张图最慢返回，验证结果仍按原顺序。
      const delay = image.length % 3 === 0 ? 5 : 40;
      await new Promise((resolve) => setTimeout(resolve, delay));
      inFlight--;
      const content = prompt.includes('category')
        ? { category: 'invoice', type: '其他发票' }
        : { amount: 12.5, date: '2026-07-20', name: '测试甲' };
      return { choices: [{ message: { content: JSON.stringify(content) } }] };
    });
    const files: string[] = [];
    for (let i = 0; i < 3; i++) {
      const file = path.join(root, `票据${i}.png`);
      fs.writeFileSync(file, await sharp({ create: { width: 20 + i, height: 20, channels: 3, background: '#fff' } }).png().toBuffer());
      files.push(file);
    }
    const first = await processAllFiles(files);
    assert.deepEqual(first.classifications.map((c: any) => c.filepath), files, '结果必须按原文件顺序');
    assert.deepEqual(first.invoices.map((inv: any) => inv.filepath), files);
    assert.ok(maxInFlight > 1, '多个文件应同时识别');
    const callsAfterFirst = calls;
    assert.ok(callsAfterFirst >= 3);

    const copy = path.join(root, '再次上传.png');
    fs.copyFileSync(files[1], copy);
    const second = await processAllFiles([copy]);
    assert.equal(calls, callsAfterFirst, '内容相同的文件命中缓存，不再调用模型');
    assert.equal(second.invoices[0].filepath, copy, '缓存结果使用本次文件路径');
    assert.equal(second.invoices[0].amount, 12.5);
  } finally {
    Object.assign(config, original);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('大图发送识别前缩到长边 2000px 的 JPEG，小图保持原样', async () => {
  const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const shrunk = await shrinkImageForVision(big);
  assert.ok(shrunk, '超过 2000px 的图片应被压缩');
  const meta = await sharp(shrunk!).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(Math.max(meta.width || 0, meta.height || 0), 2000);
  const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#ffffff' } }).png().toBuffer();
  assert.equal(await shrinkImageForVision(small), null);
});

test('补助单交通费、伙食费是每日标准还是应领金额，按行合计或合计行确定', () => {
  const amounts = (raw: any) => normalizeSubsidy(reconcileSubsidyTable(raw)).entries
    .map((e) => [e.name, e.days, e.transport_allowance, e.meal_allowance]);

  // 实际样张：两列印的是每日标准 80/100，行合计 360，合计行 160/200/360。
  assert.deepEqual(amounts({
    entries: [{ name: '测试甲', days: 2, people: 1, transport_cell: 80, meal_cell: 100, row_total: 360 }],
    table_total_transport: 160, table_total_meal: 200, table_total: 360,
  }), [['测试甲', 2, 160, 200]]);

  // 两列已是应领金额（含扣减为 0）时原样采用。
  assert.deepEqual(amounts({
    entries: [
      { name: '测试甲', days: 3, people: 1, transport_cell: 240, meal_cell: 300, row_total: 540 },
      { name: '测试乙', days: 2, people: 1, transport_cell: 0, meal_cell: 150, row_total: 150 },
    ],
  }), [['测试甲', 3, 240, 300], ['测试乙', 2, 0, 150]]);

  // 没有行合计时用合计行判断。
  assert.deepEqual(amounts({
    entries: [{ name: '测试甲', days: 2, people: 1, transport_cell: 80, meal_cell: 100, row_total: null }],
    table_total_transport: 160, table_total_meal: 200, table_total: null,
  }), [['测试甲', 2, 160, 200]]);

  // 只有 1 天时两种解释相同，无需合计也可确定。
  assert.deepEqual(amounts({
    entries: [{ name: '测试甲', days: 1, people: 1, transport_cell: 80, meal_cell: 100, row_total: null }],
  }), [['测试甲', 1, 80, 100]]);

  // 多天又没有任何合计可核对时停止，不猜测。
  assert.throws(() => reconcileSubsidyTable({
    entries: [{ name: '测试甲', days: 2, people: 1, transport_cell: 80, meal_cell: 100, row_total: null }],
  }), /每日标准还是应领金额/);
  // 行合计两种解释都对不上时停止。
  assert.throws(() => reconcileSubsidyTable({
    entries: [{ name: '测试甲', days: 2, people: 1, transport_cell: 80, meal_cell: 100, row_total: 999 }],
  }), /对不上/);
  // 缺少单元格时停止。
  assert.throws(() => reconcileSubsidyTable({
    entries: [{ name: '测试甲', days: 2, people: 1, transport_cell: null, meal_cell: 100, row_total: 360 }],
  }), /缺失/);
});
