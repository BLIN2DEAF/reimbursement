 import dotenv from 'dotenv';
 import path from 'path';
 import { fileURLToPath } from 'url';
 
 const __dirname = path.dirname(fileURLToPath(import.meta.url));
 dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
 
export const config = {
   mimoApiKey: process.env.MIMO_API_KEY || '',
   mimoBaseUrl: process.env.MIMO_BASE_URL || '',
   mimoModel: process.env.MIMO_MODEL || '',
 
   bipUrl: process.env.BIP_URL || 'https://fsc.sdhsg.com/yonbip/resources/uap/rbac/login/main/index.html',
   bipUsername: process.env.BIP_USERNAME || '',
   bipPassword: process.env.BIP_PASSWORD || '',
 
   bankAccount: process.env.BANK_ACCOUNT || '',
   paymentBank: process.env.PAYMENT_BANK || '',
   budgetItem: process.env.BUDGET_ITEM || '',
   mealRate: parseInt(process.env.MEAL_RATE || '100'),
   transportRate: parseInt(process.env.TRANSPORT_RATE || '80'),
 
   host: process.env.HOST || '127.0.0.1',
   port: parseInt(process.env.PORT || '8080'),
   sessionTtlMs: parseInt(process.env.SESSION_TTL_MS || String(8 * 60 * 60 * 1000)),
   errorBrowserTtlMs: parseInt(process.env.ERROR_BROWSER_TTL_MS || String(10 * 60 * 1000)),
   sessionDir: path.resolve(__dirname, '..', 'sessions'),
   // 同时识别的文件数。模型服务有并发限制时可调小。
   visionConcurrency: Math.min(8, Math.max(1, parseInt(process.env.VISION_CONCURRENCY || '3') || 3)),
   // 同一文件重复上传时复用识别结果；设为 0 关闭。
   visionCache: process.env.VISION_CACHE !== '0',
 };

export function requireAutomationConfig(): void {
  const missing: string[] = [];
  if (!config.bipUrl) missing.push('BIP_URL');
  if (!config.bipUsername) missing.push('BIP_USERNAME');
  if (!config.bipPassword) missing.push('BIP_PASSWORD');
  if (missing.length) {
    throw new Error(`缺少自动填单配置: ${missing.join(', ')}`);
  }
}

export function requireVisionConfig(): void {
  const missing: string[] = [];
  if (!config.mimoApiKey) missing.push('MIMO_API_KEY');
  if (!config.mimoBaseUrl) missing.push('MIMO_BASE_URL');
  if (!config.mimoModel) missing.push('MIMO_MODEL');
  if (missing.length) throw new Error(`缺少图片识别配置: ${missing.join(', ')}`);
}
