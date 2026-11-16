 import * as fs from 'fs';
 import * as path from 'path';
 
 export function sanitize(name: string): string {
   return name.replace(/[<>:"\/\\|?*]/g, '');
 }
 
export function invoiceTypeFromText(text: string): string {
   // 退票、改签及其手续费属于“其他费用”，即使文本里同时出现飞机/高铁关键词也不能进交通费用。
   if (/退票|改签|退改|手续费|保险|保费|refund|change|insurance/i.test(text)) return '其他发票';
   if (/飞机|航空|机票|行程|flight|air/i.test(text)) return '机票';
   if (/高铁|动车|火车|rail|train|high.?speed/i.test(text)) return '高铁票';
   if (/住宿|酒店|宾馆|旅馆|hotel|accommodation/i.test(text)) return '住宿发票';
   return '其他发票';
 }
 
 export function docTypeFromText(text: string): string {
   if (/出差审批|审批单|出差申请|travel approval|approval/i.test(text)) return '出差审批单';
   if (/补助|补贴|subsidy|allowance/i.test(text)) return '出差补助单';
   if (/税额|税务|tax|计算表/i.test(text)) return '税额计算表';
   return '其他凭证';
 }
 
 export function genInvoiceFilename(
   name: string, date: string, amount: number, type: string, ext: string
 ): string {
   let ds = date.replace(/[/年]/g, '-').replace(/[月日]/g, '');
   if (ds.length === 8) ds = `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`;
   return `${sanitize(name)}—${ds}—${amount.toFixed(2)}—${sanitize(type)}${ext}`;
 }
 
 export function genDocFilename(
   name: string, date: string, docType: string, ext: string
 ): string {
   let ds = date.replace(/[/年]/g, '-').replace(/[月日]/g, '');
   if (ds.length === 8) ds = `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`;
   return `${sanitize(name)}—${ds}—${sanitize(docType)}${ext}`;
 }
 
 export interface ClassItem {
   filename: string;
   filepath: string;
   category: string;
   subcategory: string;
   ext: string;
   name?: string;
   date?: string;
   amount?: number;
 }
 
 export interface ClassifyResult {
   invoices: Record<string, any[]>;
   documents: Record<string, any[]>;
 }
 
 export function classifyAndRename(sessionDir: string, items: ClassItem[]): ClassifyResult {
   const result: ClassifyResult = {
     invoices: { '机票': [], '高铁票': [], '住宿发票': [], '其他发票': [] },
     documents: { '出差审批单': [], '出差补助单': [], '税额计算表': [], '其他凭证': [] },
   };
 
   for (const item of items) {
     const src = item.filepath;
     if (!fs.existsSync(src)) continue;
     const ext = item.ext || path.extname(item.filename);
 
     if (item.category === 'invoice') {
       const invType = invoiceTypeFromText(item.subcategory);
       const name = item.name || '未知';
       const date = item.date || '';
       const amount = item.amount || 0;
       const targetDir = path.join(sessionDir, 'invoices', invType);
       fs.mkdirSync(targetDir, { recursive: true });
       let newName = genInvoiceFilename(name, date, amount, invType, ext);
       let dst = path.join(targetDir, newName);
       let c = 1;
      while (fs.existsSync(dst)) {
        dst = path.join(targetDir, `${path.basename(newName, ext)}_${c}${ext}`);
        c++;
      }
      fs.renameSync(src, dst);
      result.invoices[invType].push({
        original: item.filename, renamed: path.basename(dst), path: dst, source: src,
        name, date, amount, type: invType,
       });
     } else if (item.category === 'document') {
       const dt = docTypeFromText(item.subcategory);
       const name = item.name || '未知';
       const date = item.date || '';
       const targetDir = path.join(sessionDir, 'documents', dt);
       fs.mkdirSync(targetDir, { recursive: true });
       // 通知、文件处理单及解析失败的材料保留原名，便于核对附件。
       let newName = dt === '其他凭证'
         ? sanitize(path.basename(item.filename))
         : genDocFilename(name, date, dt, ext);
       let dst = path.join(targetDir, newName);
       let c = 1;
      while (fs.existsSync(dst)) {
        dst = path.join(targetDir, `${path.basename(newName, ext)}_${c}${ext}`);
        c++;
      }
      fs.renameSync(src, dst);
      result.documents[dt].push({
        original: item.filename, renamed: path.basename(dst), path: dst,
        name, date, type: dt,
       });
     }
   }
   return result;
 }

const INVOICE_DETAIL_FIELDS = ['check_in_date', 'check_out_date', 'lodging_days', 'stay_periods'];

// 按原始文件路径把识别出的发票信息合并到整理后的文件上。不能按“同类第几张”对应：
// 任一发票识别失败或类型判断不一致时，后续日期、金额、入住信息会整体错位。
export function attachInvoiceDetails(
  invoices: Record<string, any[]>,
  detailsBySource: Map<string, any>,
): void {
  for (const items of Object.values(invoices)) {
    for (const item of items) {
      const extracted = detailsBySource.get(item.source);
      delete item.source;
      if (!extracted) continue;
      if (extracted.name) item.name = extracted.name;
      if (extracted.date) item.date = extracted.date;
      if (extracted.amount) item.amount = extracted.amount;
      for (const field of INVOICE_DETAIL_FIELDS) {
        if (extracted[field] !== undefined && extracted[field] !== '') item[field] = extracted[field];
      }
    }
  }
}
