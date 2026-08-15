const $ = selector => document.querySelector(selector);
const stateLabels = { upcoming: '未开始', running: '进行中', ended: '已结束', closed: '已关闭' };
const resultLabels = { AC: '答案正确', WA: '答案错误', PC: '部分正确', TLE: '超过时间限制', MLE: '超过内存限制', CANNOT_START: '无法启动', FILE_ERROR: '文件错误', RE: '运行错误', INVALID_SPJ: '特殊评测错误', SPJ_TLE: '特殊评测超时', SPJ_RE: '特殊评测运行错误', SKIPPED: '跳过', PE: '格式错误', OLE: '输出超过限制' };

function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = bad ? 'show bad' : 'show';
  setTimeout(() => { el.className = ''; }, 3500);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body.error || body || `请求失败：${response.status}`);
  return body;
}

function formatTime(iso) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function identityFields(contest) {
  return `
    <label>考号<input name="studentId" required pattern="[A-Za-z0-9_-]{1,32}" placeholder="OI123456"></label>
    <label>姓名<input name="studentName" required maxlength="40" placeholder="张三"></label>
    ${contest.requiresAccessCode ? '<label>比赛口令<input name="accessCode" type="password" required></label>' : ''}
    ${contest.requiresStudentToken ? '<label>个人提交码<input name="studentToken" type="password" required></label>' : ''}`;
}

function renderPracticeResult(result) {
  if (['queued', 'judging'].includes(result.status)) return '<div class="upload-state pending">正在进行自主测评…</div>';
  if (['judge_error', 'judge_unavailable'].includes(result.status)) return `<div class="upload-state error"><strong>测评失败</strong><span>${escapeHtml(result.details?.error || '测评器异常')}</span></div>`;
  const tasks = result.details?.tasks || [];
  return `<div class="practice-result"><h3>自主测评完成：${result.score ?? 0} 分</h3>${tasks.map(task => `<details><summary><b>${escapeHtml(task.title)}</b><strong>${task.score ?? 0} 分</strong></summary>${task.formatError ? `<p class="notice">${escapeHtml(task.formatError)}</p>` : ''}${task.cases?.length ? `<table><thead><tr><th>测试点</th><th>结果</th><th>得分</th><th>用时</th><th>内存</th></tr></thead><tbody>${task.cases.map(item => `<tr><td>#${item.case}</td><td><b>${escapeHtml(resultLabels[item.result] || item.result)}</b><small>${escapeHtml(item.result)}</small></td><td>${item.score}</td><td>${item.time >= 0 ? `${item.time} ms` : '—'}</td><td>${item.memory >= 0 ? `${Math.ceil(item.memory / 1024)} KiB` : '—'}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">没有测试点结果。</p>'}</details>`).join('')}</div>`;
}

async function pollPracticeResult(contestId, submissionId, studentId, studentToken, resultBox) {
  try {
    const result = await api(`/api/contests/${contestId}/practice-submissions/${submissionId}?studentId=${encodeURIComponent(studentId)}`, { headers: { 'x-student-token': studentToken } });
    resultBox.innerHTML = renderPracticeResult(result);
    if (['queued', 'judging'].includes(result.status)) setTimeout(() => pollPracticeResult(contestId, submissionId, studentId, studentToken, resultBox), 2000);
  } catch (error) { resultBox.innerHTML = `<div class="upload-state error"><strong>无法读取测评结果</strong><span>${escapeHtml(error.message)}</span></div>`; }
}

async function loadRanking(id) {
  try {
    const rows = await api(`/api/contests/${id}/ranking`);
    $('#ranking-table').innerHTML = rows.length ? `<table><thead><tr><th>排名</th><th>选手</th><th>成绩</th><th>用时</th></tr></thead><tbody>${rows.map(row => `<tr><td><b>${row.rank}</b></td><td>${escapeHtml(row.studentName)}<small>${escapeHtml(row.studentId)}</small></td><td><strong>${row.score}</strong></td><td>${row.usedTime} ms</td></tr>`).join('')}</tbody></table>` : '<p class="empty">暂无已完成测评的提交。</p>';
  } catch (error) { $('#ranking-table').textContent = error.message; }
}

function renderContest(contest) {
  const id = contest.id;
  document.title = `${contest.title} · OI 赛场`;
  $('#contest-page').innerHTML = `
    <div class="contest-number-banner"><span>比赛数字编号</span><strong>#${contest.id}</strong><small>监考登录器将自动填写，无需手动输入</small></div><h1>${escapeHtml(contest.title)}</h1>
    <section class="contest-notice"><h3>比赛注意事项</h3><p>${escapeHtml(contest.description || '暂无比赛注意事项')}</p>
      <div class="submission-guide">
        <h3>文件命名与目录示例</h3>
        <div class="guide-images">
          <figure><img src="/assets/csp-file-table.png" alt="CSP 题目文件名、输入输出文件名和源码文件名示例"><figcaption>以题面表格规定的目录、输入输出文件名和源码文件名为准。</figcaption></figure>
          <figure><img src="/assets/folder-structure.png?v=2" alt="考号紧接姓名的文件夹、题目子文件夹和源码文件的目录结构示例"><figcaption>最外层文件夹必须由考号紧接姓名，中间不加空格、加号或其他符号，例如 OI123456张三。</figcaption></figure>
        </div>
      </div>
    </section>
    <div class="timeline"><span>开始<br><b>${formatTime(contest.startAt)}</b></span><span>截止<br><b>${formatTime(contest.endAt)}</b></span><span>状态<br><b>${stateLabels[contest.state]}</b></span></div>
    <div class="task-chips">${contest.tasks.map(task => `<span>${escapeHtml(task.title)} · ${escapeHtml(task.subFolder ? `${task.source}/${task.source}.cpp` : `${task.source}.cpp`)}</span>`).join('')}</div>
    <div class="exam-number-lookup"><h3>忘记考号？</h3><form id="exam-number-form"><input name="studentName" required maxlength="40" placeholder="输入完整姓名"><button class="ghost">查询考号</button></form><div id="exam-number-result"></div></div>
    ${contest.requiresStudentToken ? `<form class="proctor-download-form" method="post" action="/api/contests/${id}/proctor-client"><h3>下载本人监考登录器 <span class="inline-contest-number">本场 #${contest.id}</span></h3><label>考号<input name="studentId" required pattern="[A-Za-z0-9_-]{1,32}" placeholder="OI123456"></label><label>个人提交码<input name="studentToken" type="password" required></label><button class="primary">验证并下载专属 EXE</button><small>登录器将自动填写当前网站地址、比赛编号 #${contest.id}、考号和提交码；网站地址仍可在启动时修改。请勿转发给其他人。</small></form>` : ''}
    ${contest.state !== 'upcoming' && contest.hasPackage ? (contest.requiresStudentToken ? `<form class="package-download-form" method="post" action="/api/contests/${id}/package" target="_blank"><h3>下载比赛题目</h3><label>考号<input name="studentId" required pattern="[A-Za-z0-9_-]{1,32}" placeholder="OI123456"></label><label>个人提交码<input name="studentToken" type="password" required></label><button class="download-button primary">验证并下载题目包</button><small>每个考号同一时间只允许一个下载任务，请勿重复点击。</small></form>` : '<p class="notice">管理员尚未导入参赛名单，暂时不能下载题目包。</p>') : ''}
    ${['ended', 'closed'].includes(contest.state) ? (contest.requiresStudentToken ? `<form class="self-test-download-form" method="post" action="/api/contests/${id}/self-test-download" target="_blank"><h3>赛后自主测评</h3><p>验证身份后，可下载测试数据和本人最后一次提交的文件夹，在 LemonLime 中自行复测。</p><label>考号<input name="studentId" required pattern="[A-Za-z0-9_-]{1,32}" placeholder="OI123456"></label><label>个人提交码<input name="studentToken" type="password" required></label><div class="self-test-actions">${contest.judgeReady ? '<button class="download-button primary" name="kind" value="test-data">下载测试数据</button>' : ''}<button class="download-button ghost" name="kind" value="submission">下载本人提交文件夹</button></div><small>只能下载与当前考号对应的提交；测试数据仅在管理员保留 Lemon 比赛包时提供。</small></form>` : '<p class="notice">本场未导入参赛名单，无法验证身份并提供个人提交下载。</p>') : ''}
    ${['ended', 'closed'].includes(contest.state) && contest.requiresStudentToken && contest.judgeReady ? `<form id="practice-submission-form" class="submission-form folder-submission-form practice-submission-form" data-endpoint="practice-submissions"><h3 class="full">在线重新提交自测</h3><p class="full empty">自测提交不会修改正式成绩、排名或正式提交记录；每次完成后可以继续提交。</p><label>考号<input name="studentId" required pattern="[A-Za-z0-9_-]{1,32}" placeholder="OI123456"></label><label>姓名<input name="studentName" required maxlength="40" placeholder="张三"></label><label>个人提交码<input name="studentToken" type="password" required></label><label class="full file-drop">自测文件夹<input name="folder" type="file" webkitdirectory directory multiple required><small>仍须选择“考号紧接姓名”的完整文件夹，格式错误仅影响本次自测。</small></label><button class="primary full" data-label="上传并测评">上传并测评</button><div class="upload-result full" aria-live="polite"></div></form>` : ''}
    ${contest.state === 'running' ? `<form id="submission-form" class="submission-form folder-submission-form" data-endpoint="submissions">${identityFields(contest)}<label class="full file-drop">OI 提交文件夹<input name="folder" type="file" webkitdirectory directory multiple required><small>最外层文件夹必须由考号紧接姓名，中间不加符号，例如 OI123456张三；无需压缩。</small></label><button class="primary full" data-label="上传文件夹">上传文件夹</button><div class="upload-result full" aria-live="polite"></div></form>` : ''}
    ${contest.rankingPublic ? `<div class="ranking"><h3>实时排名</h3><div id="ranking-table">加载中…</div></div>` : '<p class="notice">本场排名暂未公开。</p>'}`;

  $('#exam-number-form').addEventListener('submit', async event => {
    event.preventDefault();
    const studentName = new FormData(event.currentTarget).get('studentName');
    try {
      const rows = await api(`/api/contests/${id}/exam-number?studentName=${encodeURIComponent(studentName)}`);
      $('#exam-number-result').innerHTML = rows.length
        ? `<div class="status-box">${rows.map(row => `<span>${escapeHtml(row.studentName)}：<strong>${escapeHtml(row.studentId)}</strong></span>`).join('')}${rows.length > 1 ? '<em>存在重名，请联系监考人员确认本人考号。</em>' : ''}</div>`
        : '<p class="empty">未找到该姓名，请检查是否输入完整或联系监考人员。</p>';
    } catch (error) { toast(error.message, true); }
  });

  document.querySelectorAll('.folder-submission-form').forEach(formNode => formNode.addEventListener('submit', async event => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const query = new URLSearchParams({ studentId: form.get('studentId'), studentName: form.get('studentName'), accessCode: form.get('accessCode') || '', studentToken: form.get('studentToken') || '' });
    const files = [...formElement.querySelector('input[name="folder"]').files];
    const paths = files.map(file => file.webkitRelativePath || file.name);
    const roots = new Set(paths.map(name => name.replaceAll('\\', '/').split('/')[0]));
    const expectedRoot = `${form.get('studentId')}${String(form.get('studentName')).trim()}`;
    if (!files.length || roots.size !== 1 || !roots.has(expectedRoot)) return toast(`最外层文件夹应命名为：${expectedRoot}`, true);
    const resultBox = formElement.querySelector('.upload-result');
    const payload = new FormData();
    payload.append('manifest', JSON.stringify(paths));
    files.forEach((file, index) => payload.append(`file-${index}`, file, file.name));
    const button = formElement.querySelector('button');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const buttonLabel = button.dataset.label || button.textContent;
    button.disabled = true; button.textContent = '正在上传…';
    resultBox.innerHTML = '<div class="upload-state pending">正在上传文件夹…</div>';
    try {
      const uploaded = await api(`/api/contests/${id}/${formElement.dataset.endpoint}?${query}`, { method: 'PUT', body: payload, signal: controller.signal });
      toast('上传成功');
      if (formElement.dataset.endpoint === 'practice-submissions') {
        resultBox.innerHTML = '<div class="upload-state pending">上传成功，正在等待测评…</div>';
        pollPracticeResult(id, uploaded.submissionId, form.get('studentId'), form.get('studentToken'), resultBox);
      } else resultBox.innerHTML = '<div class="upload-state success"><span class="upload-check" aria-hidden="true">✓</span><div><strong>上传成功</strong></div></div>';
      formElement.reset();
    } catch (error) {
      const title = error.name === 'AbortError' ? '上传超时' : '上传失败';
      resultBox.innerHTML = `<div class="upload-state error"><strong>${title}</strong></div>`;
      toast(title, true);
    } finally { clearTimeout(timeout); button.disabled = false; button.textContent = buttonLabel; }
  }));

  if (contest.rankingPublic) loadRanking(id);
}

const id = Number(new URLSearchParams(location.search).get('id'));
try {
  const contests = await api('/api/contests');
  const contest = Number.isInteger(id) && id > 0 ? contests.find(item => item.id === id) : null;
  if (!contest) throw new Error('比赛不存在或链接无效');
  renderContest(contest);
} catch (error) {
  $('#contest-page').innerHTML = `<h1>无法打开比赛</h1><p class="empty">${escapeHtml(error.message)}</p><a class="primary back-home" href="/">返回比赛列表</a>`;
}

const updateClock = () => { $('#clock').textContent = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()); };
updateClock(); setInterval(updateClock, 1000);
