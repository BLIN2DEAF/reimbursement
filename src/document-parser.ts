 import * as fs from 'fs';
 import OpenAI from 'openai';
 import { config } from './config.js';
 
 let _client: OpenAI | null = null;
 function getClient(): OpenAI {
   if (!_client) {
     _client = new OpenAI({ apiKey: config.mimoApiKey, baseURL: config.mimoBaseUrl });
   }
   return _client;
 }
 
 // ---- file -> base64 ----
 function fileToBase64(fp: string): { b64: string; mime: string } {
   const ext = fp.toLowerCase().split('.').pop();
   const imageMimes: Record<string, string> = {
     png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
   };
   if (ext && imageMimes[ext]) {
     const data = fs.readFileSync(fp);
     return { b64: data.toString('base64'), mime: imageMimes[ext] };
   }
   // PDF: return as-is; the vision model will need image conversion
   if (ext === 'pdf') {
     const data = fs.readFileSync(fp);
     return { b64: data.toString('base64'), mime: 'application/pdf' };
   }
   throw new Error(`Unsupported file: ${fp}`);
 }
 
 // ---- vision call ----
 async function callVision(prompt: string, b64: string, mime: string): Promise<string> {
   const client = getClient();
   const resp = await client.chat.completions.create({
     model: config.mimoModel,
     messages: [{
       role: 'user',
       content: [
         { type: 'text', text: prompt },
         { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
       ],
     }],
     max_tokens: 2048,
   });
   return resp.choices[0]?.message?.content || '';
 }
 
 /** 安全提取 JSON 从模型返回文本 */
 function extractJson(text: string): any {
   const start = text.indexOf('{');
   const end = text.lastIndexOf('}');
   if (start === -1 || end === -1) return null;
   try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
 }
 
 // ---- classify ----
 const CLASSIFY_PROMPT = `你是一个文档分类助手。请判断这张图片/文档的类型。
 1) 发票（机票/高铁票/住宿发票/其他发票）
 2) 出差审批单
 3) 出差补助单
 4) 税额计算表
 5) 其他
 返回JSON: {"category":"invoice|document","type":"具体类型名称"}`;
 
 export async function classifyFile(fp: string): Promise<{ category: string; type: string }> {
   const { b64, mime } = fileToBase64(fp);
   const text = await callVision(CLASSIFY_PROMPT, b64, mime);
   const j = extractJson(text);
   return j ? { category: j.category || '', type: j.type || '' } : { category: 'unknown', type: '未知' };
 }
 
 // ---- invoice ----
 const INVOICE_PROMPT = `仔细分析这张发票，提取以下信息。返回JSON：
 {"name":"购买方/乘客姓名","date":"YYYY-MM-DD","amount":含税总金额,"invoice_number":"发票号","vendor":"销售方","type":"发票类型"}
 信息不全则填null或空。`;
 
 export async function extractInvoice(fp: string): Promise<any> {
   const { b64, mime } = fileToBase64(fp);
   const text = await callVision(INVOICE_PROMPT, b64, mime);
   const j = extractJson(text);
   return j || { name: '', date: '', amount: 0, type: '其他发票' };
 }
 
 // ---- approval ----
 const APPROVAL_PROMPT = `仔细分析这张出差审批单，提取以下信息。返回JSON：
 {"travelers":["姓名1","姓名2"],"start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","destination":"目的地","purpose":"事由","department":"部门","approver":"审批人"}
 信息不全则填null或空。`;
 
 export async function extractApproval(fp: string): Promise<any> {
   const { b64, mime } = fileToBase64(fp);
   const text = await callVision(APPROVAL_PROMPT, b64, mime);
   const j = extractJson(text);
   return j || { travelers: [], start_date: '', end_date: '', destination: '', purpose: '' };
 }
 
 // ---- subsidy ----
 const SUBSIDY_PROMPT = `仔细分析这张出差补助单，提取以下信息。返回JSON：
 {"entries":[{"name":"姓名","days":天数,"people":人数,"meal_allowance":伙食补助,"transport_allowance":交通补助}],"total_meal":伙食合计,"total_transport":交通合计,"total_amount":总金额}
 直接读取单据上的数字。信息不全填0或空。`;
 
 export async function extractSubsidy(fp: string): Promise<any> {
   const { b64, mime } = fileToBase64(fp);
   const text = await callVision(SUBSIDY_PROMPT, b64, mime);
   const j = extractJson(text);
   return j || { entries: [], total_meal: 0, total_transport: 0, total_amount: 0 };
 }
 
 // ---- tax ----
 const TAX_PROMPT = `仔细分析这张税额计算表，提取以下信息。返回JSON：
 {"total_amount":"总金额","tax_rate":"税率","tax_amount":"税额","notes":"备注"}
 信息不全则填null或空。`;
 
 export async function extractTax(fp: string): Promise<any> {
   const { b64, mime } = fileToBase64(fp);
   const text = await callVision(TAX_PROMPT, b64, mime);
   const j = extractJson(text);
   return j || { total_amount: '', tax_rate: '', tax_amount: '', notes: '' };
 }
 
 // ---- batch processing ----
 export async function processAllFiles(
   filepaths: string[],
   onProgress?: (msg: string, pct: number) => void
 ) {
   const classifications: any[] = [];
   const invoices: any[] = [];
   const approvals: any[] = [];
   const subsidies: any[] = [];
   const taxSheets: any[] = [];
 
   const total = filepaths.length;
   for (let i = 0; i < total; i++) {
     const fp = filepaths[i];
     onProgress?.(`正在分类文件 (${i+1}/${total})`, Math.round(i / total * 50));
     const cls = await classifyFile(fp);
     classifications.push({ filepath: fp, class: cls });
 
     if (cls.category === 'invoice') {
       onProgress?.(`正在提取发票信息 (${i+1}/${total})`, 50 + Math.round(i / total * 25));
       const info = await extractInvoice(fp);
       invoices.push({ ...info, filepath: fp });
     } else if (cls.type === '出差审批单') {
       onProgress?.('正在解析出差审批单', 60);
       approvals.push({ ...(await extractApproval(fp)), filepath: fp });
     } else if (cls.type === '出差补助单') {
       onProgress?.('正在解析出差补助单', 65);
       subsidies.push({ ...(await extractSubsidy(fp)), filepath: fp });
     } else if (cls.type === '税额计算表') {
       onProgress?.('正在解析税额计算表', 70);
       taxSheets.push({ ...(await extractTax(fp)), filepath: fp });
     }
   }
   return { classifications, invoices, approvals, subsidies, taxSheets };
 }
