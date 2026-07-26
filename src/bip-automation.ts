 import { chromium, Browser, BrowserContext, Page } from 'playwright';
 import { config } from './config.js';
 
 export class ReimbursementAutomation {
   private browser: Browser | null = null;
   private context: BrowserContext | null = null;
   page: Page | null = null;
   private progressCb: ((msg: string, pct: number) => void) | null = null;
 
   onProgress(cb: (msg: string, pct: number) => void) { this.progressCb = cb; }
   private async progress(msg: string, pct: number) { this.progressCb?.(msg, pct); }
 
   private mainFrame() {
     return this.page!.frameLocator('#forwardFrame').frameLocator('#mainiframe');
   }
 
   async start(): Promise<Page> {
     this.browser = await chromium.launch({ headless: false });
     this.context = await this.browser.newContext({ viewport: { width: 1440, height: 900 } });
     this.page = await this.context.newPage();
     return this.page;
   }
 
   async login() {
     await this.progress('正在打开BIP登录页...', 10);
     await this.page!.goto(config.bipUrl, { waitUntil: 'networkidle' });
     await this.progress('正在输入账号密码...', 15);
     const lf = this.page!.frameLocator('#forwardFrame');
     await lf.getByRole('textbox', { name: '用户名' }).fill(config.bipUsername);
     await lf.getByRole('textbox', { name: '密码' }).fill(config.bipPassword);
     await this.progress('正在登录...', 18);
     await Promise.all([
       this.page!.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
       lf.getByRole('button', { name: '登录' }).click(),
     ]);
     await this.page!.waitForTimeout(3000);
     await this.progress('登录成功', 20);
   }
 
   async navigateToForm() {
     await this.progress('正在导航到差旅费用报账单...', 25);
     const lf = this.page!.frameLocator('#forwardFrame');
     await lf.locator('.app-icon').dblclick();
     await this.page!.waitForTimeout(3000);
     this.page = this.context!.pages().pop()!;
     await this.page.waitForLoadState('networkidle');
 
     const wf = this.page.frameLocator('#forwardFrame');
     const [listPage] = await Promise.all([
       this.page.context().waitForEvent('page', { timeout: 15000 }),
       wf.frameLocator('#mainiframe').getByText('差旅费用报账单').first().click(),
     ]);
     this.page = listPage;
     await listPage.waitForLoadState('networkidle');
     await this.progress('已进入报销单列表页', 30);
 
     const lff = listPage.frameLocator('#forwardFrame');
     await lff.frameLocator('#mainiframe').getByRole('button', { name: '新增' }).click();
     await listPage.waitForTimeout(2000);
 
     const [formPage] = await Promise.all([
       listPage.context().waitForEvent('page', { timeout: 15000 }),
       lff.frameLocator('#mainiframe').locator('text=自制').first().click(),
     ]);
     this.page = formPage;
     await formPage.waitForLoadState('networkidle');
     await this.progress('已进入差旅费用报账单表单', 35);
   }
 
   async fillBasicInfo(summary = '包洋报销差旅费用') {
     await this.progress('正在填写基本信息...', 40);
     const mf = this.mainFrame();
     try {
       const inp = mf.locator('.base-form-control-wrapper > .wui-input').first();
       await inp.waitFor({ timeout: 5000 });
       await inp.fill(summary);
     } catch {}
     await this.page!.waitForTimeout(500);
     await this.progress('基本信息填写完成', 45);
   }
 
   async fillSubsidy(subsidyData: any) {
     await this.progress('正在填写出差补助...', 50);
     const entries = subsidyData?.entries || [];
     if (!entries.length) return;
 
     const { mealRate, transportRate } = config;
     const groups: Record<number, { people: number; meal: number; transport: number }> = {};
     for (const e of entries) {
       const d = e.days || 0;
       const p = e.people || 1;
       if (!groups[d]) groups[d] = { people: 0, meal: 0, transport: 0 };
       groups[d].people += p;
       groups[d].meal += p * d * mealRate;
       groups[d].transport += p * d * transportRate;
     }
 
     const mf = this.mainFrame();
     const sortedDays = Object.keys(groups).map(Number).sort((a, b) => b - a);
     for (let idx = 0; idx < sortedDays.length; idx++) {
       const days = sortedDays[idx];
       const g = groups[days];
       await this.progress(`补助组 ${idx+1}: ${g.people}人${days}天`, 52 + idx * 3);
       if (idx > 0) await this.page!.waitForTimeout(3000);
       for (const [stype, amt] of [['交通费', g.transport], ['伙食', g.meal]] as const) {
         if (this.page!.isClosed()) return;
         try {
           const btns = mf.getByRole('button', { name: '增行' });
           const cnt = await btns.count();
           await (cnt > 3 ? btns.nth(3) : btns.last()).click();
         } catch {}
         await this.page!.waitForTimeout(1500);
       }
     }
     await this.progress('出差补助填写完成', 65);
   }
 
   async run(sessionData: any) {
     await this.start();
     try {
       await this.login();
       await this.navigateToForm();
       await this.fillBasicInfo(sessionData.summary || '包洋报销差旅费用');
       if (sessionData.subsidy) await this.fillSubsidy(sessionData.subsidy);
       await this.progress('报销单填写完成，请检查浏览器中的信息', 95);
     } catch (err: any) {
       await this.progress(`执行出错: ${err.message}`, 0);
       try { await this.page?.screenshot({ path: 'sessions/error.png' }); } catch {}
       throw err;
     }
   }
 
   async close() {
     await this.browser?.close();
   }
 }
