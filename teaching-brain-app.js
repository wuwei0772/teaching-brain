/* global supabase */
'use strict';

var CONFIG_KEY = 'teaching_brain_supabase_config_v1';
var LEGACY_OUTCOME_KEY = 'teaching_brain_outcomes_v1';
var LEGACY_MIGRATION_KEY = 'teaching_brain_outcomes_migrated_v1';
var FILE_BUCKET = 'teaching-brain-files';
var SB = { client: null, connected: false, workspaceId: '', user: null, channel: null };
var EDIT_STATE = { type: null, id: null };
var _cache = { result: [], insight: [], lessonPlans: [], usage: [], feedback: [] };
var _outcomeFilter = 'teaching';
var _outcomeDateFilter = 'all';
var _insightStatusFilter = '全部';
var _realtimeTimer = null;
var _toastTimer = null;
var _confirmResolve = null;

var OUTCOME_TYPES = [
  { key:'teaching', name:'教学案例', library:'教学案例库', fields:[
    ['title','案例标题','text',true],['lesson','课程 / Lesson','text',true],['problem','问题描述','textarea',true],
    ['solution','解决方案','textarea',true],['result','结果反馈','textarea',true],['reusableAdvice','可复用建议','textarea',false],['submittedBy','提交人','text',true]
  ]},
  { key:'score', name:'高分案例', library:'高分案例库', fields:[
    ['studentName','学生昵称','text',true],['courseType','课程体系','text',true],['startingLevel','起点水平','text',true],
    ['finalScore','最终成绩','text',true],['successFactors','关键成功因素','textarea',true],['studyPeriod','学习周期','text',false],['submittedBy','提交人','text',true]
  ]},
  { key:'feedback', name:'家长好评', library:'家长好评库', fields:[
    ['studentName','学生昵称','text',false],['teacher','教师','text',true],['feedback','好评内容','textarea',true],
    ['source','来源','select',true,['微信','企业微信','问卷','电话回访']],['authorized','是否授权公开','select',true,['是','否']],['submittedBy','提交人','text',true]
  ]},
  { key:'work', name:'学生作品', library:'学生作品库', fields:[
    ['studentName','学生昵称','text',true],['lesson','课程 / Lesson','text',true],['workTitle','作品标题','text',true],
    ['workType','作品类型','select',true,['作文','演讲视频','口语录音','项目作品','其他']],['workLink','作品链接或文件上传','fileLink',true],
    ['teacherComment','教师点评','textarea',false],['authorized','是否授权公开','select',true,['是','否']],['submittedBy','提交人','text',true]
  ]}
];

var OUTCOME_LIBRARIES = [
  ['教学案例库','课堂问题 · 解决方案 · 可复用建议','teaching'],
  ['教师培训资料','Trial 课 · 课堂方法 · 培训 PPT','training'],
  ['高分案例库','KET · PET · FCE 实考成绩案例','score'],
  ['家长好评库','好评内容 · 来源 · 使用授权','feedback'],
  ['学生作品库','作文 · 演讲视频 · 口语录音','work'],
  ['数据看板库','续费率 · 退费率 · 实考通过率','dashboard'],
  ['AI助手提示词库','备课助手 · 复盘助手 · 培训助手','ai'],
  ['洞察检查库','待分析 · 待执行 · 执行验证','insight']
];

function showToast(msg, type) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function() { el.className = 'toast'; }, 3000);
}

function setCloudStatus(message, connected) {
  var el = document.getElementById('cloud-status');
  el.textContent = message;
  el.className = 'cloud-status' + (connected ? ' connected' : '');
  document.getElementById('logout-btn').style.display = connected ? '' : 'none';
}

function gv(id) {
  var el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function sv(id, value) {
  var el = document.getElementById(id);
  if (el) el.value = value || '';
}

function clearEl(id) {
  sv(id, '');
  var el = document.getElementById(id);
  if (el) el.classList.remove('error');
}

function clearForm(prefix, fields) {
  fields.forEach(function(field) { clearEl(prefix + '-' + field); });
}

function validateReq(ids) {
  var valid = true;
  ids.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (!el.value.trim()) { el.classList.add('error'); valid = false; }
    else el.classList.remove('error');
  });
  return valid;
}

function escHtml(value) {
  return String(value || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(value) {
  return value ? String(value).replace('T',' ').slice(0,16) : '—';
}

function tr(value, length) {
  if (!value) return '<span style="color:var(--text-light)">—</span>';
  value = String(value);
  return value.length > length ? value.slice(0, length) + '…' : value;
}

function toggleAccordion(header) { header.parentElement.classList.toggle('open'); }

function filterProgress(status, btn) {
  document.querySelectorAll('.filter-btn').forEach(function(item) { item.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('.progress-row').forEach(function(row) {
    row.style.display = status === 'all' || row.dataset.status === status ? '' : 'none';
  });
}

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); }
  catch (error) { return {}; }
}

function saveConfig(url, key) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ url: url, key: key }));
  localStorage.removeItem('sb_url');
  localStorage.removeItem('sb_key');
}

function createSupabaseClient(url, key) {
  if (!window.supabase || !window.supabase.createClient) throw new Error('Supabase 客户端加载失败');
  SB.client = window.supabase.createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  saveConfig(url, key);
}

async function loginSupabase() {
  try {
    var url = gv('sb-url').replace(/\/$/, '');
    var key = gv('sb-key');
    var email = gv('sb-email');
    var password = gv('sb-password');
    if (!url || !key || !email || !password) throw new Error('请填写 Supabase URL、Publishable Key、邮箱和密码');
    createSupabaseClient(url, key);
    var response = await SB.client.auth.signInWithPassword({ email: email, password: password });
    if (response.error) throw response.error;
    await connectAuthenticatedUser(response.data.user);
  } catch (error) {
    setCloudStatus('连接失败：' + error.message, false);
    showToast('登录失败：' + error.message, 'error');
  }
}

async function signupSupabase() {
  try {
    var url = gv('sb-url').replace(/\/$/, '');
    var key = gv('sb-key');
    var email = gv('sb-email');
    var password = gv('sb-password');
    if (!url || !key || !email || !password) throw new Error('请填写 Supabase URL、Publishable Key、邮箱和密码');
    createSupabaseClient(url, key);
    var response = await SB.client.auth.signUp({ email: email, password: password });
    if (response.error) throw response.error;
    if (response.data.session) await connectAuthenticatedUser(response.data.user);
    else setCloudStatus('注册成功，请按邮件提示验证邮箱后登录', false);
    showToast('注册请求已提交', 'success');
  } catch (error) {
    showToast('注册失败：' + error.message, 'error');
  }
}

async function logoutSupabase() {
  if (SB.channel) SB.client.removeChannel(SB.channel);
  if (SB.client) await SB.client.auth.signOut();
  SB.connected = false; SB.workspaceId = ''; SB.user = null; SB.channel = null;
  _cache.result = []; _cache.insight = []; _cache.lessonPlans = []; _cache.usage = []; _cache.feedback = [];
  renderOutcomeLibraries(); renderOutcomes(); renderInsightCards();
  setCloudStatus('已退出登录', false);
}

async function connectAuthenticatedUser(user) {
  SB.user = user;
  var membership = await SB.client.from('workspace_members')
    .select('workspace_id, role').eq('user_id', user.id).limit(1).maybeSingle();
  if (membership.error) throw membership.error;
  if (!membership.data) throw new Error('没有可用工作区，请确认数据库迁移已执行');
  SB.workspaceId = membership.data.workspace_id;
  SB.connected = true;
  setCloudStatus('已连接：' + user.email + ' · 实时同步已开启', true);
  subscribeRealtime();
  await refreshAll();
  await migrateLegacyOutcomes();
}

function requireConnection() {
  if (SB.connected) return true;
  showToast('请先登录 Supabase', 'error');
  return false;
}

function subscribeRealtime() {
  if (SB.channel) SB.client.removeChannel(SB.channel);
  SB.channel = SB.client.channel('teaching-brain-' + SB.workspaceId)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'content_items',
      filter: 'workspace_id=eq.' + SB.workspaceId
    }, function() {
      clearTimeout(_realtimeTimer);
      _realtimeTimer = setTimeout(refreshAll, 250);
    }).subscribe();
}

function contentItemToRecord(item) {
  return Object.assign({}, item.content || {}, {
    id: item.id,
    type: item.content_type,
    title: (item.content && item.content.title) || item.title,
    courseCode: item.course_code,
    levelCode: item.level_code,
    unitCode: item.unit_code,
    lessonCode: item.lesson_code,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    status: item.status
  });
}

async function readOptionalPlatformTable(table) {
  var response = await SB.client.from(table).select('*').eq('workspace_id', SB.workspaceId);
  return response.error ? [] : response.data;
}

async function refreshAll() {
  if (!SB.connected) {
    renderOutcomeLibraries(); renderOutcomes(); renderInsightCards();
    return;
  }
  var response = await SB.client.from('content_items').select('*')
    .eq('workspace_id', SB.workspaceId).order('created_at', { ascending: false });
  if (response.error) {
    showToast('加载 Supabase 数据失败：' + response.error.message, 'error');
    return;
  }
  var records = response.data.map(contentItemToRecord);
  _cache.insight = records.filter(function(row) { return row.type === 'insight'; });
  _cache.lessonPlans = records.filter(function(row) { return row.type === 'lesson_plan'; });
  _cache.result = records.filter(function(row) { return row.type !== 'insight' && row.type !== 'lesson_plan'; });
  var platformRows = await Promise.all([
    readOptionalPlatformTable('lesson_usage_records'),
    readOptionalPlatformTable('teacher_feedback')
  ]);
  _cache.usage = platformRows[0];
  _cache.feedback = platformRows[1];
  renderOutcomeLibraries(); renderOutcomes(); renderInsightCards();
}

function readOutcomes() { return _cache.result || []; }
function outcomeTypeByKey(key) { return OUTCOME_TYPES.find(function(type) { return type.key === key; }); }

function renderEntryForms() {
  document.getElementById('outcome-entry-grid').innerHTML = OUTCOME_TYPES.map(function(type) {
    return '<div class="form-card entry-card"><div class="form-card-header"><div class="form-card-title">'+type.name+'录入</div>'
      +'<div class="form-card-subtitle">提交后实时保存到 Supabase '+type.library+'</div></div><div class="form-body">'
      +type.fields.map(function(field) { return renderEntryField(type.key, field); }).join('')
      +'</div><div class="form-footer"><button class="submit-btn" id="'+type.key+'-submit-btn" onclick="submitOutcome(\''+type.key+'\')">提交至'+type.library+'</button>'
      +'<span class="form-error-msg" id="'+type.key+'-err">请补充必填字段</span></div></div>';
  }).join('');
}

function renderEntryField(prefix, field) {
  var key = field[0], label = field[1], kind = field[2], required = field[3], options = field[4] || [];
  var id = prefix + '-' + key, mark = required ? '<span class="req">*</span>' : '';
  if (kind === 'textarea') return '<div class="form-group"><label class="form-label">'+label+mark+'</label><textarea class="form-textarea" id="'+id+'" placeholder="简要填写即可"></textarea></div>';
  if (kind === 'select') return '<div class="form-group"><label class="form-label">'+label+mark+'</label><select class="form-select" id="'+id+'"><option value="">请选择</option>'+options.map(function(option){return '<option>'+option+'</option>';}).join('')+'</select></div>';
  if (kind === 'fileLink') return '<div class="form-group"><label class="form-label">'+label+mark+'</label><input class="form-input" id="'+id+'" placeholder="粘贴链接，或从下方选择文件"><input class="form-input" type="file" id="'+id+'-file" onchange="useSelectedFile(\''+id+'\',this)" style="margin-top:5px;padding:5px"></div>';
  return '<div class="form-group"><label class="form-label">'+label+mark+'</label><input class="form-input" id="'+id+'" placeholder="请填写"></div>';
}

function useSelectedFile(id, input) {
  if (input.files && input.files[0]) sv(id, input.files[0].name);
}

function outcomeDisplayTitle(type, content) {
  return content.title || content.workTitle || content.studentName || content.teacher || type.name;
}

async function submitOutcome(key) {
  if (!requireConnection()) return;
  var type = outcomeTypeByKey(key);
  var required = type.fields.filter(function(field) { return field[3]; }).map(function(field) { return key + '-' + field[0]; });
  if (!validateReq(required)) { document.getElementById(key+'-err').classList.add('visible'); return; }
  document.getElementById(key+'-err').classList.remove('visible');
  var btn = document.getElementById(key + '-submit-btn');
  btn.disabled = true; btn.textContent = '保存中...';
  try {
    var content = {};
    type.fields.forEach(function(field) { content[field[0]] = gv(key + '-' + field[0]); });
    var inserted = await SB.client.from('content_items').insert({
      workspace_id: SB.workspaceId,
      content_type: key,
      title: outcomeDisplayTitle(type, content),
      status: 'published',
      content: content
    }).select().single();
    if (inserted.error) throw inserted.error;
    var fileInput = document.getElementById(key + '-workLink-file');
    if (fileInput && fileInput.files && fileInput.files[0]) {
      await uploadAttachment(inserted.data.id, fileInput.files[0]);
      fileInput.value = '';
    }
    clearForm(key, type.fields.map(function(field) { return field[0]; }));
    await refreshAll();
    selectOutcomeLibrary(key);
    showToast('已实时保存至 ' + type.library, 'success');
  } catch (error) {
    showToast('保存失败：' + error.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '提交至' + type.library;
  }
}

function safeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function uploadAttachment(contentId, file) {
  var path = SB.workspaceId + '/' + contentId + '/' + crypto.randomUUID() + '-' + safeFileName(file.name);
  var upload = await SB.client.storage.from(FILE_BUCKET).upload(path, file, { upsert: false });
  if (upload.error) throw upload.error;
  var metadata = await SB.client.from('attachments').insert({
    content_id: contentId, storage_path: path, file_name: file.name,
    mime_type: file.type || null, size_bytes: file.size
  });
  if (metadata.error) {
    await SB.client.storage.from(FILE_BUCKET).remove([path]);
    throw metadata.error;
  }
}

function renderOutcomeLibraries() {
  var rows = readOutcomes();
  document.getElementById('outcome-library-grid').innerHTML = OUTCOME_LIBRARIES.map(function(lib) {
    var count = lib[2] === 'insight' ? _cache.insight.length : rows.filter(function(row) { return row.type === lib[2]; }).length;
    return '<button class="outcome-btn'+(_outcomeFilter===lib[2]?' active':'')+'" onclick="selectOutcomeLibrary(\''+lib[2]+'\')">'
      +'<div class="outcome-btn-name">'+lib[0]+'</div><div class="outcome-btn-note">'+lib[1]+'</div><div class="outcome-btn-count">'+count+'</div></button>';
  }).join('');
}

function selectOutcomeLibrary(key) {
  _outcomeFilter = key; renderOutcomeLibraries();
  var insightMode = key === 'insight';
  document.querySelector('.outcome-filter-bar').style.display = insightMode ? 'none' : 'flex';
  document.querySelector('#outcomes .lib-table-wrap').style.display = insightMode ? 'none' : 'block';
  document.getElementById('insight-library').style.display = insightMode ? 'block' : 'none';
  insightMode ? renderInsightCards() : renderOutcomes();
}

function setOutcomeDateFilter(days, btn) {
  _outcomeDateFilter = days;
  document.querySelectorAll('.outcome-filter-bar .filter-btn').forEach(function(item) { item.classList.remove('active'); });
  btn.classList.add('active'); renderOutcomes();
}

function outcomeTitle(row) { return row.title || row.workTitle || row.studentName || row.teacher || '未命名内容'; }
function outcomeCourse(row) { return row.lesson || row.courseType || row.source || row.workType || '—'; }
function outcomeSubmitter(row) { return row.submittedBy || row.teacher || '—'; }

function renderOutcomes() {
  var query = gv('outcome-search').toLowerCase(), now = Date.now();
  var rows = readOutcomes().filter(function(row) {
    if (row.type !== _outcomeFilter) return false;
    if (_outcomeDateFilter !== 'all' && now - new Date(row.createdAt).getTime() > Number(_outcomeDateFilter) * 86400000) return false;
    return !query || Object.keys(row).some(function(key) { return String(row[key] || '').toLowerCase().includes(query); });
  });
  var table = document.getElementById('outcome-table'), empty = document.getElementById('outcome-empty');
  if (!rows.length) { table.style.display = 'none'; empty.style.display = ''; return; }
  empty.style.display = 'none'; table.style.display = '';
  document.getElementById('outcome-tbody').innerHTML = rows.map(function(row) {
    return '<tr><td>'+tr(outcomeTitle(row),30)+'</td><td class="muted">'+tr(outcomeCourse(row),24)+'</td><td class="muted">'+tr(outcomeSubmitter(row),16)+'</td>'
      +'<td class="muted">'+fmtDate(row.createdAt)+'</td><td><div class="lib-actions"><button class="lib-action-btn" onclick="viewOutcomeDetail(\''+row.id+'\')">查看详情</button>'
      +'<button class="lib-action-btn" onclick="referenceOutcome(\''+row.id+'\')">引用</button><button class="lib-action-btn" onclick="reviewOutcome(\''+row.id+'\')">复盘</button>'
      +'<button class="lib-action-btn del" onclick="deleteOutcome(\''+row.id+'\')">删除</button></div></td></tr>';
  }).join('');
}

function openPanel() {
  document.getElementById('panel-overlay').classList.add('open');
  document.getElementById('detail-panel').classList.add('open');
}

function closePanel() {
  document.getElementById('panel-overlay').classList.remove('open');
  document.getElementById('detail-panel').classList.remove('open');
  EDIT_STATE.type = null; EDIT_STATE.id = null;
}

function closePanelOverlay(event) { if (event.target === document.getElementById('panel-overlay')) closePanel(); }

function lessonLevelCount(code) {
  return (_cache.lessonPlans || []).filter(function(plan) {
    var platform = plan.platform || {};
    return plan.levelCode === code || String(platform.level || '').toLowerCase().replace(/\s+/g, '-') === code;
  }).length;
}

function lessonLevelCard(name, code, link) {
  var count = lessonLevelCount(code);
  var available = Boolean(link);
  var status = count
    ? '<span class="status-tag status-done">'+count+' 篇已发布</span>'
    : '<span class="status-tag '+(available?'status-in-progress':'status-not-started')+'">'+(available?'网页已接入 · 待同步数据库':'待建设')+'</span>';
  return '<div class="lesson-level-card'+(available?' available':'')+'"><div class="lesson-level-name">'+name+'</div>'
    +'<div class="lesson-level-note">'+name+' 完整教案库</div>'+status
    +(available?'<a class="lesson-level-link" href="'+link+'" target="_blank" rel="noopener">打开 '+name+' 教案库 →</a>':'')+'</div>';
}

function openTeachingLibrary() {
  var published = (_cache.lessonPlans || []).filter(function(plan) { return plan.status === 'published'; }).length;
  var summary = SB.connected
    ? '共享数据库：'+published+' 篇已发布教案 · '+(_cache.usage||[]).length+' 次教师查看 · '+(_cache.feedback||[]).length+' 条教师反馈'
    : '登录共享 Supabase 后，可查看各册教案、教师使用和反馈数据。';
  document.getElementById('panel-title').textContent = '教学教案库';
  document.getElementById('panel-mode-label').textContent = 'Teaching Plan 核心产品 · Teaching Brain 数据看板';
  document.getElementById('panel-footer').style.display = 'none';
  document.getElementById('panel-body').innerHTML =
    '<p class="lesson-level-intro">'+summary+'</p>'
    +'<div class="lesson-level-grid">'
    +lessonLevelCard('Think 1','think-1','')
    +lessonLevelCard('Think 2','think-2','')
    +lessonLevelCard('Think 3','think-3','https://fce-complete-lesson-plans.vercel.app')
    +lessonLevelCard('Think 4','think-4','')
    +'</div>';
  openPanel();
}

function viewOutcomeDetail(id) {
  var row = readOutcomes().find(function(item) { return item.id === id; });
  if (!row) return;
  var type = outcomeTypeByKey(row.type);
  document.getElementById('panel-title').textContent = type ? type.library + '详情' : '内容详情';
  document.getElementById('panel-mode-label').textContent = 'Supabase 实时数据';
  document.getElementById('panel-footer').style.display = 'none';
  document.getElementById('panel-body').innerHTML = (type ? type.fields : []).map(function(field) {
    return '<div class="detail-field"><div class="detail-field-key">'+field[1]+'</div><div class="detail-field-val'+(row[field[0]]?'':' empty')+'">'+escHtml(row[field[0]] || '未填写')+'</div></div>';
  }).join('') + '<div class="detail-field"><div class="detail-field-key">提交时间</div><div class="detail-field-val">'+fmtDate(row.createdAt)+'</div></div>';
  openPanel();
}

async function referenceOutcome(id) {
  var row = readOutcomes().find(function(item) { return item.id === id; });
  if (!row) return;
  var type = outcomeTypeByKey(row.type), text = '【'+(type?type.library:'成果')+'】'+outcomeTitle(row)+'｜'+outcomeCourse(row);
  try { await navigator.clipboard.writeText(text); showToast('引用信息已复制', 'success'); }
  catch (error) { showToast('引用：' + text); }
}

function reviewOutcome(id) {
  var row = readOutcomes().find(function(item) { return item.id === id; });
  if (!row) return;
  sv('i-title', '复盘：' + outcomeTitle(row));
  sv('i-finding', row.result || row.finalScore || row.feedback || row.teacherComment || '');
  sv('i-root_cause', row.solution || row.successFactors || '');
  document.getElementById('insight').scrollIntoView({ behavior: 'smooth' });
  showToast('已带入洞察表单，可继续完成复盘');
}

async function deleteOutcome(id) {
  if (!requireConnection()) return;
  if (!await showConfirm('确认删除这条成果记录？删除后无法恢复。', '确认删除')) return;
  try {
    var files = await SB.client.from('attachments').select('storage_path').eq('content_id', id);
    if (files.error) throw files.error;
    if (files.data.length) {
      var remove = await SB.client.storage.from(FILE_BUCKET).remove(files.data.map(function(file) { return file.storage_path; }));
      if (remove.error) throw remove.error;
    }
    var deleted = await SB.client.from('content_items').delete().eq('id', id);
    if (deleted.error) throw deleted.error;
    await refreshAll(); showToast('已从 Supabase 删除', 'success');
  } catch (error) { showToast('删除失败：' + error.message, 'error'); }
}

async function submitInsight() {
  if (!requireConnection()) return;
  if (!validateReq(['i-title','i-finding'])) { document.getElementById('i-err').classList.add('visible'); return; }
  document.getElementById('i-err').classList.remove('visible');
  var content = { finding: gv('i-finding'), root_cause: gv('i-root_cause'), action_plan: gv('i-action_plan'), owner: gv('i-owner') };
  var inserted = await SB.client.from('content_items').insert({
    workspace_id: SB.workspaceId, content_type: 'insight', title: gv('i-title'),
    status: gv('i-status') || '待分析', content: content
  });
  if (inserted.error) { showToast('添加失败：' + inserted.error.message, 'error'); return; }
  clearForm('i', ['title','finding','root_cause','action_plan','owner']);
  document.getElementById('i-status').value = '待分析';
  await refreshAll(); showToast('洞察已实时保存', 'success');
}

async function loadInsights() { await refreshAll(); }

function filterInsight(status, btn) {
  _insightStatusFilter = status;
  document.querySelectorAll('.insight-status-tab').forEach(function(item) { item.classList.remove('active'); });
  btn.classList.add('active'); renderInsightCards();
}

function renderInsightCards() {
  var rows = (_cache.insight || []).slice();
  var query = (document.getElementById('insight-search').value || '').toLowerCase();
  if (_insightStatusFilter !== '全部') rows = rows.filter(function(row) { return row.status === _insightStatusFilter; });
  if (query) rows = rows.filter(function(row) {
    return (row.title||'').toLowerCase().includes(query) || (row.finding||'').toLowerCase().includes(query) || (row.root_cause||'').toLowerCase().includes(query);
  });
  var grid = document.getElementById('insight-grid');
  if (!rows.length) { grid.innerHTML = '<div class="insight-empty">暂无洞察记录。</div>'; return; }
  grid.innerHTML = rows.map(function(row) {
    return '<div class="insight-card s-'+escHtml(row.status||'待分析')+'"><div class="insight-card-header"><div><div class="insight-card-title">'+escHtml(row.title)+'</div>'
      +'<div class="insight-card-meta">'+(row.owner?'负责人：'+escHtml(row.owner):'')+'</div></div><span class="insight-status-badge badge-'+escHtml(row.status||'待分析')+'">'+escHtml(row.status||'待分析')+'</span></div>'
      +(row.finding?'<div class="insight-section"><div class="insight-section-label">发现</div><div class="insight-section-text">'+escHtml(row.finding)+'</div></div>':'')
      +(row.root_cause?'<div class="insight-section"><div class="insight-section-label">根因</div><div class="insight-section-text">'+escHtml(row.root_cause)+'</div></div>':'')
      +(row.action_plan?'<div class="insight-section"><div class="insight-section-label">行动方案</div><div class="insight-section-text">'+escHtml(row.action_plan)+'</div></div>':'')
      +'<div class="insight-card-footer"><select class="form-select" style="font-size:12px;padding:4px 8px;height:auto;width:auto;" onchange="updateInsightStatus(\''+row.id+'\',this.value)">'
      +['待分析','待执行','执行中','已验证','已关闭'].map(function(status){return '<option'+(row.status===status?' selected':'')+'>'+status+'</option>';}).join('')
      +'</select><button class="insight-action-btn" onclick="openEdit(\'insight\',\''+row.id+'\')">编辑</button>'
      +'<button class="insight-action-btn del" onclick="deleteRecord(\'insight\',\''+row.id+'\')">删除</button></div></div>';
  }).join('');
}

async function updateInsightStatus(id, status) {
  if (!requireConnection()) return;
  var updated = await SB.client.from('content_items').update({ status: status }).eq('id', id);
  if (updated.error) showToast('更新失败：' + updated.error.message, 'error');
  else { await refreshAll(); showToast('状态已更新：' + status, 'success'); }
}

function openEdit(type, id) {
  if (type !== 'insight') return;
  var row = _cache.insight.find(function(item) { return item.id === id; });
  if (!row) return;
  EDIT_STATE = { type: type, id: id };
  document.getElementById('panel-title').textContent = '洞察编辑';
  document.getElementById('panel-mode-label').textContent = '保存后自动生成历史版本';
  document.getElementById('panel-footer').style.display = 'flex';
  document.getElementById('panel-body').innerHTML =
    editField('title','标题',row.title,false) + editField('finding','发现',row.finding,true)
    + editField('root_cause','根因分析',row.root_cause,true) + editField('action_plan','行动方案',row.action_plan,true)
    + editField('owner','负责人',row.owner,false);
  openPanel();
}

function editField(key, label, value, textarea) {
  var input = textarea
    ? '<textarea class="form-textarea" id="edit-'+key+'">'+escHtml(value)+'</textarea>'
    : '<input class="form-input" id="edit-'+key+'" value="'+escHtml(value)+'">';
  return '<div class="detail-edit-group"><label class="detail-edit-label">'+label+'</label>'+input+'</div>';
}

async function saveEdit() {
  if (!requireConnection() || EDIT_STATE.type !== 'insight') return;
  if (!validateReq(['edit-title','edit-finding'])) return;
  var content = { finding: gv('edit-finding'), root_cause: gv('edit-root_cause'), action_plan: gv('edit-action_plan'), owner: gv('edit-owner') };
  var updated = await SB.client.from('content_items').update({ title: gv('edit-title'), content: content }).eq('id', EDIT_STATE.id);
  if (updated.error) showToast('保存失败：' + updated.error.message, 'error');
  else { closePanel(); await refreshAll(); showToast('保存成功，已生成历史版本', 'success'); }
}

async function deleteRecord(type, id) {
  if (type === 'insight') await deleteOutcome(id);
}

async function exportJSON() {
  if (!requireConnection()) return;
  var response = await SB.client.from('content_items').select('*').eq('workspace_id', SB.workspaceId).order('created_at');
  if (response.error) { showToast('导出失败：' + response.error.message, 'error'); return; }
  var blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), content_items: response.data }, null, 2)], { type: 'application/json' });
  var link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'teaching-brain-supabase-backup-' + new Date().toISOString().slice(0,10) + '.json';
  link.click(); URL.revokeObjectURL(link.href);
}

async function importJSON(input) {
  if (!requireConnection()) { input.value = ''; return; }
  var file = input.files[0];
  if (!file || !await showConfirm('导入内容将追加到 Supabase，确认继续？', '确认导入')) { input.value = ''; return; }
  try {
    var payload = JSON.parse(await file.text());
    var rows = payload.content_items || payload.outcomes || [];
    var inserts = rows.map(function(row) {
      if (row.content_type) return { workspace_id: SB.workspaceId, content_type: row.content_type, title: row.title, status: row.status || 'published', content: row.content || {} };
      var type = outcomeTypeByKey(row.type) || { name: '导入内容' };
      var content = Object.assign({}, row); delete content.id; delete content.type; delete content.createdAt;
      return { workspace_id: SB.workspaceId, content_type: row.type || 'teaching', title: outcomeDisplayTitle(type, content), status: 'published', content: content };
    });
    var inserted = await SB.client.from('content_items').insert(inserts);
    if (inserted.error) throw inserted.error;
    await refreshAll(); showToast('已导入 Supabase：' + inserts.length + ' 条', 'success');
  } catch (error) { showToast('导入失败：' + error.message, 'error'); }
  finally { input.value = ''; }
}

async function migrateLegacyOutcomes() {
  if (localStorage.getItem(LEGACY_MIGRATION_KEY) === 'done') return;
  var rows;
  try { rows = JSON.parse(localStorage.getItem(LEGACY_OUTCOME_KEY) || '[]'); }
  catch (error) { rows = []; }
  if (!rows.length) { localStorage.setItem(LEGACY_MIGRATION_KEY, 'done'); return; }
  var inserts = rows.map(function(row) {
    var type = outcomeTypeByKey(row.type) || { name: '迁移内容' };
    var content = Object.assign({}, row); delete content.id; delete content.type; delete content.createdAt;
    return { workspace_id: SB.workspaceId, content_type: row.type || 'teaching', title: outcomeDisplayTitle(type, content), status: 'published', content: content };
  });
  var response = await SB.client.from('content_items').insert(inserts);
  if (response.error) { showToast('本地旧数据迁移失败：' + response.error.message, 'error'); return; }
  localStorage.setItem(LEGACY_MIGRATION_KEY, 'done');
  await refreshAll();
  showToast('已将本地旧案例迁移至 Supabase：' + inserts.length + ' 条', 'success');
}

async function saveLessonPlan(plan) {
  if (!requireConnection()) throw new Error('请先登录 Supabase');
  var payload = {
    workspace_id: SB.workspaceId,
    content_type: 'lesson_plan',
    title: plan.title || '未命名教案',
    status: plan.status || 'draft',
    content: plan.content || plan
  };
  var response = plan.id
    ? await SB.client.from('content_items').update(payload).eq('id', plan.id).select().single()
    : await SB.client.from('content_items').insert(payload).select().single();
  if (response.error) throw response.error;
  return response.data;
}

function showConfirm(message, title) {
  return new Promise(function(resolve) {
    _confirmResolve = resolve;
    document.getElementById('confirm-msg').textContent = message;
    document.getElementById('confirm-title').textContent = title || '确认操作';
    document.getElementById('confirm-overlay').classList.add('open');
  });
}

async function initializeApp() {
  renderEntryForms(); renderOutcomeLibraries(); renderOutcomes(); renderInsightCards();
  document.getElementById('confirm-ok').addEventListener('click', function() {
    document.getElementById('confirm-overlay').classList.remove('open');
    if (_confirmResolve) { _confirmResolve(true); _confirmResolve = null; }
  });
  document.getElementById('confirm-cancel').addEventListener('click', function() {
    document.getElementById('confirm-overlay').classList.remove('open');
    if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; }
  });
  var config = loadConfig();
  sv('sb-url', config.url); sv('sb-key', config.key);
  if (!config.url || !config.key) return;
  try {
    createSupabaseClient(config.url, config.key);
    var session = await SB.client.auth.getSession();
    if (session.data.session) await connectAuthenticatedUser(session.data.session.user);
  } catch (error) {
    setCloudStatus('自动连接失败：' + error.message, false);
  }
}

document.addEventListener('DOMContentLoaded', initializeApp);
