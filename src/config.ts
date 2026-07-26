 import dotenv from 'dotenv';
 import path from 'path';
 import { fileURLToPath } from 'url';
 
 const __dirname = path.dirname(fileURLToPath(import.meta.url));
 dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
 
 export const config = {
   mimoApiKey: process.env.MIMO_API_KEY || '',
   mimoBaseUrl: process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1',
   mimoModel: process.env.MIMO_MODEL || 'mimo2.5',
 
   bipUrl: process.env.BIP_URL || '',
   bipUsername: process.env.BIP_USERNAME || '',
   bipPassword: process.env.BIP_PASSWORD || '',
 
   bankAccount: process.env.BANK_ACCOUNT || '',
   payeeName: process.env.PAYEE_NAME || '',
   paymentBank: process.env.PAYMENT_BANK || '中国农业银行',
   orgName: process.env.ORG_NAME || '',
   budgetItem: process.env.BUDGET_ITEM || '',
   mealRate: parseInt(process.env.MEAL_RATE || '100'),
   transportRate: parseInt(process.env.TRANSPORT_RATE || '80'),
 
   port: parseInt(process.env.PORT || '8080'),
   sessionDir: path.resolve(__dirname, '..', 'sessions'),
 };
