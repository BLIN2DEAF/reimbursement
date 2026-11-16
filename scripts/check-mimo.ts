import dotenv from 'dotenv';
import OpenAI from 'openai';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { normalizeSubsidy, SUBSIDY_EXTRACTION_PROMPT } from '../src/subsidy.js';

dotenv.config();

const apiKey = process.env.MIMO_API_KEY || '';
const baseURL = process.env.MIMO_BASE_URL || '';
const model = process.env.MIMO_MODEL || '';

const missing = [
  ['MIMO_API_KEY', apiKey],
  ['MIMO_BASE_URL', baseURL],
  ['MIMO_MODEL', model],
].filter(([, value]) => !value).map(([key]) => key);
if (missing.length) {
  console.error(`图片识别配置不完整: ${missing.join(', ')}`);
  process.exit(1);
}

const client = new OpenAI({ apiKey, baseURL });
console.log(`Base URL: ${baseURL}`);
console.log(`Configured model: ${model}`);

try {
  const models = await client.models.list();
  const ids = models.data.map((item) => item.id).sort();
  console.log(`Available models (${ids.length}): ${ids.join(', ')}`);
  if (!ids.includes(model)) console.warn(`警告：模型列表中没有 ${model}`);
} catch (error: any) {
  console.warn(`无法读取模型列表：HTTP ${error?.status || '?'} ${error?.error?.message || error?.message || error}`);
}

async function createSyntheticSubsidyPng(): Promise<string> {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
      body{font-family:"Microsoft YaHei",sans-serif;background:#fff;color:#111;padding:46px}
      h1{text-align:center;font-size:30px;margin:0 0 28px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:20px;margin-bottom:24px}
      table{width:100%;border-collapse:collapse;font-size:19px}th,td{border:2px solid #222;padding:14px;text-align:center}th{background:#eee}
      .total{font-weight:700;font-size:22px}.note{margin-top:20px;font-size:16px;color:#444}
    </style><body><h1>出差补助单（合成测试数据）</h1><div class="meta"><div>出差人员：测试甲、测试乙</div><div>每人实际应领金额如下</div></div>
      <table><thead><tr><th>姓名</th><th>个人天数</th><th>人数</th><th>伙食补助应领</th><th>市内交通补助应领</th><th>个人合计</th></tr></thead><tbody>
      <tr><td>测试甲</td><td>4</td><td>1</td><td>320 元</td><td>280 元</td><td>600 元</td></tr>
      <tr><td>测试乙</td><td>2</td><td>1</td><td>100 元</td><td>0 元（已扣减）</td><td>100 元</td></tr>
      <tr class="total"><td>合计</td><td>—</td><td>2</td><td>420 元</td><td>280 元</td><td>700 元</td></tr></tbody></table><div class="note">本图片为接口健康检查生成，不包含任何真实人员或财务信息。</div></body></html>`);
    const screenshot = await page.screenshot({ type: 'png', fullPage: true });
    return screenshot.toString('base64');
  } finally {
    await browser.close();
  }
}

try {
  const syntheticPng = await createSyntheticSubsidyPng();
  const response = await client.chat.completions.create({
    model,
    max_completion_tokens: 4096,
    extra_body: { thinking: { type: 'disabled' } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${syntheticPng}` } },
        { type: 'text', text: SUBSIDY_EXTRACTION_PROMPT + '\n/no_think' },
      ],
    }],
  });
  const content = response.choices[0]?.message?.content || '';
  const jsonText = content.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const match = jsonText.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`模型返回空内容或非 JSON：${content || '(empty response)'}`);
  const parsed = JSON.parse(match[0]);
  const expected = {
    entries: [
      { name: '测试甲', days: 4, people: 1, meal_allowance: 320, transport_allowance: 280 },
      { name: '测试乙', days: 2, people: 1, meal_allowance: 100, transport_allowance: 0 },
    ], total_meal: 420, total_transport: 280, total_amount: 700,
  };
  const actual = normalizeSubsidy(parsed);
  console.log(`Image extraction result: ${JSON.stringify(actual)}`);
  assert.deepEqual(actual, expected, '必须逐人识别两条明细，保留零金额且排除合计行');
  console.log('Per-person image input check: PASS');
} catch (error: any) {
  console.error(JSON.stringify({
    status: error?.status,
    code: error?.code || error?.error?.code,
    type: error?.type || error?.error?.type,
    message: error?.error?.message || error?.message || String(error),
  }, null, 2));
  process.exit(1);
}
