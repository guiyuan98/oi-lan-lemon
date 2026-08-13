import http from 'node:http';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import Busboy from 'busboy';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_STUDENT_ZIP = Number(process.env.MAX_STUDENT_ZIP_MB || 20) * 1024 * 1024;
const MAX_PACKAGE_ZIP = Number(process.env.MAX_PACKAGE_ZIP_MB || 512) * 1024 * 1024;
const MAX_PREVIEW_FILE = 10 * 1024 * 1024;
const PREVIEW_TICKET_TTL = 30 * 60 * 1000;
const MAX_PREVIEW_TICKETS = 20;
const MAX_PROCTOR_SCREEN = 1024 * 1024;
const PROCTOR_ONLINE_MS = 12_000;
const proctorClients = new Map();

await mkdir(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'oi-lan.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS contests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    access_hash TEXT NOT NULL DEFAULT '',
    ranking_public INTEGER NOT NULL DEFAULT 1,
    package_name TEXT,
    package_path TEXT,
    lemon_root TEXT,
    cdf_path TEXT,
    tasks_json TEXT NOT NULL DEFAULT '[]',
    closed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS participants (
    contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
    student_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    token_plain TEXT NOT NULL DEFAULT '',
    submission_allowed INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (contest_id, student_id)
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
    student_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    version INTEGER NOT NULL,
    archive_path TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    status TEXT NOT NULL,
    format_report TEXT NOT NULL DEFAULT '',
    score INTEGER,
    used_time INTEGER,
    details_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(contest_id, student_id, version)
  );
  CREATE INDEX IF NOT EXISTS submissions_latest
    ON submissions(contest_id, student_id, version DESC);
`);
if (!db.prepare('PRAGMA table_info(participants)').all().some(column => column.name === 'token_plain')) {
  db.exec("ALTER TABLE participants ADD COLUMN token_plain TEXT NOT NULL DEFAULT ''");
}
if (!db.prepare('PRAGMA table_info(participants)').all().some(column => column.name === 'submission_allowed')) {
  db.exec('ALTER TABLE participants ADD COLUMN submission_allowed INTEGER NOT NULL DEFAULT 1');
  db.exec(`UPDATE participants SET submission_allowed = 0 WHERE EXISTS (
    SELECT 1 FROM submissions WHERE submissions.contest_id = participants.contest_id AND submissions.student_id = participants.student_id
  )`);
}
if (!db.prepare('PRAGMA table_info(contests)').all().some(column => column.name === 'closed_at')) {
  db.exec('ALTER TABLE contests ADD COLUMN closed_at TEXT');
}

const adminTokenPath = path.join(DATA, 'admin-token.txt');
let ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  if (existsSync(adminTokenPath)) ADMIN_TOKEN = (await readFile(adminTokenPath, 'utf8')).trim();
  else {
    ADMIN_TOKEN = randomBytes(12).toString('base64url');
    await writeFile(adminTokenPath, ADMIN_TOKEN, { encoding: 'utf8', mode: 0o600 });
  }
}

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const nowIso = () => new Date().toISOString();
const asInt = value => Number.parseInt(value, 10);
const safeId = value => /^[A-Za-z0-9_-]{1,32}$/.test(value || '');
const json = (res, status, body) => {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length });
  res.end(data);
};

function secureHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求内容过大'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON 格式错误'), { status: 400 }); }
}

async function readForm(req, limit = 8192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('表单内容过大'), { status: 413 });
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

async function receiveFile(req, target, limit) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomBytes(6).toString('hex')}.upload`;
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = createWriteStream(temp, { flags: 'wx' });
      req.on('data', chunk => {
        size += chunk.length;
        if (size > limit) req.destroy(Object.assign(new Error('上传文件过大'), { status: 413 }));
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
    if (size < 4) throw Object.assign(new Error('上传文件为空'), { status: 400 });
    await rm(target, { force: true });
    await rename(temp, target);
    return size;
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function receiveFolder(req, target, limit) {
  if (!String(req.headers['content-type'] || '').startsWith('multipart/form-data')) {
    throw Object.assign(new Error('请选择整个考号文件夹上传'), { status: 415 });
  }
  let manifestText = '';
  let total = 0;
  let fileCount = 0;
  const uploads = new Map();
  await new Promise((resolve, reject) => {
    let failed = false;
    const fail = error => {
      if (failed) return;
      failed = true;
      req.unpipe(parser);
      req.resume();
      reject(error);
    };
    let parser;
    try {
      parser = Busboy({ headers: req.headers, limits: { fieldSize: 1024 * 1024, fields: 1, files: 200, parts: 201, fileSize: limit } });
    } catch (error) {
      reject(Object.assign(new Error(`文件夹上传格式错误：${error.message}`), { status: 400 }));
      return;
    }
    parser.on('field', (name, value) => {
      if (name !== 'manifest') return fail(Object.assign(new Error('文件夹清单字段错误'), { status: 400 }));
      manifestText = value;
    });
    parser.on('file', (name, stream) => {
      const match = /^file-(\d+)$/.exec(name);
      if (!match || uploads.has(Number(match[1]))) {
        stream.resume();
        return fail(Object.assign(new Error('文件夹中的文件编号错误'), { status: 400 }));
      }
      const index = Number(match[1]);
      const chunks = [];
      fileCount += 1;
      stream.on('data', chunk => {
        if (failed) return;
        total += chunk.length;
        if (total > limit) return fail(Object.assign(new Error('提交文件夹总体积超过限制'), { status: 413 }));
        chunks.push(chunk);
      });
      stream.on('limit', () => fail(Object.assign(new Error('提交文件夹中单个文件超过限制'), { status: 413 })));
      stream.on('error', fail);
      stream.on('end', () => { if (!failed) uploads.set(index, Buffer.concat(chunks)); });
    });
    parser.on('filesLimit', () => fail(Object.assign(new Error('提交文件夹中的文件数量超过 200 个'), { status: 413 })));
    parser.on('fieldsLimit', () => fail(Object.assign(new Error('文件夹清单字段过多'), { status: 400 })));
    parser.on('partsLimit', () => fail(Object.assign(new Error('提交文件夹内容过多'), { status: 413 })));
    parser.on('error', error => fail(Object.assign(new Error(`文件夹上传格式错误：${error.message}`), { status: 400 })));
    parser.on('finish', () => { if (!failed) resolve(); });
    req.on('aborted', () => fail(Object.assign(new Error('文件夹上传中断'), { status: 400 })));
    req.pipe(parser);
  });
  let manifest;
  try { manifest = JSON.parse(manifestText); }
  catch { throw Object.assign(new Error('无法读取文件夹清单'), { status: 400 }); }
  if (!Array.isArray(manifest) || !manifest.length || manifest.length !== fileCount || manifest.length > 200) {
    throw Object.assign(new Error('文件夹清单与实际文件不一致'), { status: 400 });
  }
  const zip = new AdmZip();
  const seen = new Set();
  manifest.forEach((name, index) => {
    const relative = normalizedZipPath(String(name));
    if (seen.has(relative)) throw Object.assign(new Error(`文件夹中存在重复路径：${relative}`), { status: 400 });
    if (!uploads.has(index)) throw Object.assign(new Error(`文件夹中缺少文件：${relative}`), { status: 400 });
    seen.add(relative);
    zip.addFile(relative, uploads.get(index));
  });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, zip.toBuffer());
  return fileCount;
}

function normalizedZipPath(name) {
  const clean = name.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.split('/').includes('..')) {
    throw Object.assign(new Error(`压缩包含危险路径：${name}`), { status: 400 });
  }
  return clean;
}

async function extractZipStrict(zipPath, target, maxUncompressed) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (!entries.length) throw Object.assign(new Error('ZIP 中没有文件'), { status: 400 });
  let total = 0;
  for (const entry of entries) {
    normalizedZipPath(entry.entryName);
    total += Number(entry.header.size || 0);
    if (total > maxUncompressed) throw Object.assign(new Error('ZIP 解压后体积超过限制'), { status: 413 });
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const entry of entries) {
    const rel = normalizedZipPath(entry.entryName);
    const destination = path.resolve(target, rel);
    if (!destination.startsWith(path.resolve(target) + path.sep) && destination !== path.resolve(target)) {
      throw Object.assign(new Error('ZIP 路径越界'), { status: 400 });
    }
    if (entry.isDirectory) await mkdir(destination, { recursive: true });
    else {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, entry.getData());
    }
  }
  return entries.map(entry => normalizedZipPath(entry.entryName)).filter(name => !name.endsWith('/'));
}

async function walkFiles(dir, base = dir) {
  const result = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) result.push(...await walkFiles(full, base));
    else result.push(path.relative(base, full).replaceAll('\\', '/'));
  }
  return result;
}

function parseTasks(cdf) {
  if (!Array.isArray(cdf.tasks) || !cdf.tasks.length) {
    throw Object.assign(new Error('CDF 中没有题目，请在 LemonLime 中添加并配置题目'), { status: 400 });
  }
  return cdf.tasks.map((task, index) => {
    const missing = [];
    if (!String(task.problemTitle || '').trim()) missing.push('题目标题');
    if (!String(task.sourceFileName || '').trim()) missing.push('源码文件名');
    if (missing.length) {
      const title = String(task.problemTitle || `第 ${index + 1} 题`).trim();
      throw Object.assign(new Error(`CDF 第 ${index + 1} 题“${title}”未配置完整：缺少${missing.join('、')}。请在 LemonLime 中删除空白题目或补全设置后重新打包`), { status: 400 });
    }
    return {
      title: task.problemTitle.trim(),
      source: task.sourceFileName.trim(),
      subFolder: Boolean(task.subFolderCheck)
    };
  });
}

function contestState(contest) {
  if (contest.closed_at) return 'closed';
  const now = Date.now();
  if (now < Date.parse(contest.start_at)) return 'upcoming';
  if (now > Date.parse(contest.end_at)) return 'ended';
  return 'running';
}

function publicContest(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    startAt: row.start_at,
    endAt: row.end_at,
    closedAt: row.closed_at,
    state: contestState(row),
    hasPackage: Boolean(row.package_path),
    judgeReady: Boolean(row.cdf_path),
    rankingPublic: Boolean(row.ranking_public),
    requiresAccessCode: Boolean(row.access_hash),
    requiresStudentToken: db.prepare('SELECT 1 FROM participants WHERE contest_id = ? LIMIT 1').get(row.id) !== undefined,
    tasks: JSON.parse(row.tasks_json || '[]')
  };
}

function getContest(id) {
  return db.prepare('SELECT * FROM contests WHERE id = ?').get(id);
}

function authorizeContest(contest, studentId, studentName, accessCode, studentToken) {
  if (!safeId(studentId)) throw Object.assign(new Error('考号只能含字母、数字、下划线或连字符，最长 32 位'), { status: 400 });
  if (!studentName || studentName.length > 40) throw Object.assign(new Error('姓名不能为空且最长 40 字'), { status: 400 });
  if (contest.access_hash && sha256(accessCode || '') !== contest.access_hash) {
    throw Object.assign(new Error('比赛口令错误'), { status: 403 });
  }
  const participant = db.prepare('SELECT * FROM participants WHERE contest_id = ? AND student_id = ?').get(contest.id, studentId);
  const hasRoster = db.prepare('SELECT 1 FROM participants WHERE contest_id = ? LIMIT 1').get(contest.id);
  if (hasRoster && (!participant || participant.token_hash !== sha256(studentToken || ''))) {
    throw Object.assign(new Error('考号或个人提交码错误'), { status: 403 });
  }
  if (participant && participant.student_name !== studentName) {
    throw Object.assign(new Error(`姓名应填写：${participant.student_name}`), { status: 400 });
  }
  return participant?.student_name || studentName;
}

function requireAdmin(req) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    throw Object.assign(new Error('管理员令牌错误'), { status: 401 });
  }
}

function proctorKey(contestId, studentId) {
  return `${contestId}:${studentId}`;
}

function authorizeProctor(contestId, studentId, studentToken) {
  if (!safeId(studentId)) throw Object.assign(new Error('考号格式错误'), { status: 400 });
  const participant = db.prepare('SELECT token_hash FROM participants WHERE contest_id = ? AND student_id = ?').get(contestId, studentId);
  if (!participant || participant.token_hash !== sha256(studentToken || '')) {
    throw Object.assign(new Error('考号或个人提交码错误'), { status: 403 });
  }
  return participant;
}

function proctorPermissions(contestId, studentId) {
  const submitted = Boolean(db.prepare('SELECT 1 FROM submissions WHERE contest_id = ? AND student_id = ? LIMIT 1').get(contestId, studentId));
  return { canExit: submitted };
}

function parseRoster(csv) {
  if (!csv?.trim()) return [];
  const rows = csv.trim().split(/\r?\n/).map(line => line.split(',').map(v => v.trim()));
  if (/student|学号|考号/i.test(rows[0]?.[0] || '')) rows.shift();
  return rows.map(([studentId, studentName, token]) => {
    if (!safeId(studentId) || !studentName || !token) throw Object.assign(new Error(`名单行错误：${studentId || '(空)'},${studentName || '(空)'}`), { status: 400 });
    return { studentId, studentName, token };
  });
}

function parseRosterNames(text) {
  if (!text?.trim()) return [];
  const names = text.replace(/^\uFEFF/, '').split(/\r?\n/)
    .map(line => line.split(/[\t,]/)[0].trim())
    .filter(name => name && !/^(姓名|name)$/i.test(name));
  if (names.length > 1000) throw Object.assign(new Error('单场比赛最多导入 1000 名学生'), { status: 400 });
  for (const name of names) {
    if (name.length > 40) throw Object.assign(new Error(`姓名过长：${name}`), { status: 400 });
  }
  return names;
}

function humanCode(length = 8) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
}

function randomStudentId(used) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = `OI${randomInt(100000, 1000000)}`;
    if (!used.has(id)) { used.add(id); return id; }
  }
  throw new Error('无法生成不重复考号');
}

function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

async function validateSubmission(zipPath, studentId, tasks, extracted) {
  const files = await extractZipStrict(zipPath, extracted, 100 * 1024 * 1024);
  const root = `${studentId}/`;
  if (!files.some(file => file.startsWith(root))) {
    throw Object.assign(new Error(`提交的最外层文件夹必须是本人考号：${studentId}/`), { status: 400, code: 'SUBMISSION_FORMAT' });
  }
  const relative = files.map(file => file.slice(root.length));
  const results = tasks.map(task => {
    const expected = `${task.subFolder ? `${task.source}/` : ''}${task.source}.cpp`;
    const valid = relative.includes(expected);
    return { title: task.title, expected, valid, reason: valid ? '' : `找不到 ${expected}` };
  });
  const missing = results.filter(task => !task.valid);
  return {
    tasks: results,
    report: missing.length
      ? `逐题格式检查：找到 ${results.length - missing.length}/${results.length} 道；${missing.map(task => `${task.title}：${task.reason}`).join('；')}`
      : `格式正确：${tasks.length} 道题，检测到 ${relative.length} 个文件`
  };
}

let judgeQueue = Promise.resolve();
const activePackageDownloads = new Set();
const packagePreviewTickets = new Map();
function enqueueJudge(submissionId) {
  judgeQueue = judgeQueue.then(() => runJudge(submissionId)).catch(error => console.error('[judge]', error));
}

async function runJudge(submissionId) {
  const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
  const contest = getContest(submission.contest_id);
  if (!contest?.cdf_path || !contest.lemon_root) {
    db.prepare("UPDATE submissions SET status = 'judge_unavailable', details_json = ? WHERE id = ?")
      .run(JSON.stringify({ error: '管理员尚未上传 Lemon 比赛包' }), submissionId);
    return;
  }
  const worker = process.env.LEMON_WORKER || path.join(ROOT, 'bin', process.platform === 'win32' ? 'lemon-headless.exe' : 'lemon-headless');
  if (!existsSync(worker)) {
    db.prepare("UPDATE submissions SET status = 'judge_unavailable', details_json = ? WHERE id = ?")
      .run(JSON.stringify({ error: `找不到 Lemon worker：${worker}` }), submissionId);
    return;
  }

  db.prepare("UPDATE submissions SET status = 'judging' WHERE id = ?").run(submissionId);
  const job = path.join(DATA, 'jobs', String(submissionId));
  try {
    await rm(job, { recursive: true, force: true });
    await mkdir(job, { recursive: true });
    const contestCopy = path.join(job, 'contest');
    await cp(contest.lemon_root, contestCopy, { recursive: true });
    const extracted = path.join(job, 'submission');
    const tasks = JSON.parse(contest.tasks_json);
    const format = await validateSubmission(submission.archive_path, submission.student_id, tasks, extracted);
    db.prepare('UPDATE submissions SET format_report = ? WHERE id = ?').run(format.report, submissionId);
    if (!format.tasks.some(task => task.valid)) {
      const details = { studentId: submission.student_id, totalScore: 0, totalTime: 0,
        tasks: format.tasks.map(task => ({ title: task.title, score: 0, compile: 'NO_SOURCE', formatError: task.reason, cases: [] })) };
      db.prepare("UPDATE submissions SET status = 'judged', score = 0, used_time = 0, details_json = ? WHERE id = ?")
        .run(JSON.stringify(details), submissionId);
      return;
    }
    const studentSource = path.join(extracted, submission.student_id);
    await mkdir(path.join(contestCopy, 'source'), { recursive: true });
    await cp(studentSource, path.join(contestCopy, 'source', submission.student_id), { recursive: true });
    const cdf = path.join(contestCopy, path.relative(contest.lemon_root, contest.cdf_path));
    const compiler = process.env.CXX || 'g++';
    const result = await new Promise((resolve, reject) => {
      const child = spawn(worker, ['--contest', cdf, '--compiler', compiler], { cwd: contestCopy, windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Lemon worker 超过 30 分钟未结束'));
      }, 30 * 60 * 1000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(stderr || `Lemon worker 退出码 ${code}`));
        else {
          try { resolve(JSON.parse(stdout)); }
          catch { reject(new Error(`Lemon worker 返回的不是 JSON：${stdout.slice(0, 500)}`)); }
        }
      });
    });
    const contestant = result.contestants?.find(item => item.studentId === submission.student_id) || result.contestants?.[0];
    if (!contestant) throw new Error('Lemon 结果中找不到该选手');
    contestant.tasks = tasks.map((task, index) => {
      const judged = contestant.tasks?.[index] || { title: task.title, score: 0, cases: [] };
      const checked = format.tasks[index];
      return checked.valid ? judged : { ...judged, title: task.title, score: 0, compile: 'NO_SOURCE', formatError: checked.reason, cases: [] };
    });
    contestant.totalScore = contestant.tasks.reduce((sum, task) => sum + Number(task.score || 0), 0);
    db.prepare("UPDATE submissions SET status = 'judged', score = ?, used_time = ?, details_json = ? WHERE id = ?")
      .run(contestant.totalScore, contestant.totalTime, JSON.stringify(contestant), submissionId);
  } catch (error) {
    db.prepare("UPDATE submissions SET status = 'judge_error', details_json = ? WHERE id = ?")
      .run(JSON.stringify({ error: error.message }), submissionId);
  } finally {
    // ponytail: jobs are deleted after judging; keep archives and DB results as the audit trail.
    await rm(job, { recursive: true, force: true });
  }
}

function latestSubmissions(contestId) {
  return db.prepare(`
    SELECT s.* FROM submissions s
    JOIN (SELECT student_id, MAX(version) version FROM submissions WHERE contest_id = ? GROUP BY student_id) latest
      ON latest.student_id = s.student_id AND latest.version = s.version
    WHERE s.contest_id = ?
    ORDER BY s.submitted_at DESC
  `).all(contestId, contestId);
}

function adminParticipants(contestId) {
  return db.prepare(`
    SELECT p.*, s.id submission_id, s.version, s.status, s.score, s.submitted_at, s.format_report, s.details_json
    FROM participants p
    LEFT JOIN submissions s ON s.id = (
      SELECT id FROM submissions WHERE contest_id = p.contest_id AND student_id = p.student_id ORDER BY version DESC LIMIT 1
    )
    WHERE p.contest_id = ?
    ORDER BY p.student_name, p.student_id
  `).all(contestId).map(row => {
    const details = JSON.parse(row.details_json || '{}');
    const proctor = proctorClients.get(proctorKey(contestId, row.student_id));
    const proctorOnline = Boolean(proctor && Date.now() - proctor.lastSeen < PROCTOR_ONLINE_MS);
    return {
      studentId: row.student_id,
      studentName: row.student_name,
      submissionAllowed: Boolean(row.submission_allowed),
      submissionId: row.submission_id || null,
      version: row.version || null,
      status: row.status || null,
      score: row.score,
      submittedAt: row.submitted_at || null,
      formatReport: row.format_report || '',
      taskScores: (details.tasks || []).map(task => ({ title: task.title, score: task.score, formatError: task.formatError || '' })),
      proctor: proctor ? {
        online: proctorOnline,
        lastSeen: new Date(proctor.lastSeen).toISOString(),
        violation: proctorOnline ? proctor.violation : '',
        processes: proctorOnline ? proctor.processes : [],
        hasScreen: proctorOnline && Boolean(proctor.screen)
      } : { online: false, lastSeen: null, violation: '', processes: [], hasScreen: false }
    };
  });
}

function previewContentType(filename) {
  const extension = path.extname(filename).toLowerCase();
  const types = {
    '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.c': 'text/plain; charset=utf-8',
    '.cc': 'text/plain; charset=utf-8', '.cpp': 'text/plain; charset=utf-8', '.cxx': 'text/plain; charset=utf-8',
    '.h': 'text/plain; charset=utf-8', '.hpp': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8',
    '.java': 'text/plain; charset=utf-8', '.js': 'text/plain; charset=utf-8', '.mjs': 'text/plain; charset=utf-8',
    '.json': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
    '.csv': 'text/plain; charset=utf-8', '.in': 'text/plain; charset=utf-8', '.out': 'text/plain; charset=utf-8',
    '.ans': 'text/plain; charset=utf-8', '.cdf': 'text/plain; charset=utf-8', '.xml': 'text/plain; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.bmp': 'image/bmp', '.pdf': 'application/pdf'
  };
  return types[extension] || '';
}

function adminPackagePath(contest, kind) {
  return kind === 'package' ? contest.package_path : path.join(DATA, 'contests', String(contest.id), 'lemon-contest.zip');
}

function createPackagePreviewTicket(data, filename, contentType) {
  const now = Date.now();
  for (const [token, ticket] of packagePreviewTickets) {
    if (ticket.expiresAt <= now) packagePreviewTickets.delete(token);
  }
  while (packagePreviewTickets.size >= MAX_PREVIEW_TICKETS) {
    packagePreviewTickets.delete(packagePreviewTickets.keys().next().value);
  }
  const token = randomBytes(24).toString('base64url');
  packagePreviewTickets.set(token, { data, filename, contentType, expiresAt: now + PREVIEW_TICKET_TTL });
  return `/api/package-previews/${token}`;
}

function sendPackagePreview(req, res, ticket) {
  const total = ticket.data.length;
  const headers = {
    'content-type': ticket.contentType,
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(ticket.filename))}`,
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store'
  };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (!match) {
    res.writeHead(200, { ...headers, 'content-length': total });
    return res.end(ticket.data);
  }
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      return res.end();
    }
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= total || end < start) {
    res.writeHead(416, { 'content-range': `bytes */${total}` });
    return res.end();
  }
  end = Math.min(end, total - 1);
  const chunk = ticket.data.subarray(start, end + 1);
  res.writeHead(206, { ...headers, 'content-length': chunk.length, 'content-range': `bytes ${start}-${end}/${total}` });
  return res.end(chunk);
}

async function serveStatic(req, res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  const types = {
    'index.html': 'text/html; charset=utf-8',
    'contest.html': 'text/html; charset=utf-8',
    'app.js': 'text/javascript; charset=utf-8',
    'contest.js': 'text/javascript; charset=utf-8',
    'styles.css': 'text/css; charset=utf-8',
    'assets/csp-file-table.png': 'image/png',
    'assets/folder-structure.png': 'image/png'
  };
  if (!types[file]) return false;
  const data = await readFile(path.join(PUBLIC, file));
  res.writeHead(200, { 'content-type': types[file], 'content-length': data.length });
  res.end(data);
  return true;
}

const server = http.createServer(async (req, res) => {
  secureHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && await serveStatic(req, res, url.pathname)) return;

    if (req.method === 'GET' && url.pathname === '/api/health') {
      const worker = process.env.LEMON_WORKER || path.join(ROOT, 'bin', process.platform === 'win32' ? 'lemon-headless.exe' : 'lemon-headless');
      return json(res, 200, { ok: true, judgeReady: existsSync(worker), time: nowIso() });
    }
    if (req.method === 'POST' && url.pathname === '/api/proctor/heartbeat') {
      const contestId = asInt(url.searchParams.get('contestId'));
      const studentId = url.searchParams.get('studentId');
      const contest = getContest(contestId);
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      authorizeProctor(contestId, studentId, req.headers['x-student-token']);
      const body = await readJson(req, 2 * 1024 * 1024);
      let screen = null;
      if (body.screen) {
        screen = Buffer.from(String(body.screen), 'base64');
        if (!screen.length || screen.length > MAX_PROCTOR_SCREEN) return json(res, 413, { error: '屏幕图像过大' });
      }
      const key = proctorKey(contestId, studentId);
      const previous = proctorClients.get(key);
      const state = {
        lastSeen: Date.now(), screen: screen || previous?.screen || null,
        processes: Array.isArray(body.processes) ? body.processes.slice(0, 60).map(value => String(value).slice(0, 80)) : [],
        violation: String(body.violation || '').slice(0, 200)
      };
      proctorClients.set(key, state);
      return json(res, 200, { ok: true, ...proctorPermissions(contestId, studentId) });
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'contests' && parts[3] === 'proctor-client') {
      const contest = getContest(asInt(parts[2]));
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      if (!String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) return json(res, 415, { error: '下载请求格式错误' });
      const form = await readForm(req);
      const studentId = form.get('studentId');
      authorizeProctor(contest.id, studentId, form.get('studentToken'));
      const templatePath = path.join(PUBLIC, 'downloads', 'OI-Proctor-Client.exe');
      if (!existsSync(templatePath)) return json(res, 503, { error: '监考登录器尚未生成，请联系管理员' });
      const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const protocol = forwardedProtocol === 'https' ? 'https' : 'http';
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      if (!/^[A-Za-z0-9.:[\]-]+$/.test(host)) return json(res, 400, { error: '网站地址无效' });
      const config = Buffer.from(`\nOI_PROCTOR_CONFIG_V1\n${JSON.stringify({ server: `${protocol}://${host}`, contestId: contest.id, studentId, studentToken: form.get('studentToken') })}`);
      const executable = Buffer.concat([await readFile(templatePath), config]);
      const filename = `${studentId}-监考登录器.exe`;
      res.writeHead(200, {
        'content-type': 'application/vnd.microsoft.portable-executable', 'content-length': executable.length,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, 'cache-control': 'no-store'
      });
      return res.end(executable);
    }
    if (req.method === 'GET' && url.pathname === '/api/contests') {
      return json(res, 200, db.prepare('SELECT * FROM contests ORDER BY start_at DESC').all().map(publicContest));
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'contests' && parts[3] === 'ranking') {
      const contest = getContest(asInt(parts[2]));
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      if (!contest.ranking_public) return json(res, 403, { error: '排名尚未公开' });
      const rows = latestSubmissions(contest.id).filter(row => ['judged', 'format_error'].includes(row.status))
        .sort((a, b) => b.score - a.score || a.used_time - b.used_time || a.submitted_at.localeCompare(b.submitted_at))
        .map((row, index) => ({ rank: index + 1, studentId: row.student_id, studentName: row.student_name, score: row.score, usedTime: row.used_time, submittedAt: row.submitted_at }));
      return json(res, 200, rows);
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'contests' && parts[3] === 'exam-number') {
      const contest = getContest(asInt(parts[2]));
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      const studentName = (url.searchParams.get('studentName') || '').trim();
      if (!studentName || studentName.length > 40) return json(res, 400, { error: '请输入完整姓名' });
      const rows = db.prepare('SELECT student_id, student_name FROM participants WHERE contest_id = ? AND student_name = ? ORDER BY student_id').all(contest.id, studentName);
      return json(res, 200, rows.map(row => ({ studentId: row.student_id, studentName: row.student_name })));
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'contests' && parts[3] === 'package') {
      const contest = getContest(asInt(parts[2]));
      if (!contest?.package_path) return json(res, 404, { error: '题目包不存在' });
      if (contestState(contest) === 'upcoming') return json(res, 403, { error: '比赛尚未开始' });
      if (!String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) return json(res, 415, { error: '请填写考号和个人提交码下载' });
      const form = await readForm(req);
      const studentId = form.get('studentId');
      const participant = safeId(studentId) ? db.prepare('SELECT token_hash FROM participants WHERE contest_id = ? AND student_id = ?').get(contest.id, studentId) : null;
      if (!participant || participant.token_hash !== sha256(form.get('studentToken') || '')) return json(res, 403, { error: '考号或个人提交码错误' });
      const info = await stat(contest.package_path);
      const downloadKey = `${contest.id}:${studentId}`;
      if (activePackageDownloads.has(downloadKey)) return json(res, 429, { error: '该考号正在下载题目包，请勿重复下载' });
      activePackageDownloads.add(downloadKey);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': info.size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(contest.package_name)}` });
      const stream = createReadStream(contest.package_path);
      res.once('close', () => activePackageDownloads.delete(downloadKey));
      stream.once('error', error => res.destroy(error));
      return stream.pipe(res);
    }
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'contests' && parts[3] === 'submissions') {
      const contest = getContest(asInt(parts[2]));
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      const state = contestState(contest);
      if (state !== 'running') return json(res, 403, { error: state === 'upcoming' ? '比赛尚未开始' : state === 'closed' ? '比赛已由管理员关闭' : '提交已截止' });
      const studentId = url.searchParams.get('studentId');
      const studentName = authorizeContest(contest, studentId, url.searchParams.get('studentName'), url.searchParams.get('accessCode'), url.searchParams.get('studentToken'));
      const participant = db.prepare('SELECT submission_allowed FROM participants WHERE contest_id = ? AND student_id = ?').get(contest.id, studentId);
      if (participant) {
        const claimed = db.prepare('UPDATE participants SET submission_allowed = 0 WHERE contest_id = ? AND student_id = ? AND submission_allowed = 1').run(contest.id, studentId);
        if (!claimed.changes) throw Object.assign(new Error('本场比赛每人只允许提交一次；如需重新提交，请联系管理员重置提交次数'), { status: 409 });
      } else if (db.prepare('SELECT 1 FROM submissions WHERE contest_id = ? AND student_id = ? LIMIT 1').get(contest.id, studentId)) {
        throw Object.assign(new Error('本场比赛每人只允许提交一次'), { status: 409 });
      }
      const latest = db.prepare('SELECT MAX(version) version FROM submissions WHERE contest_id = ? AND student_id = ?').get(contest.id, studentId);
      const version = (latest?.version || 0) + 1;
      const dir = path.join(DATA, 'submissions', String(contest.id), studentId);
      const archive = path.join(dir, `${version}.zip`);
      const extracted = path.join(DATA, 'format-check', `${contest.id}-${studentId}-${version}`);
      try {
        if (String(req.headers['content-type'] || '').startsWith('multipart/form-data')) await receiveFolder(req, archive, MAX_STUDENT_ZIP);
        else if (req.headers['content-type'] === 'application/zip') await receiveFile(req, archive, MAX_STUDENT_ZIP);
        else throw Object.assign(new Error('请选择整个考号文件夹上传'), { status: 415 });
        const tasks = JSON.parse(contest.tasks_json);
        const format = await validateSubmission(archive, studentId, tasks, extracted);
        const result = db.prepare(`INSERT INTO submissions
          (contest_id, student_id, student_name, version, archive_path, submitted_at, status, format_report)
          VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`)
          .run(contest.id, studentId, studentName, version, archive, nowIso(), format.report);
        enqueueJudge(Number(result.lastInsertRowid));
        return json(res, 201, { ok: true, status: 'uploaded' });
      } catch (error) {
        await rm(archive, { force: true });
        if (participant) db.prepare('UPDATE participants SET submission_allowed = 1 WHERE contest_id = ? AND student_id = ?').run(contest.id, studentId);
        if ([400, 415].includes(error.status)) throw Object.assign(new Error('上传失败'), { status: error.status });
        throw error;
      } finally {
        await rm(extracted, { recursive: true, force: true });
      }
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && parts[0] === 'api' && parts[1] === 'package-previews' && parts[2]) {
      const ticket = packagePreviewTickets.get(parts[2]);
      if (!ticket || ticket.expiresAt <= Date.now()) {
        packagePreviewTickets.delete(parts[2]);
        return json(res, 404, { error: '预览链接已过期，请重新打开在线预览' });
      }
      return sendPackagePreview(req, res, ticket);
    }

    const adminPackageFormDownload = req.method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'contests' && ['package', 'lemon-package'].includes(parts[4]) && parts[5] === 'download';
    if (url.pathname.startsWith('/api/admin/') && !adminPackageFormDownload) requireAdmin(req);
    if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
      const contests = db.prepare('SELECT * FROM contests ORDER BY start_at DESC').all().map(row => ({
        ...publicContest(row),
        participantCount: db.prepare('SELECT COUNT(*) count FROM participants WHERE contest_id = ?').get(row.id).count,
        participants: adminParticipants(row.id),
        submissions: latestSubmissions(row.id).map(s => ({
          id: s.id, studentId: s.student_id, studentName: s.student_name, version: s.version, status: s.status,
          score: s.score, submittedAt: s.submitted_at, formatReport: s.format_report, details: JSON.parse(s.details_json || '{}'),
          submissionAllowed: Boolean(db.prepare('SELECT submission_allowed FROM participants WHERE contest_id = ? AND student_id = ?').get(row.id, s.student_id)?.submission_allowed)
        }))
      }));
      return json(res, 200, { contests, adminTokenPath });
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'contests' && parts[4] === 'proctor' && parts[6] === 'screen') {
      const contestId = asInt(parts[3]);
      const studentId = parts[5];
      const state = proctorClients.get(proctorKey(contestId, studentId));
      if (!state?.screen) return json(res, 404, { error: '暂无屏幕画面' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': state.screen.length, 'cache-control': 'no-store' });
      return res.end(state.screen);
    }
    if ((req.method === 'GET' || adminPackageFormDownload) && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'contests' && ['package', 'lemon-package'].includes(parts[4]) && ['download', 'entries', 'preview', 'preview-ticket'].includes(parts[5])) {
      if (adminPackageFormDownload) {
        if (!String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) return json(res, 415, { error: '下载请求格式错误' });
        const form = await readForm(req);
        if (form.get('adminToken') !== ADMIN_TOKEN) return json(res, 401, { error: '管理员令牌错误' });
      }
      const contest = getContest(asInt(parts[3]));
      const kind = parts[4];
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      const archivePath = adminPackagePath(contest, kind);
      if (!archivePath || !existsSync(archivePath)) return json(res, 404, { error: kind === 'package' ? '公开题目包不存在' : 'Lemon 比赛包不存在' });
      const filename = kind === 'package' ? contest.package_name : `${contest.title}-Lemon.zip`;
      const info = await stat(archivePath);
      if (parts[5] === 'download') {
        res.writeHead(200, {
          'content-type': kind === 'package' ? 'application/octet-stream' : 'application/zip',
          'content-length': info.size,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
        });
        return createReadStream(archivePath).pipe(res);
      }

      let zip;
      let zipEntries;
      try {
        zip = new AdmZip(archivePath);
        zipEntries = zip.getEntries();
      } catch {
        zip = null;
        zipEntries = null;
      }
      if (parts[5] === 'entries') {
        if (!zip) return json(res, 200, { filename, archive: false, size: info.size, previewable: Boolean(previewContentType(filename)) && info.size <= MAX_PREVIEW_FILE });
        const entries = zipEntries.filter(entry => !entry.isDirectory).map(entry => {
          const name = normalizedZipPath(entry.entryName);
          const size = Number(entry.header.size || 0);
          return { name, size, previewable: Boolean(previewContentType(name)) && size <= MAX_PREVIEW_FILE };
        });
        return json(res, 200, { filename, archive: true, size: info.size, entries });
      }

      const requestedPath = url.searchParams.get('path');
      let previewName = filename;
      let data;
      if (requestedPath) {
        if (!zip) return json(res, 400, { error: '该文件不是 ZIP，不能浏览内部文件' });
        const safePath = normalizedZipPath(requestedPath);
        const entry = zip.getEntry(safePath);
        if (!entry || entry.isDirectory) return json(res, 404, { error: '压缩包内文件不存在' });
        if (Number(entry.header.size || 0) > MAX_PREVIEW_FILE) return json(res, 413, { error: '文件超过 10 MiB，请下载后查看' });
        previewName = safePath;
        data = entry.getData();
      } else {
        if (info.size > MAX_PREVIEW_FILE) return json(res, 413, { error: '文件超过 10 MiB，请下载后查看' });
        data = await readFile(archivePath);
      }
      const contentType = previewContentType(previewName);
      if (!contentType) return json(res, 415, { error: '该文件类型不支持在线预览，请下载后查看' });
      if (parts[5] === 'preview-ticket') {
        return json(res, 200, { url: createPackagePreviewTicket(data, previewName, contentType) });
      }
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': data.length,
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(previewName))}`
      });
      return res.end(data);
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/contests') {
      const body = await readJson(req);
      if (!body.title?.trim()) throw Object.assign(new Error('比赛名称不能为空'), { status: 400 });
      if (!Number.isFinite(Date.parse(body.startAt)) || !Number.isFinite(Date.parse(body.endAt)) || Date.parse(body.endAt) <= Date.parse(body.startAt)) {
        throw Object.assign(new Error('开始/截止时间无效'), { status: 400 });
      }
      const importedNames = parseRosterNames(body.rosterNames || '');
      const roster = importedNames.length ? (() => {
        const used = new Set();
        return importedNames.map(studentName => ({ studentId: randomStudentId(used), studentName, token: humanCode() }));
      })() : parseRoster(body.rosterCsv || '');
      const insert = db.prepare(`INSERT INTO contests(title, description, start_at, end_at, access_hash, ranking_public, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(body.title.trim(), body.description?.trim() || '', new Date(body.startAt).toISOString(), new Date(body.endAt).toISOString(), body.accessCode ? sha256(body.accessCode) : '', body.rankingPublic === false ? 0 : 1, nowIso());
      const id = Number(insert.lastInsertRowid);
      const addParticipant = db.prepare('INSERT INTO participants(contest_id, student_id, student_name, token_hash, token_plain) VALUES (?, ?, ?, ?, ?)');
      for (const row of roster) addParticipant.run(id, row.studentId, row.studentName, sha256(row.token), row.token);
      return json(res, 201, { id, roster });
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'contests' && parts[4] === 'roster.csv') {
      const contest = getContest(asInt(parts[3]));
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      const roster = db.prepare('SELECT student_id, student_name, token_plain FROM participants WHERE contest_id = ? ORDER BY student_id').all(contest.id);
      const lines = ['考号,姓名,个人提交码', ...roster.map(row => [row.student_id, row.student_name, row.token_plain].map(csvCell).join(','))];
      const data = Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-length': data.length,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${contest.title}-报名信息.csv`)}`
      });
      return res.end(data);
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'contests' && parts[4] === 'exam-roster.csv') {
      const contest = getContest(asInt(parts[3]));
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      const roster = db.prepare('SELECT student_id, student_name FROM participants WHERE contest_id = ? ORDER BY student_name, student_id').all(contest.id);
      const lines = ['姓名,考号', ...roster.map(row => [row.student_name, row.student_id].map(csvCell).join(','))];
      const data = Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-length': data.length,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${contest.title}-比赛名单.csv`)}`
      });
      return res.end(data);
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'contests' && parts[4] === 'participants' && parts.length === 5) {
      const contest = getContest(asInt(parts[3]));
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      if (['closed', 'ended'].includes(contestState(contest))) return json(res, 409, { error: '比赛已结束，不能再添加学生' });
      const body = await readJson(req);
      const studentName = String(body.studentName || '').trim();
      if (!studentName || studentName.length > 40) throw Object.assign(new Error('姓名不能为空且最长 40 字'), { status: 400 });
      const used = new Set(db.prepare('SELECT student_id FROM participants WHERE contest_id = ?').all(contest.id).map(row => row.student_id));
      const studentId = randomStudentId(used);
      const token = humanCode();
      db.prepare('INSERT INTO participants(contest_id, student_id, student_name, token_hash, token_plain) VALUES (?, ?, ?, ?, ?)')
        .run(contest.id, studentId, studentName, sha256(token), token);
      return json(res, 201, { studentId, studentName, token });
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'contests' && parts[4] === 'participants' && parts.length === 6) {
      const contest = getContest(asInt(parts[3]));
      const studentId = parts[5];
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      if (!safeId(studentId)) return json(res, 400, { error: '考号格式错误' });
      const participant = db.prepare('SELECT * FROM participants WHERE contest_id = ? AND student_id = ?').get(contest.id, studentId);
      if (!participant) return json(res, 404, { error: '学生不存在' });
      const active = db.prepare("SELECT COUNT(*) count FROM submissions WHERE contest_id = ? AND student_id = ? AND status IN ('queued', 'judging')").get(contest.id, studentId).count;
      if (active) return json(res, 409, { error: '该学生的提交仍在测评，暂时不能删除' });
      const submissionIds = db.prepare('SELECT id FROM submissions WHERE contest_id = ? AND student_id = ?').all(contest.id, studentId).map(row => row.id);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM submissions WHERE contest_id = ? AND student_id = ?').run(contest.id, studentId);
        db.prepare('DELETE FROM participants WHERE contest_id = ? AND student_id = ?').run(contest.id, studentId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      await Promise.all([
        rm(path.join(DATA, 'submissions', String(contest.id), studentId), { recursive: true, force: true }),
        ...submissionIds.map(id => rm(path.join(DATA, 'jobs', String(id)), { recursive: true, force: true }))
      ]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'contests' && parts[4] === 'package') {
      const contest = getContest(asInt(parts[3]));
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      const filename = path.basename(url.searchParams.get('filename') || 'problems.zip');
      const target = path.join(DATA, 'contests', String(contest.id), 'public', filename);
      await receiveFile(req, target, MAX_PACKAGE_ZIP);
      db.prepare('UPDATE contests SET package_name = ?, package_path = ? WHERE id = ?').run(filename, target, contest.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'contests' && parts[4] === 'lemon-package') {
      const contest = getContest(asInt(parts[3]));
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      const dir = path.join(DATA, 'contests', String(contest.id));
      const archive = path.join(dir, 'lemon-contest.zip');
      const template = path.join(dir, 'lemon-template');
      await receiveFile(req, archive, MAX_PACKAGE_ZIP);
      await extractZipStrict(archive, template, 2 * 1024 * 1024 * 1024);
      const files = await walkFiles(template);
      const cdfs = files.filter(file => file.toLowerCase().endsWith('.cdf'));
      if (cdfs.length !== 1) throw Object.assign(new Error(`Lemon 比赛包必须恰好包含一个 .cdf，实际 ${cdfs.length} 个`), { status: 400 });
      const cdfPath = path.join(template, ...cdfs[0].split('/'));
      const lemonRoot = path.dirname(cdfPath);
      let cdf;
      try { cdf = JSON.parse(await readFile(cdfPath, 'utf8')); }
      catch { throw Object.assign(new Error('CDF 文件内容损坏或不是有效的 LemonLime 配置'), { status: 400 }); }
      const tasks = parseTasks(cdf);
      if (!existsSync(path.join(lemonRoot, 'data'))) throw Object.assign(new Error('CDF 同目录下缺少 data 文件夹'), { status: 400 });
      db.prepare('UPDATE contests SET lemon_root = ?, cdf_path = ?, tasks_json = ? WHERE id = ?').run(lemonRoot, cdfPath, JSON.stringify(tasks), contest.id);
      return json(res, 200, { ok: true, tasks });
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'contests' && parts[4] === 'package') {
      const contest = getContest(asInt(parts[3]));
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      if (contest.package_path) await rm(contest.package_path, { force: true });
      db.prepare('UPDATE contests SET package_name = NULL, package_path = NULL WHERE id = ?').run(contest.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'contests' && parts[4] === 'lemon-package') {
      const contest = getContest(asInt(parts[3]));
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      const active = db.prepare("SELECT COUNT(*) count FROM submissions WHERE contest_id = ? AND status IN ('queued', 'judging')").get(contest.id).count;
      if (active) return json(res, 409, { error: `仍有 ${active} 个提交正在测评，不能删除比赛包` });
      const dir = path.join(DATA, 'contests', String(contest.id));
      await Promise.all([
        rm(path.join(dir, 'lemon-contest.zip'), { force: true }),
        rm(path.join(dir, 'lemon-template'), { recursive: true, force: true })
      ]);
      db.prepare("UPDATE contests SET lemon_root = NULL, cdf_path = NULL, tasks_json = '[]' WHERE id = ?").run(contest.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'contests' && parts[4] === 'close') {
      const contest = getContest(asInt(parts[3]));
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      const closedAt = contest.closed_at || nowIso();
      if (!contest.closed_at) db.prepare('UPDATE contests SET closed_at = ? WHERE id = ?').run(closedAt, contest.id);
      return json(res, 200, { ok: true, closedAt });
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'contests' && parts.length === 4) {
      const contest = getContest(asInt(parts[3]));
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      if (!['closed', 'ended'].includes(contestState(contest))) {
        return json(res, 409, { error: '只能删除已关闭或已结束的比赛' });
      }
      const active = db.prepare("SELECT COUNT(*) count FROM submissions WHERE contest_id = ? AND status IN ('queued', 'judging')").get(contest.id).count;
      if (active) return json(res, 409, { error: `仍有 ${active} 个提交正在测评，请等待完成后再删除` });
      const submissionIds = db.prepare('SELECT id FROM submissions WHERE contest_id = ?').all(contest.id).map(row => row.id);
      db.prepare('DELETE FROM contests WHERE id = ?').run(contest.id);
      await Promise.all([
        rm(path.join(DATA, 'contests', String(contest.id)), { recursive: true, force: true }),
        rm(path.join(DATA, 'submissions', String(contest.id)), { recursive: true, force: true }),
        ...submissionIds.map(id => rm(path.join(DATA, 'jobs', String(id)), { recursive: true, force: true }))
      ]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PATCH' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'contests' && parts.length === 4) {
      const contest = getContest(asInt(parts[3]));
      if (!contest) return json(res, 404, { error: '比赛不存在' });
      const body = await readJson(req);
      const title = body.title === undefined ? contest.title : String(body.title).trim();
      if (!title || title.length > 80) return json(res, 400, { error: '比赛名称不能为空且最长 80 字' });
      const editsTime = body.startAt !== undefined || body.endAt !== undefined;
      if (editsTime && contest.closed_at) return json(res, 409, { error: '比赛已由管理员关闭，不能再修改时间' });
      const startAt = body.startAt === undefined ? contest.start_at : body.startAt;
      const endAt = body.endAt === undefined ? contest.end_at : body.endAt;
      if (!Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt)) || Date.parse(endAt) <= Date.parse(startAt)) {
        return json(res, 400, { error: '开始、截止时间无效，截止时间必须晚于开始时间' });
      }
      const rankingPublic = body.rankingPublic === undefined ? contest.ranking_public : body.rankingPublic ? 1 : 0;
      db.prepare('UPDATE contests SET title = ?, start_at = ?, end_at = ?, ranking_public = ? WHERE id = ?')
        .run(title, new Date(startAt).toISOString(), new Date(endAt).toISOString(), rankingPublic, contest.id);
      return json(res, 200, publicContest(getContest(contest.id)));
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'submissions' && parts[4] === 'archive') {
      const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(asInt(parts[3]));
      if (!submission || !existsSync(submission.archive_path)) return json(res, 404, { error: '提交文件不存在' });
      const info = await stat(submission.archive_path);
      const filename = `${submission.student_id}-v${submission.version}.zip`;
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': info.size,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
      });
      return createReadStream(submission.archive_path).pipe(res);
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'submissions' && parts[4] === 'reset-attempt') {
      const submission = db.prepare('SELECT contest_id, student_id FROM submissions WHERE id = ?').get(asInt(parts[3]));
      if (!submission) return json(res, 404, { error: '提交不存在' });
      const reset = db.prepare('UPDATE participants SET submission_allowed = 1 WHERE contest_id = ? AND student_id = ?').run(submission.contest_id, submission.student_id);
      if (!reset.changes) return json(res, 409, { error: '该比赛没有可重置的报名学生' });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'submissions' && parts[4] === 'rejudge') {
      const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(asInt(parts[3]));
      if (!submission) return json(res, 404, { error: '提交不存在' });
      db.prepare("UPDATE submissions SET status = 'queued', score = NULL, used_time = NULL, details_json = '{}' WHERE id = ?").run(submission.id);
      enqueueJudge(submission.id);
      return json(res, 202, { ok: true });
    }

    return json(res, 404, { error: '接口不存在' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '服务器内部错误' });
    else res.destroy();
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log(`OI LAN server: http://localhost:${PORT}`);
    console.log(`Admin token: ${ADMIN_TOKEN}`);
    console.log(`Admin token file: ${adminTokenPath}`);
    writeFile(path.join(DATA, 'server.pid'), String(process.pid)).catch(console.error);
  });
}

export { db, server, parseTasks, normalizedZipPath, validateSubmission };
