import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  diffGeneratedRows,
  INVOICE_UPLOAD_GROUPS,
  ReimbursementAutomation,
  resolveSubsidyTableChange,
} from '../src/bip-automation.js';

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage();
  await page.setContent('<iframe id="forwardFrame" name="forwardFrame"></iframe>');
  const forwardFrame = page.frames().find((item) => item.name() === 'forwardFrame');
  assert.ok(forwardFrame, 'forwardFrame must exist');
  await forwardFrame.setContent('<iframe id="mainiframe" name="mainiframe"></iframe>');
  const frame = page.frames().find((item) => item.name() === 'mainiframe');
  assert.ok(frame, 'mainiframe must exist');

  await frame.setContent(`
    <div class="form-item fjzs"><input value="0"></div>
    <div class="form-item zyx25"><input type="checkbox"></div>
    <div class="form-item djbh"><input value=""></div>
    <button id="draft-save">保存</button><button id="save-submit">保存提交</button>
    <div id="save-loading" style="display:none">加载中...</div>
    <section data-area-code="hidden-transport" style="display:none"><h2>交通费用</h2><span class="arap_bxbusitem_card_body-button"><button>发票上传</button></span><div id="hot-key-bzitem"><div class="table-next-body"><table><tbody><tr rowkey="hidden-old"><td>隐藏浏览态旧行</td></tr></tbody></table></div></div></section>
    <section data-area-code="arap_bxbusitem"><h2>交通费用（填列飞机、火车、长途汽车）</h2><span class="arap_bxbusitem_card_body-button arap_bxbusitem-button"><button>发票上传</button></span><div id="hot-key-bzitem"><div class="table-next-header-wrapper"><table><thead><tr><th colkey="defitem1">出发日期</th><th colkey="vat_amount">价税合计金额</th><th colkey="skyhzh">收款人账号</th></tr></thead></table></div><div class="table-next-body fixed-pane"><table><tbody><tr rowkey="transport-old"><td colkey="summary">旧交通行</td><td colkey="defitem1">2026-07-01</td><td colkey="vat_amount">100.00</td></tr></tbody></table></div><div class="table-next-body scroll-pane"><table><tbody><tr><td colkey="skyhzh">旧账号</td></tr></tbody></table></div></div></section>
    <section data-area-code="other"><h2>住宿费用</h2><span class="other_card_body-button"><button>发票上传</button></span><div id="hot-key-bzitem"><div class="table-next-header-wrapper"><table><thead><tr><th colkey="defitem21">人员级别</th><th colkey="defitem4">入住城市</th><th colkey="defitem1">入住日期</th><th colkey="defitem2">离店日期</th><th colkey="defitem9">住宿天数</th><th colkey="defitem5">住宿人数</th><th colkey="vat_amount">价税合计金额</th><th colkey="skyhzh">收款人账号</th></tr></thead></table></div><div class="table-next-body"><table><tbody><tr rowkey="lodging-old"><td colkey="defitem21"></td><td colkey="defitem4"></td><td colkey="defitem1"></td><td colkey="defitem2"></td><td colkey="defitem9"></td><td colkey="defitem5"></td><td colkey="vat_amount">100.00</td><td colkey="skyhzh"></td></tr></tbody></table></div></div></section>
    <section data-area-code="zsitem"><h2>其他费用（填列退票费、改签费）</h2><span class="zsitem_card_body-button"><button>发票上传</button></span><div id="hot-key-bzitem"><div class="table-next-header-wrapper"><table><thead><tr><th colkey="vat_amount">价税合计金额</th><th colkey="skyhzh">收款人账号</th></tr></thead></table></div><div class="table-next-body"><table><tbody><tr rowkey="other-old"><td colkey="vat_amount">100.00</td><td colkey="skyhzh"></td></tr></tbody></table></div></div></section>
    <section data-area-code="subsidy" style="margin-top:1200px">
      <h2>出差补贴</h2>
      <div class="subsidy-card-inner">
        <div class="subsidy-toolbar-shell"><span class="prefix-bzitem_card_body-button-suffix" style="display:contents"><button>增行</button><button>发票上传</button></span></div>
        <div class="subsidy-table-shell"><div id="hot-key-bzitem">
          <div class="table-next-header-wrapper"><table><thead><tr><th colkey="defitem14">摘要</th><th colkey="pk_reimtype">补助类型</th><th colkey="defitem9">出差天数</th><th colkey="defitem5">出差人数</th><th colkey="vat_amount">补助金额</th></tr></thead></table></div>
          <div class="table-next-body"><table><tbody></tbody></table></div>
        </div></div>
      </div>
    </section>
    <section data-area-code="hidden-subsidy" style="display:none"><h2>出差补贴</h2><span class="bzitem_card_body-button"><button>增行</button></span><div id="hot-key-bzitem"><table><thead><tr><th colkey="pk_reimtype">补助类型</th><th colkey="defitem9">出差天数</th><th colkey="defitem5">出差人数</th><th colkey="vat_amount">补助金额</th></tr></thead><tbody></tbody></table></div></section>
    <script>
      document.querySelectorAll('section button').forEach((button) => button.addEventListener('click', () => {
        const area = button.closest('section').dataset.areaCode;
        document.body.dataset.clicked = area;
        document.body.dataset[area + 'Clicks'] = String(Number(document.body.dataset[area + 'Clicks'] || '0') + 1);
        if (area === 'subsidy' && button.textContent.trim() === '增行') {
          const section = button.closest('section');
          const shell = section.querySelector('.subsidy-table-shell');
          if (!section.querySelector('#hot-key-bzitem')) {
            shell.innerHTML = '<div id="hot-key-bzitem"><div class="table-next-header-wrapper"><table><thead><tr><th colkey="defitem14">摘要</th><th colkey="pk_reimtype">补助类型</th><th colkey="defitem9">出差天数</th><th colkey="defitem5">出差人数</th><th colkey="vat_amount">补助金额</th></tr></thead></table></div><div class="table-next-body"><table><tbody></tbody></table></div></div>';
          }
          const tbody = section.querySelector('.table-next-body tbody');
          const row = document.createElement('tr');
          row.setAttribute('rowkey', 'subsidy-' + (tbody.children.length + 1));
          row.className = 'table-next-row selected-row';
          Array.from(tbody.children).forEach((oldRow) => oldRow.classList.remove('selected-row'));
          row.innerHTML = '<td colkey="defitem14"><input></td><td colkey="pk_reimtype"></td><td colkey="defitem9"></td><td colkey="defitem5"></td><td colkey="vat_amount"></td>';
          tbody.appendChild(row);
          row.querySelector('input').focus();
        }
      }));
      document.querySelector('#draft-save').addEventListener('click', () => {
        document.body.dataset.draftSaved = 'true';
        document.querySelector('#save-loading').style.display = 'block';
        setTimeout(() => {
          document.querySelector('.form-item.djbh input').value = 'DRAFT-001';
          document.querySelector('#save-loading').style.display = 'none';
        }, 3300);
      });
      document.querySelector('#save-submit').addEventListener('click', () => { document.body.dataset.submitted = 'true'; });
    </script>
  `);

  const automation = new ReimbursementAutomation();
  automation.page = page;
  const expectedIndexes: Record<string, number> = { arap_bxbusitem: 1, other: 2, zsitem: 3 };
  const expectedRows: Record<string, string[]> = { arap_bxbusitem: ['transport-old'], other: ['lodging-old'], zsitem: ['other-old'] };

  for (const group of INVOICE_UPLOAD_GROUPS) {
    await frame.evaluate(() => { delete document.body.dataset.clicked; });
    const wrapperIndex = await (automation as any).getExpenseWrapperIndex(group.sectionTitle, group.areaCode, group.toolbars);
    assert.equal(
      wrapperIndex, expectedIndexes[group.areaCode],
      `${group.label} table index must match its BIP area`,
    );
    const clicked = await (automation as any).clickInvoiceUpload(
      group.sectionTitle,
      group.areaCode,
      group.toolbars,
      wrapperIndex,
    );
    assert.equal(clicked, true, `${group.label} upload button should be found from the resolved table`);
    assert.equal(
      await frame.evaluate(() => document.body.dataset.clicked),
      group.areaCode,
      `${group.label} row snapshot and upload button must use the same ${group.sectionTitle} area`,
    );
    assert.deepEqual(await (automation as any).getTableRowKeys(wrapperIndex), expectedRows[group.areaCode]);
  }

  assert.equal(
    await (automation as any).getExpenseWrapperIndex('交通费用', 'missing-area-code', ['missing-toolbar']),
    -1,
    '费用区专属工具栏缺失时必须停止，禁止再按位置猜测表格',
  );
  assert.equal(
    await (automation as any).clickInvoiceUpload('交通费用', 'arap_bxbusitem', ['bzitem_card_body-button'], 0),
    false,
    '出差补贴工具栏必须被硬性禁止用于发票上传',
  );
  assert.equal(
    await frame.evaluate(() => document.body.dataset.subsidyClicks || '0'),
    '0',
    '交通、住宿、其他发票测试中均不得点击出差补贴的上传按钮',
  );
  assert.equal(await (automation as any).getSubsidyWrapperIndex(), 4, '视口下方的空补助表必须通过补助专属列结构解析');
  const allTablesBeforeSubsidy = await (automation as any).getAllTableRowSnapshots();
  const subsidyBefore = await (automation as any).getTableRowSnapshot(4);
  assert.equal(subsidyBefore.rowCount, 0, '补助表增行前允许为空');
  await (automation as any).clickSubsidyAddRow();
  assert.equal(
    await frame.evaluate(() => document.body.dataset.clicked),
    'subsidy',
    '补助增行只能点击补助卡片，不能点击任何费用分区',
  );
  const subsidyAfter = await (automation as any).getTableRowSnapshot(4);
  const allTablesAfterSubsidy = await (automation as any).getAllTableRowSnapshots();
  assert.equal(subsidyAfter.rowCount, 1, '补助专属增行必须在视口下方的空表中新建一行');
  assert.deepEqual(diffGeneratedRows(subsidyBefore, subsidyAfter), ['__bip_row_index__:0']);
  assert.deepEqual(
    resolveSubsidyTableChange(allTablesBeforeSubsidy, allTablesAfterSubsidy),
    {
      wrapperIdx: 4,
      rowRef: '__bip_row_index__:0',
      before: allTablesBeforeSubsidy.find((item: any) => item.wrapperIdx === 4),
      after: allTablesAfterSubsidy.find((item: any) => item.wrapperIdx === 4),
      matchedBy: 'token',
    },
    '增行后必须通过唯一行变化和当前选中行定位补助表',
  );

  await frame.locator('[data-area-code="subsidy"] #hot-key-bzitem').evaluate((element) => element.remove());
  assert.equal(
    await (automation as any).getSubsidyWrapperIndex(),
    -1,
    '补助表尚未懒加载时，增行前允许没有 wrapper，不能猜测其他表格',
  );
  const allTablesBeforeLazySubsidy = await (automation as any).getAllTableRowSnapshots();
  await (automation as any).clickSubsidyAddRow();
  assert.equal(await (automation as any).getSubsidyWrapperIndex(), 4, '点击补助增行后必须重新识别懒挂载表格');
  assert.equal((await (automation as any).getTableRowSnapshot(4)).rowCount, 1, '懒挂载补助表必须只生成一行');
  const allTablesAfterLazySubsidy = await (automation as any).getAllTableRowSnapshots();
  assert.equal(
    resolveSubsidyTableChange(allTablesBeforeLazySubsidy, allTablesAfterLazySubsidy)?.wrapperIdx,
    4,
    '补助表点击后才懒挂载时也必须通过新表中的焦点行定位',
  );

  const lodgingGroup = INVOICE_UPLOAD_GROUPS.find((group) => group.label === '住宿发票');
  assert.ok(lodgingGroup);
  const lodgingIndex = expectedIndexes.other;
  const lodgingBefore = await (automation as any).getTableRowSnapshot(lodgingIndex);
  await frame.locator('[data-area-code="other"] tbody').evaluate((tbody) => {
    const row = document.createElement('tr');
    row.setAttribute('rowkey', 'lodging-new');
    row.innerHTML = [
      '<td colkey="defitem21"><span class="table-cell"></span></td>',
      '<td colkey="defitem4"><span class="table-cell"></span></td>',
      '<td colkey="defitem1"><span class="table-cell"></span></td>',
      '<td colkey="defitem2"><span class="table-cell"></span></td>',
      '<td colkey="defitem9"><span class="table-cell"></span></td>',
      '<td colkey="defitem5"><span class="table-cell"></span></td>',
      '<td colkey="skyhzh"><span class="table-cell"></span></td>',
    ].join('');
    tbody.appendChild(row);
  });
  const lodgingGenerated = await (automation as any).waitForGeneratedExpenseRows(
    lodgingGroup.sectionTitle,
    lodgingGroup.areaCode,
    lodgingGroup.toolbars,
    lodgingBefore,
    1500,
  );
  assert.equal(lodgingGenerated.wrapperIdx, lodgingIndex, '住宿新增行必须只从住宿费用表识别');
  assert.deepEqual(lodgingGenerated.rowRefs, ['__bip_row_index__:1']);
  for (const colkey of ['defitem21', 'defitem4', 'defitem1', 'defitem2', 'defitem9', 'defitem5', 'skyhzh']) {
    assert.equal(
      await (automation as any).tableCell(lodgingIndex, lodgingGenerated.rowRefs[0], colkey).count(),
      1,
      `住宿新增行必须能够定位 ${colkey} 字段`,
    );
  }

  const otherGroup = INVOICE_UPLOAD_GROUPS.find((group) => group.label === '其他发票');
  assert.ok(otherGroup);
  assert.equal(otherGroup.needPayee, true, '其他费用新增行也必须补选收款人账号');
  const otherIndex = expectedIndexes.zsitem;
  const otherBefore = await (automation as any).getTableRowSnapshot(otherIndex);
  await frame.locator('[data-area-code="zsitem"] tbody').evaluate((tbody) => {
    const row = document.createElement('tr');
    row.setAttribute('rowkey', 'other-new');
    row.innerHTML = '<td colkey="vat_amount"><span class="table-cell">120.00</span></td><td colkey="skyhzh"><span class="table-cell"></span></td>';
    tbody.appendChild(row);
  });
  const otherGenerated = await (automation as any).waitForGeneratedExpenseRows(
    otherGroup.sectionTitle,
    otherGroup.areaCode,
    otherGroup.toolbars,
    otherBefore,
    1500,
  );
  assert.equal(otherGenerated.wrapperIdx, otherIndex, '其他发票新增行必须只从其他费用表识别');
  assert.deepEqual(otherGenerated.rowRefs, ['__bip_row_index__:1']);
  assert.equal(
    await (automation as any).tableCell(otherIndex, otherGenerated.rowRefs[0], 'vat_amount').count(),
    1,
    '其他发票新增行必须留在其他费用表',
  );
  assert.equal(
    await (automation as any).tableCell(otherIndex, otherGenerated.rowRefs[0], 'skyhzh').count(),
    1,
    '其他费用新增行必须能够定位并填写收款人账号列',
  );

  const transportIndex = expectedIndexes.arap_bxbusitem;
  const beforeSplitPaneRow = await (automation as any).getTableRowSnapshot(transportIndex);
  await frame.locator('[data-area-code="arap_bxbusitem"] .fixed-pane tbody').evaluate((tbody) => {
    const row = document.createElement('tr');
    row.setAttribute('rowkey', 'transport-new');
    row.innerHTML = '<td colkey="summary">新增机票</td>';
    tbody.appendChild(row);
  });
  await frame.locator('[data-area-code="arap_bxbusitem"] .scroll-pane tbody').evaluate((tbody) => {
    const row = document.createElement('tr');
    row.innerHTML = '<td colkey="skyhzh"><span class="table-cell"></span></td>';
    tbody.appendChild(row);
  });
  const afterSplitPaneRow = await (automation as any).getTableRowSnapshot(transportIndex);
  const generatedRowRefs = diffGeneratedRows(beforeSplitPaneRow, afterSplitPaneRow);
  assert.equal(beforeSplitPaneRow.rowCount, 1);
  assert.equal(afterSplitPaneRow.rowCount, 2);
  assert.deepEqual(generatedRowRefs, ['__bip_row_index__:1']);
  assert.equal(
    await (automation as any).tableCell(transportIndex, generatedRowRefs[0], 'skyhzh').count(),
    1,
    '左侧固定表体有 rowkey、右侧滚动表体没有 rowkey 时，仍必须定位同一新增行的账号单元格',
  );
  const testAccount = '62000000000000001';
  const selectedColumns: string[] = [];
  let accountAttempts = 0;
  (automation as any).selectTableRefer = async (wrapperIdx: number, rowRef: string, colkey: string, value: string) => {
    selectedColumns.push(colkey);
    if (colkey === 'skyhzh') {
      accountAttempts++;
      if (accountAttempts === 1) return false;
      const cell = (automation as any).tableCell(wrapperIdx, rowRef, colkey);
      await cell.locator('.table-cell').evaluate((element: HTMLElement, selected: string) => {
        element.textContent = selected;
      }, value);
    }
    return true;
  };
  assert.equal(
    await (automation as any).fillTablePayeeAccount(transportIndex, generatedRowRefs[0], testAccount),
    true,
    '账号 refer 确认后必须回读新增行并确认账号已经写入',
  );
  assert.deepEqual(
    selectedColumns,
    ['skyhzh', 'skyhzh'],
    '账号选择失败时只能重试账号，绝不能改写 receiver 收款人字段',
  );
  assert.equal(
    await (automation as any).getTableCellValue(transportIndex, generatedRowRefs[0], 'skyhzh'),
    testAccount,
  );
  await frame.locator('[data-area-code="arap_bxbusitem"] .scroll-pane tbody > tr').nth(1)
    .locator('td[colkey="skyhzh"] .table-cell').evaluate((element: HTMLElement) => { element.textContent = '示例银行'; });
  (automation as any).selectTableRefer = async () => true;
  assert.equal(
    await (automation as any).fillTablePayeeAccount(transportIndex, generatedRowRefs[0], testAccount),
    false,
    '账号列只有银行名称而没有匹配账号尾号时不得误判成功',
  );

  assert.deepEqual(
    diffGeneratedRows(
      { rowKeys: ['old-a', 'old-b'], rowCount: 2 },
      { rowKeys: ['redraw-a', 'redraw-b'], rowCount: 2 },
    ),
    [],
    '整张虚拟表重绘且行数未增加时不得把全部旧行误判为新增行',
  );

  assert.deepEqual(
    diffGeneratedRows(
      {
        rowKeys: [], rowCount: 1, fingerprints: [''], businessCount: 0, sectionTotal: 0,
      },
      {
        rowKeys: ['lodging-generated'], rowCount: 1,
        fingerprints: ['INDEX:1|defitem14:张三报销差旅费用|defitem9:11.0|szxmid:境内差旅费'],
        businessCount: 1, sectionTotal: 2249.82,
      },
      { expectedRowCount: 1, expectedAmount: 2249.82 },
    ),
    ['__bip_row_index__:0'],
    '住宿票按价税合计解析且金额列尚未挂载时，必须凭业务条数和唯一新rowkey识别生成行',
  );
  assert.deepEqual(
    diffGeneratedRows(
      {
        rowKeys: [], rowCount: 1, fingerprints: [''], businessCount: 0, sectionTotal: 0,
      },
      {
        rowKeys: ['lodging-net-amount'], rowCount: 1,
        fingerprints: ['INDEX:1|defitem14:张三报销差旅费用'],
        businessCount: 1, sectionTotal: 2249.82,
      },
      { expectedRowCount: 1, expectedAmount: 2227.54 },
    ),
    [],
    '住宿发票若仍解析成不含税金额必须停止，不能在填写阶段静默换算放行',
  );
  assert.deepEqual(
    diffGeneratedRows(
      {
        rowKeys: [], rowCount: 1, fingerprints: [''], businessCount: 0, sectionTotal: 0,
      },
      {
        rowKeys: ['wrong-amount'], rowCount: 1, fingerprints: ['INDEX:1|defitem14:异常行'],
        businessCount: 1, sectionTotal: 5000,
      },
      { expectedRowCount: 1, expectedAmount: 2227.54 },
    ),
    [],
    '业务条数虽然增加，但金额量级明显不符时仍必须停止，不能误填账号或住宿字段',
  );

  assert.equal(await automation.fillAttachmentCount(7), true);
  assert.equal(await frame.locator('.form-item.fjzs input').inputValue(), '7');
  assert.equal(await automation.ensureMergePaymentChecked(), true);
  assert.equal(await frame.locator('.form-item.zyx25 input').isChecked(), true);
  const saveStartedAt = Date.now();
  assert.equal(await automation.saveDraftOnly(), true);
  assert.ok(Date.now() - saveStartedAt >= 3000, '保存加载层消失前不得提前进入附件上传步骤');
  assert.equal(await frame.evaluate(() => document.body.dataset.draftSaved), 'true');
  assert.equal(await frame.evaluate(() => document.body.dataset.submitted), undefined, '保存提交 must never be clicked');

  // 真实费用卡片和补助卡片使用同一套 TableNext 组件：外层布局 wrapper 内会再嵌套
  // 一个同名的实际表格。旧定位器把 outer + inner 误计为两张表，因而在上传前拒绝交通区。
  // 标题还是工具栏/表体共同容器的兄弟节点，工具栏自身也可能是 display:contents。
  await frame.setContent(`
    <section data-area-code="hidden-transport" style="display:none">
      <h2>交通费用</h2>
      <span class="arap_bxbusitem_card_body-button"><button>发票上传</button></span>
      <div id="hot-key-bzitem"><div class="table-next-body"><table><tbody></tbody></table></div></div>
    </section>
    <section data-area-code="nested-transport">
      <h2>交通费用（填列飞机、火车、长途汽车、车辆租赁等城市间交通费）</h2>
      <div class="expense-card-body">
        <span class="prefix-arap_bxbusitem_card_body-button-suffix" style="display:contents">
          <button data-click-area="arap_bxbusitem">发票上传</button>
        </span>
        <div id="hot-key-bzitem" class="outer-transport-wrapper">
          <div id="hot-key-bzitem" class="inner-transport-wrapper">
            <div class="table-next-header-wrapper"><table><thead><tr>
              <th colkey="defitem14">摘要</th><th colkey="defitem1">出发日期</th>
              <th colkey="vat_amount">价税合计金额</th>
            </tr></thead></table></div>
            <div class="table-next-body"><table><tbody></tbody></table></div>
          </div>
        </div>
      </div>
    </section>
    <section data-area-code="nested-lodging">
      <h2>住宿费用</h2>
      <div class="expense-card-body">
        <span class="prefix-other_card_body-button-suffix" style="display:contents">
          <button data-click-area="other">发票上传</button>
        </span>
        <div id="hot-key-bzitem" class="outer-lodging-wrapper">
          <div id="hot-key-bzitem" class="inner-lodging-wrapper">
            <div class="table-next-header-wrapper"><table><thead><tr>
              <th colkey="defitem21">人员级别</th><th colkey="defitem4">入住城市</th>
              <th colkey="defitem1">入住日期</th><th colkey="defitem2">离店日期</th>
            </tr></thead></table></div>
            <div class="table-next-body"><table><tbody></tbody></table></div>
          </div>
        </div>
      </div>
    </section>
    <section data-area-code="nested-other">
      <h2>其他费用（填列通行费、加油费、退票费、保险费等其他费用）</h2>
      <div class="expense-card-body">
        <span class="prefix-zsitem_card_body-button-suffix" style="display:contents">
          <button data-click-area="zsitem">发票上传</button>
        </span>
        <div id="hot-key-bzitem" class="outer-other-wrapper">
          <div id="hot-key-bzitem" class="inner-other-wrapper">
            <div class="table-next-header-wrapper"><table><thead><tr>
              <th colkey="defitem14">摘要</th><th colkey="vat_amount">价税合计金额</th>
            </tr></thead></table></div>
            <div class="table-next-body"><table><tbody></tbody></table></div>
          </div>
        </div>
      </div>
    </section>
    <section data-area-code="nested-subsidy">
      <h2>出差补贴</h2>
      <span class="bzitem_card_body-button"><button id="nested-subsidy-upload">发票上传</button></span>
      <div id="hot-key-bzitem"><div class="table-next-body"><table><tbody></tbody></table></div></div>
    </section>
    <script>
      document.querySelectorAll('[data-click-area]').forEach((button) => button.addEventListener('click', () => {
        document.body.dataset.nestedExpenseClicked = button.dataset.clickArea;
      }));
      document.querySelector('#nested-subsidy-upload').addEventListener('click', () => {
        document.body.dataset.nestedSubsidyClicked = 'true';
      });
    </script>
  `);
  const nestedExpenseAutomation = new ReimbursementAutomation();
  nestedExpenseAutomation.page = page;
  const nestedExpenseIndexes: Record<string, number> = { arap_bxbusitem: 2, other: 4, zsitem: 6 };
  for (const group of INVOICE_UPLOAD_GROUPS) {
    await frame.evaluate(() => { delete document.body.dataset.nestedExpenseClicked; });
    const nestedIndex = await (nestedExpenseAutomation as any).getExpenseWrapperIndex(
      group.sectionTitle,
      group.areaCode,
      group.toolbars,
    );
    assert.equal(
      nestedIndex,
      nestedExpenseIndexes[group.areaCode],
      `嵌套${group.sectionTitle}必须返回全 DOM 中最内层实际 wrapper 的序号`,
    );
    assert.equal(
      await (nestedExpenseAutomation as any).clickInvoiceUpload(
        group.sectionTitle,
        group.areaCode,
        group.toolbars,
        nestedIndex,
      ),
      true,
      `嵌套${group.sectionTitle}卡片仍必须能够点击本区专属发票上传按钮`,
    );
    assert.equal(
      await frame.evaluate(() => document.body.dataset.nestedExpenseClicked),
      group.areaCode,
      `嵌套${group.sectionTitle}只能点击本分区的发票上传按钮`,
    );
  }
  assert.equal(
    await frame.evaluate(() => document.body.dataset.nestedSubsidyClicked),
    undefined,
    '解析嵌套交通费用表时绝不能点击出差补贴的发票上传按钮',
  );

  // 2026-08 BIP 页面把交通、住宿、其他费用共同放在一个外层 #hot-key-bzitem，
  // 只有出差补贴保留独立的内层 wrapper。此时不能再把外层所有列混成一张表；
  // 应按每张费用卡片自己的标题、专属工具栏和列头建立稳定 token。
  await frame.setContent(`
    <div id="hot-key-bzitem" class="shared-expense-wrapper">
      <section class="shared-expense-card shared-transport">
        <h2>交通费用（填列飞机、火车、长途汽车、车辆租赁等城市间交通费）</h2>
        <span class="button-app-wrapper arap_bxbusitem_card_body-button-app-wrapper"><button data-shared-area="arap_bxbusitem">发票上传</button></span>
        <div class="table-next-header-wrapper"><table><thead><tr><th colkey="defitem1">出发日期</th><th colkey="vat_amount">价税合计金额</th><th colkey="skyhzh">收款人账号</th></tr></thead></table></div>
        <div class="table-next-body"><table><tbody><tr rowkey="shared-transport-old"><td colkey="defitem1">2026-08-25</td><td colkey="vat_amount">107.00</td><td colkey="skyhzh"></td></tr></tbody></table></div>
      </section>
      <section class="shared-expense-card shared-lodging">
        <h2>住宿费用</h2>
        <span class="button-app-wrapper other_card_body-button-app-wrapper"><button data-shared-area="other">发票上传</button></span>
        <div class="table-next-header-wrapper"><table><thead><tr><th colkey="defitem21">人员级别</th><th colkey="defitem4">入住城市</th><th colkey="defitem1">入住日期</th><th colkey="defitem2">离店日期</th><th colkey="defitem9">住宿天数</th><th colkey="vat_amount">价税合计金额</th></tr></thead></table></div>
        <div class="table-next-body"><table><tbody></tbody></table></div>
      </section>
      <section class="shared-expense-card shared-other">
        <h2>其他费用（填列通行费、加油费、退票费、保险费等其他费用）</h2>
        <span class="button-app-wrapper zsitem_card_body-button-app-wrapper"><button data-shared-area="zsitem">发票上传</button></span>
        <div class="table-next-header-wrapper"><table><thead><tr><th colkey="defitem14">摘要</th><th colkey="vat_amount">价税合计金额</th><th colkey="skyhzh">收款人账号</th></tr></thead></table></div>
        <div class="table-next-body"><table><tbody></tbody></table></div>
      </section>
      <section class="shared-subsidy-card">
        <h2>出差补贴</h2><span class="bzitem_card_body-button"><button id="shared-subsidy-upload">发票上传</button></span>
        <div id="hot-key-bzitem"><div class="table-next-header-wrapper"><table><thead><tr><th colkey="pk_reimtype">补助类型</th><th colkey="defitem9">出差天数</th><th colkey="defitem5">出差人数</th></tr></thead></table></div><div class="table-next-body"><table><tbody></tbody></table></div></div>
      </section>
    </div>
    <script>
      document.querySelectorAll('[data-shared-area]').forEach((button) => button.addEventListener('click', () => {
        document.body.dataset.sharedExpenseClicked = button.dataset.sharedArea;
      }));
      document.querySelector('#shared-subsidy-upload').addEventListener('click', () => {
        document.body.dataset.sharedSubsidyClicked = 'true';
      });
    </script>
  `);
  const sharedWrapperAutomation = new ReimbursementAutomation();
  sharedWrapperAutomation.page = page;
  for (const group of INVOICE_UPLOAD_GROUPS) {
    await frame.evaluate(() => { delete document.body.dataset.sharedExpenseClicked; });
    const target = await (sharedWrapperAutomation as any).getExpenseTarget(
      group.sectionTitle, group.areaCode, group.toolbars,
    );
    assert.ok(target?.targetToken, `共享外层 wrapper 中必须为${group.sectionTitle}卡片建立稳定 token`);
    assert.equal(target.schemaMatched, true, `${group.sectionTitle}必须通过本卡片列结构校验`);
    assert.equal(
      await (sharedWrapperAutomation as any).clickInvoiceUpload(
        group.sectionTitle, group.areaCode, group.toolbars, target.targetToken,
      ),
      true,
      `共享外层 wrapper 中必须点击${group.sectionTitle}自己的发票上传按钮`,
    );
    assert.equal(
      await frame.evaluate(() => document.body.dataset.sharedExpenseClicked),
      group.areaCode,
      `共享外层 wrapper 中${group.sectionTitle}不能串到其他费用卡片`,
    );
  }
  const sharedTransportTarget = await (sharedWrapperAutomation as any).getExpenseTarget(
    '交通费用', 'arap_bxbusitem', ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'],
  );
  assert.deepEqual(
    (await (sharedWrapperAutomation as any).getTableRowSnapshot(sharedTransportTarget.targetToken)).rowKeys,
    ['shared-transport-old'],
    '共享外层 wrapper 的交通快照只能读取交通卡片自己的行',
  );
  assert.equal(
    await frame.evaluate(() => document.body.dataset.sharedSubsidyClicked),
    undefined,
    '共享外层 wrapper 的任一费用上传都不能点击出差补贴',
  );

  // 真实机票批次会把两张发票合并为一条费用明细，并可能复用已预渲染的空槽：
  // tr 数量和 rowkey 均不变，只更新 input.value。固定列与滚动列又分属不同 tbody。
  await frame.setContent(`
    <section data-area-code="reserved-transport">
      <h2>交通费用（填列飞机、火车、长途汽车）</h2>
      <div class="expense-summary">共 <span id="reserved-business-count">0</span> 条，合计 <span id="reserved-section-total">0.00</span></div>
      <span class="arap_bxbusitem_card_body-button"><button>发票上传</button></span>
      <div id="hot-key-bzitem" class="outer-reserved-transport">
        <div id="hot-key-bzitem" class="inner-reserved-transport">
          <div class="table-next-header-wrapper"><table><thead><tr>
            <th colkey="defitem14">摘要</th><th colkey="defitem1">出发日期</th>
            <th colkey="vat_amount">价税合计金额</th><th colkey="skyhzh">收款人账号</th>
          </tr></thead></table></div>
          <div class="table-next-body fixed-business-pane"><table><tbody>
            <tr rowkey="hidden-fixed-clone" style="display:none"><td colkey="defitem14"><input value="隐藏旧行"></td><td colkey="defitem1"><input value="2020-01-01"></td></tr>
            <tr rowkey="stable-reserved"><td colkey="defitem14"><input value=""></td><td colkey="defitem1"><input value=""></td></tr>
          </tbody></table></div>
          <div class="table-next-body scrolling-business-pane" style="width:280px;overflow-x:auto"><table><tbody>
            <tr rowkey="hidden-scroll-clone" style="display:none"><td colkey="vat_amount"><input value="9999.00"></td><td colkey="skyhzh"><input value="隐藏账号"></td></tr>
            <tr rowkey="scroll-reserved-clone"><td colkey="vat_amount"><input value=""></td><td colkey="tax_amount"><input value=""></td><td colkey="skyhzh"><input value=""></td></tr>
          </tbody></table></div>
        </div>
      </div>
    </section>
  `);
  const reservedTransportAutomation = new ReimbursementAutomation();
  reservedTransportAutomation.page = page;
  const reservedTransportTarget = await (reservedTransportAutomation as any).getExpenseTarget(
    '交通费用',
    'arap_bxbusitem',
    ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'],
  );
  assert.ok(reservedTransportTarget?.targetToken, '预留槽交通表必须获得稳定 DOM token');
  const reservedTransportIndex = reservedTransportTarget.wrapperIdx;
  const reservedTransportToken = reservedTransportTarget.targetToken;
  assert.equal(reservedTransportIndex, 1, '预留槽场景必须继续绑定最内层交通费用 wrapper');
  const reservedBefore = await (reservedTransportAutomation as any).getTableRowSnapshot(reservedTransportToken);
  assert.equal(reservedBefore.rowCount, 1, '左右窗格各自的同一预留行只能计为一条逻辑行');
  assert.deepEqual(
    reservedBefore.rowKeys,
    ['stable-reserved'],
    '左右窗格为同一逻辑行使用不同 rowkey 时只能保留一个规范 key',
  );
  assert.equal(reservedBefore.businessCount, 0);
  assert.equal(reservedBefore.sectionTotal, 0);
  await frame.locator('.fixed-business-pane tbody > tr:visible').nth(0).evaluate((row) => {
    (row.querySelector('td[colkey="defitem14"] input') as HTMLInputElement).value = '张三报销差旅费用';
    (row.querySelector('td[colkey="defitem1"] input') as HTMLInputElement).value = '2026-07-19';
  });
  await frame.locator('.scrolling-business-pane tbody > tr:visible').nth(0).evaluate((row) => {
    (row.querySelector('td[colkey="vat_amount"] input') as HTMLInputElement).value = '2210.00';
    (row.querySelector('td[colkey="tax_amount"] input') as HTMLInputElement).value = '174.23';
  });
  await frame.evaluate(() => {
    document.querySelector('#reserved-business-count')!.textContent = '1';
    document.querySelector('#reserved-section-total')!.textContent = '2,210.00';
  });
  await (reservedTransportAutomation as any).getExpenseTarget(
    '交通费用',
    'arap_bxbusitem',
    ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'],
  );
  const reservedAfter = await (reservedTransportAutomation as any).getTableRowSnapshot(reservedTransportToken);
  assert.equal(reservedAfter.rowCount, 1, '预留槽原地回填后逻辑行数保持不变');
  assert.deepEqual(reservedAfter.rowKeys, reservedBefore.rowKeys, '预留槽原地回填后 rowkey 保持不变');
  assert.equal(reservedAfter.businessCount, 1, '业务卡片条数必须从0变为1');
  assert.equal(reservedAfter.sectionTotal, 2210, '业务卡片合计必须等于两张机票的批次总额');
  const reservedGeneratedRows = diffGeneratedRows(
    reservedBefore,
    reservedAfter,
    { expectedRowCount: 1, expectedAmount: 2210 },
  );
  assert.deepEqual(
    reservedGeneratedRows,
    ['__bip_row_index__:0'],
    '两张机票合并到预留槽时必须通过跨窗格业务值变化识别唯一生成行',
  );
  assert.equal(
    await (reservedTransportAutomation as any).scrollTableToColumn(reservedTransportToken, 'skyhzh'),
    true,
    'token 绑定的交通表必须能够滚动到自己的收款人账号列',
  );
  assert.equal(
    await (reservedTransportAutomation as any).tableCell(
      reservedTransportToken,
      reservedGeneratedRows[0],
      'skyhzh',
    ).count(),
    1,
    '预留槽识别结果必须命中滚动窗格中同一逻辑行的收款人账号列',
  );
  const beforeAccountOnlyChange = await (reservedTransportAutomation as any).getTableRowSnapshot(reservedTransportToken);
  await frame.locator('.scrolling-business-pane tbody > tr:visible').nth(0)
    .locator('td[colkey="skyhzh"] input').evaluate((input: HTMLInputElement) => { input.value = '62000000000000001'; });
  const afterAccountOnlyChange = await (reservedTransportAutomation as any).getTableRowSnapshot(reservedTransportToken);
  assert.deepEqual(
    diffGeneratedRows(beforeAccountOnlyChange, afterAccountOnlyChange),
    [],
    '后续只填写收款人账号不能再次被识别成新发票行',
  );
  await frame.locator('.fixed-business-pane tbody').evaluate((tbody) => {
    const row = document.createElement('tr');
    row.innerHTML = '<td colkey="defitem14">第二批高铁</td><td colkey="defitem1">2026-07-24</td>';
    tbody.appendChild(row);
  });
  await frame.locator('.scrolling-business-pane tbody').evaluate((tbody) => {
    const row = document.createElement('tr');
    row.innerHTML = '<td colkey="vat_amount">300.00</td><td colkey="tax_amount">0.00</td><td colkey="skyhzh"></td>';
    tbody.appendChild(row);
  });
  assert.equal(
    await (reservedTransportAutomation as any).scrollTableToColumn(reservedTransportToken, 'skyhzh'),
    true,
  );
  assert.equal(
    await (reservedTransportAutomation as any).tableCell(
      reservedTransportToken,
      '__bip_row_index__:1',
      'skyhzh',
    ).count(),
    1,
    '机票填完后再上传高铁时，token 必须能够定位交通表第二条逻辑行的账号列',
  );
  await frame.locator('.fixed-business-pane').evaluate((pane) => pane.remove());
  await frame.locator('.inner-reserved-transport th[colkey="defitem1"], .inner-reserved-transport th[colkey="vat_amount"]')
    .evaluateAll((headers) => headers.forEach((header) => header.remove()));
  const rightScrolledRebind = await (reservedTransportAutomation as any).getExpenseTarget(
    '交通费用',
    'arap_bxbusitem',
    ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'],
  );
  assert.equal(
    rightScrolledRebind?.targetToken,
    reservedTransportToken,
    '第一批交通票填完账号并停在右侧后，第二批仍必须沿用已验证的交通 token',
  );

  // BIP can remove a hidden wrapper between two browser evaluations. The old numeric index then
  // points at the subsidy table even though the traffic DOM node itself is still alive. Expense
  // snapshots and field writes must follow the stable token, never the stale index.
  await frame.setContent(`
    <div id="drift-placeholder" style="display:none"><div id="hot-key-bzitem">
      <div class="table-next-header-wrapper"><table><thead><tr><th colkey="vat_amount"></th></tr></thead></table></div>
      <div class="table-next-body"><table><tbody></tbody></table></div>
    </div></div>
    <section data-area-code="drift-transport">
      <h2>交通费用（填列飞机、火车、长途汽车）</h2>
      <div>共<span id="drift-traffic-count">0</span>条，合计<span id="drift-traffic-total">0.00</span></div>
      <span class="arap_bxbusitem_card_body-button"><button>发票上传</button></span>
      <div id="hot-key-bzitem" class="drift-outer-shell"><div id="hot-key-bzitem" class="drift-traffic-table">
        <div class="table-next-header-wrapper"><table><thead><tr>
          <th colkey="defitem14">摘要</th><th colkey="defitem1">出发日期</th>
          <th colkey="vat_amount">价税合计金额</th><th colkey="skyhzh">收款人账号</th>
        </tr></thead></table></div>
        <div class="table-next-body" style="width:280px;overflow-x:auto"><table><tbody><tr rowkey="drift-reserved">
          <td colkey="defitem14"><input value=""></td><td colkey="defitem1"><input value=""></td>
          <td colkey="vat_amount"><input value=""></td><td colkey="skyhzh"><input value=""></td>
        </tr></tbody></table></div>
      </div></div>
    </section>
    <section data-area-code="drift-subsidy">
      <h2>出差补贴</h2><div>共2条，合计360.00</div>
      <span class="bzitem_card_body-button"><button>增行</button></span>
      <div id="hot-key-bzitem" class="drift-subsidy-table">
        <div class="table-next-header-wrapper"><table><thead><tr>
          <th colkey="pk_reimtype">补助类型</th><th colkey="defitem9">出差天数</th>
          <th colkey="defitem5">出差人数</th><th colkey="vat_amount">补助金额</th>
        </tr></thead></table></div>
        <div class="table-next-body"><table><tbody>
          <tr rowkey="subsidy-a"><td colkey="pk_reimtype">伙食费</td><td colkey="defitem9">2</td><td colkey="defitem5">1</td><td colkey="vat_amount">200</td></tr>
          <tr rowkey="subsidy-b"><td colkey="pk_reimtype">交通费</td><td colkey="defitem9">2</td><td colkey="defitem5">1</td><td colkey="vat_amount">160</td></tr>
        </tbody></table></div>
      </div>
    </section>
  `);
  const driftAutomation = new ReimbursementAutomation();
  driftAutomation.page = page;
  const driftTargetBefore = await (driftAutomation as any).getExpenseTarget(
    '交通费用', 'arap_bxbusitem', ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'],
  );
  assert.ok(driftTargetBefore?.targetToken);
  assert.equal(driftTargetBefore.wrapperIdx, 2, '移除占位 wrapper 前交通 inner 的诊断索引应为2');
  const driftBefore = await (driftAutomation as any).getTableRowSnapshot(driftTargetBefore.targetToken);
  assert.equal(driftBefore.businessCount, 0);
  assert.equal(driftBefore.sectionTotal, 0);
  await frame.locator('#drift-placeholder').evaluate((node) => node.remove());
  const staleIndexSnapshot = await (driftAutomation as any).getTableRowSnapshot(driftTargetBefore.wrapperIdx);
  assert.equal(staleIndexSnapshot.businessCount, 2, '旧 numeric index 必须在测试中真实漂移到补贴表');
  assert.equal(staleIndexSnapshot.sectionTotal, 360, '旧 numeric index 漂移后的360元证明回归形状有效');
  await frame.evaluate(() => {
    document.querySelector('#drift-traffic-count')!.textContent = '1';
    document.querySelector('#drift-traffic-total')!.textContent = '2,210.00';
    const row = document.querySelector('.drift-traffic-table tbody tr')!;
    (row.querySelector('td[colkey="defitem14"] input') as HTMLInputElement).value = '张三报销差旅费用';
    (row.querySelector('td[colkey="defitem1"] input') as HTMLInputElement).value = '2026-07-19';
    (row.querySelector('td[colkey="vat_amount"] input') as HTMLInputElement).value = '2210.00';
  });
  const driftGenerated = await (driftAutomation as any).waitForGeneratedExpenseRows(
    '交通费用',
    'arap_bxbusitem',
    ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'],
    driftBefore,
    5000,
    { expectedRowCount: 1, expectedAmount: 2210 },
  );
  assert.equal(driftGenerated.wrapperIdx, 1, 'DOM 重排后交通表当前索引应更新为1');
  assert.equal(driftGenerated.targetToken, driftTargetBefore.targetToken, 'DOM 节点仍存在时必须沿用交通 token');
  assert.deepEqual(driftGenerated.rowRefs, ['__bip_row_index__:0']);
  assert.equal(driftGenerated.after.businessCount, 1);
  assert.equal(driftGenerated.after.sectionTotal, 2210);
  assert.equal(
    await (driftAutomation as any).scrollTableToColumn(driftGenerated.targetToken, 'skyhzh'),
    true,
  );
  assert.equal(
    await (driftAutomation as any).tableCell(
      driftGenerated.targetToken,
      driftGenerated.rowRefs[0],
      'skyhzh',
    ).count(),
    1,
    '旧索引已指向补贴时，账号单元格仍必须由交通 token 定位',
  );
  await frame.locator('.drift-traffic-table').evaluate((oldTable) => {
    const replacement = oldTable.cloneNode(true) as HTMLElement;
    delete replacement.dataset.codexTableToken;
    delete replacement.dataset.codexExpenseArea;
    delete replacement.dataset.codexSectionBusinessCount;
    delete replacement.dataset.codexSectionTotal;
    replacement.querySelectorAll('[data-codex-owner-token]').forEach((node) => {
      delete (node as HTMLElement).dataset.codexOwnerToken;
    });
    const row = document.createElement('tr');
    row.innerHTML = '<td colkey="defitem14"><input value="第二批高铁"></td>'
      + '<td colkey="defitem1"><input value="2026-07-24"></td>'
      + '<td colkey="vat_amount"><input value="300.00"></td>'
      + '<td colkey="skyhzh"><input value=""></td>';
    replacement.querySelector('tbody')!.appendChild(row);
    oldTable.replaceWith(replacement);
    document.querySelector('#drift-traffic-count')!.textContent = '2';
    document.querySelector('#drift-traffic-total')!.textContent = '2,510.00';
  });
  const removedTokenSnapshot = await (driftAutomation as any).getTableRowSnapshot(driftGenerated.targetToken);
  assert.equal(removedTokenSnapshot.targetFound, false, 'React 替换交通节点后旧 token 必须失效，不能迁移到其他表');
  const replacedGenerated = await (driftAutomation as any).waitForGeneratedExpenseRows(
    '交通费用',
    'arap_bxbusitem',
    ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'],
    driftGenerated.after,
    5000,
    { expectedRowCount: 1, expectedAmount: 300 },
  );
  assert.notEqual(replacedGenerated.targetToken, driftGenerated.targetToken, '重建后的交通 DOM 必须获得新 token');
  assert.deepEqual(replacedGenerated.rowRefs, ['__bip_row_index__:1']);
  assert.equal(replacedGenerated.after.businessCount, 2);
  assert.equal(replacedGenerated.after.sectionTotal, 2510);
  assert.equal(
    (await (driftAutomation as any).getTableRowSnapshot(driftTargetBefore.wrapperIdx)).sectionTotal,
    360,
    'React 重建后旧 numeric index 仍指向补贴时也不得参与交通检测',
  );
  await frame.locator('.drift-traffic-table').evaluate((oldTable) => {
    const replacement = oldTable.cloneNode(true) as HTMLElement;
    delete replacement.dataset.codexTableToken;
    delete replacement.dataset.codexExpenseArea;
    delete replacement.dataset.codexSectionBusinessCount;
    delete replacement.dataset.codexSectionTotal;
    replacement.querySelectorAll('[data-codex-owner-token]').forEach((node) => {
      delete (node as HTMLElement).dataset.codexOwnerToken;
    });
    replacement.querySelectorAll('[colkey="defitem1"], [colkey="defitem14"]')
      .forEach((node) => node.remove());
    oldTable.replaceWith(replacement);
  });
  assert.equal(
    (await (driftAutomation as any).getTableRowSnapshot(replacedGenerated.targetToken)).targetFound,
    false,
  );
  const rightOnlyTarget = await (driftAutomation as any).getExpenseTarget(
    '交通费用', 'arap_bxbusitem', ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'],
  );
  assert.equal(
    rightOnlyTarget,
    null,
    '旧 token 消失且新节点只剩右侧虚拟列时必须安全等待，不能把同卡片其他表猜成交通表',
  );

  // A wrapper may own the traffic header/body and also contain a later nested subsidy wrapper.
  // The owner rule must select the outer traffic table and exclude all nested subsidy rows.
  await frame.setContent(`
    <section data-area-code="owner-transport">
      <h2>交通费用（填列飞机、火车、长途汽车）</h2><div>共1条，合计2,210.00</div>
      <span class="arap_bxbusitem_card_body-button"><button>发票上传</button></span>
      <div id="hot-key-bzitem" class="owner-traffic-table">
        <div class="table-next-header-wrapper"><table><thead><tr>
          <th colkey="defitem1">出发日期</th><th colkey="vat_amount">价税合计金额</th><th colkey="skyhzh">收款人账号</th>
        </tr></thead></table></div>
        <div class="table-next-body"><table><tbody><tr rowkey="owner-traffic-row">
          <td colkey="defitem1">2026-07-19</td><td colkey="vat_amount">2210.00</td><td colkey="skyhzh"></td>
        </tr></tbody></table></div>
        <div class="nested-subsidy-section"><h3>出差补贴</h3><div>共2条，合计360.00</div>
          <span class="bzitem_card_body-button"><button>增行</button></span>
          <div id="hot-key-bzitem" class="owner-nested-subsidy">
            <div class="table-next-header-wrapper"><table><thead><tr>
              <th colkey="pk_reimtype">补助类型</th><th colkey="defitem9">天数</th><th colkey="defitem5">人数</th><th colkey="vat_amount">补助金额</th><th colkey="skyhzh">收款人账号</th>
            </tr></thead></table></div>
            <div class="table-next-body"><table><tbody>
              <tr><td colkey="pk_reimtype">伙食费</td><td colkey="defitem9">2</td><td colkey="defitem5">1</td><td colkey="vat_amount">200</td><td colkey="skyhzh">补贴账号A</td></tr>
              <tr><td colkey="pk_reimtype">交通费</td><td colkey="defitem9">2</td><td colkey="defitem5">1</td><td colkey="vat_amount">160</td><td colkey="skyhzh">补贴账号B</td></tr>
            </tbody></table></div>
          </div>
        </div>
      </div>
    </section>
  `);
  const ownerAutomation = new ReimbursementAutomation();
  ownerAutomation.page = page;
  const ownerTarget = await (ownerAutomation as any).getExpenseTarget(
    '交通费用', 'arap_bxbusitem', ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'],
  );
  assert.ok(ownerTarget?.targetToken);
  assert.equal(ownerTarget.wrapperIdx, 0, '自有交通表体的 outer wrapper 必须被保留为目标');
  assert.equal(ownerTarget.ownedColkeys.includes('pk_reimtype'), false, '交通结构签名不得混入嵌套补贴列');
  const ownerSnapshot = await (ownerAutomation as any).getTableRowSnapshot(ownerTarget.targetToken);
  assert.equal(ownerSnapshot.rowCount, 1, '交通快照不得统计嵌套补贴的两行');
  assert.equal(ownerSnapshot.businessCount, 1);
  assert.equal(ownerSnapshot.sectionTotal, 2210);
  assert.equal(ownerSnapshot.fingerprints.some((item: string) => item.includes('pk_reimtype')), false);
  assert.equal(await (ownerAutomation as any).scrollTableToColumn(ownerTarget.targetToken, 'skyhzh'), true);
  assert.equal(
    await (ownerAutomation as any).tableCell(ownerTarget.targetToken, '__bip_row_index__:0', 'skyhzh').count(),
    1,
    '交通 token 的账号定位不得命中嵌套补贴表中的同名 skyhzh 列',
  );

  // If the validated traffic table disappears during a React redraw, a subsidy table left in
  // the same visual card must never inherit the traffic identity merely because it is nearby.
  await frame.locator('[data-area-code="owner-transport"]').evaluate((section) => {
    const nestedSubsidy = section.querySelector('.nested-subsidy-section');
    if (!nestedSubsidy) throw new Error('missing nested subsidy fixture');
    section.appendChild(nestedSubsidy);
    section.querySelector('.owner-traffic-table')?.remove();
  });
  const subsidyOnlyTarget = await (ownerAutomation as any).getExpenseTarget(
    '交通费用', 'arap_bxbusitem', ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'],
  );
  assert.equal(
    subsidyOnlyTarget,
    null,
    '交通表卸载后同一区域只剩补贴表时必须停止，不能按卡片位置猜测',
  );
  assert.equal(
    await frame.locator('.owner-nested-subsidy').getAttribute('data-codex-expense-area'),
    null,
    '补贴表不得被重标记为交通费用表',
  );

  await frame.setContent(`
    <section><h2>交通费用</h2><span class="arap_bxbusitem_card_body-button"><button>发票上传</button></span>
      <div id="hot-key-bzitem"><div class="table-next-header-wrapper"><table><thead><tr>
        <th colkey="pk_reimtype">补助类型</th><th colkey="defitem9">天数</th><th colkey="defitem5">人数</th><th colkey="vat_amount">补助金额</th>
      </tr></thead></table></div><div class="table-next-body"><table><tbody></tbody></table></div></div>
    </section>
  `);
  const wrongSchemaAutomation = new ReimbursementAutomation();
  wrongSchemaAutomation.page = page;
  assert.equal(
    await (wrongSchemaAutomation as any).getExpenseWrapperIndex(
      '交通费用', 'arap_bxbusitem', ['arap_bxbusitem_card_body-button', 'arap_bxbusitem-button'],
    ),
    -1,
    '交通工具栏旁只有补贴列结构时必须拒绝绑定，不能点击或读取补贴表',
  );

  // 真实 BIP 会嵌套两个同名 wrapper，并预渲染一条空白编辑槽；点击“增行”时
  // DOM 行数仍为 1，只把该槽原地切换成 selected/focused。必须去重外层 wrapper。
  await frame.setContent(`
    <section data-area-code="nested-subsidy">
      <span class="prefix-bzitem_card_body-button-suffix"><button>增行</button></span>
      <div id="hot-key-bzitem" class="outer-bzitem">
        <div id="hot-key-bzitem" class="inner-bzitem">
          <div class="table-next-header-wrapper"><table><thead><tr>
            <th colkey="defitem14">摘要</th><th colkey="pk_reimtype">补助类型</th>
            <th colkey="defitem9">出差天数</th><th colkey="defitem5">出差人数</th>
          </tr></thead></table></div>
          <div class="table-next-body"><table><tbody><tr rowkey="reserved-subsidy-row">
            <td colkey="defitem14"><input></td><td colkey="pk_reimtype"></td>
            <td colkey="defitem9"></td><td colkey="defitem5"></td>
          </tr></tbody></table></div>
        </div>
      </div>
    </section>
    <script>
      document.querySelector('button').addEventListener('click', () => {
        const row = document.querySelector('.table-next-body tr');
        row.classList.add('selected-row');
        row.querySelector('input').focus();
      });
    </script>
  `);
  const nestedAutomation = new ReimbursementAutomation();
  nestedAutomation.page = page;
  const nestedBefore = await (nestedAutomation as any).getAllTableRowSnapshots();
  assert.equal(nestedBefore.length, 1, '嵌套同名 wrapper 只能保留最内层实际表格');
  assert.equal(nestedBefore[0].wrapperIdx, 1, '后续填写仍必须使用全 DOM 中的真实 wrapper 序号');
  assert.equal(nestedBefore[0].rowCount, 1, '增行前真实 BIP 已预渲染一条空白编辑槽');
  await (nestedAutomation as any).clickSubsidyAddRow();
  const nestedAfter = await (nestedAutomation as any).getAllTableRowSnapshots();
  const activatedSlot = resolveSubsidyTableChange(nestedBefore, nestedAfter);
  assert.ok(activatedSlot);
  assert.equal(activatedSlot.wrapperIdx, 1);
  assert.equal(activatedSlot.rowRef, '__bip_row_index__:0');
  assert.equal(
    await (nestedAutomation as any).fillTableText(activatedSlot.wrapperIdx, activatedSlot.rowRef, 'defitem14', '真实预留行测试摘要'),
    true,
    '定位后必须能把摘要写入最内层实际补助表的预留行',
  );
  assert.equal(
    await frame.locator('.inner-bzitem td[colkey="defitem14"] input').inputValue(),
    '真实预留行测试摘要',
  );

  // 收款人账号列位于长表格中段。旧实现先跳到最右端且只继续向右，永远看不到中段虚拟列。
  await frame.setContent(`
    <style>
      #hot-key-bzitem { width: 420px; }
      .table-next-body-inner-wrapper { width: 400px; height: 80px; overflow-x: auto; }
      .virtual-surface { position: relative; width: 4000px; height: 60px; }
      .table-next-body { position: absolute; left: 1600px; top: 0; width: 220px; height: 50px; }
      td { width: 200px; height: 36px; }
    </style>
    <div id="hot-key-bzitem">
      <div id="middle-scroll-owner" class="table-next-body-inner-wrapper">
        <div class="virtual-surface">
          <div class="table-next-body"><table><tbody><tr>
            <td colkey="skyhzh"><span class="table-cell">62000000000000001</span></td>
          </tr></tbody></table></div>
        </div>
      </div>
    </div>
  `);
  const middleColumnAutomation = new ReimbursementAutomation();
  middleColumnAutomation.page = page;
  assert.equal(
    await (middleColumnAutomation as any).scrollTableToColumn(0, 'skyhzh'),
    true,
    '横向扫描必须能找到位于最右端之前的收款人账号列',
  );
  const middleScrollLeft = await frame.locator('#middle-scroll-owner').evaluate((element: HTMLElement) => element.scrollLeft);
  assert.ok(middleScrollLeft > 0 && middleScrollLeft < 3500, '账号列命中位置不应是滚动条最右端');

  await frame.setContent(`
    <div role="dialog" class="wui-modal">
      <h2>行政区划</h2>
      <input placeholder="搜索城市">
      <ul class="wui-tree" id="city-tree">
        <li><span class="wui-tree-title">100000 中国</span></li>
        <li><span class="wui-tree-title">110000 北京市</span></li>
        <li><span class="wui-tree-title">110101 北京市东城区</span></li>
      </ul>
      <table><tbody><tr><td>暂无数据</td></tr></tbody></table>
      <button>确定(Y)</button>
    </div>
    <button id="city-search" aria-label="搜索">搜索</button>
    <script>
      document.querySelector('input').addEventListener('input', (event) => {
        document.body.dataset.cityQuery = event.target.value;
        setTimeout(() => {
          document.querySelector('#city-tree').innerHTML =
            '<li><span class="wui-tree-title">510000 四川省</span></li>'
            + '<li><span class="wui-tree-title" data-city-level="city">511500 四川省宜宾市</span></li>';
        }, 1200);
        setTimeout(() => {
          document.querySelector('#city-tree').innerHTML =
            '<li><span class="wui-tree-title">510000 四川省</span></li>'
            + '<li><span class="wui-tree-title" data-city-level="city">511500 四川省宜宾市</span></li>'
            + '<li><span class="wui-tree-title" data-city="first">511502 四川省宜宾市翠屏区</span></li>'
            + '<li><span class="wui-tree-title" data-city="second">511503 四川省宜宾市南溪区</span></li>';
        }, 3300);
      });
      document.querySelector('input').addEventListener('keydown', () => {
        document.body.dataset.searchKeyPressed = 'true';
      });
      document.querySelector('#city-search').addEventListener('click', () => {
        document.body.dataset.searchButtonClicked = 'true';
      });
      document.querySelector('#city-tree').addEventListener('click', (event) => {
        if (event.target.closest('[data-city-level="city"]')) {
          document.body.dataset.cityFolderClicked = 'true';
        }
        const node = event.target.closest('[data-city]');
        if (node) document.body.dataset.selectedCity = node.dataset.city;
      });
    </script>
  `);
  const cityAutomation = new ReimbursementAutomation();
  cityAutomation.page = page;
  assert.equal(
    await (cityAutomation as any).selectFirstReferSearchResult('宜宾'),
    true,
    '入住城市参照必须能够搜索具体城市并选择结果',
  );
  assert.equal(await frame.evaluate(() => document.body.dataset.cityQuery), '宜宾');
  assert.equal(
    await frame.evaluate(() => document.body.dataset.searchKeyPressed),
    undefined,
    '填写城市后不得按 Enter 或其他按键催促检索',
  );
  assert.equal(
    await frame.evaluate(() => document.body.dataset.searchButtonClicked),
    undefined,
    '填写城市后不得点击搜索按钮催促检索',
  );
  assert.equal(
    await frame.evaluate(() => document.body.dataset.cityFolderClicked),
    undefined,
    '仅出现宜宾市级节点时不得提前点击，必须继续等待区县节点',
  );
  assert.equal(
    await frame.evaluate(() => document.body.dataset.selectedCity),
    'first',
    '入住城市必须选择查询结果中的第一个地点',
  );

  // 影像扫描页面必须完成“本地导入 → 导入确认 → 保存 → 保存确认”的完整闭环。
  const scanPage = await browser.newPage();
  await scanPage.setContent(`
    <button id="local-import">本地导入</button>
    <div id="import-dialog" style="display:none">
      <input id="importFile" type="file" multiple>
      <button id="import-confirm">确 定</button>
    </div>
    <button id="scan-save">保存</button>
    <div id="save-dialog" style="display:none">
      <button id="save-confirm">确 定</button>
    </div>
    <script>
      document.querySelector('#local-import').addEventListener('click', () => {
        document.querySelector('#import-dialog').style.display = 'block';
      });
      document.querySelector('#import-confirm').addEventListener('click', () => {
        const selected = document.querySelector('#importFile').files.length;
        document.body.dataset.imported = String(selected);
        document.querySelector('#import-dialog').style.display = 'none';
      });
      document.querySelector('#scan-save').addEventListener('click', () => {
        document.querySelector('#save-dialog').style.display = 'block';
      });
      document.querySelector('#save-confirm').addEventListener('click', () => {
        document.body.dataset.saved = 'true';
        document.querySelector('#save-dialog').style.display = 'none';
      });
    </script>
  `);
  const attachmentAutomation = new ReimbursementAutomation();
  const attachmentReport = await (attachmentAutomation as any).uploadFilesInScanPage(
    scanPage,
    [path.resolve(process.cwd(), 'test_upload.pdf')],
  );
  assert.deepEqual(attachmentReport, { expected: 1, uploaded: 1, warnings: [] });
  assert.equal(await scanPage.evaluate(() => document.body.dataset.imported), '1');
  assert.equal(await scanPage.evaluate(() => document.body.dataset.saved), 'true');
  await scanPage.close();

  // 生产影像系统可能在最终保存后主动关闭窗口；这是成功完成，不得被误报为 Target closed。
  const autoCloseScanPage = await browser.newPage();
  await autoCloseScanPage.exposeFunction('closeScanWindowAfterSave', () => {
    setTimeout(() => { void autoCloseScanPage.close(); }, 20);
  });
  await autoCloseScanPage.setContent(`
    <button id="local-import">本地导入</button>
    <div id="import-dialog" style="display:none">
      <input id="importFile" type="file" multiple>
      <button id="import-confirm">确 定</button>
    </div>
    <button id="scan-save">保存</button>
    <script>
      document.querySelector('#local-import').addEventListener('click', () => {
        document.querySelector('#import-dialog').style.display = 'block';
      });
      document.querySelector('#import-confirm').addEventListener('click', () => {
        document.querySelector('#import-dialog').style.display = 'none';
      });
      document.querySelector('#scan-save').addEventListener('click', () => {
        window.closeScanWindowAfterSave();
      });
    </script>
  `);
  const autoCloseReport = await (attachmentAutomation as any).uploadFilesInScanPage(
    autoCloseScanPage,
    [path.resolve(process.cwd(), 'test_upload.pdf')],
  );
  assert.deepEqual(autoCloseReport, { expected: 1, uploaded: 1, warnings: [] });
  assert.equal(autoCloseScanPage.isClosed(), true, '最终保存后影像窗口应已自动关闭');


  // 机票账号填写后停在右侧；高铁已新增，但金额列被横向虚拟滚动卸载。
  await frame.setContent("\n<style>\n.train-header,.train-body{width:400px;overflow-x:auto}\n.train-header table,.train-body table{width:1200px;table-layout:fixed;border-collapse:collapse}\ntd,th{height:28px}\n</style>\n<section data-area-code=\"arap_bxbusitem\">\n<h2>交通费用</h2><span>共<span id=\"train-count\">1</span>条，合计<span id=\"train-total\">2,580.00</span></span>\n<span class=\"arap_bxbusitem_card_body-button\"><button>发票上传</button></span>\n<div id=\"hot-key-bzitem\">\n<div class=\"table-next-header-wrapper train-header\"><table><colgroup>\n<col style=\"width:80px\"><col style=\"width:160px\"><col style=\"width:160px\"><col style=\"width:600px\"><col style=\"width:200px\">\n</colgroup><thead><tr>\n<th colkey=\"INDEX\">序号</th><th colkey=\"vat_amount\">价税合计金额</th><th colkey=\"defitem1\">出发日期</th><th>其他字段</th><th colkey=\"skyhzh\">收款人账号</th>\n</tr></thead></table></div>\n<div class=\"table-next-body train-body\"><table><colgroup>\n<col style=\"width:80px\"><col style=\"width:160px\"><col style=\"width:160px\"><col style=\"width:600px\"><col style=\"width:200px\">\n</colgroup><tbody><tr rowkey=\"flight-row\" data-amount=\"2580.00\">\n<td colkey=\"INDEX\">1</td><td class=\"virtual-amount\"></td><td colkey=\"defitem1\"></td><td></td><td colkey=\"skyhzh\">TEST-0001</td>\n</tr></tbody></table></div>\n</div></section>\n<script>\nconst trainBody=document.querySelector('.train-body');\nfunction renderTrainAmounts(){\ntrainBody.querySelectorAll('tr').forEach(row=>{\nconst cell=row.querySelector('.virtual-amount');\nif(trainBody.scrollLeft<200){cell.setAttribute('colkey','vat_amount');cell.textContent=row.dataset.amount}\nelse{cell.removeAttribute('colkey');cell.textContent=''}\n});\n}\ntrainBody.addEventListener('scroll',renderTrainAmounts);\ntrainBody.scrollLeft=800;renderTrainAmounts();\n</script>");
  const trainAutomation = new ReimbursementAutomation();
  trainAutomation.page = page;
  const trainTarget = await (trainAutomation as any).getExpenseTarget(
    '交通费用', 'arap_bxbusitem', ['arap_bxbusitem_card_body-button'],
  );
  assert.ok(trainTarget?.targetToken);
  const beforeTrain = await (trainAutomation as any).getTableRowSnapshot(trainTarget.targetToken);
  assert.equal(beforeTrain.sectionTotal, 2580);
  assert.equal(beforeTrain.rowCount, 1);
  assert.equal(beforeTrain.fingerprints[0].includes('vat_amount:'), false);
  await frame.evaluate(() => {
    const body = document.querySelector('.train-body')!;
    const row = body.querySelector('tr')!.cloneNode(true) as HTMLElement;
    row.setAttribute('rowkey', 'train-row');
    row.dataset.amount = '60.00';
    row.querySelector('[colkey="INDEX"]')!.textContent = '2';
    row.querySelector('[colkey="skyhzh"]')!.textContent = '';
    body.querySelector('tbody')!.appendChild(row);
    document.querySelector('#train-count')!.textContent = '2';
    document.querySelector('#train-total')!.textContent = '2,640.00';
    body.dispatchEvent(new Event('scroll'));
  });
  await (trainAutomation as any).getExpenseTarget(
    '交通费用', 'arap_bxbusitem', ['arap_bxbusitem_card_body-button'],
  );
  const hiddenTrain = await (trainAutomation as any).getTableRowSnapshot(trainTarget.targetToken);
  assert.equal(hiddenTrain.sectionTotal, 2640);
  assert.equal(hiddenTrain.rowCount, 2);
  assert.deepEqual(diffGeneratedRows(beforeTrain, hiddenTrain, { expectedRowCount: 1, expectedAmount: 60 }), []);
  const foundTrain = await (trainAutomation as any).waitForGeneratedExpenseRows(
    '交通费用', 'arap_bxbusitem', ['arap_bxbusitem_card_body-button'],
    beforeTrain, 6000, { expectedRowCount: 1, expectedAmount: 60 },
  );
  assert.deepEqual(foundTrain.rowRefs, ['__bip_row_index__:1'], '必须恢复金额虚拟列并唯一定位高铁行');
  assert.match(foundTrain.after.fingerprints[1], /vat_amount:60\.00/);
  (trainAutomation as any).selectTableRefer = async (target: string, rowRef: string, colkey: string, value: string) => {
    const cell = (trainAutomation as any).tableCell(target, rowRef, colkey);
    await cell.evaluate((element: HTMLElement, selected: string) => { element.textContent = selected; }, value);
    return true;
  };
  assert.equal(await (trainAutomation as any).fillTablePayeeAccount(
    foundTrain.targetToken, foundTrain.rowRefs[0], testAccount,
  ), true);
  assert.equal(await frame.locator('[rowkey="flight-row"] [colkey="skyhzh"]').textContent(), 'TEST-0001', '机票行不能被改写');
  assert.equal(await frame.locator('[rowkey="train-row"] [colkey="skyhzh"]').textContent(), testAccount);

  // 发票上传弹窗：8 张票分两次解析完成时，必须等全部出现且不再“解析中”才继续。
  const makeUploadDialogPage = async (script: string) => {
    const uploadPage = await browser.newPage();
    await uploadPage.setContent('<iframe id="forwardFrame" name="forwardFrame"></iframe>');
    const fwd = uploadPage.frames().find((item) => item.name() === 'forwardFrame')!;
    await fwd.setContent('<iframe id="mainiframe" name="mainiframe"></iframe>');
    const main = uploadPage.frames().find((item) => item.name() === 'mainiframe')!;
    await main.setContent(`
      <div role="dialog" class="upload-invoice-dialog" style="width:600px;height:400px">
        <button>上传票据</button>
        <table><thead><tr><th><input type="checkbox" id="check-all"></th><th>金额</th><th>状态</th></tr></thead>
        <tbody id="rows"><tr><td colspan="3">暂无数据</td></tr></tbody></table>
      </div>
      <script>
        const tbody = document.querySelector('#rows');
        function addRow(key, amount, status) {
          if (tbody.textContent.includes('暂无数据')) tbody.innerHTML = '';
          const tr = document.createElement('tr');
          tr.setAttribute('data-row-key', key);
          tr.innerHTML = '<td><input type="checkbox"></td><td>' + amount + '</td><td class="status">' + status + '</td>';
          tbody.appendChild(tr);
          return tr;
        }
        document.querySelector('#check-all').addEventListener('change', (event) => {
          tbody.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = event.target.checked; });
        });
        ${script}
      </script>
    `);
    const uploadAutomation = new ReimbursementAutomation();
    uploadAutomation.page = uploadPage;
    return { uploadPage, uploadAutomation };
  };

  {
    const { uploadPage, uploadAutomation } = await makeUploadDialogPage(`
      [54, 54, 51, 51].forEach((amount, i) => addRow('t' + i, amount, '查验成功'));
      const late = [41, 51, 51, 54].map((amount, i) => addRow('t' + (i + 4), amount, '解析中'));
      setTimeout(() => late.forEach((tr) => { tr.querySelector('.status').textContent = '查验成功'; }), 5000);
    `);
    const root = (uploadAutomation as any).visibleInvoiceUploadRoot();
    const startedAt = Date.now();
    const result = await (uploadAutomation as any).waitForInvoiceUploadList(root, 0, 8, '高铁票');
    assert.equal(result.structureKnown, true);
    assert.equal(result.rowCount, 8, '必须等到 8 张票据全部列出');
    assert.ok(Date.now() - startedAt >= 5000, '仍在“解析中”的票据未完成前不得继续');
    await root.locator('#check-all').check();
    const selection = await (uploadAutomation as any).readInvoiceUploadList(root);
    assert.equal(selection.checkedCount, 8, '全选后应勾选全部 8 张');
    await uploadPage.close();
  }

  {
    const { uploadPage, uploadAutomation } = await makeUploadDialogPage(`
      addRow('ok', 54, '查验成功');
      setTimeout(() => addRow('bad', 51, '查验失败：发票已报销'), 1500);
    `);
    const root = (uploadAutomation as any).visibleInvoiceUploadRoot();
    await assert.rejects(
      (uploadAutomation as any).waitForInvoiceUploadList(root, 0, 2, '高铁票'),
      /票据失败/,
      '弹窗中出现失败票据时必须在“去报销”前停止',
    );
    await uploadPage.close();
  }

  {
    const { uploadPage, uploadAutomation } = await makeUploadDialogPage(`addRow('ok', 54, '无异常');`);
    const root = (uploadAutomation as any).visibleInvoiceUploadRoot();
    const result = await (uploadAutomation as any).waitForInvoiceUploadList(root, 0, 1, '机票');
    assert.equal(result.rowCount, 1, '“无异常”不能被误判为失败');
    await uploadPage.close();
  }

  // 真实 BIP 结构：勾选框在固定列的独立表格里，单元格 class 为 col-customer-checkbox；
  // 勾选后 label 带 is-checked，input.checked 仍为 false。必须按 is-checked 计数。
  {
    const { uploadPage, uploadAutomation } = await makeUploadDialogPage(`
      document.querySelector('table').remove();
      const dialog = document.querySelector('[role="dialog"]');
      dialog.insertAdjacentHTML('beforeend',
        '<table><thead><tr><th>序号</th><th>发票号码</th><th>价税合计</th></tr></thead><tbody class="wui-table-tbody">'
        + '<tr class="wui-table-row" data-row-key="inv-1"><td>1</td><td>2651887621</td><td>3,120.00</td></tr></tbody></table>'
        + '<table class="fixed-left"><thead><tr><th class="col-customer-checkbox"><span class="base-checkbox-wrapper">'
        + '<label class="wui-checkbox" id="real-check-all"><input type="checkbox"><span class="wui-checkbox-label"></span></label></span></th></tr></thead>'
        + '<tbody class="wui-table-tbody"><tr class="wui-table-row" data-row-key="inv-1"><td class="col-customer-checkbox align-to-checkbox">'
        + '<span class="base-checkbox-wrapper"><label class="wui-checkbox wui-checkbox-inverse"><input type="checkbox"><span class="wui-checkbox-label"></span></label></span>'
        + '</td></tr></tbody></table>');
      document.querySelector('#real-check-all').addEventListener('click', () => {
        document.querySelectorAll('label.wui-checkbox').forEach((label) => label.classList.add('is-checked'));
      });
    `);
    const root = (uploadAutomation as any).visibleInvoiceUploadRoot();
    const before = await (uploadAutomation as any).readInvoiceUploadList(root);
    assert.equal(before.rowCount, 1, '主表和固定列表格按 data-row-key 去重，只算 1 张');
    assert.equal(before.checkedCount, 0);
    await root.locator('#real-check-all').click();
    const after = await (uploadAutomation as any).readInvoiceUploadList(root);
    assert.equal(after.hasRowCheckboxes, true);
    assert.equal(after.checkedCount, 1, 'label.is-checked 应计为已勾选，不能把 col-customer-checkbox 单元格当成勾选框');
    await uploadPage.close();
  }

  // “强制登录”弹窗在步骤中途出现并遮住按钮时，操作前自动关闭再继续；普通文字不触发。
  {
    const popupContext = await browser.newContext();
    const popupAutomation = new ReimbursementAutomation();
    popupContext.on('page', (newPage) => { void (popupAutomation as any).installPopupHandlers(newPage); });
    const popupPage = await popupContext.newPage();
    await popupPage.setContent('<iframe id="forwardFrame" name="forwardFrame"></iframe>');
    const fwd = popupPage.frames().find((item) => item.name() === 'forwardFrame')!;
    await fwd.setContent(`
      <p>说明：若提示强制登录请联系管理员</p>
      <button id="ordinary-ok">确定</button>
      <button id="target">新增</button>
      <script>
        let shown = 0;
        window.forceLoginCount = 0;
        window.ordinaryOkClicks = 0;
        document.querySelector('#ordinary-ok').addEventListener('click', () => { window.ordinaryOkClicks++; });
        document.querySelector('#target').addEventListener('click', () => { document.body.dataset.added = 'yes'; });
        setTimeout(() => {
          const modal = document.createElement('div');
          modal.className = 'wui-modal';
          modal.setAttribute('role', 'dialog');
          modal.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:10';
          modal.innerHTML = '<p>该账号已在其他地方登录，是否强制登录？</p><button>确定</button>';
          modal.querySelector('button').addEventListener('click', () => { window.forceLoginCount++; modal.remove(); });
          document.body.appendChild(modal);
        }, 300);
      </script>
    `);
    popupAutomation.page = popupPage;
    await popupPage.waitForTimeout(600);
    await popupPage.locator('#forwardFrame').contentFrame().locator('#target').click({ timeout: 5000 });
    assert.equal(await fwd.evaluate(() => document.body.dataset.added), 'yes', '弹窗关闭后应继续完成原操作');
    assert.equal(await fwd.evaluate(() => (window as any).forceLoginCount), 1, '强制登录弹窗应被自动确认一次');
    assert.equal(await fwd.evaluate(() => (window as any).ordinaryOkClicks), 0, '页面普通文字含“强制登录”时不能误点其他确定按钮');
    await popupContext.close();
  }

  // 网络慢时参照弹窗、选项和明细调整弹窗都会晚出现：必须等待，不能只在点击后瞬间检查一次。
  {
    const slowPage = await browser.newPage();
    await slowPage.setContent('<iframe id="forwardFrame" name="forwardFrame"></iframe>');
    const slowForward = slowPage.frames().find((item) => item.name() === 'forwardFrame')!;
    await slowForward.setContent('<iframe id="mainiframe" name="mainiframe"></iframe>');
    const slowFrame = slowPage.frames().find((item) => item.name() === 'mainiframe')!;
    await slowFrame.setContent(`
      <div class="form-item jsfs"><span class="iconfont icon-refer" id="settle-icon">…</span><span id="settle-value"></span></div>
      <button id="go">去报销</button>
      <script>
        window.log = [];
        document.querySelector('#settle-icon').addEventListener('click', () => {
          setTimeout(() => {
            const popup = document.createElement('div');
            popup.className = 'refer-pop-window-show';
            popup.innerHTML = '<div class="loading">加载中</div>';
            document.body.appendChild(popup);
            // 弹窗先出现，选项再晚一点加载
            setTimeout(() => {
              popup.innerHTML = '<a href="#" id="opt">联动支付</a><button>确定(Y)</button>';
              popup.querySelector('#opt').addEventListener('click', (e) => { e.preventDefault(); window.log.push('pick'); });
              popup.querySelector('button').addEventListener('click', () => {
                window.log.push('confirm');
                document.querySelector('#settle-value').textContent = '联动支付';
                popup.remove();
              });
            }, 1200);
          }, 1300);
        });
        document.querySelector('#go').addEventListener('click', () => {
          setTimeout(() => {
            const dialog = document.createElement('div');
            dialog.setAttribute('role', 'dialog');
            dialog.innerHTML = '<p>明细调整</p><button>确认</button>';
            dialog.querySelector('button').addEventListener('click', () => { window.log.push('detail-confirm'); dialog.remove(); });
            document.body.appendChild(dialog);
          }, 2000);
        });
      </script>
    `);
    const slowAutomation = new ReimbursementAutomation();
    slowAutomation.page = slowPage;
    const started = Date.now();
    assert.equal(await (slowAutomation as any).selectReferByItem('jsfs', '结算方式', '联动支付'), true, '应等到慢加载的参照选项后再选择');
    assert.ok(Date.now() - started >= 2500, '选项 2.5 秒后才出现，必须等待');
    assert.deepEqual(await slowFrame.evaluate(() => (window as any).log), ['pick', 'confirm']);
    assert.equal(await slowFrame.locator('#settle-value').textContent(), '联动支付');

    await slowFrame.locator('#go').click();
    assert.equal(await (slowAutomation as any).confirmDetailDialog(), true, '明细调整弹窗晚 2 秒出现也要能确认');
    assert.deepEqual(await slowFrame.evaluate(() => (window as any).log), ['pick', 'confirm', 'detail-confirm']);

    // 超时内始终不出现时返回 false，不无限等待。
    assert.equal(await (slowAutomation as any).waitForReferResult(['不存在的选项'], 800), false);
    await slowPage.close();
  }

  // BIP 网络慢：页面显示“加载中”时必须等待；表单可能在新页面里很久才加载出来。
  {
    const loadContext = await browser.newContext();
    const loadAutomation = new ReimbursementAutomation();
    (loadAutomation as any).context = loadContext;
    const listPage = await loadContext.newPage();
    await listPage.setContent(`
      <div class="wui-loading-mask" id="mask" style="position:fixed;inset:0"><span>加载中...</span></div>
      <script>setTimeout(() => document.querySelector('#mask').remove(), 2500);</script>`);
    loadAutomation.page = listPage;
    const progress: string[] = [];
    loadAutomation.onProgress((msg) => progress.push(msg));
    assert.equal(await (loadAutomation as any).isBipBusy(), true, '加载层可见时应判定为忙');
    let started = Date.now();
    assert.equal(await (loadAutomation as any).waitForBipReady('测试加载', 20000), true);
    assert.ok(Date.now() - started >= 2500, '加载层消失前不能继续');
    assert.equal(await (loadAutomation as any).isBipBusy(), false);

    // 一直转圈时按超时返回，不会无限等待。
    await listPage.setContent('<div class="wui-spin-spinning" style="width:20px;height:20px"></div>');
    started = Date.now();
    assert.equal(await (loadAutomation as any).waitForBipReady('一直加载', 1500), false);
    assert.ok(Date.now() - started < 4000);

    // 点“自制”后表单在新页面打开，且 6.5 秒后才加载出“报账事由”输入框。
    const formPromise = (loadAutomation as any).waitForFormPage(30000);
    const formPage = await loadContext.newPage();
    await formPage.setContent('<iframe id="forwardFrame" name="forwardFrame"></iframe>');
    const formForward = formPage.frames().find((item) => item.name() === 'forwardFrame')!;
    await formForward.setContent('<iframe id="mainiframe" name="mainiframe"></iframe>');
    const formMain = formPage.frames().find((item) => item.name() === 'mainiframe')!;
    await formMain.setContent(`
      <div id="loading">加载中...</div>
      <script>setTimeout(() => {
        document.querySelector('#loading').remove();
        document.body.insertAdjacentHTML('beforeend', '<div class="form-item zy"><input></div>');
      }, 6500);</script>`);
    const found = await formPromise;
    assert.equal(found, formPage, '应在所有页面中找到真正加载出表单的那一页');
    assert.ok(progress.some((msg) => /正在等待报账单表单加载/.test(msg)), '等待时应向页面报告进度');
    await loadContext.close();
  }

  // 首页常用应用只剩“我的单据”时，不能点第一个图标，必须通过应用搜索打开差旅费用报账单。
  {
    const navContext = await browser.newContext();
    const navAutomation = new ReimbursementAutomation();
    (navAutomation as any).context = navContext;
    const navPage = await navContext.newPage();
    await navPage.setContent('<iframe id="forwardFrame" name="forwardFrame"></iframe>');
    const navFrame = navPage.frames().find((item) => item.name() === 'forwardFrame')!;
    // 真实 BIP 登录后首页要过一会儿才渲染出来；用延迟显示复现“检查时还没加载”的情况。
    const homepage = (tiles: string[]) => `
      <div id="home" style="display:none">
      <ul><li class="ant-select-search"><div class="ant-select-search__field__wrap">
        <input class="ant-input ant-select-search__field" placeholder="请输入应用名称" value="">
      </div></li></ul>
      ${tiles.map((title) => `<div class="app-group-item nodrag" title="${title}"><div class="app-icon"></div><span>${title}</span></div>`).join('')}
      <div class="ant-select-dropdown" style="display:none"><ul>
        <li role="option" class="ant-select-dropdown-menu-item">差旅费用借款单</li>
        <li role="option" class="ant-select-dropdown-menu-item" id="travel-option">差旅费用报账单</li>
      </ul></div>
      </div>
      <script>
        setTimeout(() => { document.querySelector('#home').style.display = 'block'; }, 1500);
        window.opened = [];
        document.querySelectorAll('.app-group-item').forEach((tile) => tile.addEventListener('click', () => window.opened.push(tile.title)));
        document.querySelector('input').addEventListener('input', (event) => {
          document.querySelector('.ant-select-dropdown').style.display = event.target.value ? 'block' : 'none';
        });
        document.querySelector('#travel-option').addEventListener('click', () => {
          window.opened.push('search:差旅费用报账单');
          window.open('about:blank#travel-expense');
        });
      </script>`;
    navAutomation.page = navPage;

    await navFrame.setContent(homepage(['我的单据']));
    const opened = await (navAutomation as any).openTravelExpenseApp();
    assert.deepEqual(await navFrame.evaluate(() => (window as any).opened), ['search:差旅费用报账单'], '不能点“我的单据”，应通过应用搜索打开');
    assert.match(opened.url(), /#travel-expense$/, '应切换到新打开的报账单页面');

    // 首页已固定差旅费用报账单时直接点它。
    await navFrame.setContent(homepage(['我的单据', '差旅费用报账单']));
    navAutomation.page = navPage;
    await (navAutomation as any).openTravelExpenseApp();
    assert.deepEqual(await navFrame.evaluate(() => (window as any).opened), ['差旅费用报账单']);

    // 网络慢时搜索下拉框在出现后很快被重绘收起：点击会失败，必须重试或用键盘选中，且不能误开“借款单”。
    await navFrame.setContent(`
      <ul><li class="ant-select-search"><div class="ant-select-search__field__wrap">
        <input class="ant-input ant-select-search__field" placeholder="请输入应用名称" value="">
      </div></li></ul>
      <div class="app-group-item" title="我的单据"></div>
      <div class="ant-select-dropdown" style="display:none"><ul>
        <li role="option" class="ant-select-dropdown-menu-item ant-select-dropdown-menu-item-active">差旅费用借款单</li>
        <li role="option" class="ant-select-dropdown-menu-item">差旅费用报账单</li>
      </ul></div>
      <script>
        window.opened = [];
        let shows = 0;
        const dropdown = document.querySelector('.ant-select-dropdown');
        const input = document.querySelector('input');
        const items = Array.from(dropdown.querySelectorAll('li'));
        input.addEventListener('input', () => {
          if (!input.value) { dropdown.style.display = 'none'; return; }
          shows++;
          dropdown.style.display = 'block';
          items.forEach((li, i) => li.classList.toggle('ant-select-dropdown-menu-item-active', i === 0));
          // 前两次显示后 300ms 就被重绘收起，模拟慢网络下结果反复刷新
          if (shows <= 2) setTimeout(() => { dropdown.style.display = 'none'; }, 300);
        });
        items.forEach((li) => li.addEventListener('click', () => window.opened.push('click:' + li.textContent)));
        input.addEventListener('keydown', (event) => {
          const index = items.findIndex((li) => li.classList.contains('ant-select-dropdown-menu-item-active'));
          if (event.key === 'ArrowDown') {
            items.forEach((li, i) => li.classList.toggle('ant-select-dropdown-menu-item-active', i === Math.min(index + 1, items.length - 1)));
          }
          if (event.key === 'Enter') window.opened.push('enter:' + items[index].textContent);
        });
      </script>`);
    navAutomation.page = navPage;
    await (navAutomation as any).openTravelExpenseApp();
    const flakyOpened: string[] = await navFrame.evaluate(() => (window as any).opened);
    assert.ok(flakyOpened.length >= 1, '下拉框被收起后应重试并最终打开应用');
    assert.ok(flakyOpened.every((item) => item.endsWith('差旅费用报账单')), '只能打开差旅费用报账单，不能误开借款单：' + flakyOpened.join(','));

    // 既无图标也无搜索时，报出现有常用应用，提示如何处理。
    await navFrame.setContent('<div class="app-group-item" title="我的单据"></div>');
    await assert.rejects((navAutomation as any).openTravelExpenseApp(), /现有：我的单据/);
    await navContext.close();
  }

  // trace 写入本次诊断目录，可用 show-trace 回放。
  {
    const traceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-trace-'));
    try {
      const traceContext = await browser.newContext();
      const traceAutomation = new ReimbursementAutomation();
      (traceAutomation as any).context = traceContext;
      (traceAutomation as any).diagnosticDir = traceRoot;
      assert.equal(await (traceAutomation as any).startTracing(), true);
      const tracePage = await traceContext.newPage();
      await tracePage.setContent('<button>保存</button>');
      await tracePage.getByRole('button', { name: '保存' }).click();
      await (traceAutomation as any).stopTracing();
      assert.ok(fs.statSync(path.join(traceRoot, 'trace.zip')).size > 0, 'trace.zip 应写入本次诊断目录');
      await traceContext.close();
    } finally {
      fs.rmSync(traceRoot, { recursive: true, force: true });
    }
  }

  console.log('BIP invoice areas, draft-save boundary and scan attachments: PASS');
} finally {
  await browser.close();
}
