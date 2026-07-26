 // ============================================================
 // 鎶ラ攢鑷姩鍖栫郴缁?鈥?鍓嶇閫昏緫
 // ============================================================
 
 let sessionId = null;
 let ws = null;
 let currentResult = null;
 let uploadedFiles = [];
 const API_BASE = window.location.origin;
 const WS_BASE = window.location.origin.replace(/^http/, 'ws');
 
 // DOM
 const $ = (s) => document.querySelector(s);
 const $$ = (s) => document.querySelectorAll(s);
 const dropzone = $('#dropzone');
 const fileInput = $('#file-input');
 const fileList = $('#file-list');
 const uploadBtn = $('#upload-btn');
 const progressSection = $('#progress-section');
 const progressFill = $('#progress-fill');
 const progressMsg = $('#progress-msg');
 const confirmSection = $('#confirm-section');
 const steps = $$('.step-dot');
 
 // ============================================================
 // 鍒濆鍖? // ============================================================
 
 async function init() {
   const res = await fetch(`${API_BASE}/api/session`, { method: 'POST' });
   const data = await res.json();
   sessionId = data.session_id;
   connectWS();
 }
 
 function connectWS() {
   ws = new WebSocket(`${WS_BASE}/ws/${sessionId}`);
   ws.onmessage = (evt) => {
     const msg = JSON.parse(evt.data);
     handleWSMessage(msg);
   };
   ws.onclose = () => {
     setTimeout(connectWS, 2000);
   };
 }
 
 function handleWSMessage(msg) {
   switch (msg.type) {
     case 'progress':
       updateProgress(msg.percent, msg.message);
       break;
     case 'result':
       currentResult = msg.data;
       showConfirmation(msg.data);
       break;
     case 'ready':
       uploadBtn.disabled = false;
       break;
     case 'error':
       updateProgress(-1, msg.message, true);
       break;
     case 'ack':
       break;
   }
 }
 
 // ============================================================
 // 杩涘害
 // ============================================================
 
 function updateProgress(pct, msg, isError = false) {
   progressSection.classList.add('show');
   confirmSection.classList.remove('show');
   if (pct < 0) {
     progressFill.style.width = '100%';
     progressFill.classList.add('error');
     steps.forEach(s => s.classList.add('error'));
   } else {
     progressFill.style.width = `${pct}%`;
     progressFill.classList.remove('done', 'error');
     if (pct >= 100) progressFill.classList.add('done');
   }
   progressMsg.textContent = msg;
   // 鏇存柊姝ラ鎸囩ず
   const idx = pct < 25 ? 0 : pct < 50 ? 1 : pct < 75 ? 2 : 3;
   steps.forEach((s, i) => {
     s.classList.toggle('active', i === idx);
     s.classList.toggle('done', i < idx);
   });
 }
 
 // ============================================================
 // 鎷栨嫿涓婁紶
 // ============================================================
 
 dropzone.addEventListener('dragover', (e) => {
   e.preventDefault();
   dropzone.classList.add('drag-over');
 });
 dropzone.addEventListener('dragleave', () => {
   dropzone.classList.remove('drag-over');
 });
 dropzone.addEventListener('drop', (e) => {
   e.preventDefault();
   dropzone.classList.remove('drag-over');
   addFiles(e.dataTransfer.files);
 });
 dropzone.addEventListener('click', () => fileInput.click());
 fileInput.addEventListener('change', () => addFiles(fileInput.files));
 
 function addFiles(fileListObj) {
   for (const f of fileListObj) {
     if (!uploadedFiles.find(uf => uf.name === f.name && uf.size === f.size)) {
       uploadedFiles.push(f);
     }
   }
   renderFileList();
 }
 
 function removeFile(index) {
   uploadedFiles.splice(index, 1);
   renderFileList();
 }
 
 function renderFileList() {
   if (uploadedFiles.length === 0) {
     fileList.innerHTML = '';
     return;
   }
   fileList.innerHTML = uploadedFiles.map((f, i) =>
     `<span class="file-tag">${f.name} <span class="remove" onclick="removeFile(${i})">&times;</span></span>`
   ).join('');
 }
 
 uploadBtn.addEventListener('click', async () => {
   if (uploadedFiles.length === 0) return;
   uploadBtn.disabled = true;
   const formData = new FormData();
   for (const f of uploadedFiles) {
     formData.append('files', f);
   }
   try {
     const res = await fetch(`${API_BASE}/api/upload/${sessionId}`, {
       method: 'POST', body: formData,
     });
     const data = await res.json();
     if (data.message) {
       updateProgress(5, data.message);
     }
   } catch (err) {
     updateProgress(-1, `涓婁紶澶辫触: ${err.message}`, true);
     uploadBtn.disabled = false;
   }
 });
 
 // ============================================================
 // 纭鐣岄潰
 // ============================================================
 
 function showConfirmation(data) {
   progressSection.classList.remove('show');
   confirmSection.classList.add('show');
   steps.forEach(s => { s.classList.add('done'); s.classList.remove('active'); });
 
   // 鎶ラ攢浜?/ 鎽樿
   const travelers = data.travelers || [];
   const summary = data.summary || '鍖呮磱鎶ラ攢宸梾璐圭敤';
   $('#confirm-summary').textContent = summary;
   $('#confirm-summary').dataset.value = summary;
 
   if (travelers.length > 0) {
     $('#confirm-travelers').textContent = travelers.join('銆?);
     $('#confirm-travelers').dataset.value = JSON.stringify(travelers);
   }
 
   // 鍑哄樊瀹℃壒鍗曚俊鎭?   const approval = data.approval;
   if (approval) {
     $('#confirm-destination').textContent = approval.destination || '鈥?;
     $('#confirm-dates').textContent =
       (approval.start_date || '') + ' ~ ' + (approval.end_date || '');
     $('#confirm-purpose').textContent = approval.purpose || '鈥?;
   }
 
   // 鍑哄樊琛ュ姪
   const subsidy = data.subsidy;
   if (subsidy && subsidy.entries && subsidy.entries.length > 0) {
     renderSubsidyTable(subsidy);
   } else {
     $('#subsidy-section').style.display = 'none';
   }
 
   // 鍙戠エ
   const invoices = data.invoices || {};
   const invoiceList = data.invoice_list || [];
   renderInvoices(invoices, invoiceList);
 
   // 鏂囨。
   renderDocuments(data.documents || {});
 
   // 婊氬姩鍒扮‘璁ゅ尯
   confirmSection.scrollIntoView({ behavior: 'smooth' });
 }
 
 function renderSubsidyTable(subsidy) {
   const tbody = $('#subsidy-body');
   const entries = subsidy.entries || [];
   tbody.innerHTML = entries.map(e => `
     <tr>
       <td>${e.name || '鈥?}</td>
       <td>${e.days || 0}</td>
       <td>${e.people || 1}</td>
       <td>楼${(e.meal_allowance || 0).toFixed(2)}</td>
       <td>楼${(e.transport_allowance || 0).toFixed(2)}</td>
     </tr>
   `).join('');
   $('#subsidy-total-meal').textContent = `楼${(subsidy.total_meal || 0).toFixed(2)}`;
   $('#subsidy-total-transport').textContent = `楼${(subsidy.total_transport || 0).toFixed(2)}`;
   $('#subsidy-total-amount').textContent = `楼${(subsidy.total_amount || 0).toFixed(2)}`;
 }
 
 function renderInvoices(invoices, invoiceList) {
   const container = $('#invoices-container');
   const categories = [
     { key: '鏈虹エ', label: '鏈虹エ', cls: 'flight', icon: '鉁堬笍' },
     { key: '楂橀搧绁?, label: '楂橀搧绁?, cls: 'train', icon: '馃殑' },
     { key: '浣忓鍙戠エ', label: '浣忓鍙戠エ', cls: 'hotel', icon: '馃彣' },
     { key: '鍏朵粬鍙戠エ', label: '鍏朵粬鍙戠エ', cls: 'other', icon: '馃搫' },
   ];
 
   let hasInvoices = false;
   let html = '';
   for (const cat of categories) {
     const items = invoices[cat.key] || [];
     if (items.length === 0 && invoiceList.filter(i => i.type === cat.key).length === 0) continue;
     hasInvoices = true;
     const allItems = items.length > 0 ? items : invoiceList.filter(i => i.type === cat.key);
     html += `
       <div class="invoice-category">
         <h4>${cat.icon} ${cat.label} <span style="color:var(--gray-400);font-weight:400;">(${allItems.length})</span></h4>
         ${allItems.map(inv => `
           <div class="invoice-card">
             <span class="name">${inv.name || '鈥?}</span>
             <span class="date">${inv.date || '鈥?}</span>
             <span class="amount">楼${typeof inv.amount === 'number' ? inv.amount.toFixed(2) : (parseFloat(inv.amount) || 0).toFixed(2)}</span>
             <span class="type-badge ${cat.cls}">${cat.label}</span>
           </div>
         `).join('')}
       </div>
     `;
   }
   container.innerHTML = hasInvoices ? html : '<div class="empty-state"><p>鏃犲彂绁ㄦ枃浠?/p></div>';
 }
 
 function renderDocuments(documents) {
   const container = $('#documents-container');
   const types = [
     { key: '鍑哄樊瀹℃壒鍗?, icon: 'approval', label: '馃搵' },
     { key: '鍑哄樊琛ュ姪鍗?, icon: 'subsidy', label: '馃挵' },
     { key: '绋庨璁＄畻琛?, icon: 'tax', label: '馃Ь' },
   ];
   let hasDocs = false;
   let html = '';
   for (const t of types) {
     const items = documents[t.key] || [];
     if (items.length === 0) continue;
     hasDocs = true;
     html += items.map(doc => `
       <div class="doc-item">
         <div class="icon ${t.icon}">${t.label}</div>
         <div>
           <div style="font-weight:500;">${doc.renamed || doc.original || t.key}</div>
           <div style="font-size:12px;color:var(--gray-400);">${t.key}</div>
         </div>
       </div>
     `).join('');
   }
   container.innerHTML = hasDocs ? html : '<div class="empty-state"><p>鏃犳姤閿€鍑瘉鏂囦欢</p></div>';
 }
 
 // ============================================================
 // 纭 / 淇敼
 // ============================================================
 
 function editField(fieldId) {
   const el = document.getElementById(fieldId);
   if (!el) return;
   const currentVal = el.dataset.value || el.textContent;
   const newVal = prompt('淇敼鍊?', currentVal);
   if (newVal && newVal !== currentVal) {
     el.textContent = newVal;
     el.dataset.value = newVal;
   }
 }
 
 async function confirmData() {
   if (!currentResult) return;
   // 鍙戦€佹洿鏂板悗鐨勬暟鎹粰鍚庣
   const summary = $('#confirm-summary').dataset.value || $('#confirm-summary').textContent;
   const updated = {
     ...currentResult,
     summary: summary,
   };
   ws.send(JSON.stringify({ action: 'update_data', data: updated }));
   ws.send(JSON.stringify({ action: 'confirm' }));
   confirmSection.classList.remove('show');
   progressSection.classList.add('show');
   updateProgress(85, '鐢ㄦ埛宸茬‘璁わ紝寮€濮嬭嚜鍔ㄥ～鍗?..');
   document.querySelector('.btn-success').disabled = true;
 }
 
 // ============================================================
 // 鍚姩
 // ============================================================
 
 init();

