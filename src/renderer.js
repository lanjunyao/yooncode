const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat('zh-CN');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let expanded = false;
let lastData = null;
let selectedScreenshot = null;
let selectedScreenshotItem = null;
const cpuHistory = [];
let companionPool = [];
let companionIndex = 0;
let peekTimer = null;
let mouseInside = false;
let pendingDelete = null;
let selectedSessionPath = null;
let activeTab = 'overview';
let currentScreenshots = [];
let companionData = null;
let currentRole = null;
let shareTemplate = 'warm';
let manualFullscreen = false;
let fontSizeMode = 'normal';
let manualTransitioning = false;

function compact(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return nf.format(n);
}

function avatarState(remaining) {
  if (remaining == null) return 2;
  if (remaining >= 80) return 0;
  if (remaining >= 60) return 1;
  if (remaining >= 35) return 2;
  if (remaining > 0) return 3;
  return 4;
}

function applyRoleAvatar(state = avatarState(lastData?.remainingPercent)) {
  const image = $('avatarSprite');
  if (currentRole && !currentRole.builtin && currentRole.expressions?.[state]) {
    image.classList.add('role-single'); image.src=currentRole.expressions[state]; image.style.left='0';
  } else {
    image.classList.remove('role-single'); image.src=currentRole?.sprite||'assets/yoona-expressions.png'; image.style.left=`${state * -100}%`;
  }
}

function contextStatus(percent) {
  if (percent >= 90) return { level:'danger', title:'上下文即将自动压缩', text:'建议立即开启新对话，避免早期细节在压缩摘要中丢失。' };
  if (percent >= 80) return { level:'danger', title:'已进入上下文压缩预警区', text:'继续对话可能触发自动压缩，建议完成当前步骤后开启新对话。' };
  if (percent >= 65) return { level:'warn', title:'上下文使用量偏高', text:'建议整理关键结论，准备在新对话中继续。' };
  return { level:'safe', title:'当前上下文空间充足', text:'距离自动压缩还有充足空间，可以安心继续。' };
}

function formatReset(epoch) {
  if (!epoch) return '--';
  const date = new Date(epoch * 1000);
  const diff = date - Date.now();
  if (diff > 0 && diff < 86400000) return `${Math.max(1, Math.ceil(diff / 3600000))} 小时后`;
  return date.toLocaleDateString('zh-CN', { month:'numeric', day:'numeric' });
}

function renderUsage(data) {
  lastData = data;
  const remaining = data.remainingPercent;
  const contextPercent = data.contextWindow ? Math.min(100, data.currentContextTokens / data.contextWindow * 100) : 0;
  const state = avatarState(remaining);
  applyRoleAvatar(state);
  $('quotaBadge').textContent = remaining == null ? '--' : `${Math.round(remaining)}%`;
  $('liveDot').classList.toggle('offline', !data.connected);
  $('syncText').textContent = data.connected ? '刚刚同步' : '未连接';
  $('codexName').textContent = data.codexName || 'Codex';
  $('username').textContent = data.username || '--';
  $('sessionTitle').textContent = `当前活跃对话 · ${data.sessionTitle || '等待会话事件'}`;
  $('sessionTitle').title = data.workspacePath ? `点击打开 ${data.workspacePath}` : '当前活跃对话';
  $('outputCompact').textContent = compact(data.turnOutputTokens);
  $('lastTokens').textContent = compact(data.lastTokens);
  $('totalCompact').textContent = compact(data.totalTokens);
  $('contextCompact').textContent = data.contextWindow ? `${Math.round(contextPercent)}% · ${compact(data.currentContextTokens)}` : '--';
  $('resetAt').textContent = formatReset(data.resetsAt);
  $('quotaBar').style.width = `${remaining || 0}%`;
  $('peekQuotaBar').style.width = `${remaining || 0}%`;
  $('quotaDetail').textContent = remaining == null ? '未知' : `剩余 ${Math.round(remaining)}%`;
  $('contextDetail').textContent = data.contextWindow ? `${compact(data.currentContextTokens)} / ${compact(data.contextWindow)}` : '--';
  $('turnDetail').textContent = compact(data.lastTokens);
  $('totalTokens').textContent = compact(data.totalTokens);
  $('dataSource').textContent = `数据源：${data.source} · 更新于 ${data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('zh-CN') : '--'}`;
  const contextPercentRounded=Math.round(contextPercent);
  $('handoffContext').textContent=`当前上下文 ${contextPercentRounded}%`;
  $('handoffProgress').style.width=`${contextPercentRounded}%`;
  $('weeklyRing').style.setProperty('--quota',remaining||0);
  $('weeklyRingValue').textContent=remaining==null?'--':`${Math.round(remaining)}%`;
  $('weeklyUsed').textContent=remaining==null?'--':`${Math.round(100-remaining)}%`;
  $('weeklyReset').textContent=formatReset(data.resetsAt);
  $('weeklyStatus').textContent=remaining==null?'等待 Codex 限额数据':remaining>=65?'本周状态良好，可以安心工作':remaining>=35?'额度适中，优先安排重要任务':'额度偏紧，请控制消耗';
  renderForecast(data.forecast);
  updateCompanion(remaining, contextPercent);
  renderSessionList(data.sessions || [], data.sessionPath);
  renderMemoryPage(data);
  renderReplay(data);
  renderAgents(data);
  if(expanded) updateOverflow();
}

function sessionRisk(percent){if(percent>=90)return{level:'danger',text:'即将超出限制，建议立即续聊'};if(percent>=80)return{level:'danger',text:'已进入压缩预警区'};if(percent>=65)return{level:'warn',text:'上下文偏高，建议准备续聊'};return{level:'safe',text:'上下文空间充足'}}
function selectedSession(){return lastData?.sessions?.find(item=>item.path===selectedSessionPath)||null}
function renderSessionList(sessions, activePath){
  if(!sessions.length){selectedSessionPath=null;$('sessionList').innerHTML='<div class="session-empty">暂未读取到可用对话</div>';$('sessionRiskCount').textContent='0 个预警';drawTrend([]);return}
  const ordered=[...sessions].sort((a,b)=>b.contextPercent-a.contextPercent||new Date(b.updatedAt)-new Date(a.updatedAt));
  if(!selectedSessionPath||!sessions.some(item=>item.path===selectedSessionPath))selectedSessionPath=sessions.find(item=>item.path===activePath)?.path||ordered[0].path;
  const visible=ordered.slice(0,3);if(!visible.some(item=>item.path===selectedSessionPath))visible[visible.length-1]=sessions.find(item=>item.path===selectedSessionPath);
  const warned=sessions.filter(item=>item.contextPercent>=65).length;$('sessionRiskCount').textContent=`${warned} 个预警`;$('sessionRiskCount').classList.toggle('warn',warned>0);
  $('sessionList').innerHTML=visible.map((item,index)=>{const risk=sessionRisk(item.contextPercent);return`<button class="session-item ${risk.level} ${item.path===selectedSessionPath?'active':''}" data-session-index="${index}"><div class="session-item-main"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.model)} · ${risk.text}</small></div><span>${Math.round(item.contextPercent)}%</span></button>`}).join('');
  document.querySelectorAll('.session-item').forEach(button=>button.onclick=()=>{selectedSessionPath=visible[Number(button.dataset.sessionIndex)].path;renderSessionList(sessions,activePath);renderMemoryPage(lastData);renderAgents(lastData);setCompanion(sessionRisk(selectedSession().contextPercent).text+'，我可以帮你整理续聊包。')});
  const selected=selectedSession()||ordered[0],risk=sessionRisk(selected.contextPercent);$('selectedSessionTitle').textContent=selected.title;$('selectedSessionHint').textContent=risk.text;$('selectedSessionHint').className=risk.level;$('handoffContext').textContent=`所选对话上下文 ${Math.round(selected.contextPercent)}%`;$('handoffProgress').style.width=`${Math.round(selected.contextPercent)}%`;drawTrend(selected.history||[]);
}

function eventTime(value){const date=new Date(typeof value==='number'&&value<1e12?value*1000:value);return Number.isNaN(date.getTime())?'--:--':date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}
function switchTab(name){activeTab=name;document.querySelectorAll('.memory-tab').forEach(button=>button.classList.toggle('active',button.dataset.tab===name));document.querySelectorAll('.memory-tab-panel').forEach(panel=>panel.classList.toggle('active',panel.id===`tab-${name}`));const expandedPanel=document.querySelector('.expanded-content');expandedPanel.scrollTop=0;requestAnimationFrame(()=>{if(name==='overview')drawTrend(selectedSession()?.history||lastData?.history||[]);if(name==='screenshots')renderGallery(currentScreenshots);if(name==='companion')drawShareCard();updateOverflow()})}

function renderMemoryPage(data){
  if(!data)return;const sessions=data.sessions||[],ordered=[...sessions].sort((a,b)=>b.contextPercent-a.contextPercent||new Date(b.updatedAt)-new Date(a.updatedAt));const riskCount=sessions.filter(item=>item.contextPercent>=65).length;
  $('memoryRiskBadge').textContent=`${riskCount} 个对话需要关注`;$('memorySessionList').innerHTML=ordered.slice(0,5).map((item,index)=>{const risk=sessionRisk(item.contextPercent);return`<button class="memory-session-row ${risk.level} ${item.path===selectedSessionPath?'active':''}" data-memory-index="${index}"><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.model)} · ${risk.text}</small></div><span>${Math.round(item.contextPercent)}%</span></button>`}).join('')||'<div class="session-empty">暂未读取到最近对话</div>';
  document.querySelectorAll('.memory-session-row').forEach(button=>button.onclick=()=>{selectedSessionPath=ordered[Number(button.dataset.memoryIndex)].path;renderMemoryPage(data);renderSessionList(sessions,data.sessionPath);renderAgents(data)});
  const selected=selectedSession()||ordered[0];if(selected){const risk=sessionRisk(selected.contextPercent);$('memorySelectedTitle').textContent=selected.title;$('memoryReadyState').textContent=selected.contextPercent>=65?'建议准备迁移':'可随时生成';$('memoryContextValue').textContent=`${Math.round(selected.contextPercent)}% · ${compact(selected.currentContextTokens)}`;$('memoryContextBar').style.width=`${Math.round(selected.contextPercent)}%`;$('memoryContextBar').style.background=selected.contextPercent>=80?'linear-gradient(90deg,#efb064,#ef707b)':'linear-gradient(90deg,#7c8cf5,#6bd7b6)';$('memoryRiskText').textContent=risk.text;$('memoryGoalChip').textContent='目标 1 项';$('memoryDecisionChip').textContent=`进展 ${Math.min(12,selected.history?.length||0)} 条`;$('memoryFileChip').textContent='文件待提取';$('memoryTodoChip').textContent='待办 1 项'}
  $('cockpitWorkspace').textContent=data.workspacePath||'未识别';$('cockpitWorkspace').title=data.workspacePath||'';$('cockpitSessions').textContent=`${sessions.length} 个`;
}

function renderReplay(data){
  if(!data)return;const replay=data.replay||[];$('replayList').innerHTML=replay.length?replay.slice().reverse().map(item=>`<div class="replay-event ${item.type==='done'?'done':item.type==='warning'?'warning':''}"><time>${eventTime(item.timestamp)}</time><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.detail)}</p></div>`).join(''):'<div class="session-empty">当前对话还没有足够的工作事件</div>';
  const riskCount=(data.sessions||[]).filter(item=>item.contextPercent>=65).length;$('shareSessionCount').textContent=(data.sessions||[]).length;$('shareRiskCount').textContent=riskCount;$('shareTokenCount').textContent=compact(data.totalTokens);$('shareHeadline').textContent=riskCount?`今天已守住 ${riskCount} 个高上下文对话`:'今天的工作节奏很稳';
}

function renderAgents(data){
  if(!data)return;const sessions=data.sessions||[];$('agentCountBadge').textContent=`${sessions.length} 个最近任务`;$('agentsList').innerHTML=sessions.map(item=>{const updated=new Date(typeof item.updatedAt==='number'&&item.updatedAt<1e12?item.updatedAt*1000:item.updatedAt).getTime(),age=Date.now()-updated;let status='待命',statusClass='waiting',cardClass='';if(item.contextPercent>=65){status='需要关注';statusClass='risk';cardClass='risk'}else if(age<120000){status='活跃';statusClass=''}else if(age>900000){status='已暂停';statusClass='waiting'}return`<article class="agent-radar-card ${cardClass}" data-agent-path="${escapeHtml(item.path)}"><div class="agent-radar-head"><div class="agent-radar-title"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.model)} · ${eventTime(item.updatedAt)} 更新</small></div><span class="agent-radar-status ${statusClass}">${status}</span></div><div class="agent-radar-meta"><span>上下文 ${Math.round(item.contextPercent)}%</span><span>${compact(item.currentContextTokens)} / ${compact(item.contextWindow)}</span></div><div class="agent-radar-progress"><i style="width:${Math.round(item.contextPercent)}%"></i></div></article>`}).join('')||'<div class="session-empty">暂未读取到最近任务</div>';
  document.querySelectorAll('.agent-radar-card').forEach(card=>card.onclick=()=>{selectedSessionPath=card.dataset.agentPath;renderAgents(data);renderMemoryPage(data);switchTab('memory')});
}

function renderForecast(forecast){
  if(!forecast?.ready){$('forecastValue').textContent='积累样本中';$('forecastReason').textContent=forecast?.reason||'根据周剩余变化和工作时间计算';$('forecastRate').textContent='--';$('forecastAt').textContent='--';$('forecastConfidence').textContent='--';return}
  const hours=forecast.hoursLeft;$('forecastValue').textContent=hours<24?`约 ${hours.toFixed(1)} 小时`:`约 ${(hours/24).toFixed(1)} 天`;
  $('forecastReason').textContent=`基于最近 ${forecast.spanHours.toFixed(1)} 小时有效样本`;
  $('forecastRate').textContent=`−${forecast.ratePerHour.toFixed(2)}% / 小时`;
  $('forecastAt').textContent=new Date(forecast.exhaustAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  $('forecastConfidence').textContent=forecast.confidence;
}

function setCompanion(text) {
  const line=$('companionLine'),message=$('companionMessage');
  line.classList.remove('talking'); void line.offsetWidth; message.textContent=text; line.classList.add('talking');
}

function updateCompanion(remaining, contextPercent) {
  const messages=currentRole?.messages||{},fallback=(key,values)=>messages[key]?.length?messages[key]:values;
  if (contextPercent >= 80) companionPool=fallback('context',['上下文快满啦，换个新对话会更安心。','先把重要结论保存下来吧，我帮你守着。']);
  else if (remaining == null) companionPool=fallback('gentle',['我正在确认额度状态，稍等我一下呀。','Codex 在线，我也在这里陪你。']);
  else if (remaining >= 80) companionPool=fallback('abundant',['今天额度很充足，我们开心开工吧 ✨','状态满满，想做什么大胆告诉 Codex。']);
  else if (remaining >= 35) companionPool=fallback('normal',['状态很好，慢慢来，我陪你。','记得把关键结论留在笔记里呀。']);
  else companionPool=fallback('tight',['额度有点紧张啦，先做最重要的事。','我们省着一点用，也能把事情做好。']);
  companionIndex=0; setCompanion(companionPool[0]);
}

function drawTrend(history) {
  $('trendCaption').textContent = `最近 ${history.length} 轮`;
  const current=history.length?history[history.length-1].contextPercent:0;
  const peak=history.length?Math.max(...history.map(item=>item.contextPercent)):0;
  $('trendSummary').innerHTML=`<span>当前 ${Math.round(current)}%</span><span>峰值 ${Math.round(peak)}%</span><span>安全区 &lt; 65%</span>`;
  const canvas = $('trendCanvas');
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const w=rect.width,h=rect.height,p=8;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle='rgba(91,205,166,.035)';ctx.fillRect(p,h-p-(h-2*p)*65/100,w-2*p,(h-2*p)*65/100);
  ctx.fillStyle='rgba(240,173,91,.045)';ctx.fillRect(p,h-p-(h-2*p)*80/100,w-2*p,(h-2*p)*15/100);
  ctx.fillStyle='rgba(240,100,110,.05)';ctx.fillRect(p,p,w-2*p,(h-2*p)*20/100);
  ctx.strokeStyle='rgba(255,255,255,.045)';ctx.lineWidth=1;
  [20,40,60,80].forEach(v=>{const y=h-p-(h-2*p)*v/100;ctx.beginPath();ctx.moveTo(p,y);ctx.lineTo(w-p,y);ctx.stroke()});
  if (history.length < 2) return;
  const grad=ctx.createLinearGradient(0,0,0,h);grad.addColorStop(0,'rgba(128,143,255,.4)');grad.addColorStop(1,'rgba(128,143,255,0)');
  const pts=history.map((d,i)=>({x:p+(w-2*p)*i/(history.length-1),y:h-p-(h-2*p)*d.contextPercent/100}));
  ctx.beginPath();ctx.moveTo(pts[0].x,h-p);pts.forEach(q=>ctx.lineTo(q.x,q.y));ctx.lineTo(pts.at(-1).x,h-p);ctx.closePath();ctx.fillStyle=grad;ctx.fill();
  ctx.beginPath();pts.forEach((q,i)=>i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y));ctx.strokeStyle='#8e9aff';ctx.lineWidth=2;ctx.stroke();
  const latest=pts[pts.length-1];ctx.beginPath();ctx.arc(latest.x,latest.y,3.5,0,Math.PI*2);ctx.fillStyle=current>=80?'#f0646e':current>=65?'#f0ad5b':'#8e9aff';ctx.fill();
}

function renderGallery(items) {
  currentScreenshots=items;
  $('shotCount').textContent = `${items.length} 张 · 右键删除`;
  $('overviewShots').innerHTML=items.length?items.slice(0,4).map((item,index)=>`<button class="overview-shot-button" data-overview-shot="${index}" title="点击预览 ${escapeHtml(item.name)}"><img src="${item.url}" alt="最近截图"></button>`).join(''):'<span class="empty-mini">还没有截图</span>';
  const scanning=items.filter(item=>item.ocrStatus===0||item.ocrStatus===1).length;
  $('ocrBadge').textContent=scanning?`OCR 识别中 ${scanning}`:'OCR 本地识别';
  if (!items.length) { $('gallery').innerHTML=`<div class="empty">${$('shotSearch').value.trim()?'没有匹配的截图，换个关键词试试吧':'还没有截图，留住第一个灵感瞬间吧'}</div>`; updateOverflow(); return; }
  $('gallery').innerHTML=items.map((item,index)=>`<button class="shot" data-index="${index}"><img src="${item.url}" alt="桌面截图">${item.favorite?'<b class="shot-favorite">★</b>':''}<b class="shot-category">${escapeHtml(item.category||'截图')}</b><time>${new Date(item.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time><span class="shot-ocr">${item.ocrStatus===1?'识别中':escapeHtml(item.tags||'')}</span></button>`).join('');
  document.querySelectorAll('.shot').forEach(el=>{const item=items[Number(el.dataset.index)];el.onclick=()=>openImageModal(item);el.oncontextmenu=e=>{e.preventDefault();pendingDelete=item.path;$('deleteName').textContent=item.name;$('deleteModal').classList.add('open');$('deleteModal').setAttribute('aria-hidden','false')}});
  document.querySelectorAll('.overview-shot-button').forEach(el=>{const item=items[Number(el.dataset.overviewShot)];el.onclick=()=>openImageModal(item)});
  updateOverflow();
}

function bytes(value) {
  if (!Number.isFinite(value)) return '--';
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function renderSystem(data) {
  $('cpuValue').textContent=`${data.cpuPercent}%`; $('cpuBar').style.width=`${data.cpuPercent}%`;
  $('memoryValue').textContent=`${data.memoryPercent}%`; $('memoryBar').style.width=`${data.memoryPercent}%`;
  $('memoryText').textContent=`${bytes(data.memoryUsed)} / ${bytes(data.memoryTotal)}`;
  $('diskList').innerHTML=(data.disks||[]).map(d=>`<button class="disk-row ${d.usedPercent>=90?'danger':d.usedPercent>=75?'warn':'safe'}" data-disk="${d.name}" title="打开 ${d.name}\\"><b>${d.name}</b><div class="disk-mini"><i style="width:${d.usedPercent}%"></i></div><span>${d.usedPercent}%</span></button>`).join('')||'<small>暂无磁盘数据</small>';
  document.querySelectorAll('.disk-row').forEach(el=>el.onclick=()=>window.pulse.openDisk(el.dataset.disk));
  $('systemUpdated').textContent=`${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})} 刷新`;
  cpuHistory.push(data.cpuPercent); if(cpuHistory.length>36)cpuHistory.shift(); drawCpu();
}

function drawCpu(){
  const canvas=$('cpuCanvas'),rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;const dpr=devicePixelRatio||1;canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;const c=canvas.getContext('2d');c.scale(dpr,dpr);c.clearRect(0,0,rect.width,rect.height);if(cpuHistory.length<2)return;const g=c.createLinearGradient(0,0,0,rect.height);g.addColorStop(0,'rgba(120,137,250,.35)');g.addColorStop(1,'rgba(120,137,250,0)');c.beginPath();cpuHistory.forEach((v,i)=>{const x=rect.width*i/(cpuHistory.length-1),y=rect.height-(v/100)*rect.height;i?c.lineTo(x,y):c.moveTo(x,y)});c.lineTo(rect.width,rect.height);c.lineTo(0,rect.height);c.closePath();c.fillStyle=g;c.fill();c.beginPath();cpuHistory.forEach((v,i)=>{const x=rect.width*i/(cpuHistory.length-1),y=rect.height-(v/100)*rect.height;i?c.lineTo(x,y):c.moveTo(x,y)});c.strokeStyle='#8290f5';c.lineWidth=1.5;c.stroke();
}

function roleById(id){return companionData?.roles?.find(role=>role.id===id)||null}
function roleImageHtml(role){const source=role.builtin?(role.sprite||'assets/yoona-expressions.png'):role.expressions?.[0];return `<img class="${role.builtin?'sprite':''}" src="${source}" alt="${escapeHtml(role.name)}">`}
function renderCompanion(data){
  if(!data)return;companionData=data;currentRole=roleById(data.selectedRoleId)||data.roles?.[0]||null;const color=currentRole?.theme||'#8391ff';$('tab-companion').style.setProperty('--role-color',color);$('letterTime').value=data.endTime||'18:30';$('autoLetter').checked=Boolean(data.autoLetter);applyRoleAvatar();renderLetter(data.letter);
  $('rolesList').innerHTML=(data.roles||[]).map(role=>`<article class="role-card ${role.id===data.selectedRoleId?'active':''}" data-role-id="${escapeHtml(role.id)}"><div class="role-card-avatar">${roleImageHtml(role)}</div><div class="role-card-body"><strong>${escapeHtml(role.name)}${role.builtin?' · 内置':''}</strong><p>${escapeHtml(role.description||'属于你的陪伴角色')}</p><div class="role-card-actions"><button data-role-use="${escapeHtml(role.id)}">${role.id===data.selectedRoleId?'正在陪伴':'使用'}</button>${role.builtin?'':`<button data-role-export="${escapeHtml(role.id)}">导出</button><button data-role-delete="${escapeHtml(role.id)}">删除</button>`}</div></div></article>`).join('');
  document.querySelectorAll('[data-role-use]').forEach(button=>button.onclick=async e=>{e.stopPropagation();renderCompanion(await window.pulse.selectRole(button.dataset.roleUse));lastData&&updateCompanion(lastData.remainingPercent,lastData.contextWindow?lastData.currentContextTokens/lastData.contextWindow*100:0)});
  document.querySelectorAll('[data-role-export]').forEach(button=>button.onclick=async e=>{e.stopPropagation();await window.pulse.exportRole(button.dataset.roleExport);setCompanion('角色包已经导出，可以分享给信任的人。')});
  document.querySelectorAll('[data-role-delete]').forEach(button=>button.onclick=async e=>{e.stopPropagation();renderCompanion(await window.pulse.deleteRole(button.dataset.roleDelete))});
  document.querySelectorAll('.role-card').forEach(card=>card.onclick=async()=>renderCompanion(await window.pulse.selectRole(card.dataset.roleId)));
  drawShareCard();
}

function renderLetter(letter){
  const stats=letter?.stats||{};$('letterTitle').textContent=letter?`${letter.day} · 写给今天的你`:'今天还没有来信';$('letterRole').textContent=letter?.roleName||currentRole?.name||'YoonCode';$('letterGreeting').textContent=letter?.greeting||'当一天的工作告一段落，我会替你整理完成的事和明天的第一步。';$('letterAchievements').innerHTML=letter?.achievements?.length?letter.achievements.map(item=>`<div>${escapeHtml(item)}</div>`).join(''):'<div class="letter-empty">点击“今天先到这里”，收下今天的第一封工作来信。</div>';$('letterTomorrow').textContent=letter?.tomorrow||'等待今天的工作记忆';$('letterClosing').textContent=letter?.closing||'你只管创造，剩下的记忆、守护与陪伴，交给我。';$('letterSource').textContent=letter?.sourceNote||'所有内容默认在本机整理';$('letterAchievementCount').textContent=stats.achievements||0;$('letterStreak').textContent=`${stats.streak||0} 天`;$('letterProtected').textContent=stats.protectedCount||0;$('letterSaved').textContent=`${stats.savedExplanations||0} 次`;$('letterShots').textContent=stats.screenshotCount||0;$('letterSessions').textContent=stats.sessions||0;
}

function letterText(letter){if(!letter)return '今天还没有生成 YoonCode 工作来信。';return [`${letter.greeting}`,'',...letter.achievements.map(item=>`• ${item}`),'',`明天从这里继续：${letter.tomorrow}`,'',letter.closing,'',letter.sourceNote].join('\n')}
function canvasLines(ctx,text,maxWidth){const chars=[...String(text||'')],lines=[];let line='';for(const char of chars){const test=line+char;if(ctx.measureText(test).width>maxWidth&&line){lines.push(line);line=char}else line=test}if(line)lines.push(line);return lines}
function roundedRect(ctx,x,y,w,h,r,fill){ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=fill;ctx.fill()}
function loadCanvasImage(src){return new Promise(resolve=>{if(!src)return resolve(null);const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>resolve(null);image.src=src})}
async function drawShareCard(){
  const canvas=$('shareCanvas');if(!canvas)return;const ctx=canvas.getContext('2d'),letter=companionData?.letter,role=currentRole||{},stats=letter?.stats||{},showName=$('cardShowName')?.checked,showDetails=$('cardShowDetails')?.checked;ctx.clearRect(0,0,1080,1350);let color=role.theme||'#8391ff',panel='rgba(255,255,255,.055)',text='#f3f5fb',muted='#99a3ba';if(shareTemplate==='warm'){const g=ctx.createLinearGradient(0,0,1080,1350);g.addColorStop(0,'#171d38');g.addColorStop(.55,'#10162a');g.addColorStop(1,'#142821');ctx.fillStyle=g;ctx.fillRect(0,0,1080,1350)}else if(shareTemplate==='dev'){ctx.fillStyle='#080c16';ctx.fillRect(0,0,1080,1350);ctx.strokeStyle='rgba(125,141,255,.08)';for(let x=0;x<1080;x+=54){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,1350);ctx.stroke()}for(let y=0;y<1350;y+=54){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(1080,y);ctx.stroke()}panel='rgba(15,22,40,.93)';color='#72dab5'}else{const g=ctx.createRadialGradient(540,400,80,540,650,900);g.addColorStop(0,color);g.addColorStop(.34,'#202750');g.addColorStop(1,'#090d19');ctx.fillStyle=g;ctx.fillRect(0,0,1080,1350);panel='rgba(5,9,19,.38)'}
  ctx.fillStyle=color;ctx.font='700 25px "Segoe UI"';ctx.fillText('YOONCODE',72,78);ctx.fillStyle=muted;ctx.font='22px "Microsoft YaHei"';ctx.fillText('AI WORK COMPANION',72,112);ctx.textAlign='right';ctx.fillText(letter?.day||new Date().toLocaleDateString('zh-CN'),1008,82);ctx.textAlign='left';
  const imgSrc=role.builtin?(role.sprite||'assets/yoona-expressions.png'):role.expressions?.[0],img=await loadCanvasImage(imgSrc);if(img){ctx.save();ctx.beginPath();ctx.roundRect(790,145,218,218,54);ctx.clip();if(role.builtin)ctx.drawImage(img,0,0,img.naturalWidth/5,img.naturalHeight,790,145,218,218);else ctx.drawImage(img,790,145,218,218);ctx.restore()}
  ctx.fillStyle=text;ctx.font='700 58px "Microsoft YaHei"';const title=shareTemplate==='minimal'?'今天的每一步，\n都没有白走。':'今天，也和 AI \n一起走了很远。';title.split('\n').forEach((line,index)=>ctx.fillText(line,72,205+index*76));ctx.fillStyle=muted;ctx.font='25px "Microsoft YaHei"';ctx.fillText(showName&&letter?.displayName?`写给 ${letter.displayName}`:`由 ${role.name||'YoonCode'} 陪你记住`,72,390);
  roundedRect(ctx,72,445,936,235,28,panel);const cards=[['连续协作',`${stats.streak||0} 天`],['守住对话',String(stats.protectedCount||0)],['少重复解释',`${stats.savedExplanations||0} 次`],['今日截图',String(stats.screenshotCount||0)]];cards.forEach((item,index)=>{const x=102+index*224;ctx.fillStyle=muted;ctx.font='22px "Microsoft YaHei"';ctx.fillText(item[0],x,510);ctx.fillStyle=index===1||index===2?'#76d9b7':text;ctx.font='700 42px "Segoe UI","Microsoft YaHei"';ctx.fillText(item[1],x,570)});ctx.fillStyle=muted;ctx.font='20px "Microsoft YaHei"';ctx.fillText('所有统计来自本机真实工作事件',102,635);
  if(showDetails&&letter?.achievements?.length){ctx.fillStyle=text;ctx.font='700 28px "Microsoft YaHei"';ctx.fillText('今天值得记住的事',72,750);ctx.font='23px "Microsoft YaHei"';ctx.fillStyle='#b8c1d4';let y=800;for(const item of letter.achievements.slice(0,3)){for(const line of canvasLines(ctx,`✓  ${item}`,860).slice(0,2)){ctx.fillText(line,88,y);y+=38}y+=15}}
  else{ctx.fillStyle=text;ctx.font='700 30px "Microsoft YaHei"';ctx.fillText('明天从这里继续',72,755);ctx.fillStyle='#b8c1d4';ctx.font='24px "Microsoft YaHei"';let y=808;for(const line of canvasLines(ctx,letter?.tomorrow||'从今天最后停下的地方继续。',880).slice(0,4)){ctx.fillText(line,72,y);y+=39}}
  roundedRect(ctx,72,1090,936,150,26,panel);ctx.fillStyle='#c5cce0';ctx.font='italic 25px "Microsoft YaHei"';let qy=1140;for(const line of canvasLines(ctx,letter?.closing||'你只管创造，剩下的记忆、守护与陪伴，交给我。',850).slice(0,2)){ctx.fillText(line,105,qy);qy+=40}ctx.fillStyle=color;ctx.font='700 20px "Segoe UI"';ctx.fillText(`— ${role.name||'YoonCode'}`,105,1212);ctx.fillStyle='#667187';ctx.font='19px "Microsoft YaHei"';ctx.fillText('YoonCode · 一个会记得你的工作，也会温柔回应你的 AI 桌面伴侣',72,1300);
}

async function makeDailyLetter(force=true){const button=$('finishTodayBtn');button.disabled=true;button.textContent='正在整理今天…';try{const letter=await window.pulse.generateDailyLetter(force);companionData={...(companionData||{}),letter};renderLetter(letter);await drawShareCard();setCompanion('今天的工作来信已经写好啦，辛苦了。')}catch(error){setCompanion(`来信暂时没有写好：${error.message||'请稍后重试'}`)}finally{button.disabled=false;button.textContent='今天先到这里'}}
$('finishTodayBtn').onclick=()=>makeDailyLetter(true);$('regenerateLetterBtn').onclick=()=>makeDailyLetter(true);$('letterTime').onchange=async()=>renderCompanion(await window.pulse.saveCompanionSettings({endTime:$('letterTime').value,autoLetter:$('autoLetter').checked}));$('autoLetter').onchange=async()=>renderCompanion(await window.pulse.saveCompanionSettings({endTime:$('letterTime').value,autoLetter:$('autoLetter').checked}));
$('copyLetterBtn').onclick=async()=>{await window.pulse.copyLetter(letterText(companionData?.letter));setCompanion('工作来信已经复制好啦。')};$('letterToCardBtn').onclick=()=>{$('.share-studio').scrollIntoView({behavior:'smooth',block:'start'});drawShareCard()};
document.querySelectorAll('.share-template').forEach(button=>button.onclick=()=>{shareTemplate=button.dataset.template;document.querySelectorAll('.share-template').forEach(item=>item.classList.toggle('active',item===button));drawShareCard()});$('cardShowName').onchange=drawShareCard;$('cardShowDetails').onchange=drawShareCard;
$('copyCardBtn').onclick=async()=>{await drawShareCard();await window.pulse.copyShareCard($('shareCanvas').toDataURL('image/png'));setCompanion('协作卡片已经复制，可以分享今天的成果啦。')};$('saveCardBtn').onclick=async()=>{await drawShareCard();const saved=await window.pulse.saveShareCard($('shareCanvas').toDataURL('image/png'));if(saved)setCompanion('协作卡片已经保存好啦。')};
const closeRoleEditor=()=>{$('roleModal').classList.remove('open');$('roleModal').setAttribute('aria-hidden','true')};
$('createRoleBtn').onclick=()=>{$('roleName').value='';$('roleDescription').value='';$('roleTheme').value='#8391ff';$('roleGentle').value='';$('roleLetter').value='';document.querySelectorAll('.roleImage').forEach(input=>input.value='');$('roleEditorHint').textContent='图片和文案只保存在本机';$('roleModal').classList.add('open');$('roleModal').setAttribute('aria-hidden','false')};$('roleClose').onclick=closeRoleEditor;$('roleModal').onclick=e=>{if(e.target===$('roleModal'))closeRoleEditor()};
function readRoleImage(file){return new Promise((resolve,reject)=>{if(!file)return reject(new Error('请选择完整的五档表情图片'));if(file.size>3*1024*1024)return reject(new Error('每张表情图片不能超过 3MB'));const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('表情图片读取失败'));reader.readAsDataURL(file)})}
$('saveRoleBtn').onclick=async()=>{const button=$('saveRoleBtn');button.disabled=true;button.textContent='正在保存…';try{const expressions=await Promise.all([...document.querySelectorAll('.roleImage')].map(input=>readRoleImage(input.files[0]))),gentle=$('roleGentle').value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean),letter=$('roleLetter').value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);const role={name:$('roleName').value,description:$('roleDescription').value,theme:$('roleTheme').value,expressions,messages:{gentle,abundant:gentle,normal:gentle,tight:gentle,context:gentle,letter}};renderCompanion(await window.pulse.saveRole(role));closeRoleEditor();lastData&&updateCompanion(lastData.remainingPercent,lastData.contextWindow?lastData.currentContextTokens/lastData.contextWindow*100:0);setCompanion('新角色已经住进 YoonCode 啦。')}catch(error){$('roleEditorHint').textContent=error.message||'角色保存失败'}finally{button.disabled=false;button.textContent='保存并使用角色'}};
$('importRoleBtn').onclick=async()=>{try{renderCompanion(await window.pulse.importRole());setCompanion('角色包安装完成，新的陪伴已经准备好啦。')}catch(error){setCompanion(`角色包没有安装成功：${error.message||'格式无效'}`)}};

function openImageModal(item){selectedScreenshotItem=item;selectedScreenshot=item.path;$('modalName').textContent=item.name;$('modalImage').src=item.url;$('favoriteImageBtn').textContent=item.favorite?'★ 已收藏':'☆ 收藏';$('modalToast').textContent=item.ocrText?`OCR：${item.ocrText.slice(0,80)}`:'';$('imageModal').classList.add('open');$('imageModal').setAttribute('aria-hidden','false')}
function closeImageModal(){$('imageModal').classList.remove('open');$('imageModal').setAttribute('aria-hidden','true');selectedScreenshot=null;selectedScreenshotItem=null}
function toast(text){$('modalToast').textContent=text;setTimeout(()=>{if($('modalToast').textContent===text)$('modalToast').textContent=''},1800)}

async function setExpanded(value) {
  expanded=value; $('app').classList.toggle('expanded',expanded);
  clearTimeout(peekTimer);
  await window.pulse.setPeek(false);
  await window.pulse.setExpanded(expanded);
  if(expanded){renderGallery(await window.pulse.listScreenshots());requestAnimationFrame(()=>{const session=selectedSession();drawTrend(session?.history||lastData?.history||[]);updateOverflow()});}
}

function updateOverflow(){const panel=document.querySelector('.expanded-content');if(!expanded)return;const apply=()=>panel.classList.toggle('needs-scroll',panel.scrollHeight>panel.clientHeight);requestAnimationFrame(apply);setTimeout(apply,160)}

$('avatarBtn').onclick=()=>{const avatar=$('avatarBtn');avatar.classList.remove('react');void avatar.offsetWidth;avatar.classList.add('react');if(!expanded){setCompanion('先看看今天的整体状态，我会陪你慢慢安排。');setTimeout(async()=>{await setExpanded(true);switchTab('overview')},180)}else if(activeTab!=='overview'){setCompanion('总览已经为你打开，重要状态都在这里。');switchTab('overview')}else{setCompanion('我先安静藏起来，需要时再到顶部找我呀。');setTimeout(()=>setExpanded(false),180)}};
$('captureBtn').onclick=async()=>{const b=$('captureBtn');b.disabled=true;b.textContent='正在捕捉桌面…';try{const r=await window.pulse.takeScreenshot();renderGallery(r.items)}finally{b.disabled=false;b.innerHTML='全屏截图 <kbd>Ctrl Alt F</kbd>'}};
$('regionBtn').onclick=async()=>{const b=$('regionBtn');b.disabled=true;b.textContent='拖拽选择区域…';try{const r=await window.pulse.takeRegionScreenshot();renderGallery(r.items)}finally{b.disabled=false;b.innerHTML='<span>⌗</span> 局部截图 <kbd>Ctrl Alt S</kbd>'}};
$('folderBtn').onclick=()=>window.pulse.openScreenshots();$('minBtn').onclick=()=>window.pulse.minimize();$('closeBtn').onclick=()=>window.pulse.close();
$('overviewOpenShots').onclick=()=>switchTab('screenshots');
document.querySelectorAll('.memory-tab').forEach(button=>button.onclick=()=>switchTab(button.dataset.tab));
$('sessionTitle').onclick=()=>lastData?.workspacePath&&window.pulse.openWorkspace(lastData.workspacePath);
$('modalClose').onclick=closeImageModal;$('imageModal').onclick=e=>{if(e.target===$('imageModal'))closeImageModal()};
$('copyImageBtn').onclick=async()=>{if(selectedScreenshot){await window.pulse.copyScreenshot(selectedScreenshot);toast('已复制到剪贴板')}};
$('editImageBtn').onclick=()=>selectedScreenshot&&openAnnotationEditor();
$('saveAsBtn').onclick=async()=>{if(selectedScreenshot){const saved=await window.pulse.saveScreenshotAs(selectedScreenshot);if(saved)toast('已另存为新文件')}};
$('openFolderModalBtn').onclick=()=>window.pulse.openScreenshots();
addEventListener('keydown',e=>{if(e.key==='Escape'&&$('imageModal').classList.contains('open'))closeImageModal()});
window.addEventListener('resize',()=>lastData&&expanded&&drawTrend(selectedSession()?.history||lastData.history||[]));
// Windows 原生光标监测覆盖整条横条；避免拖拽区域触发错误的 DOM mouseleave。
setInterval(()=>{if(companionPool.length){companionIndex=(companionIndex+1)%companionPool.length;setCompanion(companionPool[companionIndex])}},8500);

(async()=>{window.pulse.onUsage(renderUsage);window.pulse.onSystemStats(renderSystem);window.pulse.onScreenshots(renderGallery);window.pulse.onBugReady(result=>{if(!expanded)setExpanded(true);switchTab('replay');openBugModal(result)});window.pulse.onLetterReady(letter=>{companionData={...(companionData||{}),letter};renderLetter(letter);drawShareCard();setCompanion('今天的工作来信已经替你收好啦。')});window.pulse.onPeek(value=>$('app').classList.toggle('peek',value));window.pulse.onUsageError(m=>{$('syncText').textContent=m;$('liveDot').classList.add('offline')});const [usage,system,shots,manualImage,companion]=await Promise.all([window.pulse.getUsage(),window.pulse.getSystemStats(),window.pulse.listScreenshots(),window.pulse.getManualImage(),window.pulse.getCompanion()]);renderCompanion(companion);renderUsage(usage);renderSystem(system);renderGallery(shots);applyManualImage(manualImage)})();

window.pulse.getUiSettings().then(settings=>renderFontSetting(settings.fontSize)).catch(()=>renderFontSetting('normal'));

const gentleMessages=[
  '忙了这么久，肩膀放松一下，好不好？',
  '别忘了喝一点水，我会替你守着状态。',
  '不需要一次做到完美，慢慢来就很好。',
  '今天也辛苦啦，你已经推进很多了。',
  '眼睛累的话，就看看远处休息半分钟吧。',
  '先完成最重要的一件事，其他的交给稍后的自己。',
  '遇到难题也没关系，我们一点点拆开它。',
  '记得保存重要结论，我不想你白白辛苦呀。',
  '如果思路乱了，就开一个新对话重新呼吸吧。',
  '你的节奏就很好，不用跟任何人比较。',
  '累的时候停一下，不会耽误你成为更好的自己。',
  '我在这里呢，放心专注眼前这一小步。',
  '保持耐心，漂亮的结果正在慢慢长出来。',
  '今天的你也很认真，值得被温柔地肯定。',
  '工作告一段落后，记得奖励自己一点快乐。',
  '上下文和额度我帮你看着，你安心思考就好。',
  '如果心里有点烦，就深呼吸三次再继续吧。',
  '你不必一直高效，平稳地前进也很了不起。'
];

$('companionLine').onclick=()=>{const pool=currentRole?.messages?.gentle?.length?currentRole.messages.gentle:gentleMessages;setCompanion(pool[Math.floor(Math.random()*pool.length)])};
function applyManualImage(url){$('manualCoverImage').src=url||'assets/manual-product.png'}
$('manualChooseImage').onclick=async()=>{const button=$('manualChooseImage');button.disabled=true;button.textContent='正在选择…';try{applyManualImage(await window.pulse.chooseManualImage())}finally{button.disabled=false;button.textContent='自定义封面配图'}};
$('manualResetImage').onclick=async()=>{await window.pulse.resetManualImage();applyManualImage('');};
$('helpBtn').onclick=async e=>{e.stopPropagation();if(!expanded)await setExpanded(true);$('helpModal').classList.add('open');$('helpModal').setAttribute('aria-hidden','false');updateOverflow()};
const closeHelp=async()=>{$('helpModal').classList.remove('open','fullscreen');$('helpModal').setAttribute('aria-hidden','true');if(manualFullscreen){manualFullscreen=false;await window.pulse.setManualFullscreen(false);$('manualFullscreen').textContent='⛶';$('manualFullscreen').title='全屏阅读'}};
const handleHelpClose=e=>{e.preventDefault();e.stopPropagation();closeHelp()};
function bindReliableManualButton(button,action){let pointerAt=0;button.addEventListener('pointerdown',e=>{if(e.button!==0)return;pointerAt=Date.now();e.preventDefault();e.stopPropagation();action(e)});button.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();if(Date.now()-pointerAt>500)action(e)})}
bindReliableManualButton($('helpClose'),handleHelpClose);
$('helpModal').onclick=e=>{if(e.target===$('helpModal'))closeHelp()};
bindReliableManualButton($('manualFullscreen'),async()=>{if(manualTransitioning)return;manualTransitioning=true;try{manualFullscreen=!manualFullscreen;$('helpModal').classList.toggle('fullscreen',manualFullscreen);$('manualFullscreen').textContent=manualFullscreen?'↙':'⛶';$('manualFullscreen').title=manualFullscreen?'退出全屏':'全屏阅读';await window.pulse.setManualFullscreen(manualFullscreen);updateOverflow()}finally{manualTransitioning=false}});
function renderFontSetting(mode){fontSizeMode=mode||'normal';document.querySelectorAll('[data-font-size]').forEach(button=>button.classList.toggle('active',button.dataset.fontSize===fontSizeMode))}
const closeSettings=()=>{$('settingsModal').classList.remove('open');$('settingsModal').setAttribute('aria-hidden','true')};
$('settingsBtn').onclick=async e=>{e.preventDefault();e.stopPropagation();if(!expanded)await setExpanded(true);$('settingsModal').classList.add('open');$('settingsModal').setAttribute('aria-hidden','false');renderFontSetting(fontSizeMode)};
$('settingsClose').onclick=closeSettings;
$('settingsModal').onclick=e=>{if(e.target===$('settingsModal'))closeSettings()};
document.querySelectorAll('[data-font-size]').forEach(button=>button.onclick=async()=>{const result=await window.pulse.setFontSize(button.dataset.fontSize);renderFontSetting(result.fontSize);setCompanion(result.fontSize==='large'?'字已经调大啦，眼睛舒服最重要。':result.fontSize==='medium'?'换成更轻松的阅读大小啦。':'已经恢复正常大小。');updateOverflow()});
$('modalClose').onclick=e=>{e.stopPropagation();closeImageModal()};
addEventListener('keydown',e=>{if(e.key==='Escape'){closeImageModal();closeHelp();closeSettings();closeDelete()}});
window.addEventListener('resize',()=>{if(expanded){lastData&&drawTrend(selectedSession()?.history||lastData.history||[]);updateOverflow()}});
const closeDelete=()=>{$('deleteModal').classList.remove('open');$('deleteModal').setAttribute('aria-hidden','true');pendingDelete=null};
$('deleteCancel').onclick=closeDelete;
$('deleteModal').onclick=e=>{if(e.target===$('deleteModal'))closeDelete()};
$('deleteConfirm').onclick=async()=>{if(!pendingDelete)return;const target=pendingDelete;const result=await window.pulse.deleteScreenshot(target);closeDelete();renderGallery(result.items);if(selectedScreenshot===target)closeImageModal()};

async function generateHandoff(){
  const button=$('generateHandoffBtn');button.disabled=true;button.textContent='正在整理当前对话…';
  try{
    const result=await window.pulse.generateHandoff(selectedSessionPath);
    $('handoffEditor').value=result.text;$('handoffGoals').textContent=`目标 ${result.stats.objectives} 项`;$('handoffDone').textContent=`完成 ${result.stats.completed} 项`;$('handoffFiles').textContent=`文件 ${result.stats.files} 个`;$('handoffPending').textContent=`待办 ${result.stats.pending} 项`;
    $('memoryGoalChip').textContent=`目标 ${result.stats.objectives} 项`;$('memoryDecisionChip').textContent=`进展 ${result.stats.completed} 条`;$('memoryFileChip').textContent=`文件 ${result.stats.files} 个`;$('memoryTodoChip').textContent=`待办 ${result.stats.pending} 项`;$('memoryReadyState').textContent='记忆舱已就绪';
    $('handoffModal').classList.add('open');$('handoffModal').setAttribute('aria-hidden','false');
  }catch(error){setCompanion(`续聊包暂时没有生成成功：${error.message||'请稍后重试'}`)}finally{button.disabled=false;button.textContent='生成续聊包'}
}
const closeHandoff=()=>{$('handoffModal').classList.remove('open');$('handoffModal').setAttribute('aria-hidden','true')};
$('generateHandoffBtn').onclick=generateHandoff;$('regenerateHandoff').onclick=generateHandoff;$('handoffClose').onclick=closeHandoff;$('handoffModal').onclick=e=>{if(e.target===$('handoffModal'))closeHandoff()};
$('selectedHandoffBtn').onclick=generateHandoff;
$('memoryGenerateBtn').onclick=generateHandoff;
$('cockpitOpenWorkspace').onclick=()=>lastData?.workspacePath&&window.pulse.openWorkspace(lastData.workspacePath);$('cockpitOpenShots').onclick=()=>window.pulse.openScreenshots();
$('copyShareBtn').onclick=async()=>{if(!lastData)return;const risks=(lastData.sessions||[]).filter(item=>item.contextPercent>=65).length;const text=`YoonCode 今日协作摘要\n最近对话：${(lastData.sessions||[]).length} 个\n需要关注：${risks} 个\n累计 Token：${compact(lastData.totalTokens)}\n${risks?'允码伴侣已经准备好高风险对话的续聊包。':'今天的对话上下文状态良好。'}`;await window.pulse.copyHandoff(text);setCompanion('今日协作摘要已经复制好啦，可以放心分享。')};

function openBugModal(result){$('bugEditor').value=result.text||'';$('bugPreview').src=result.screenshotPath?`file://${result.screenshotPath.replace(/\\/g,'/')}`:'';$('bugSessionName').textContent=result.sessionTitle||'当前对话';$('bugModal').classList.add('open');$('bugModal').setAttribute('aria-hidden','false');if(result.screenshotItems)renderGallery(result.screenshotItems)}
const closeBug=()=>{$('bugModal').classList.remove('open');$('bugModal').setAttribute('aria-hidden','true')};
async function generateBug(){const button=$('generateBugBtn');button.disabled=true;button.textContent='正在捕捉故障现场…';try{const result=await window.pulse.generateBugCapsule();openBugModal(result)}catch(error){setCompanion(`故障胶囊暂时没有生成成功：${error.message||'请稍后重试'}`)}finally{button.disabled=false;button.textContent='生成故障胶囊'}}
$('generateBugBtn').onclick=generateBug;$('regenerateBug').onclick=generateBug;$('bugClose').onclick=closeBug;$('bugModal').onclick=e=>{if(e.target===$('bugModal'))closeBug()};$('copyBugBtn').onclick=async()=>{await window.pulse.copyBugCapsule($('bugEditor').value);$('bugToast').textContent='故障胶囊已复制，可以直接粘贴给 Codex';setTimeout(()=>{$('bugToast').textContent=''},2200)};
$('copyHandoffBtn').onclick=async()=>{const session=selectedSession();await window.pulse.copyHandoff($('handoffEditor').value,{contextPercent:session?.contextPercent||0,sessionTitle:session?.title||''});$('handoffToast').textContent='已复制，可以粘贴到新的 Codex 对话';setTimeout(()=>{$('handoffToast').textContent=''},2200)};

let shotSearchTimer=null;$('shotSearch').oninput=e=>{clearTimeout(shotSearchTimer);shotSearchTimer=setTimeout(async()=>renderGallery(await window.pulse.searchScreenshots(e.target.value)),240)};
$('favoriteImageBtn').onclick=async()=>{if(!selectedScreenshotItem)return;const items=await window.pulse.favoriteScreenshot(selectedScreenshot,!selectedScreenshotItem.favorite);const updated=items.find(item=>item.path===selectedScreenshot);renderGallery(items);if(updated)openImageModal(updated)};
const closeTag=()=>{$('tagModal').classList.remove('open');$('tagModal').setAttribute('aria-hidden','true')};
$('tagImageBtn').onclick=()=>{if(!selectedScreenshotItem)return;$('tagInput').value=selectedScreenshotItem.tags||'';$('tagModal').classList.add('open');$('tagModal').setAttribute('aria-hidden','false');setTimeout(()=>$('tagInput').focus(),50)};
$('tagCancel').onclick=closeTag;$('tagModal').onclick=e=>{if(e.target===$('tagModal'))closeTag()};
$('tagSave').onclick=async()=>{if(!selectedScreenshotItem)return;const items=await window.pulse.tagScreenshot(selectedScreenshot,$('tagInput').value);const updated=items.find(item=>item.path===selectedScreenshot);closeTag();renderGallery(items);if(updated)openImageModal(updated)};

const annotation={tool:'rect',color:'#ff5f6d',actions:[],drawing:false,start:null,current:null,image:null};
const annotationHints={rect:'拖拽即可画矩形',arrow:'从箭尾拖向箭头方向',text:'先输入文字，再点击图片放置',mosaic:'拖拽需要模糊的区域'};
function annotationPoint(event){const canvas=$('annotationCanvas'),rect=canvas.getBoundingClientRect();return{x:(event.clientX-rect.left)*canvas.width/rect.width,y:(event.clientY-rect.top)*canvas.height/rect.height}}
function drawArrow(ctx,a){const angle=Math.atan2(a.y2-a.y1,a.x2-a.x1),head=Math.max(14,Math.min(34,ctx.canvas.width/45));ctx.beginPath();ctx.moveTo(a.x1,a.y1);ctx.lineTo(a.x2,a.y2);ctx.stroke();ctx.beginPath();ctx.moveTo(a.x2,a.y2);ctx.lineTo(a.x2-head*Math.cos(angle-Math.PI/6),a.y2-head*Math.sin(angle-Math.PI/6));ctx.moveTo(a.x2,a.y2);ctx.lineTo(a.x2-head*Math.cos(angle+Math.PI/6),a.y2-head*Math.sin(angle+Math.PI/6));ctx.stroke()}
function drawAnnotationAction(ctx,a){
  ctx.save();ctx.strokeStyle=a.color;ctx.fillStyle=a.color;ctx.lineWidth=Math.max(4,ctx.canvas.width/420);ctx.lineCap='round';ctx.lineJoin='round';
  if(a.tool==='rect')ctx.strokeRect(a.x1,a.y1,a.x2-a.x1,a.y2-a.y1);
  else if(a.tool==='arrow')drawArrow(ctx,a);
  else if(a.tool==='text'){ctx.font=`700 ${Math.max(24,ctx.canvas.width/38)}px "Microsoft YaHei",sans-serif`;ctx.lineWidth=Math.max(3,ctx.canvas.width/700);ctx.strokeStyle='rgba(0,0,0,.72)';ctx.strokeText(a.text,a.x1,a.y1);ctx.fillText(a.text,a.x1,a.y1)}
  else if(a.tool==='mosaic'){
    const x=Math.min(a.x1,a.x2),y=Math.min(a.y1,a.y2),w=Math.abs(a.x2-a.x1),h=Math.abs(a.y2-a.y1);if(w>2&&h>2){const size=Math.max(4,Math.round(Math.min(w,h)/18)),temp=document.createElement('canvas');temp.width=Math.max(1,Math.round(w/size));temp.height=Math.max(1,Math.round(h/size));const tc=temp.getContext('2d');tc.drawImage(ctx.canvas,x,y,w,h,0,0,temp.width,temp.height);ctx.imageSmoothingEnabled=false;ctx.drawImage(temp,0,0,temp.width,temp.height,x,y,w,h);ctx.imageSmoothingEnabled=true}
  }
  ctx.restore();
}
function redrawAnnotation(preview=null){const canvas=$('annotationCanvas'),ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);if(annotation.image)ctx.drawImage(annotation.image,0,0,canvas.width,canvas.height);annotation.actions.forEach(a=>drawAnnotationAction(ctx,a));if(preview)drawAnnotationAction(ctx,preview)}
function closeAnnotation(){$('annotationModal').classList.remove('open');$('annotationModal').setAttribute('aria-hidden','true');annotation.drawing=false}
function openAnnotationEditor(){
  const source=selectedScreenshotItem;if(!source)return;const img=new Image();img.onload=()=>{annotation.image=img;annotation.actions=[];const canvas=$('annotationCanvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;redrawAnnotation();$('annotationModal').classList.add('open');$('annotationModal').setAttribute('aria-hidden','false')};img.src=source.url;
}
document.querySelectorAll('.annotation-tool').forEach(button=>button.onclick=()=>{annotation.tool=button.dataset.tool;document.querySelectorAll('.annotation-tool').forEach(item=>item.classList.toggle('active',item===button));$('annotationHint').textContent=annotationHints[annotation.tool]});
$('annotationColor').oninput=e=>annotation.color=e.target.value;
const annotationCanvas=$('annotationCanvas');
annotationCanvas.onpointerdown=e=>{const point=annotationPoint(e);if(annotation.tool==='text'){const text=$('annotationText').value.trim();if(!text){$('annotationHint').textContent='请先在上方输入要标注的文字';$('annotationText').focus();return}annotation.actions.push({tool:'text',color:annotation.color,x1:point.x,y1:point.y,text});redrawAnnotation();return}annotation.drawing=true;annotation.start=point;annotation.current=point;annotationCanvas.setPointerCapture(e.pointerId)};
annotationCanvas.onpointermove=e=>{if(!annotation.drawing)return;annotation.current=annotationPoint(e);redrawAnnotation({tool:annotation.tool,color:annotation.color,x1:annotation.start.x,y1:annotation.start.y,x2:annotation.current.x,y2:annotation.current.y})};
annotationCanvas.onpointerup=e=>{if(!annotation.drawing)return;annotation.drawing=false;const end=annotationPoint(e),distance=Math.hypot(end.x-annotation.start.x,end.y-annotation.start.y);if(distance>5)annotation.actions.push({tool:annotation.tool,color:annotation.color,x1:annotation.start.x,y1:annotation.start.y,x2:end.x,y2:end.y});redrawAnnotation()};
$('annotationUndo').onclick=()=>{annotation.actions.pop();redrawAnnotation()};$('annotationClear').onclick=()=>{annotation.actions=[];redrawAnnotation()};
$('annotationClose').onclick=closeAnnotation;$('annotationModal').onclick=e=>{if(e.target===$('annotationModal'))closeAnnotation()};
$('annotationSave').onclick=async()=>{if(!selectedScreenshot)return;const button=$('annotationSave');button.disabled=true;button.textContent='正在保存…';try{redrawAnnotation();const result=await window.pulse.saveAnnotation(selectedScreenshot,$('annotationCanvas').toDataURL('image/png'));closeAnnotation();closeImageModal();renderGallery(result.items)}finally{button.disabled=false;button.textContent='保存为新截图'}};
addEventListener('keydown',e=>{if(e.key==='Escape'){closeHandoff();closeTag();closeAnnotation();closeBug()}});
