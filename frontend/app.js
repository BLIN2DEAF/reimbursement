// ============================================================
// 报销自动化系统 - 前端逻辑 (Dashboard layout)
// 增强: 数字滚动 / 全屏拖入 / toast / 逐项入场 / 文件图标 / 粘贴
// ============================================================

let sessionId = null;
let ws = null;
let currentResult = null;
let uploadedFiles = [];
let automationStarted = false;
let confirmInFlight = false;
const API_BASE = window.location.origin;
const WS_BASE = window.location.origin.replace(/^http/, 'ws');

function esc(s) {
  return String(s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function fmtCNY(value) {
  var n = Number(value) || 0;
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2 }).format(n);
}

function $(s) { return document.querySelector(s); }
function $$(s) { return document.querySelectorAll(s); }

const dropzone     = $('#dropzone');
const fileInput    = $('#file-input');
const uploadBtn    = $('#upload-btn');
const uploadPanel  = $('#upload-panel');
const progressPanel = $('#progress-panel');
const progressFill  = $('#progress-fill');
const progressMsg   = $('#progress-msg');
const phaseTitle    = $('#phase-title');
const phaseSub      = $('.phase-sub');
const phaseBadge    = $('#phase-badge');
const sidebarSteps  = $$('.sidebar-step');
const sidebarFileList = $('#sidebar-file-list');
const fileCountEl   = $('#file-count');
const statusDot     = $('#status-dot');
const wsStatusText  = $('#ws-status-text');
const mainContent   = $('.main-content');
const dragOverlay   = $('#drag-overlay');
const toastContainer = $('#toast-container');
const previewOverlay = $('#preview-overlay');
const previewTitle   = $('#preview-title');
const previewBody    = $('#preview-body');
const previewCount   = $('#preview-count');
const previewPrevBtn = $('#preview-prev');
const previewNextBtn = $('#preview-next');
const previewNavPrev = $('#preview-nav-prev');
const previewNavNext = $('#preview-nav-next');
let previewFiles = [];
let previewIndex = 0;


// ============================================================
// Toast 通知
// ============================================================

function showToast(message, type) {
  type = type || 'info';
  var icons = { success: '✓', info: 'ℹ', error: '✗', warning: '⚠' };
  var toast = document.createElement('div');
  toast.className = 'toast ' + type;
  var icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = icons[type] || '';
  var text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  toast.appendChild(icon);
  toast.appendChild(text);
  toastContainer.appendChild(toast);
  setTimeout(function() {
    toast.classList.add('removing');
    setTimeout(function() { if (toast.parentNode) toast.remove(); }, 250);
  }, 3000);
}

// ============================================================
// 数字滚动动效
// ============================================================

function animateNumber(el, target, duration) {
  duration = duration || 800;
  var start = 0;
  var startTime = null;
  target = parseFloat(target) || 0;
  if (target === 0) { el.textContent = fmtCNY(0); return; }
  var step = function(ts) {
    if (!startTime) startTime = ts;
    var progress = Math.min((ts - startTime) / duration, 1);
    var eased = 1 - Math.pow(1 - progress, 3);
    var current = start + (target - start) * eased;
    el.textContent = fmtCNY(current);
    if (progress < 1) requestAnimationFrame(step);
    else el.textContent = fmtCNY(target);
  }
  requestAnimationFrame(step);
}

// ============================================================
// 初始化
// ============================================================

async function init() {
  try {
    var res = await fetch(API_BASE + '/api/session', { method: 'POST' });
    if (!res.ok) throw new Error('创建会话失败 (' + res.status + ')');
    var data = await res.json();
    sessionId = data.session_id;
    connectWS();
    setupGlobalDrag();
    setupPaste();
  } catch (err) {
    uploadBtn.disabled = true;
    showToast(err.message || '服务连接失败', 'error');
  }
}

var wsRetry = 0;
var wsTimer = null;
function connectWS() {
  if (wsTimer) clearTimeout(wsTimer);
  wsStatusText.textContent = 'connecting...';
  statusDot.className = 'status-dot';
  ws = new WebSocket(WS_BASE + '/ws/' + sessionId);
  ws.onmessage = function(evt) {
    try { var msg = JSON.parse(evt.data); handleWSMessage(msg); }
    catch(e) { console.error('WS parse error:', e); }
  };
  ws.onopen = function() {
    wsRetry = 0;
    wsStatusText.textContent = '已连接';
    statusDot.className = 'status-dot online';
  };
  ws.onclose = function() {
    wsStatusText.textContent = '已断开';
    statusDot.className = 'status-dot offline';
    wsRetry++;
    var delay = Math.min(2000 * wsRetry, 10000);
    wsTimer = setTimeout(connectWS, delay);
  };
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'progress': updateProgress(msg.percent, msg.message); break;
    case 'result':   currentResult = msg.data; showConfirmation(msg.data); break;
    case 'ready':
      uploadBtn.disabled = !msg.canUpload;
      if (msg.phase === 'review') {
        confirmInFlight = false;
        automationStarted = false;
        var reviewButton = document.querySelector('#confirm-section .btn-success');
        if (reviewButton) reviewButton.disabled = false;
        setConfirmationReadOnly(false);
      } else if (msg.phase === 'automating' || msg.phase === 'complete') {
        automationStarted = true;
        confirmInFlight = false;
        if ($('#confirm-section')) {
          updateAutomationStatus(
            msg.phase === 'complete' ? 100 : 5,
            msg.phase === 'complete' ? '报销单已填写，请对照下方信息进行人工复核' : '正在恢复自动填单进度...',
            msg.phase === 'complete' ? 'complete' : 'running'
          );
        }
      }
      if (msg.canUpload) showToast('已连接，可以开始上传了', 'success');
      break;
    case 'error':
      updateProgress(-1, msg.message, true);
      if (!automationStarted) {
        uploadBtn.disabled = false;
        uploadPanel.style.display = '';
        progressPanel.classList.remove('show');
      }
      showToast(msg.message || '处理失败', 'error');
      break;
    case 'confirm_rejected':
      // 服务端拒绝确认时留在核对页，允许修改后重新确认。
      confirmInFlight = false;
      var rejectedButton = document.querySelector('#confirm-section .btn-success');
      if (rejectedButton) rejectedButton.disabled = false;
      if (!automationStarted) setConfirmationReadOnly(false);
      showToast(msg.message || '确认信息有误，请修改后重试', 'error');
      break;
    case 'complete': showCompletion(msg); break;
    case 'accepted':
      confirmInFlight = false;
      automationStarted = true;
      var cs = $('#confirm-section');
      updateProgress(5, '已确认填单信息，正在准备打开用友 BIP...');
      var automationCard = $('#automation-status');
      if (cs && automationCard) automationCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      showToast('已确认，正在填写用友 BIP 报销单', 'success');
      break;
    case 'ack':      break;
  }
}

// ============================================================
// 进度
// ============================================================

function updateProgress(pct, msg, isError) {
  if (automationStarted && $('#confirm-section')) {
    updateAutomationStatus(pct, msg, pct < 0 || isError ? 'error' : 'running');
    return;
  }

  uploadPanel.style.display = 'none'; progressPanel.classList.add('show'); mainContent.classList.add('scene-in'); setTimeout(function(){ mainContent.classList.remove('scene-in'); }, 500);
  var activeStep = automationStarted ? 3 : 1;
  phaseTitle.textContent = automationStarted ? '自动填单' : '智能识别';
  phaseBadge.textContent = automationStarted ? 'STEP 4/4' : 'STEP 2/4';
  setActiveStep(activeStep);

  var track = document.querySelector('#progress-track');
  if (track) track.setAttribute('aria-valuenow', pct < 0 ? 0 : Math.round(pct));

  if (pct < 0) {
    progressFill.style.width = '100%';
    progressFill.classList.add('error');
    markStepError(activeStep);
  } else {
    progressFill.style.width = pct + '%';
    progressFill.classList.remove('done', 'error');
    if (pct >= 100) {
      progressFill.classList.add('done');
      showToast('处理完成，数据提取完成', 'success');
    }
  }
  progressMsg.textContent = '';
  var dot = document.createElement('span');
  dot.className = 'pulse-dot';
  dot.setAttribute('aria-hidden', 'true');
  progressMsg.appendChild(dot);
  progressMsg.appendChild(document.createTextNode(msg || '正在分析文件...'));
}

function setConfirmationReadOnly(locked) {
  var section = $('#confirm-section');
  if (!section) return;
  section.classList.toggle('is-locked', locked);
  var editableControls = section.querySelectorAll('.value.editable, .table-edit');
  editableControls.forEach(function(control) {
    control.disabled = locked;
    control.setAttribute('aria-disabled', locked ? 'true' : 'false');
  });
  var confirmButton = section.querySelector('.btn-success');
  if (confirmButton) confirmButton.hidden = locked;
  var lockNote = $('#confirmation-lock');
  if (lockNote) lockNote.hidden = !locked;
}

function updateAutomationStatus(pct, msg, state, meta) {
  var card = $('#automation-status');
  if (!card) return false;

  progressPanel.classList.remove('show');
  uploadPanel.style.display = 'none';
  card.hidden = false;
  card.dataset.state = state;
  setConfirmationReadOnly(true);

  var track = $('#automation-progress-track');
  var previous = track ? Number(track.getAttribute('aria-valuenow')) || 0 : 0;
  var incoming = pct >= 0 ? Math.max(0, Math.min(100, Number(pct) || 0)) : previous;
  var normalized = state === 'complete' ? 100 : Math.max(previous, incoming);
  var fill = $('#automation-progress-fill');
  var title = $('#automation-status-title');
  var message = $('#automation-status-message');
  var badge = $('#automation-status-badge');
  var detail = $('#automation-status-meta');

  if (track) track.setAttribute('aria-valuenow', String(Math.round(normalized)));
  if (fill) fill.style.width = normalized + '%';
  if (message) message.textContent = msg || '正在填写报销单...';

  if (state === 'complete') {
    if (title) title.textContent = '填单完成，等待人工复核';
    if (badge) badge.textContent = '待复核';
    if (detail) detail.textContent = meta || '系统不会自动提交，请在 BIP 中对照下方识别结果复核。';
    phaseTitle.textContent = '等待人工复核';
    phaseBadge.textContent = '待复核';
    if (phaseSub) phaseSub.textContent = '解析结果保留在下方，请核对 BIP 中的报销信息后再提交';
    setActiveStep(4);
  } else if (state === 'error') {
    if (title) title.textContent = '自动填单未完成';
    if (badge) badge.textContent = '需处理';
    if (detail) detail.textContent = meta || '请根据错误提示处理；下方识别结果仍完整保留，可继续核对。';
    phaseTitle.textContent = '自动填单异常';
    phaseBadge.textContent = '需处理';
    if (phaseSub) phaseSub.textContent = '解析结果仍保留在下方，可用于排查和人工核对';
    setActiveStep(3);
    markStepError(3);
  } else {
    if (title) title.textContent = '正在自动填单';
    if (badge) badge.textContent = Math.round(normalized) + '%';
    if (detail) detail.textContent = meta || '解析结果会保留在下方，填单过程中也可随时核对。';
    phaseTitle.textContent = '自动填单';
    phaseBadge.textContent = 'STEP 4/4';
    if (phaseSub) phaseSub.textContent = '正在写入 BIP；下方解析结果将持续保留，供后续核对';
    setActiveStep(3);
  }

  var milestones = card.querySelectorAll('[data-automation-step]');
  milestones.forEach(function(item, index) {
    item.classList.remove('done', 'active', 'error');
    if (index === 0) item.classList.add('done');
    if (state === 'running' && index === 1) item.classList.add('active');
    if (state === 'complete' && index < 2) item.classList.add('done');
    if (state === 'complete' && index === 2) item.classList.add('active');
    if (state === 'error' && index === 1) item.classList.add('error');
  });
  return true;
}

function showCompletion(msg) {
  automationStarted = true;
  var report = msg.report || {};
  var inv = report.invoices || {};
  var docs = report.attachments || {};
  var reportMeta = '补助 ' + (report.subsidyRows || 0) + ' 行 · 发票 ' + (inv.uploaded || 0) + '/' + (inv.expected || 0) + ' · 附件 ' + (docs.uploaded || 0) + '/' + (docs.expected || 0) + '。系统不会自动提交。';
  if (updateAutomationStatus(100, msg.message || '报销单填写成功', 'complete', reportMeta)) {
    showToast('报销单填写成功，请人工复核', 'success');
    return;
  }

  progressPanel.classList.add('show');
  progressFill.style.width = '100%';
  progressFill.classList.remove('error');
  progressFill.classList.add('done');
  var track = document.querySelector('#progress-track');
  if (track) track.setAttribute('aria-valuenow', '100');
  phaseTitle.textContent = '报销单填写成功';
  phaseBadge.textContent = 'COMPLETE';
  setActiveStep(4);
  progressMsg.textContent = msg.message || '报销单填写成功';
  var meta = progressPanel.querySelector('.progress-meta');
  if (meta) {
    meta.textContent = reportMeta;
  }
  showToast('报销单填写成功', 'success');
}

function setActiveStep(idx) {
  sidebarSteps.forEach(function(s, i) {
    s.classList.remove('active', 'done', 'error');
    if (i === idx) s.classList.add('active');
    if (i < idx) s.classList.add('done');
  });
}

function markStepError(idx) {
  sidebarSteps[idx].classList.add('error');
}

// ============================================================
// 全屏拖入 Overlay
// ============================================================

function setupGlobalDrag() {
  var dragCounter = 0;
  document.addEventListener('dragenter', function(e) {
    e.preventDefault();
    dragCounter++;
    dragOverlay.classList.add('active');
  });
  document.addEventListener('dragleave', function(e) {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dragOverlay.classList.remove('active');
    }
  });
  document.addEventListener('dragover', function(e) { e.preventDefault(); });
  dragOverlay.addEventListener('dragover', function(e) { e.preventDefault(); });
  dragOverlay.addEventListener('drop', function(e) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    dragOverlay.classList.remove('active');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  });
}

// ============================================================
// Ctrl+V 粘贴上传
// ============================================================

function setupPaste() {
  document.addEventListener('paste', function(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    var found = false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        var blob = items[i].getAsFile();
        if (blob) {
          var ext = blob.type === 'image/png' ? '.png' : '.jpg';
          var f = new File([blob], 'clipboard-' + Date.now() + ext, { type: blob.type });
          uploadedFiles.push(f);
          found = true;
        }
      }
    }
    if (found) {
      renderSidebarFiles();
      showToast('已粘贴 ' + (found === 1 ? '1 张图片' : found + ' 张图片'), 'info');
    }
  });
}

// ============================================================
// 拖拽上传
// ============================================================

dropzone.addEventListener('dragover', function(e) {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});
dropzone.addEventListener('dragleave', function() {
  dropzone.classList.remove('drag-over');
});
dropzone.addEventListener('drop', function(e) {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  addFiles(e.dataTransfer.files);
});
dropzone.addEventListener('click', function() { fileInput.click(); });
fileInput.addEventListener('change', function() { addFiles(fileInput.files); });

function addFiles(fileListObj) {
  for (var i = 0; i < fileListObj.length; i++) {
    var f = fileListObj[i];
    var found = false;
    for (var j = 0; j < uploadedFiles.length; j++) {
      if (uploadedFiles[j].name === f.name && uploadedFiles[j].size === f.size) {
        found = true; break;
      }
    }
    if (!found) uploadedFiles.push(f);
  }
  renderSidebarFiles();
  if (uploadedFiles.length > 0) {
    showToast('已添加 ' + uploadedFiles.length + ' 个文件', 'info');
  }
}

function removeFile(index) {
  uploadedFiles.splice(index, 1);
  renderSidebarFiles();
}

sidebarFileList.addEventListener('click', function(e) {
  var removeBtn = e.target.closest('.file-remove');
  if (removeBtn) {
    e.stopPropagation();
    removeFile(parseInt(removeBtn.getAttribute('data-index'), 10));
    return;
  }
  var row = e.target.closest('.sidebar-file');
  if (row) previewSidebarFile(parseInt(row.getAttribute('data-index'), 10));
});

sidebarFileList.addEventListener('keydown', function(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  var row = e.target.closest('.sidebar-file');
  if (row && e.target === row) {
    e.preventDefault();
    previewSidebarFile(parseInt(row.getAttribute('data-index'), 10));
  }
});

function getFileIcon(filename) {
  if (/\.pdf$/i.test(filename)) return 'pdf';
  if (/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(filename)) return 'image';
  return 'unknown';
}

function getFileIconSVG(type) {
if (type === 'pdf') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
if (type === 'image') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
}

function renderSidebarFiles() {
  fileCountEl.textContent = uploadedFiles.length;
  if (uploadedFiles.length === 0) {
    sidebarFileList.innerHTML = '<div class="sidebar-empty">暂无文件</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < uploadedFiles.length; i++) {
    var ftype = getFileIcon(uploadedFiles[i].name);
    var fname = uploadedFiles[i].name;
    html += '<div class="sidebar-file" role="button" tabindex="0" data-index="' + i + '" aria-label="预览 ' + esc(fname) + '">';
    html += '<span class="file-icon file-icon-img ' + ftype + '" aria-hidden="true">' + getFileIconSVG(ftype) + '</span>';
    html += '<span class="file-name">' + esc(fname) + '</span>';
    html += '<button type="button" class="file-remove" data-index="' + i + '" aria-label="移除 ' + esc(fname) + '">&times;</button>';
    html += '</div>';
  }
  sidebarFileList.innerHTML = html;
}

uploadBtn.addEventListener('click', async function() {
  if (uploadedFiles.length === 0) return;
  uploadBtn.disabled = true;
  var formData = new FormData();
  for (var i = 0; i < uploadedFiles.length; i++) {
    formData.append('files', uploadedFiles[i]);
  }
  showToast('正在上传 ' + uploadedFiles.length + ' 个文件...', 'info');
  try {
    var res = await fetch(API_BASE + '/api/upload/' + sessionId, {
      method: 'POST', body: formData,
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || '上传失败 (' + res.status + ')');
    if (data.message) {
      updateProgress(5, data.message);
    }
  } catch (err) {
    updateProgress(-1, '上传失败，请重试: ' + err.message, true);
    uploadBtn.disabled = false;
    uploadPanel.style.display = '';
    progressPanel.classList.remove('show');
    showToast('上传失败，请重试', 'error');
  }
});

// ============================================================
// 确认界面
// ============================================================

function showConfirmation(data) {
  progressPanel.classList.remove('show'); phaseTitle.textContent = '核对信息'; mainContent.classList.add('scene-in'); setTimeout(function(){ mainContent.classList.remove('scene-in'); }, 500);
  if (phaseSub) phaseSub.textContent = '请核对发票与凭证的识别结果，确认后系统将自动填写 BIP';
  phaseBadge.textContent = 'STEP 3/4';
  setActiveStep(2);

  var old = $('#confirm-section');
  if (old) old.remove();

  var travelers = data.travelers || [];
  var summary = data.summary || '报销差旅费用';
  var approval = data.approval || {};
  var subsidy = data.subsidy || {};
  var invoices = data.invoices || {};
  var invoiceList = data.invoice_list || [];
  var extractionErrors = data.extraction_errors || [];

  var parts = [];
  var invCount = invoiceList.length;
  var docCount = Object.values(data.documents || {}).reduce(function(a,b){return a+b.length;}, 0);
  if (invCount > 0) parts.push(invCount + ' 张发票');
  if (docCount > 0) parts.push(docCount + ' 份凭证');
  if (subsidy.entries && subsidy.entries.length > 0) parts.push('补助: ' + fmtCNY(subsidy.total_amount));
  if (approval.travelers && approval.travelers.length > 0) parts.push('出差人员: ' + approval.travelers.join(', '));

  var statusBg = parts.length > 0 ? 'rgba(85,121,93,0.09)' : 'rgba(184,78,69,0.09)';
  var statusBd = parts.length > 0 ? 'rgba(85,121,93,0.24)' : 'rgba(184,78,69,0.24)';
  var statusCl = parts.length > 0 ? '#55795d' : '#b84e45';
  var statusTx = parts.length > 0 ? parts.join(' | ') : '未提取到数据，请检查文件内容';

  var h = '<div id="confirm-section" class="results-panel show">';
  h += '<section class="automation-status" id="automation-status" data-state="running" aria-live="polite" hidden>';
  h += '<div class="automation-status-head"><span class="automation-status-orb" aria-hidden="true"><span></span></span><div class="automation-status-copy"><span class="automation-status-kicker">报销进度</span><h3 id="automation-status-title">正在自动填单</h3><p id="automation-status-message">正在准备写入 BIP...</p></div><span class="automation-status-badge" id="automation-status-badge">0%</span></div>';
  h += '<div class="automation-progress" id="automation-progress-track" role="progressbar" aria-label="自动填单进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="automation-progress-fill"></span></div>';
  h += '<div class="automation-milestones"><div data-automation-step><span>1</span><small>信息已确认</small></div><div data-automation-step><span>2</span><small>写入 BIP</small></div><div data-automation-step><span>3</span><small>人工复核</small></div></div>';
  h += '<p class="automation-status-meta" id="automation-status-meta">解析结果会保留在下方，填单过程中也可随时核对。</p>';
  h += '</section>';
  h += '<div class="data-status-bar" style="display:block;background:'+statusBg+';border-color:'+statusBd+';color:'+statusCl+'">' + esc(statusTx) + '</div>';
  var reviewWarnings = data.review_warnings || [];
  if (reviewWarnings.length > 0) {
    h += '<div class="data-status-bar review-warnings" style="display:block;background:rgba(169,111,33,0.09);border-color:rgba(169,111,33,0.24);color:#8b5a1a;margin-top:8px"><strong>请核对：</strong><ul>' + reviewWarnings.map(function(w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>';
  }
  if (extractionErrors.length > 0) {
    h += '<div class="data-status-bar" style="display:block;background:rgba(169,111,33,0.09);border-color:rgba(169,111,33,0.24);color:#8b5a1a;margin-top:8px">有 '+extractionErrors.length+' 个文件已转为其他附件，将在最后一并上传：'+esc(extractionErrors.map(function(item){ return item.filename || '未知文件'; }).join('、'))+'。这些文件不参与费用数据提取。</div>';
  }

  // Info grid
  h += '<div class="info-grid">';
  h += infoCell('报销事由', summary, 'confirm-summary', true, summary);
  var approvalEditable = Boolean(data.approval);
  var travelerText = travelers.length > 0 ? travelers.join('、') : '';
  h += infoCell('出差人员', travelerText || '—', 'confirm-travelers', approvalEditable, travelerText);
  h += infoCell('目的地', approval.destination || '—', 'confirm-destination', approvalEditable, approval.destination || '');
  h += infoCell('出发日期', approval.start_date || '—', 'confirm-start-date', approvalEditable, approval.start_date || '');
  h += infoCell('返回日期', approval.end_date || '—', 'confirm-end-date', approvalEditable, approval.end_date || '');
  h += infoCell('出差事由', approval.purpose || '—', 'confirm-purpose', approvalEditable, approval.purpose || '');
  h += '</div>';
  var sources = approval.sources || [];
  if (sources.length > 1) {
    h += '<div class="approval-sources">已合并 ' + sources.length + ' 份审批单：' + sources.map(function(src) {
      return esc((src.travelers || []).join('、') || '未识别人员') + '（' + esc(src.start_date || '?') + ' ~ ' + esc(src.end_date || '?') + '，' + esc(src.destination || '未识别地点') + '）';
    }).join('；') + '</div>';
  }

  // Subsidy
  if (subsidy.entries && subsidy.entries.length > 0) {
    h += '<div class="section-head">出差补助</div>';
    h += '<table class="subsidy-table"><thead><tr><th>姓名</th><th>天数</th><th>人数</th><th>伙食补助</th><th>交通补助</th></tr></thead><tbody>';
    for (var i = 0; i < subsidy.entries.length; i++) {
      var e = subsidy.entries[i];
      h += '<tr>';
      h += '<td><button type="button" class="table-edit" onclick="editSubsidyEntry('+i+',\'name\')">'+esc(e.name||'-')+'</button></td>';
      h += '<td><button type="button" class="table-edit" onclick="editSubsidyEntry('+i+',\'days\')">'+(e.days||0)+'</button></td>';
      h += '<td><button type="button" class="table-edit" onclick="editSubsidyEntry('+i+',\'people\')">'+(e.people||1)+'</button></td>';
      h += '<td><button type="button" class="table-edit" onclick="editSubsidyEntry('+i+',\'meal_allowance\')">'+fmtCNY(e.meal_allowance||0)+'</button></td>';
      h += '<td><button type="button" class="table-edit" onclick="editSubsidyEntry('+i+',\'transport_allowance\')">'+fmtCNY(e.transport_allowance||0)+'</button></td>';
      h += '</tr>';
    }
    h += '</tbody><tfoot>';
    h += '<tr class="total"><td colspan="3">合计</td><td>'+fmtCNY(subsidy.total_meal||0)+'</td><td>'+fmtCNY(subsidy.total_transport||0)+'</td></tr>';
    h += '<tr class="total"><td colspan="4" style="text-align:right">补助总计</td><td style="font-size:16px">'+fmtCNY(subsidy.total_amount||0)+'</td></tr>';
    h += '</tfoot></table>';
  }

  // 费用小计：分区与 BIP 报账单一致，便于逐项核对
  var subtotals = computeExpenseSubtotals(data);
  h += '<div class="section-head" style="margin-top:28px">费用小计</div>';
  h += '<table class="subtotal-table"><thead><tr><th>费用分区</th><th>包含</th><th>数量</th><th>金额</th></tr></thead><tbody>';
  for (var si = 0; si < subtotals.rows.length; si++) {
    var row = subtotals.rows[si];
    h += '<tr'+(row.count ? '' : ' class="empty"')+'><td>'+esc(row.label)+'</td><td>'+esc(row.detail)+'</td><td>'+row.count+' '+esc(row.unit)+'</td><td>'+fmtCNY(row.cents / 100)+'</td></tr>';
  }
  h += '</tbody><tfoot><tr class="total"><td colspan="3">合计</td><td>'+fmtCNY(subtotals.totalCents / 100)+'</td></tr></tfoot></table>';

  // Invoices with stagger
  h += '<div style="margin-top:28px"><div class="section-head">发票清单</div>';
  var cats = INVOICE_CATEGORIES;
  var hasInv = false;
  invoicePreviewGroups = {};
  for (var ci = 0; ci < cats.length; ci++) {
    var cat = cats[ci];
    var items = invoiceItemsForCategory(data, cat.key);
    if (items.length === 0) continue;
    hasInv = true;
    invoicePreviewGroups[cat.key] = items.map(function(item) {
      return { path: item.preview_path || item.path || '', name: item.renamed || item.original || '' };
    });
    h += '<div class="inv-cat"><h5>'+cat.label+' ('+items.length+')</h5>';
    for (var ii = 0; ii < items.length; ii++) {
      var inv = items[ii];
      var amt = (typeof inv.amount === 'number' ? inv.amount : (parseFloat(inv.amount) || 0)).toFixed(2);
      var metaParts = [];
      if (inv.date) metaParts.push(inv.date);
      if (inv.departure_station || inv.destination_station) {
        metaParts.push((inv.departure_station || '—') + ' → ' + (inv.destination_station || '—'));
      }
      if (inv.train_number) metaParts.push(inv.train_number);
      if (inv.flight_number) metaParts.push(inv.flight_number);
      if (inv.departure_time) metaParts.push(inv.departure_time);
      var seatPosition = [inv.carriage, inv.seat].filter(Boolean).join('');
      if (seatPosition) metaParts.push(seatPosition);
      if (inv.seat_class) metaParts.push(inv.seat_class);
      if (inv.renamed) metaParts.push('文件: ' + inv.renamed);

      var codeParts = [];
      if (inv.invoice_number) codeParts.push('发票号 ' + inv.invoice_number);
      if (inv.ticket_number) codeParts.push('电子客票号 ' + inv.ticket_number);
      var canPreview = Boolean(inv.preview_path || inv.path);
      h += '<button type="button" class="inv-row stagger-in'+(canPreview ? ' previewable' : '')+'"'
        + (canPreview ? ' data-cat="'+esc(cat.key)+'" data-index="'+ii+'" onclick="previewInvoiceRow(this)" title="点击查看发票原件"' : '')
        + '><span style="flex:1;min-width:0"><span class="inv-name">'+esc(inv.name||'-')+' - '+fmtCNY(amt)+'</span>';
      h += '<span class="inv-meta">'+esc(metaParts.length ? metaParts.join(' · ') : '-')+'</span>';
      if (codeParts.length) h += '<span class="inv-extra">'+esc(codeParts.join(' · '))+'</span>';
      h += '</span>';
      h += '<span class="inv-badge '+cat.cls+'">'+cat.label+'</span></button>';
    }
    h += '</div>';
  }
  if (!hasInv) h += '<div class="empty-note">无发票文件</div>';
  h += '</div>';

  // Documents with stagger
  h += '<div style="margin-top:28px"><div class="section-head">报销凭证</div>';
  var types = ['出差审批单','出差补助单','税额计算表','其他凭证'];
  var docs = data.documents || {};
  var hasDoc = false;
  for (var ti = 0; ti < types.length; ti++) {
    var dItems = docs[types[ti]] || [];
    if (dItems.length === 0) continue;
    hasDoc = true;
    for (var di = 0; di < dItems.length; di++) {
      var doc = dItems[di];
      var docFilename = doc.renamed || doc.original || '';
      var docPath = doc.path || '';
      h += '<button type="button" class="doc-row stagger-in"' + (docFilename ? ' data-path="' + esc(docPath) + '" onclick="previewInvoiceFile(this.dataset.path)"' : '') + '><span class="doc-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg></span><span class="doc-name">'+esc(doc.renamed||doc.original||types[ti])+'</span><span class="doc-meta">'+esc(types[ti])+'</span></button>';
    }
  }
  if (!hasDoc) h += '<div class="empty-note">无报销凭证文件</div>';
  h += '</div>';

  // Total with count-up
  var totalAmount = subtotals.totalCents / 100;
  if (totalAmount > 0) {
    h += '<div class="total-box"><span id="total-amount-display">总计：'+fmtCNY(0)+'</span></div>';
  }

  h += '<div class="actions-row">';
  h += '<button class="btn btn-success" onclick="confirmData()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> 确认并开始填单</button>';
  h += '<div class="confirmation-lock" id="confirmation-lock" hidden><span aria-hidden="true">✓</span><div><strong>本次填单信息已确认</strong><small>以下解析结果已锁定并持续保留，供填单完成后核对</small></div></div>';
  h += '</div>';
  h += '</div>';

  mainContent.insertAdjacentHTML('beforeend', h);
  var cs = $('#confirm-section');
  if (cs) cs.scrollIntoView({ behavior: 'smooth' });

  // Animate total
  var totalDisplay = $('#total-amount-display');
  if (totalDisplay && totalAmount > 0) {
    var start = 0, startTime = null, duration = 900;
    var step = function(ts) {
      if (!startTime) startTime = ts;
      var p = Math.min((ts - startTime) / duration, 1);
      var e = 1 - Math.pow(1 - p, 3);
      var v = start + (totalAmount - start) * e;
      totalDisplay.textContent = '总计：' + fmtCNY(v);
      if (p < 1) requestAnimationFrame(step);
      else totalDisplay.textContent = '总计：' + fmtCNY(totalAmount);
    };
    requestAnimationFrame(step);
  }

  // Debug
  var debugEl = $('#debug-raw-data');
  if (!debugEl) {
    debugEl = document.createElement('pre');
    debugEl.id = 'debug-raw-data';
    debugEl.style.cssText = 'margin-top:24px;padding:12px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;font-size:11px;color:var(--text-3);max-height:240px;overflow:auto;white-space:pre-wrap;display:none';
    cs.appendChild(debugEl);
  }
  debugEl.textContent = JSON.stringify(data, null, 2);
}

function infoCell(label, value, id, editable, dataVal) {
  var cls = editable ? ' value editable' : ' value';
  var onclick = editable ? ' onclick="editField(\''+id+'\')"' : '';
  var dv = editable ? ' data-value="'+esc(dataVal)+'"' : '';
  if (editable) {
    return '<div class="info-cell"><label>'+esc(label)+'</label><button type="button" class="'+cls+'" id="'+id+'"'+dv+onclick+'>'+esc(value)+'</button></div>';
  }
  return '<div class="info-cell"><label>'+esc(label)+'</label><div class="'+cls+'" id="'+id+'"'+dv+'>'+esc(value)+'</div></div>';
}

// ============================================================
// 编辑 / 确认
// ============================================================

function editField(fieldId) {
  var el = document.getElementById(fieldId);
  if (!el) return;
  var currentVal = el.dataset.value !== undefined ? el.dataset.value : el.textContent;
  var label = el.parentElement && el.parentElement.querySelector('label');
  var newVal = prompt('修改' + (label ? label.textContent : '') + ':', currentVal);
  if (newVal === null) return;
  newVal = newVal.trim();
  if (!newVal) {
    showToast('内容不能为空', 'error');
    return;
  }
  if (newVal === currentVal) return;
  var field = EDITABLE_FIELDS[fieldId];
  if (!field || !currentResult) return;
  var error = field.validate ? field.validate(newVal, currentResult) : '';
  if (error) {
    showToast(error, 'error');
    return;
  }
  // 先写入数据模型，再重新绘制；否则编辑补助等操作重绘确认页时会用旧值覆盖。
  field.apply(currentResult, newVal);
  showConfirmation(currentResult);
  showToast('已修改', 'info');
}

function splitTravelers(text) {
  return String(text).split(/[、,，;；\/／\s]+/).map(function(name) { return name.trim(); })
    .filter(function(name, idx, arr) { return name && arr.indexOf(name) === idx; });
}

function isIsoDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  var d = new Date(text + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

function ensureApproval(data) {
  data.approval = Object.assign({}, data.approval || {});
  return data.approval;
}

var EDITABLE_FIELDS = {
  'confirm-summary': {
    apply: function(data, value) { data.summary = value; },
  },
  'confirm-travelers': {
    validate: function(value) { return splitTravelers(value).length ? '' : '请至少填写一名出差人员，多人用“、”分隔'; },
    apply: function(data, value) {
      var names = splitTravelers(value);
      var oldNames = (data.approval && data.approval.travelers) || data.travelers || [];
      // 事由仍是按旧人员自动生成的默认值时，随人员一起更新；手动改过的事由保持不变。
      if (data.summary === (oldNames.length ? oldNames.join('、') + '报销差旅费用' : '报销差旅费用')) {
        data.summary = names.join('、') + '报销差旅费用';
      }
      ensureApproval(data).travelers = names;
      data.travelers = names;
    },
  },
  'confirm-destination': {
    apply: function(data, value) { ensureApproval(data).destination = value; },
  },
  'confirm-purpose': {
    apply: function(data, value) { ensureApproval(data).purpose = value; },
  },
  'confirm-start-date': {
    validate: function(value, data) {
      if (!isIsoDate(value)) return '日期格式应为 YYYY-MM-DD，例如 2026-07-19';
      var end = data.approval && data.approval.end_date;
      return end && isIsoDate(end) && value > end ? '出发日期不能晚于返回日期' : '';
    },
    apply: function(data, value) { ensureApproval(data).start_date = value; },
  },
  'confirm-end-date': {
    validate: function(value, data) {
      if (!isIsoDate(value)) return '日期格式应为 YYYY-MM-DD，例如 2026-07-25';
      var start = data.approval && data.approval.start_date;
      return start && isIsoDate(start) && value < start ? '返回日期不能早于出发日期' : '';
    },
    apply: function(data, value) { ensureApproval(data).end_date = value; },
  },
};

function editSubsidyEntry(index, field) {
  var subsidy = currentResult && currentResult.subsidy;
  var entry = subsidy && subsidy.entries && subsidy.entries[index];
  if (!entry) return;
  var labels = { name: '姓名', days: '天数', people: '人数', meal_allowance: '伙食补助', transport_allowance: '交通补助' };
  var oldValue = entry[field] == null ? '' : entry[field];
  var value = prompt('修改' + (labels[field] || field) + ':', oldValue);
  if (value === null) return;
  if (field === 'name') {
    entry.name = value.trim();
  } else {
    var num = Number(value);
    if (!Number.isFinite(num) || num < 0 || ((field === 'days' || field === 'people') && num <= 0)) {
      showToast('请输入有效数字', 'error');
      return;
    }
    var oldDays = Number(entry.days) || 1;
    var oldPeople = Number(entry.people) || 1;
    if (field === 'days' && num !== oldDays) {
      entry.meal_allowance = (Number(entry.meal_allowance) || 0) / oldDays * num;
      entry.transport_allowance = (Number(entry.transport_allowance) || 0) / oldDays * num;
    }
    if (field === 'people' && num !== oldPeople) {
      entry.meal_allowance = (Number(entry.meal_allowance) || 0) / oldPeople * num;
      entry.transport_allowance = (Number(entry.transport_allowance) || 0) / oldPeople * num;
    }
    entry[field] = num;
  }
  subsidy.total_meal = subsidy.entries.reduce(function(sum, item) { return sum + (Number(item.meal_allowance) || 0); }, 0);
  subsidy.total_transport = subsidy.entries.reduce(function(sum, item) { return sum + (Number(item.transport_allowance) || 0); }, 0);
  subsidy.total_amount = subsidy.total_meal + subsidy.total_transport;
  showConfirmation(currentResult);
  showToast('补助信息已更新', 'info');
}

async function confirmData() {
  if (!currentResult) return;
  if (confirmInFlight || automationStarted) {
    showToast('自动填单已经开始，请勿重复点击', 'warning');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('连接已断开，请等待重新连接后再试', 'error');
    return;
  }
  var summaryEl = document.getElementById('confirm-summary');
  var summary = summaryEl ? (summaryEl.dataset.value || summaryEl.textContent) : '';
  var updated = Object.assign({}, currentResult, { summary: summary });
  currentResult = updated;
  confirmInFlight = true;
  var confirmButton = document.querySelector('#confirm-section .btn-success');
  if (confirmButton) confirmButton.disabled = true;
  // 数据与确认必须原子发送，避免两条 WebSocket 消息之间断线后前后端状态分叉。
  ws.send(JSON.stringify({ action: 'confirm', data: updated }));
  showToast('正在确认自动填单请求...', 'info');
}

// ============================================================
// 启动
// ============================================================

// ============================================================
// 文件预览
// ============================================================

var previewBlobURLs = [];

var INVOICE_CATEGORIES = [
  {key:'机票',label:'机票',cls:'flight'},
  {key:'高铁票',label:'高铁票',cls:'train'},
  {key:'住宿发票',label:'住宿发票',cls:'hotel'},
  {key:'其他发票',label:'其他发票',cls:'other'},
];
var invoicePreviewGroups = {};

function toCents(value) {
  var n = typeof value === 'number' ? value : parseFloat(String(value == null ? '' : value).replace(/[,，\s￥¥元]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// 发票清单、小计和总计共用同一份分类数据，避免三处金额不一致。
function invoiceItemsForCategory(data, key) {
  var list = (data && data.invoice_list) || [];
  var items = list.filter(function(item) {
    var type = item.type;
    if (key === '其他发票') return type === key || !INVOICE_CATEGORIES.some(function(c) { return c.key === type; });
    return type === key;
  });
  if (items.length === 0 && list.length === 0) items = ((data && data.invoices) || {})[key] || [];
  return items;
}

function computeExpenseSubtotals(data) {
  var sum = function(items) { return items.reduce(function(total, item) { return total + toCents(item.amount); }, 0); };
  var flights = invoiceItemsForCategory(data, '机票');
  var trains = invoiceItemsForCategory(data, '高铁票');
  var lodging = invoiceItemsForCategory(data, '住宿发票');
  var others = invoiceItemsForCategory(data, '其他发票');
  var subsidy = (data && data.subsidy) || {};
  var entries = subsidy.entries || [];
  var subsidyCents = entries.length
    ? entries.reduce(function(total, e) { return total + toCents(e.meal_allowance) + toCents(e.transport_allowance); }, 0)
    : toCents(subsidy.total_amount);
  var subsidyPeople = entries.map(function(e) { return e.name; }).filter(function(name, idx, arr) { return name && arr.indexOf(name) === idx; }).length;
  var rows = [
    { label: '交通费用', detail: '机票 ' + flights.length + ' · 高铁 ' + trains.length, count: flights.length + trains.length, unit: '张', cents: sum(flights) + sum(trains) },
    { label: '住宿费用', detail: '住宿发票', count: lodging.length, unit: '张', cents: sum(lodging) },
    { label: '出差补贴', detail: '伙食 + 市内交通', count: subsidyPeople || entries.length, unit: '人', cents: subsidyCents },
    { label: '其他费用', detail: '退改签、保险等', count: others.length, unit: '张', cents: sum(others) },
  ];
  return { rows: rows, totalCents: rows.reduce(function(total, row) { return total + row.cents; }, 0) };
}

function previewInvoiceRow(button) {
  var group = invoicePreviewGroups[button.dataset.cat] || [];
  var index = parseInt(button.dataset.index, 10) || 0;
  previewInvoiceList(group, index);
}

// 预览同一类别的全部发票，可用上一张/下一张翻看。
function previewInvoiceList(files, index) {
  previewFiles = [];
  previewBlobURLs.forEach(function(u) { if (u) URL.revokeObjectURL(u); });
  previewBlobURLs = [];
  for (var i = 0; i < files.length; i++) {
    if (!files[i].path) continue;
    var rel = String(files[i].path).replace(/^.*[\\\/]sessions[\\\/]/, '');
    var parts = rel.split(/[\\\/]/);
    var name = files[i].name || parts[parts.length - 1];
    previewFiles.push({
      name: name,
      url: '/files/' + parts.map(encodeURIComponent).join('/'),
      type: /\.pdf$/i.test(name) ? 'application/pdf' : 'image',
    });
  }
  if (!previewFiles.length) return;
  previewIndex = Math.min(Math.max(index, 0), previewFiles.length - 1);
  renderPreview();
}

function previewSidebarFile(index) {
  previewFiles = [];
  previewBlobURLs.forEach(function(u) { if (u) URL.revokeObjectURL(u); });
  previewBlobURLs = [];
  for (var i = 0; i < uploadedFiles.length; i++) {
    var url = URL.createObjectURL(uploadedFiles[i]);
    previewBlobURLs.push(url);
    previewFiles.push({
      name: uploadedFiles[i].name,
      url: url,
      type: uploadedFiles[i].type,
    });
  }
  previewIndex = index;
  renderPreview();
}

function previewInvoiceFile(filepath, filename) {
  previewFiles = [];
  previewBlobURLs.forEach(function(u) { if (u) URL.revokeObjectURL(u); });
  previewBlobURLs = [];
  if (!filepath) return;
  // 绝对路径 -> sessions 下的相对路径（如 {sid}/documents/机票/xx.pdf）
  var rel = filepath.replace(/^.*[\\\/]sessions[\\\/]/, '');
  var parts = rel.split(/[\\\/]/);
  var url = '/files/' + parts.map(encodeURIComponent).join('/');
  var name = filename || parts[parts.length - 1];
  previewFiles.push({
    name: name,
    url: url,
    type: /\.pdf$/i.test(name) ? 'application/pdf' : 'image',
  });
  previewIndex = 0;
  renderPreview();
}

function renderPreview() {
  if (previewFiles.length === 0) return;
  var f = previewFiles[previewIndex];
  previewTitle.textContent = f.name;
  previewCount.textContent = (previewIndex + 1) + ' / ' + previewFiles.length;

  var isPDF = f.type === 'application/pdf' || f.name.match(/\.pdf$/i);
  var isImage = f.type.indexOf('image') === 0 || f.name.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i);

  var bodyHTML = '';
  if (isPDF) {
    bodyHTML = '<iframe src="' + f.url + '#toolbar=0&navpanes=0"></iframe>';
  } else if (isImage || f.url.indexOf('blob:') === 0) {
    bodyHTML = '<img src="' + f.url + '" alt="' + f.name + '">';
  } else {
    bodyHTML = '<div class="preview-fallback"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg><p>无法预览此文件类型</p><p style="font-size:11px;color:var(--text-muted)">' + f.name + '</p></div>';
  }
  previewBody.innerHTML = bodyHTML;

  var hasMultiple = previewFiles.length > 1;
  var hasPrev = previewIndex > 0;
  var hasNext = previewIndex < previewFiles.length - 1;
  previewPrevBtn.disabled = !hasPrev;
  previewNextBtn.disabled = !hasNext;
  previewNavPrev.disabled = !hasPrev;
  previewNavNext.disabled = !hasNext;
  previewPrevBtn.style.display = hasMultiple ? '' : 'none';
  previewNextBtn.style.display = hasMultiple ? '' : 'none';
  previewNavPrev.style.display = hasMultiple ? '' : 'none';
  previewNavNext.style.display = hasMultiple ? '' : 'none';
  if (!hasMultiple) previewCount.textContent = '';

  previewOverlay.classList.add('active');
}

function navigatePreview(dir) {
  var newIdx = previewIndex + dir;
  if (newIdx >= 0 && newIdx < previewFiles.length) {
    previewIndex = newIdx;
    renderPreview();
  }
}

function closePreview() {
  previewOverlay.classList.remove('active');
  previewBlobURLs.forEach(function(u) { if (u) URL.revokeObjectURL(u); });
  previewBlobURLs = [];
  previewFiles = [];
}

// Close handlers
previewOverlay.addEventListener('click', function(e) {
  if (e.target === previewOverlay) closePreview();
});

$('#preview-close').addEventListener('click', closePreview);
previewPrevBtn.addEventListener('click', function() { navigatePreview(-1); });
previewNextBtn.addEventListener('click', function() { navigatePreview(1); });
previewNavPrev.addEventListener('click', function() { navigatePreview(-1); });
previewNavNext.addEventListener('click', function() { navigatePreview(1); });

document.addEventListener('keydown', function(e) {
  if (!previewOverlay.classList.contains('active')) return;
  if (e.key === 'Escape') { closePreview(); return; }
  if (e.key === 'ArrowLeft') { navigatePreview(-1); return; }
  if (e.key === 'ArrowRight') { navigatePreview(1); return; }
});



// ============================================================
// 翻页数字
// ============================================================

// ============================================================
// 3D 视差卡片
// ============================================================

function setupParallax() {
  document.addEventListener('mousemove', function(e) {
    var cells = document.querySelectorAll('.info-cell');
    for (var i = 0; i < cells.length; i++) {
      var rect = cells[i].getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var dx = (e.clientX - cx) / rect.width;
      var dy = (e.clientY - cy) / rect.height;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1.5) {
        cells[i].style.transform = 'rotateY(' + (dx * 6) + 'deg) rotateX(' + (-dy * 4) + 'deg) translateZ(2px)';
        cells[i].style.boxShadow = (dx * 4) + 'px ' + (dy * 4) + 'px 16px rgba(0,0,0,0.04)';
      }
    }
  });
}

// ============================================================
// 电影感转场
// ============================================================

function curtainReveal(container, callback) {
  var curtain = document.createElement('div');
  curtain.className = 'curtain';
  curtain.style.width = container.offsetWidth + 'px';
  curtain.style.height = container.offsetHeight + 'px';
  container.style.position = 'relative';
  container.appendChild(curtain);
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      curtain.classList.add('open');
      setTimeout(function() {
        if (curtain.parentNode) curtain.remove();
        if (callback) callback();
      }, 600);
    });
  });
}

// ============================================================
// 粒子爆发
// ============================================================

function burstParticles(cx, cy) {
  var dropzoneEl = dropzone;
  var rect = dropzoneEl.getBoundingClientRect();
  var bx = cx - rect.left;
  var by = cy - rect.top;
  var count = 28;
  for (var i = 0; i < count; i++) {
    var particle = document.createElement('span');
    particle.className = 'burst-particle';
    var angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
    var dist = 40 + Math.random() * 80;
    var dx = Math.cos(angle) * dist;
    var dy = Math.sin(angle) * dist;
    particle.style.cssText = 'left:' + bx + 'px;top:' + by + 'px;--bx:' + dx + 'px;--by:' + dy + 'px;animation-delay:' + (Math.random() * 0.15) + 's;width:' + (3 + Math.random() * 5) + 'px;height:' + (3 + Math.random() * 5) + 'px';
    dropzoneEl.appendChild(particle);
    setTimeout(function(p) { return function() { if (p.parentNode) p.remove(); }; }(particle), 900);
  }
}



init();
