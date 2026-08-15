const $ = selector => document.querySelector(selector);
const stateLabels = { upcoming: '未开始', running: '进行中', ended: '已结束', closed: '已关闭' };
const statusLabels = { queued: '排队中', judging: '测评中', judged: '已完成', format_error: '格式错误（0分）', judge_error: '测评异常', judge_unavailable: '测评器未就绪' };
const resultLabels = { AC: '答案正确', WA: '答案错误', PC: '部分正确', TLE: '超过时间限制', MLE: '超过内存限制', CANNOT_START: '无法启动', FILE_ERROR: '文件错误', RE: '运行错误', INVALID_SPJ: '特殊评测错误', SPJ_TLE: '特殊评测超时', SPJ_RE: '特殊评测运行错误', SKIPPED: '跳过', INTERACTOR_ERROR: '交互器错误', PE: '格式错误', OLE: '输出超过限制' };
let contests = [];
let adminContests = [];
let adminToken = sessionStorage.getItem('oi-admin-token') || '';

function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = bad ? 'show bad' : 'show';
  setTimeout(() => { el.className = ''; }, 3500);
}

async function api(url, options = {}, admin = false) {
  const headers = new Headers(options.headers || {});
  if (admin) headers.set('x-admin-token', adminToken);
  const response = await fetch(url, { ...options, headers });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body.error || body || `请求失败：${response.status}`);
  return body;
}

function formatTime(iso) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

function datetimeLocalValue(iso) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

async function loadContests() {
  contests = await api('/api/contests');
  $('#contest-list').innerHTML = contests.length ? contests.map(contest => `
    <article class="contest-card ${contest.state}">
      <div class="card-top"><span class="state-dot"></span><span>${stateLabels[contest.state]}</span><span class="contest-id">比赛编号 <b>#${contest.id}</b></span></div>
      <h3>${escapeHtml(contest.title)}</h3>
      <p>${escapeHtml(contest.description || '暂无比赛说明')}</p>
      <div class="meta"><span>开始 ${formatTime(contest.startAt)}</span><span>截止 ${formatTime(contest.endAt)}</span><span>${contest.tasks.length} 道题</span></div>
      <a class="open-contest" href="/contest.html?id=${contest.id}">${contest.state === 'upcoming' ? '查看比赛' : '进入比赛'} <span>→</span></a>
    </article>`).join('') : '<p class="empty">还没有比赛。</p>';
}

async function loadHealth() {
  const health = await api('/api/health');
  $('#judge-health').innerHTML = `<span class="pulse ${health.judgeReady ? '' : 'warn'}"></span>${health.judgeReady ? 'LemonLime 测评器已连接' : '网站已启动，Lemon worker 尚未安装'}`;
}

async function adminOverview() {
  const data = await api('/api/admin/overview', {}, true);
  adminContests = data.contests;
  $('#admin-login').hidden = true;
  $('#admin-dashboard').hidden = false;
  $('#admin-contests').innerHTML = data.contests.length ? data.contests.map(contest => `
    <article class="panel admin-contest">
      <div class="admin-title"><div><span class="badge">#${contest.id} · ${stateLabels[contest.state]}</span><div class="editable-contest-title"><h2>${escapeHtml(contest.title)}</h2><button class="rename-contest ghost" data-id="${contest.id}" data-title="${escapeHtml(contest.title)}">修改名称</button></div></div><div class="admin-actions"><label class="switch"><input class="ranking-toggle" data-id="${contest.id}" type="checkbox" ${contest.rankingPublic ? 'checked' : ''}>公开排名</label>${['upcoming', 'running'].includes(contest.state) ? `<button class="close-contest danger-button" data-id="${contest.id}" data-title="${escapeHtml(contest.title)}">立即关闭比赛</button>` : ''}${['closed', 'ended'].includes(contest.state) ? `<button class="delete-contest danger-button" data-id="${contest.id}" data-title="${escapeHtml(contest.title)}">永久删除</button>` : ''}</div></div>
      ${contest.state !== 'closed' ? `<form class="contest-time-form" data-id="${contest.id}" data-start="${datetimeLocalValue(contest.startAt)}" data-end="${datetimeLocalValue(contest.endAt)}"><label>开始时间<input name="startAt" type="datetime-local" required value="${datetimeLocalValue(contest.startAt)}"></label><label>截止时间<input name="endAt" type="datetime-local" required value="${datetimeLocalValue(contest.endAt)}"></label><div class="time-form-actions"><span class="time-save-status" aria-live="polite">未修改</span><button type="button" class="reset-contest-time ghost" disabled>撤销</button><button class="save-contest-time primary" disabled>保存时间</button></div></form>` : ''}
      <div class="registration-line"><span>${contest.participantCount} 名已报名</span>${contest.participantCount ? `<span class="roster-actions"><button class="download-exam-roster primary" data-id="${contest.id}" data-title="${escapeHtml(contest.title)}">下载比赛名单</button><button class="download-roster ghost" data-id="${contest.id}" data-title="${escapeHtml(contest.title)}">下载提交凭证</button></span>` : ''}</div>
      <div class="setup-grid">
        <div class="package-control"><label>公开题目包<input class="problem-package" data-id="${contest.id}" type="file"><span>${contest.hasPackage ? '已上传' : '待上传'}</span></label>${contest.hasPackage ? `<div class="package-actions"><button class="download-admin-package ghost" data-id="${contest.id}" data-kind="package">下载</button><button class="inspect-admin-package ghost" data-id="${contest.id}" data-kind="package">在线查看</button><button class="delete-package danger-button" data-id="${contest.id}" data-kind="package">删除</button></div>` : ''}</div>
        <div class="package-control"><label>Lemon 比赛包 ZIP<input class="lemon-package" data-id="${contest.id}" type="file" accept=".zip"><span>${contest.judgeReady ? `已识别 ${contest.tasks.length} 题` : '待上传：需含唯一 CDF 与 data/'}</span></label>${contest.judgeReady ? `<div class="package-actions"><button class="download-admin-package ghost" data-id="${contest.id}" data-kind="lemon-package">下载</button><button class="inspect-admin-package ghost" data-id="${contest.id}" data-kind="lemon-package">在线查看</button><button class="delete-package danger-button" data-id="${contest.id}" data-kind="lemon-package">删除</button></div>` : ''}</div>
      </div>
      <div class="submission-table">
        <div class="student-manager-head"><h3>参赛选手与提交情况（${contest.participants.length}）</h3>${['upcoming', 'running'].includes(contest.state) ? `<form class="add-student" data-id="${contest.id}"><input name="studentName" required maxlength="40" placeholder="输入学生姓名"><button class="primary">添加学生</button></form>` : ''}</div>
        ${contest.participants.length ? `<table><thead><tr><th>选手</th><th>是否提交</th>${contest.tasks.map(task => `<th>${escapeHtml(task.title)}</th>`).join('')}<th>总分</th><th>操作</th></tr></thead><tbody>${contest.participants.map(student => {
          const submissionActions = student.submissionId ? `<button class="download-submission ghost" data-id="${student.submissionId}" data-name="${escapeHtml(student.studentId)}-v${student.version}.zip">下载文件夹</button><button class="rejudge ghost" data-id="${student.submissionId}">重测</button><button class="reset-attempt ghost" data-id="${student.submissionId}" data-name="${escapeHtml(student.studentName)}">${student.submissionAllowed ? '再次重置提交权限' : '允许再提交一次'}</button>` : '';
          return `<tr><td>${escapeHtml(student.studentName)}<small>${escapeHtml(student.studentId)}</small></td><td>${student.submissionId ? `<b>已提交 v${student.version}</b><small>${statusLabels[student.status] || student.status}</small>` : '<span class="not-submitted">未提交</span>'}</td>${contest.tasks.map(task => { const result = student.taskScores.find(item => item.title === task.title); return `<td>${result ? `<button class="task-result-button" data-submission-id="${student.submissionId}" data-task="${escapeHtml(task.title)}">${result.score}${result.formatError ? '<small>格式错误</small>' : ''}</button>` : '—'}</td>`; }).join('')}<td><strong>${student.score ?? '—'}</strong></td><td><div class="row-actions">${submissionActions}<button class="delete-student danger-button" data-contest-id="${contest.id}" data-student-id="${escapeHtml(student.studentId)}" data-name="${escapeHtml(student.studentName)}" data-submitted="${student.submissionId ? '1' : '0'}">删除学生</button></div></td></tr>`;
        }).join('')}</tbody></table>` : '<p class="empty">还没有参赛学生。</p>'}
      </div>
      ${['ended', 'closed'].includes(contest.state) ? `<div class="submission-table practice-admin-table">
        <div class="student-manager-head"><div><h3>赛后补题情况</h3><small>显示每名学生最近一次自主测评；补题成绩不计入正式成绩和排名。</small></div></div>
        ${contest.participants.length ? `<table><thead><tr><th>选手</th><th>补题状态</th>${contest.tasks.map(task => `<th>${escapeHtml(task.title)}</th>`).join('')}<th>补题总分</th></tr></thead><tbody>${contest.participants.map(student => {
          const practice = student.practice;
          return `<tr><td>${escapeHtml(student.studentName)}<small>${escapeHtml(student.studentId)}</small></td><td>${practice ? `<b>${statusLabels[practice.status] || practice.status}</b><small>${practice.submittedAt ? formatTime(practice.submittedAt) : ''}</small>` : '<span class="not-submitted">未补题</span>'}</td>${contest.tasks.map(task => { const result = practice?.taskScores?.find(item => item.title === task.title); return `<td>${result ? `<button class="task-result-button" data-submission-id="${practice.id}" data-task="${escapeHtml(task.title)}">${result.score}${result.formatError ? '<small>格式错误</small>' : ''}</button>` : '—'}</td>`; }).join('')}<td><strong>${practice?.score ?? '—'}</strong></td></tr>`;
        }).join('')}</tbody></table>` : '<p class="empty">还没有参赛学生。</p>'}
      </div>` : ''}
      <div class="ai-review-panel" data-id="${contest.id}" data-title="${escapeHtml(contest.title)}">
        <div class="student-manager-head"><div><h3>DeepSeek 单人赛后复盘</h3><small>使用 1M 上下文的 deepseek-v4-pro，每次只分析一名学生并生成独立 Markdown 文档。API Key 只保留在当前页面，不会保存。</small></div></div>
        <div class="ai-review-key"><input class="ai-review-api-key" type="password" autocomplete="off" placeholder="输入 DeepSeek API Key"></div>
        <p class="ai-review-privacy">生成时会把所选学生的题目资料、源代码、分数和测试点结果发送给 DeepSeek；姓名不会发送。请先确认符合学校的数据使用要求。</p>
        <div class="ai-review-students">${contest.participants.filter(student => student.submissionId).length ? contest.participants.filter(student => student.submissionId).map(student => `<div class="ai-review-student" data-student-id="${escapeHtml(student.studentId)}"><span><b>${escapeHtml(student.studentName)}</b><small>${escapeHtml(student.studentId)}</small></span><span class="ai-review-status empty">正在读取状态…</span><button class="generate-student-ai-review primary" data-student-name="${escapeHtml(student.studentName)}">生成复盘</button><button class="download-student-ai-review ghost" data-student-name="${escapeHtml(student.studentName)}" hidden>下载</button></div>`).join('') : '<p class="empty">还没有可分析的学生提交。</p>'}</div>
      </div>
      <div class="proctor-panel">
        <div class="student-manager-head"><div><h3>屏幕监考</h3><small>仅保留客户端最新缩略图；约 12 秒未收到心跳即离线。</small></div><button class="refresh-proctor ghost">刷新状态</button></div>
        ${contest.participants.length ? `<div class="proctor-grid">${contest.participants.map(student => `<article class="proctor-card ${student.proctor.online ? 'online' : 'offline'} ${student.proctor.violation ? 'warning' : ''}" data-contest-id="${contest.id}" data-student-id="${escapeHtml(student.studentId)}">
          <div class="proctor-card-head"><strong>${escapeHtml(student.studentName)}</strong><span>${student.proctor.online ? '● 在线' : '○ 离线'}</span></div><small>${escapeHtml(student.studentId)}${student.proctor.lastSeen ? ` · ${formatTime(student.proctor.lastSeen)}` : ''}</small>
          <div class="proctor-screen"><span>${student.proctor.online ? student.proctor.hasScreen ? '正在载入画面…' : '等待画面上报…' : '客户端已离线'}</span></div>
          ${student.proctor.violation ? `<p class="proctor-alert">${escapeHtml(student.proctor.violation)}</p>` : ''}<small>${student.proctor.processes.length ? `进程：${escapeHtml(student.proctor.processes.join('、'))}` : ''}</small>
        </article>`).join('')}</div>` : '<p class="empty">还没有参赛学生。</p>'}
      </div>
    </article>`).join('') : '<p class="empty">先创建第一场比赛。</p>';
  bindAdminActions();
  await Promise.all([loadProctorScreens(), loadAiReviewStatuses()]);
}

function renderAiReviewStatuses(panel, payload) {
  let anyRunning = false;
  for (const status of payload.students || []) {
    const row = [...panel.querySelectorAll('.ai-review-student')].find(item => item.dataset.studentId === status.studentId);
    if (!row) continue;
    const statusBox = row.querySelector('.ai-review-status');
    const running = ['queued', 'running'].includes(status.status);
    anyRunning ||= running;
    row.querySelector('.generate-student-ai-review').disabled = running;
    row.querySelector('.download-student-ai-review').hidden = !status.downloadReady;
    statusBox.className = `ai-review-status ${status.status === 'failed' ? 'bad' : ''}`;
    statusBox.textContent = running ? '正在生成…'
      : status.status === 'ready' ? '已生成'
        : status.status === 'failed' ? `失败：${status.error}` : '尚未生成';
  }
  return anyRunning;
}

async function loadAiReviewStatuses() {
  await Promise.all([...document.querySelectorAll('.ai-review-panel')].map(panel => pollAiReview(panel.dataset.id)));
}

async function pollAiReview(contestId) {
  const panel = document.querySelector(`.ai-review-panel[data-id="${contestId}"]`);
  if (!panel) return;
  try {
    const status = await api(`/api/admin/contests/${contestId}/ai-review/status`, {}, true);
    if (renderAiReviewStatuses(panel, status)) setTimeout(() => pollAiReview(contestId), 3000);
  } catch (error) { toast(error.message, true); }
}

async function loadProctorScreens() {
  await Promise.all([...document.querySelectorAll('.proctor-card.online')].map(async card => {
    const response = await fetch(`/api/admin/contests/${card.dataset.contestId}/proctor/${card.dataset.studentId}/screen`, { headers: { 'x-admin-token': adminToken }, cache: 'no-store' });
    if (!response.ok) return;
    const url = URL.createObjectURL(await response.blob());
    const image = new Image(); image.alt = `${card.dataset.studentId} 屏幕`; image.src = url; image.onload = () => URL.revokeObjectURL(url);
    const screen = card.querySelector('.proctor-screen');
    screen.replaceChildren(image);
    screen.classList.add('has-screen');
    screen.title = '点击放大查看';
    screen.tabIndex = 0;
    screen.addEventListener('click', () => openProctorScreen(card));
    screen.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); openProctorScreen(card); } });
  }));
}

async function openProctorScreen(card) {
  const dialog = $('#proctor-viewer');
  const image = $('#proctor-viewer-image');
  $('#proctor-viewer-title').textContent = `${card.querySelector('.proctor-card-head strong').textContent}（${card.dataset.studentId}）`;
  const response = await fetch(`/api/admin/contests/${card.dataset.contestId}/proctor/${card.dataset.studentId}/screen`, { headers: { 'x-admin-token': adminToken }, cache: 'no-store' });
  if (!response.ok) return toast('暂无可放大的屏幕画面', true);
  const url = URL.createObjectURL(await response.blob());
  image.src = url;
  dialog.showModal();
  dialog.addEventListener('close', () => { URL.revokeObjectURL(url); image.removeAttribute('src'); }, { once: true });
}

$('#proctor-viewer-close').addEventListener('click', () => $('#proctor-viewer').close());
$('#judge-detail-close').addEventListener('click', () => $('#judge-detail-viewer').close());

async function showJudgeDetail(button) {
  const submission = adminContests.flatMap(contest => [
    ...(contest.submissions || []),
    ...(contest.participants || []).map(student => student.practice).filter(Boolean)
  ]).find(item => item.id === Number(button.dataset.submissionId));
  const task = submission?.details?.tasks?.find(item => item.title === button.dataset.task);
  if (!task) return toast('该题尚无测评详情', true);
  $('#judge-detail-title').textContent = `${submission.studentName} · ${task.title} · ${task.score} 分`;
  const compile = task.formatError || task.compile === 'NO_SOURCE' ? task.formatError || '找不到源文件' : task.compile === 'CE' ? `编译错误：${task.compileMessage || ''}` : '';
  $('#judge-detail-content').innerHTML = `${compile ? `<p class="notice">${escapeHtml(compile)}</p>` : ''}${task.cases?.length ? `<div class="judge-case-list"><table><thead><tr><th>测试点</th><th>结果</th><th>得分</th><th>用时</th><th>内存</th></tr></thead><tbody>${task.cases.map(item => `<tr class="case-${escapeHtml(item.result)}"><td>#${item.case}${item.group !== item.case ? `<small>子任务 ${item.group}</small>` : ''}</td><td><b>${escapeHtml(item.result)}</b><small>${escapeHtml(resultLabels[item.result] || item.result)}</small></td><td>${item.score}</td><td>${item.time >= 0 ? `${item.time} ms` : '—'}</td><td>${item.memory >= 0 ? formatFileSize(item.memory) : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">没有测试点结果。</p>'}`;
  $('#judge-detail-viewer').showModal();
}

function bindAdminActions() {
  document.querySelectorAll('.generate-student-ai-review').forEach(button => button.addEventListener('click', async () => {
    const row = button.closest('.ai-review-student');
    const panel = button.closest('.ai-review-panel');
    const apiKey = panel.querySelector('.ai-review-api-key').value.trim();
    if (!apiKey) return toast('请先输入 DeepSeek API Key', true);
    if (!confirm(`将 ${button.dataset.studentName} 的题目、源代码和评测结果发送给 DeepSeek，并按调用量产生费用。确定继续吗？`)) return;
    button.disabled = true;
    try {
      await api(`/api/admin/contests/${panel.dataset.id}/ai-review/${encodeURIComponent(row.dataset.studentId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey }) }, true);
      toast(`${button.dataset.studentName}的复盘任务已开始`); pollAiReview(panel.dataset.id);
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }));
  document.querySelectorAll('.download-student-ai-review').forEach(button => button.addEventListener('click', async () => {
    const row = button.closest('.ai-review-student');
    const panel = button.closest('.ai-review-panel');
    try {
      const response = await fetch(`/api/admin/contests/${panel.dataset.id}/ai-review/${encodeURIComponent(row.dataset.studentId)}/download`, { headers: { 'x-admin-token': adminToken } });
      if (!response.ok) throw new Error((await response.json()).error || '下载失败');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await response.blob());
      link.download = `${panel.dataset.title}-${button.dataset.studentName}-${row.dataset.studentId}-赛后复盘.md`;
      link.click(); URL.revokeObjectURL(link.href);
    } catch (error) { toast(error.message, true); }
  }));
  document.querySelectorAll('.task-result-button').forEach(button => button.addEventListener('click', () => showJudgeDetail(button)));
  document.querySelectorAll('.rename-contest').forEach(button => button.addEventListener('click', async () => {
    const title = prompt('请输入新的比赛名称（最长 80 字）：', button.dataset.title);
    if (title === null) return;
    if (!title.trim()) return toast('比赛名称不能为空', true);
    try {
      await api(`/api/admin/contests/${button.dataset.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.trim() }) }, true);
      toast('比赛名称已修改'); await adminOverview(); await loadContests();
    } catch (error) { toast(error.message, true); }
  }));
  document.querySelectorAll('.contest-time-form').forEach(form => {
    const startInput = form.elements.startAt;
    const endInput = form.elements.endAt;
    const saveButton = form.querySelector('.save-contest-time');
    const resetButton = form.querySelector('.reset-contest-time');
    const status = form.querySelector('.time-save-status');
    const updateState = () => {
      const dirty = startInput.value !== form.dataset.start || endInput.value !== form.dataset.end;
      const valid = startInput.value && endInput.value && new Date(endInput.value) > new Date(startInput.value);
      saveButton.disabled = !dirty || !valid; resetButton.disabled = !dirty;
      status.textContent = !dirty ? '未修改' : valid ? '有未保存修改' : '截止时间必须晚于开始时间';
      status.className = `time-save-status ${dirty ? valid ? 'dirty' : 'bad' : ''}`;
    };
    startInput.addEventListener('input', updateState); endInput.addEventListener('input', updateState);
    resetButton.addEventListener('click', () => { startInput.value = form.dataset.start; endInput.value = form.dataset.end; updateState(); startInput.focus(); });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (saveButton.disabled) return;
      saveButton.disabled = true; resetButton.disabled = true; status.textContent = '正在保存…'; status.className = 'time-save-status saving';
      try {
        const changed = await api(`/api/admin/contests/${form.dataset.id}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ startAt: new Date(startInput.value).toISOString(), endAt: new Date(endInput.value).toISOString() })
        }, true);
        form.dataset.start = datetimeLocalValue(changed.startAt); form.dataset.end = datetimeLocalValue(changed.endAt);
        startInput.value = form.dataset.start; endInput.value = form.dataset.end;
        status.textContent = '✓ 已保存'; status.className = 'time-save-status saved'; saveButton.disabled = true; resetButton.disabled = true;
        setTimeout(() => { if (form.isConnected) updateState(); }, 1800);
        loadContests().catch(() => {});
      } catch (error) { status.textContent = '保存失败'; status.className = 'time-save-status bad'; saveButton.disabled = false; resetButton.disabled = false; toast(error.message, true); }
    });
  });
  document.querySelectorAll('.add-student').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const button = formElement.querySelector('button');
    button.disabled = true;
    try {
      const studentName = new FormData(formElement).get('studentName');
      const student = await api(`/api/admin/contests/${formElement.dataset.id}/participants`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ studentName }) }, true);
      alert(`学生添加成功\n姓名：${student.studentName}\n考号：${student.studentId}\n个人提交码：${student.token}\n\n请立即将考号和提交码交给学生。`);
      await adminOverview();
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }));
  document.querySelectorAll('.delete-student').forEach(button => button.addEventListener('click', async () => {
    const warning = button.dataset.submitted === '1' ? '该学生的提交文件、成绩和排名记录也会永久删除。' : '该学生将从比赛名单中移除。';
    if (!confirm(`确定删除学生“${button.dataset.name}”吗？\n${warning}`)) return;
    button.disabled = true;
    try {
      await api(`/api/admin/contests/${button.dataset.contestId}/participants/${button.dataset.studentId}`, { method: 'DELETE' }, true);
      toast('学生及相关数据已删除');
      await adminOverview(); await loadContests();
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }));
  document.querySelectorAll('.problem-package').forEach(input => input.addEventListener('change', () => uploadAdminFile(input, 'package')));
  document.querySelectorAll('.lemon-package').forEach(input => input.addEventListener('change', () => uploadAdminFile(input, 'lemon-package')));
  document.querySelectorAll('.download-admin-package').forEach(button => button.addEventListener('click', () => downloadAdminPackage(button)));
  document.querySelectorAll('.inspect-admin-package').forEach(button => button.addEventListener('click', () => inspectAdminPackage(button)));
  document.querySelectorAll('.delete-package').forEach(button => button.addEventListener('click', async () => {
    const lemon = button.dataset.kind === 'lemon-package';
    if (!confirm(`确定删除${lemon ? ' Lemon 比赛包' : '公开题目包'}吗？删除后可重新上传新包。`)) return;
    button.disabled = true;
    try {
      await api(`/api/admin/contests/${button.dataset.id}/${button.dataset.kind}`, { method: 'DELETE' }, true);
      toast(`${lemon ? 'Lemon 比赛包' : '公开题目包'}已删除，可以上传新包`);
      await adminOverview(); await loadContests();
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }));
  document.querySelectorAll('.ranking-toggle').forEach(input => input.addEventListener('change', async () => {
    try { await api(`/api/admin/contests/${input.dataset.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rankingPublic: input.checked }) }, true); toast('排名设置已保存'); }
    catch (error) { input.checked = !input.checked; toast(error.message, true); }
  }));
  document.querySelectorAll('.rejudge').forEach(button => button.addEventListener('click', async () => {
    try { await api(`/api/admin/submissions/${button.dataset.id}/rejudge`, { method: 'POST' }, true); toast('已加入重测队列'); setTimeout(adminOverview, 500); }
    catch (error) { toast(error.message, true); }
  }));
  document.querySelectorAll('.download-submission').forEach(button => button.addEventListener('click', () => downloadSubmission(button)));
  document.querySelectorAll('.reset-attempt').forEach(button => button.addEventListener('click', async () => {
    if (!confirm(`确定允许“${button.dataset.name}”再次提交一次吗？可不限次数重复重置，历史提交和成绩会保留。`)) return;
    button.disabled = true;
    try {
      await api(`/api/admin/submissions/${button.dataset.id}/reset-attempt`, { method: 'POST' }, true);
      toast('提交权限已重置；该学生用完后仍可继续重置');
      await adminOverview();
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }));
  document.querySelectorAll('.refresh-proctor').forEach(button => button.addEventListener('click', () => adminOverview().catch(error => toast(error.message, true))));
  document.querySelectorAll('.close-contest').forEach(button => button.addEventListener('click', async () => {
    if (!confirm(`确定立即关闭“${button.dataset.title}”吗？关闭后学生将不能继续提交，且不能在页面中重新开启。`)) return;
    button.disabled = true;
    try {
      await api(`/api/admin/contests/${button.dataset.id}/close`, { method: 'POST' }, true);
      toast('比赛已关闭，新的提交已停止');
      await adminOverview(); await loadContests();
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }));
  document.querySelectorAll('.delete-contest').forEach(button => button.addEventListener('click', async () => {
    const typed = prompt(`此操作会永久删除“${button.dataset.title}”的报名、提交、成绩和比赛文件。\n请输入比赛名称以确认：`);
    if (typed === null) return;
    if (typed !== button.dataset.title) return toast('比赛名称不匹配，未执行删除', true);
    button.disabled = true;
    try {
      await api(`/api/admin/contests/${button.dataset.id}`, { method: 'DELETE' }, true);
      toast('比赛及其全部数据已永久删除');
      await adminOverview(); await loadContests();
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }));
  document.querySelectorAll('.download-exam-roster').forEach(button => button.addEventListener('click', () => downloadRoster(button.dataset.id, button.dataset.title, false)));
  document.querySelectorAll('.download-roster').forEach(button => button.addEventListener('click', () => downloadRoster(button.dataset.id, button.dataset.title, true)));
}

function downloadAdminPackage(button) {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = `/api/admin/contests/${button.dataset.id}/${button.dataset.kind}/download`;
  form.target = '_blank';
  form.hidden = true;
  const token = document.createElement('input');
  token.type = 'hidden'; token.name = 'adminToken'; token.value = adminToken;
  form.append(token); document.body.append(form); form.submit(); form.remove();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function inspectAdminPackage(button) {
  const dialog = $('#package-viewer');
  const content = $('#package-viewer-content');
  $('#package-viewer-title').textContent = button.dataset.kind === 'package' ? '公开题目包' : 'Lemon 比赛包 ZIP';
  content.textContent = '正在读取文件列表…';
  if (!dialog.open) dialog.showModal();
  try {
    const result = await api(`/api/admin/contests/${button.dataset.id}/${button.dataset.kind}/entries`, {}, true);
    if (!result.archive) {
      content.innerHTML = `<p>${escapeHtml(result.filename)} · ${formatFileSize(result.size)}</p>${result.previewable ? `<button class="preview-package-entry primary" data-id="${button.dataset.id}" data-kind="${button.dataset.kind}">打开在线预览</button>` : '<p class="notice">该文件类型或大小不支持在线预览，请使用下载功能。</p>'}`;
    } else {
      content.innerHTML = `<p>共 ${result.entries.length} 个文件，压缩包大小 ${formatFileSize(result.size)}。</p>${result.entries.length ? `<div class="package-entry-list"><table><thead><tr><th>文件</th><th>大小</th><th></th></tr></thead><tbody>${result.entries.map(entry => `<tr><td><code>${escapeHtml(entry.name)}</code></td><td>${formatFileSize(entry.size)}</td><td>${entry.previewable ? `<button class="preview-package-entry ghost" data-id="${button.dataset.id}" data-kind="${button.dataset.kind}" data-path="${escapeHtml(entry.name)}">预览</button>` : '<span class="empty">仅下载</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">压缩包中没有文件。</p>'}`;
    }
    content.querySelectorAll('.preview-package-entry').forEach(preview => preview.addEventListener('click', () => previewAdminPackageFile(preview)));
  } catch (error) { content.innerHTML = `<p class="notice">${escapeHtml(error.message)}</p>`; }
}

async function previewAdminPackageFile(button) {
  const previewWindow = window.open('about:blank', '_blank');
  try {
    if (!previewWindow) throw new Error('浏览器阻止了预览窗口，请允许本站打开新窗口');
    const suffix = button.dataset.path ? `?path=${encodeURIComponent(button.dataset.path)}` : '';
    const result = await api(`/api/admin/contests/${button.dataset.id}/${button.dataset.kind}/preview-ticket${suffix}`, {}, true);
    previewWindow.opener = null;
    previewWindow.location = result.url;
  } catch (error) {
    previewWindow?.close();
    toast(error.message, true);
  }
}

async function downloadSubmission(button) {
  try {
    const response = await fetch(`/api/admin/submissions/${button.dataset.id}/archive`, { headers: { 'x-admin-token': adminToken } });
    if (!response.ok) throw new Error((await response.json()).error || '下载失败');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await response.blob());
    link.download = button.dataset.name;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) { toast(error.message, true); }
}

async function downloadRoster(id, title, includeCredentials) {
  try {
    const response = await fetch(`/api/admin/contests/${id}/${includeCredentials ? 'roster.csv' : 'exam-roster.csv'}`, { headers: { 'x-admin-token': adminToken } });
    if (!response.ok) throw new Error((await response.json()).error || '下载失败');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await response.blob());
    link.download = `${title}-${includeCredentials ? '提交凭证' : '比赛名单'}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) { toast(error.message, true); }
}

function showGeneratedRoster(contestId, roster) {
  const panel = $('#registration-result');
  panel.hidden = false;
  panel.innerHTML = `<div class="section-heading"><div><p class="eyebrow">REGISTRATION</p><h2>比赛名单已生成</h2></div><span class="roster-actions"><button id="download-new-exam-roster" class="primary">首先下载比赛名单</button><button id="download-new-roster" class="ghost">下载提交凭证</button></span></div>
    <p>共生成 ${roster.length} 个随机考号。比赛名单只含姓名和考号；提交凭证另含个人提交码，请由管理员妥善分发。</p>
    <div class="roster-preview"><table><thead><tr><th>姓名</th><th>考号</th></tr></thead><tbody>${roster.slice(0, 20).map(row => `<tr><td>${escapeHtml(row.studentName)}</td><td><b>${escapeHtml(row.studentId)}</b></td></tr>`).join('')}</tbody></table>${roster.length > 20 ? `<p class="empty">仅预览前 20 人，完整内容请下载比赛名单。</p>` : ''}</div>`;
  $('#download-new-exam-roster').addEventListener('click', () => downloadRoster(contestId, '比赛', false));
  $('#download-new-roster').addEventListener('click', () => downloadRoster(contestId, '比赛', true));
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function uploadAdminFile(input, endpoint) {
  const file = input.files[0];
  if (!file) return;
  input.disabled = true;
  try {
    const suffix = endpoint === 'package' ? `?filename=${encodeURIComponent(file.name)}` : '';
    const result = await api(`/api/admin/contests/${input.dataset.id}/${endpoint}${suffix}`, { method: 'PUT', body: file, headers: { 'content-type': 'application/octet-stream' } }, true);
    toast(endpoint === 'package' ? '公开题目包已上传' : `Lemon 比赛包已识别：${result.tasks.map(t => t.title).join('、')}`);
    await adminOverview(); await loadContests();
  } catch (error) { toast(error.message, true); }
  finally { input.disabled = false; }
}

document.querySelectorAll('.nav-button').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.nav-button').forEach(item => item.classList.toggle('active', item === button));
  document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
  $(`#${button.dataset.view}-view`).classList.add('active');
  if (button.dataset.view === 'admin' && adminToken) adminOverview().catch(error => { adminToken = ''; sessionStorage.removeItem('oi-admin-token'); toast(error.message, true); });
}));
$('#admin-login-form').addEventListener('submit', async event => {
  event.preventDefault();
  adminToken = $('#admin-token').value;
  try { await adminOverview(); sessionStorage.setItem('oi-admin-token', adminToken); }
  catch (error) { adminToken = ''; toast(error.message, true); }
});
$('#admin-logout').addEventListener('click', () => { adminToken = ''; sessionStorage.removeItem('oi-admin-token'); $('#admin-dashboard').hidden = true; $('#admin-login').hidden = false; });
$('#create-contest').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const body = Object.fromEntries(form);
  body.rankingPublic = form.get('rankingPublic') === 'on';
  body.startAt = new Date(body.startAt).toISOString();
  body.endAt = new Date(body.endAt).toISOString();
  try { const result = await api('/api/admin/contests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, true); toast(`比赛 #${result.id} 已创建，请继续上传两个比赛包`); formElement.reset(); await adminOverview(); if (result.roster.length) showGeneratedRoster(result.id, result.roster); await loadContests(); }
  catch (error) { toast(error.message, true); }
});
$('#roster-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  const text = await file.text();
  $('#roster-names').value = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.split(/[\t,]/)[0].trim()).filter(name => name && !/^(姓名|name)$/i.test(name)).join('\n');
  toast(`已导入 ${$('#roster-names').value.split('\n').filter(Boolean).length} 个姓名`);
});
$('#refresh-contests').addEventListener('click', loadContests);
$('#package-viewer-close').addEventListener('click', () => $('#package-viewer').close());
$('#package-viewer').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });

setInterval(() => { $('#clock').textContent = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()); }, 1000);
setInterval(() => {
  const editing = document.activeElement?.matches?.('#admin-dashboard input,#admin-dashboard textarea,#admin-dashboard select')
    || document.querySelector('.time-save-status.dirty,.time-save-status.bad,.time-save-status.saving')
    || document.querySelector('dialog[open]');
  if (adminToken && $('#admin-view').classList.contains('active') && !document.hidden && !editing) adminOverview().catch(() => {});
}, 5000);
await Promise.all([loadContests(), loadHealth()]);
