import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const testData = mkdtempSync(path.join(tmpdir(), 'oi-lan-lemon-test-'));
process.env.DATA_DIR = testData;
process.env.LEMON_WORKER = path.join(testData, 'missing-lemon-worker.exe');
const { db, server, normalizedZipPath, parseTasks, validateSubmission } = await import('./server.mjs');
const { default: AdmZip } = await import('adm-zip');

function folderSubmission(root, files) {
  const body = new FormData();
  const entries = Object.entries(files);
  body.append('manifest', JSON.stringify(entries.map(([name]) => `${root}/${name}`)));
  entries.forEach(([name, content], index) => body.append(`file-${index}`, new Blob([content]), path.basename(name)));
  return body;
}

after(() => {
  db.close();
  rmSync(testData, { recursive: true, force: true });
});

test('CDF tasks become strict OI paths', () => {
  assert.deepEqual(parseTasks({ tasks: [
    { problemTitle: 'sum', sourceFileName: 'sum', subFolderCheck: false },
    { problemTitle: 'tree', sourceFileName: 'tree', subFolderCheck: true }
  ] }), [
    { title: 'sum', source: 'sum', subFolder: false },
    { title: 'tree', source: 'tree', subFolder: true }
  ]);
  assert.throws(
    () => parseTasks({ tasks: [{ problemTitle: '试题1', sourceFileName: '', testCases: [] }] }),
    error => error.status === 400 && /第 1 题“试题1”.*缺少源码文件名/.test(error.message)
  );
});

test('ZIP traversal is rejected', () => {
  assert.throws(() => normalizedZipPath('../secret.txt'));
  assert.throws(() => normalizedZipPath('C:/secret.txt'));
  assert.equal(normalizedZipPath('S001/sum.cpp'), 'S001/sum.cpp');
});

test('submission format is checked independently for every task', async () => {
  const tasks = [{ title: 'sum', source: 'sum', subFolder: true }, { title: 'answer', source: 'answer', subFolder: true }];
  const makeZip = (name, files) => {
    const zip = new AdmZip();
    for (const file of files) zip.addFile(file, Buffer.from('int main(){}\n'));
    const target = path.join(testData, name);
    zip.writeZip(target);
    return target;
  };
  const partial = await validateSubmission(makeZip('partial.zip', ['OI123456/sum/sum.cpp']), 'OI123456', tasks, path.join(testData, 'partial'));
  assert.deepEqual(partial.tasks.map(task => task.valid), [true, false]);
  assert.match(partial.report, /找到 1\/2 道/);
  const wrongCase = await validateSubmission(makeZip('case.zip', ['OI123456/SUM/SUM.CPP']), 'OI123456', tasks, path.join(testData, 'case'));
  assert.deepEqual(wrongCase.tasks.map(task => task.valid), [false, false]);
  const extra = await validateSubmission(makeZip('extra.zip', ['OI123456/sum/sum.cpp', 'OI123456/readme.txt']), 'OI123456', tasks, path.join(testData, 'extra'));
  assert.equal(extra.tasks[0].valid, true);
  const systemMetadata = await validateSubmission(makeZip('metadata.zip', ['OI123456/sum/sum.cpp', '__MACOSX/._sum.cpp']), 'OI123456', tasks, path.join(testData, 'metadata'));
  assert.equal(systemMetadata.tasks[0].valid, true);
});

test('async form handlers keep a stable form reference', () => {
  const source = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
  const contestSource = readFileSync(new URL('./public/contest.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /event\.currentTarget\.reset\(\)/);
  assert.match(source, /const formElement = event\.currentTarget/);
  assert.match(source, /href="\/contest\.html\?id=\$\{contest\.id\}"/);
  assert.doesNotMatch(contestSource, /event\.currentTarget\.reset\(\)/);
  assert.match(contestSource, /const formElement = event\.currentTarget/);
  assert.match(contestSource, /上传成功/);
  assert.match(contestSource, /上传超时/);
  assert.doesNotMatch(contestSource, /已通过格式检查并进入测评队列/);
  assert.doesNotMatch(contestSource, /result\.formatReport/);
  assert.doesNotMatch(contestSource, /lookup-form/);
  assert.doesNotMatch(contestSource, /submissions\/latest/);
  assert.match(source, /delete-package/);
  assert.match(source, /add-student/);
  assert.match(source, /delete-student/);
  assert.match(contestSource, /package-download-form/);
  assert.match(source, /download-admin-package/);
  assert.match(source, /inspect-admin-package/);
  assert.match(source, /preview-ticket/);
  assert.match(source, /contest-time-form/);
  assert.match(source, /有未保存修改/);
  assert.match(source, /reset-contest-time/);
  assert.match(source, /openProctorScreen/);
  assert.match(source, /客户端已离线/);
  assert.match(source, /showJudgeDetail/);
  assert.match(source, /adminContests\.flatMap/);
  assert.match(page, /id="judge-detail-viewer"/);
  assert.match(source, /#admin-dashboard input,#admin-dashboard textarea,#admin-dashboard select/);
  assert.match(readFileSync(new URL('./server.mjs', import.meta.url), 'utf8'), /proctorOnline \? proctor\.violation : ''/);
  assert.match(page, /id="proctor-viewer"/);
  assert.doesNotMatch(source, /packagePreviewUrls/);
  const contestPage = readFileSync(new URL('./public/contest.html', import.meta.url), 'utf8');
  assert.match(contestPage, /id="contest-page"/);
  assert.doesNotMatch(page, /id="contest-dialog"/);
  assert.doesNotMatch(page, /15\. 选择整个考号文件夹上传/);
  assert.doesNotMatch(page, /16\. 可以重复提交/);
});

test('admin creates contest and strict student folder reaches judge queue', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const imageResponse = await fetch(`${origin}/assets/csp-file-table.png`);
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${origin}/contest.html?id=1`)).status, 200);
  assert.equal((await fetch(`${origin}/contest.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  const token = (await import('node:fs/promises')).readFile(path.join(testData, 'admin-token.txt'), 'utf8');
  const adminHeaders = { 'x-admin-token': (await token).trim() };
  const start = new Date(Date.now() - 60_000).toISOString();
  const end = new Date(Date.now() + 60_000).toISOString();
  const createdResponse = await fetch(`${origin}/api/admin/contests`, {
    method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ title: '自检赛', startAt: start, endAt: end, rosterNames: '张三\n李四' })
  });
  assert.equal(createdResponse.status, 201);
  const { id, roster } = await createdResponse.json();
  assert.equal(roster.length, 2);
  assert.match(roster[0].studentId, /^OI\d{6}$/);
  assert.equal(roster[0].studentName, '张三');
  assert.match(roster[0].token, /^[23456789A-HJ-NP-Z]{8}$/);

  const invalidProctorDownload = await fetch(`${origin}/api/contests/${id}/proctor-client`, {
    method: 'POST', body: new URLSearchParams({ studentId: roster[0].studentId, studentToken: 'WRONG' })
  });
  assert.equal(invalidProctorDownload.status, 403);
  const proctorDownload = await fetch(`${origin}/api/contests/${id}/proctor-client`, {
    method: 'POST', body: new URLSearchParams({ studentId: roster[0].studentId, studentToken: roster[0].token })
  });
  assert.equal(proctorDownload.status, 200);
  assert.match(proctorDownload.headers.get('content-disposition'), new RegExp(roster[0].studentId));
  const proctorExe = Buffer.from(await proctorDownload.arrayBuffer());
  assert.ok(proctorExe.length > 1024);
  const configMarker = Buffer.from('\nOI_PROCTOR_CONFIG_V1\n');
  const markerPosition = proctorExe.lastIndexOf(configMarker);
  assert.ok(markerPosition > 0);
  const embeddedConfig = JSON.parse(proctorExe.subarray(markerPosition + configMarker.length).toString());
  assert.equal(embeddedConfig.server, origin);
  assert.equal(embeddedConfig.contestId, id);
  assert.equal(embeddedConfig.studentId, roster[0].studentId);
  assert.equal(embeddedConfig.studentToken, roster[0].token);

  const invalidHeartbeat = await fetch(`${origin}/api/proctor/heartbeat?contestId=${id}&studentId=${roster[0].studentId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-student-token': 'WRONG' }, body: '{}'
  });
  assert.equal(invalidHeartbeat.status, 403);
  const heartbeat = await fetch(`${origin}/api/proctor/heartbeat?contestId=${id}&studentId=${roster[0].studentId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-student-token': roster[0].token },
    body: JSON.stringify({ screen: Buffer.from('jpeg').toString('base64'), processes: ['Code'], violation: '发现 QQ' })
  });
  assert.equal(heartbeat.status, 200);
  assert.equal((await heartbeat.json()).canExit, false);
  let proctorOverview = await fetch(`${origin}/api/admin/overview`, { headers: adminHeaders }).then(response => response.json());
  const proctoredStudent = proctorOverview.contests.find(contest => contest.id === id).participants.find(item => item.studentId === roster[0].studentId);
  assert.equal(proctoredStudent.proctor.online, true);
  assert.equal(proctoredStudent.proctor.violation, '发现 QQ');
  assert.deepEqual(proctoredStudent.proctor.processes, ['Code']);
  assert.equal((await fetch(`${origin}/api/admin/contests/${id}/proctor/${roster[0].studentId}/screen`)).status, 401);
  const proctorScreen = await fetch(`${origin}/api/admin/contests/${id}/proctor/${roster[0].studentId}/screen`, { headers: adminHeaders });
  assert.equal(proctorScreen.status, 200);
  assert.equal(Buffer.from(await proctorScreen.arrayBuffer()).toString(), 'jpeg');
  const unlockedHeartbeat = await fetch(`${origin}/api/proctor/heartbeat?contestId=${id}&studentId=${roster[0].studentId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-student-token': roster[0].token }, body: JSON.stringify({ processes: ['Code'] })
  }).then(response => response.json());
  assert.equal(unlockedHeartbeat.canExit, false);

  let participantOverview = await fetch(`${origin}/api/admin/overview`, { headers: adminHeaders }).then(response => response.json());
  assert.equal(participantOverview.contests.find(contest => contest.id === id).participants.length, 2);
  assert.ok(participantOverview.contests.find(contest => contest.id === id).participants.every(student => !student.submissionId));
  const addStudentResponse = await fetch(`${origin}/api/admin/contests/${id}/participants`, {
    method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ studentName: '王五' })
  });
  const addedStudent = await addStudentResponse.json();
  assert.equal(addStudentResponse.status, 201, JSON.stringify(addedStudent));
  assert.match(addedStudent.studentId, /^OI\d{6}$/);
  assert.match(addedStudent.token, /^[23456789A-HJ-NP-Z]{8}$/);
  participantOverview = await fetch(`${origin}/api/admin/overview`, { headers: adminHeaders }).then(response => response.json());
  assert.equal(participantOverview.contests.find(contest => contest.id === id).participants.length, 3);
  const deleteStudentResponse = await fetch(`${origin}/api/admin/contests/${id}/participants/${addedStudent.studentId}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(deleteStudentResponse.status, 200, await deleteStudentResponse.text());
  participantOverview = await fetch(`${origin}/api/admin/overview`, { headers: adminHeaders }).then(response => response.json());
  assert.equal(participantOverview.contests.find(contest => contest.id === id).participants.length, 2);

  const changedStart = new Date(Date.now() - 120_000).toISOString();
  const changedEnd = new Date(Date.now() + 120_000).toISOString();
  const timeResponse = await fetch(`${origin}/api/admin/contests/${id}`, {
    method: 'PATCH', headers: { ...adminHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ startAt: changedStart, endAt: changedEnd })
  });
  const changedContest = await timeResponse.json();
  assert.equal(timeResponse.status, 200, JSON.stringify(changedContest));
  assert.equal(changedContest.startAt, changedStart);
  assert.equal(changedContest.endAt, changedEnd);
  assert.equal(changedContest.state, 'running');
  const renameResponse = await fetch(`${origin}/api/admin/contests/${id}`, {
    method: 'PATCH', headers: { ...adminHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ title: '自检赛（改名）' })
  });
  const renamedContest = await renameResponse.json();
  assert.equal(renameResponse.status, 200, JSON.stringify(renamedContest));
  assert.equal(renamedContest.title, '自检赛（改名）');
  assert.equal((await fetch(`${origin}/api/contests`).then(response => response.json())).find(contest => contest.id === id).title, '自检赛（改名）');
  assert.equal((await fetch(`${origin}/api/admin/contests/${id}`, { method: 'PATCH', headers: { ...adminHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ title: '   ' }) })).status, 400);
  const invalidTimeResponse = await fetch(`${origin}/api/admin/contests/${id}`, {
    method: 'PATCH', headers: { ...adminHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ startAt: changedEnd, endAt: changedStart })
  });
  assert.equal(invalidTimeResponse.status, 400);

  const publicZip = new AdmZip();
  publicZip.addFile('statement.md', Buffer.from('# Public problems\n'));
  publicZip.addFile('unsafe.html', Buffer.from('<script>alert(1)</script>'));
  const publicPackage = publicZip.toBuffer();
  let publicPackageResponse = await fetch(`${origin}/api/admin/contests/${id}/package?filename=problems.zip`, {
    method: 'PUT', headers: { ...adminHeaders, 'content-type': 'application/octet-stream' }, body: publicPackage
  });
  assert.equal(publicPackageResponse.status, 200, await publicPackageResponse.text());
  const deletePublicResponse = await fetch(`${origin}/api/admin/contests/${id}/package`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(deletePublicResponse.status, 200, await deletePublicResponse.text());
  assert.equal((await fetch(`${origin}/api/admin/overview`, { headers: adminHeaders }).then(response => response.json())).contests.find(contest => contest.id === id).hasPackage, false);
  publicPackageResponse = await fetch(`${origin}/api/admin/contests/${id}/package?filename=problems.zip`, {
    method: 'PUT', headers: { ...adminHeaders, 'content-type': 'application/octet-stream' }, body: publicPackage
  });
  assert.equal(publicPackageResponse.status, 200, await publicPackageResponse.text());
  assert.equal((await fetch(`${origin}/api/admin/contests/${id}/package/entries`)).status, 401);
  const publicEntries = await fetch(`${origin}/api/admin/contests/${id}/package/entries`, { headers: adminHeaders }).then(response => response.json());
  assert.equal(publicEntries.archive, true);
  assert.equal(publicEntries.entries.find(entry => entry.name === 'statement.md').previewable, true);
  assert.equal(publicEntries.entries.find(entry => entry.name === 'unsafe.html').previewable, false);
  const statementPreview = await fetch(`${origin}/api/admin/contests/${id}/package/preview?path=statement.md`, { headers: adminHeaders });
  assert.equal(statementPreview.status, 200);
  assert.match(statementPreview.headers.get('content-type'), /^text\/plain/);
  assert.equal(await statementPreview.text(), '# Public problems\n');
  const previewTicketResponse = await fetch(`${origin}/api/admin/contests/${id}/package/preview-ticket?path=statement.md`, { headers: adminHeaders });
  assert.equal(previewTicketResponse.status, 200);
  const { url: previewUrl } = await previewTicketResponse.json();
  const rangedPreview = await fetch(`${origin}${previewUrl}`, { headers: { range: 'bytes=2-7' } });
  assert.equal(rangedPreview.status, 206);
  assert.equal(rangedPreview.headers.get('content-range'), 'bytes 2-7/18');
  assert.equal(await rangedPreview.text(), 'Public');
  assert.equal((await fetch(`${origin}/api/admin/contests/${id}/package/preview?path=unsafe.html`, { headers: adminHeaders })).status, 415);
  const adminPackageDownload = await fetch(`${origin}/api/admin/contests/${id}/package/download`, { headers: adminHeaders });
  assert.equal(adminPackageDownload.status, 200);
  assert.deepEqual(Buffer.from(await adminPackageDownload.arrayBuffer()), publicPackage);
  const adminPackageFormDownload = await fetch(`${origin}/api/admin/contests/${id}/package/download`, {
    method: 'POST',
    body: new URLSearchParams({ adminToken: adminHeaders['x-admin-token'] })
  });
  assert.equal(adminPackageFormDownload.status, 200);
  assert.deepEqual(Buffer.from(await adminPackageFormDownload.arrayBuffer()), publicPackage);
  assert.equal((await fetch(`${origin}/api/contests/${id}/package`)).status, 404);
  const invalidPackageDownload = await fetch(`${origin}/api/contests/${id}/package`, {
    method: 'POST', body: new URLSearchParams({ studentId: roster[0].studentId, studentToken: 'WRONG' })
  });
  assert.equal(invalidPackageDownload.status, 403);
  const packageDownload = await fetch(`${origin}/api/contests/${id}/package`, {
    method: 'POST', body: new URLSearchParams({ studentId: roster[0].studentId, studentToken: roster[0].token })
  });
  assert.equal(packageDownload.status, 200);
  assert.deepEqual(Buffer.from(await packageDownload.arrayBuffer()), publicPackage);

  const invalidLemonZip = new AdmZip();
  invalidLemonZip.addFile('contest/test.cdf', Buffer.from(JSON.stringify({
    contestTitle: 'Invalid', tasks: [{ problemTitle: '试题1', sourceFileName: '', testCases: [] }]
  })));
  invalidLemonZip.addFile('contest/data/.keep', Buffer.from(''));
  const invalidLemonResponse = await fetch(`${origin}/api/admin/contests/${id}/lemon-package`, {
    method: 'PUT', headers: adminHeaders, body: invalidLemonZip.toBuffer()
  });
  assert.equal(invalidLemonResponse.status, 400);
  assert.match((await invalidLemonResponse.json()).error, /第 1 题“试题1”.*缺少源码文件名/);

  const lemonZip = new AdmZip();
  lemonZip.addFile('contest/test.cdf', Buffer.from(JSON.stringify({
    version: '1.0', contestTitle: 'Self Test', contestants: [],
    tasks: [{ problemTitle: 'sum', sourceFileName: 'sum', subFolderCheck: false }]
  })));
  lemonZip.addFile('contest/data/sum/1.in', Buffer.from('1 2\n'));
  lemonZip.addFile('contest/data/sum/1.out', Buffer.from('3\n'));
  const lemonResponse = await fetch(`${origin}/api/admin/contests/${id}/lemon-package`, {
    method: 'PUT', headers: adminHeaders, body: lemonZip.toBuffer()
  });
  assert.equal(lemonResponse.status, 200, await lemonResponse.text());
  const deleteLemonResponse = await fetch(`${origin}/api/admin/contests/${id}/lemon-package`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(deleteLemonResponse.status, 200, await deleteLemonResponse.text());
  const withoutLemon = (await fetch(`${origin}/api/admin/overview`, { headers: adminHeaders }).then(response => response.json())).contests.find(contest => contest.id === id);
  assert.equal(withoutLemon.judgeReady, false);
  assert.deepEqual(withoutLemon.tasks, []);
  const replacementLemonResponse = await fetch(`${origin}/api/admin/contests/${id}/lemon-package`, {
    method: 'PUT', headers: adminHeaders, body: lemonZip.toBuffer()
  });
  assert.equal(replacementLemonResponse.status, 200, await replacementLemonResponse.text());
  const lemonEntries = await fetch(`${origin}/api/admin/contests/${id}/lemon-package/entries`, { headers: adminHeaders }).then(response => response.json());
  assert.equal(lemonEntries.archive, true);
  assert.equal(lemonEntries.entries.find(entry => entry.name === 'contest/test.cdf').previewable, true);
  const cdfPreview = await fetch(`${origin}/api/admin/contests/${id}/lemon-package/preview?path=${encodeURIComponent('contest/test.cdf')}`, { headers: adminHeaders });
  assert.equal(cdfPreview.status, 200);
  assert.match(await cdfPreview.text(), /Self Test/);
  const lemonDownload = await fetch(`${origin}/api/admin/contests/${id}/lemon-package/download`, { headers: adminHeaders });
  assert.equal(lemonDownload.status, 200);
  assert.ok((await lemonDownload.arrayBuffer()).byteLength > 0);

  const examMatches = await fetch(`${origin}/api/contests/${id}/exam-number?studentName=${encodeURIComponent(roster[0].studentName)}`).then(response => response.json());
  assert.deepEqual(examMatches, [{ studentId: roster[0].studentId, studentName: roster[0].studentName }]);
  const query = new URLSearchParams({ studentId: roster[0].studentId, studentName: roster[0].studentName, studentToken: roster[0].token });
  const submitResponse = await fetch(`${origin}/api/contests/${id}/submissions?${query}`, {
    method: 'PUT', body: folderSubmission(roster[0].studentId, { 'sum.cpp': 'int main(){}\n' })
  });
  const submitted = await submitResponse.json();
  assert.equal(submitResponse.status, 201, JSON.stringify(submitted));
  assert.deepEqual(submitted, { ok: true, status: 'uploaded' });

  const invalidQuery = new URLSearchParams({ studentId: roster[1].studentId, studentName: roster[1].studentName, studentToken: roster[1].token });
  const invalidFormatResponse = await fetch(`${origin}/api/contests/${id}/submissions?${invalidQuery}`, {
    method: 'PUT', body: folderSubmission(roster[1].studentId, { 'wrong.cpp': 'int main(){}\n' })
  });
  assert.equal(invalidFormatResponse.status, 201);
  assert.deepEqual(await invalidFormatResponse.json(), { ok: true, status: 'uploaded' });

  const duplicateResponse = await fetch(`${origin}/api/contests/${id}/submissions?${query}`, {
    method: 'PUT', body: folderSubmission(roster[0].studentId, { 'sum.cpp': 'int main(){}\n' })
  });
  assert.equal(duplicateResponse.status, 409);
  assert.match((await duplicateResponse.json()).error, /只允许提交一次/);
  assert.equal((await fetch(`${origin}/api/contests/${id}/submissions/latest?studentId=${roster[0].studentId}`)).status, 404);

  await new Promise(resolve => setTimeout(resolve, 30));
  let overview = await fetch(`${origin}/api/admin/overview`, { headers: adminHeaders }).then(response => response.json());
  let latest = overview.contests.find(contest => contest.id === id).submissions.find(submission => submission.studentId === roster[0].studentId);
  assert.equal(latest.status, 'judge_unavailable');
  assert.match(latest.formatReport, /格式正确/);
  assert.equal(latest.submissionAllowed, false);
  const submittedParticipant = overview.contests.find(contest => contest.id === id).participants.find(student => student.studentId === roster[0].studentId);
  assert.equal(submittedParticipant.submissionId, latest.id);
  assert.equal(submittedParticipant.status, 'judge_unavailable');
  const formatErrorParticipant = overview.contests.find(contest => contest.id === id).participants.find(student => student.studentId === roster[1].studentId);
  assert.equal(formatErrorParticipant.status, 'format_error');
  assert.equal(formatErrorParticipant.score, 0);
  assert.equal(formatErrorParticipant.submissionAllowed, false);
  assert.deepEqual(formatErrorParticipant.taskScores, [{ title: 'sum', score: 0 }]);
  assert.equal((await fetch(`${origin}/api/admin/submissions/${latest.id}/archive`)).status, 401);
  const archiveResponse = await fetch(`${origin}/api/admin/submissions/${latest.id}/archive`, { headers: adminHeaders });
  assert.equal(archiveResponse.status, 200);
  assert.match(archiveResponse.headers.get('content-disposition'), new RegExp(roster[0].studentId));
  const downloaded = new AdmZip(Buffer.from(await archiveResponse.arrayBuffer()));
  assert.ok(downloaded.getEntry(`${roster[0].studentId}/sum.cpp`));

  const resetResponse = await fetch(`${origin}/api/admin/submissions/${latest.id}/reset-attempt`, { method: 'POST', headers: adminHeaders });
  assert.equal(resetResponse.status, 200, await resetResponse.text());
  overview = await fetch(`${origin}/api/admin/overview`, { headers: adminHeaders }).then(response => response.json());
  latest = overview.contests.find(contest => contest.id === id).submissions.find(submission => submission.studentId === roster[0].studentId);
  assert.equal(latest.submissionAllowed, true);
  const resubmittedResponse = await fetch(`${origin}/api/contests/${id}/submissions?${query}`, {
    method: 'PUT', body: folderSubmission(roster[0].studentId, { 'sum.cpp': 'int main(){}\n' })
  });
  const resubmitted = await resubmittedResponse.json();
  assert.equal(resubmittedResponse.status, 201, JSON.stringify(resubmitted));
  assert.deepEqual(resubmitted, { ok: true, status: 'uploaded' });
  const thirdResponse = await fetch(`${origin}/api/contests/${id}/submissions?${query}`, {
    method: 'PUT', body: folderSubmission(roster[0].studentId, { 'sum.cpp': 'int main(){}\n' })
  });
  assert.equal(thirdResponse.status, 409);
  const secondReset = await fetch(`${origin}/api/admin/submissions/${latest.id}/reset-attempt`, { method: 'POST', headers: adminHeaders });
  assert.equal(secondReset.status, 200, await secondReset.text());
  const thirdSubmission = await fetch(`${origin}/api/contests/${id}/submissions?${query}`, {
    method: 'PUT', body: folderSubmission(roster[0].studentId, { 'sum.cpp': 'int main(){}\n' })
  });
  assert.equal(thirdSubmission.status, 201, await thirdSubmission.text());
  const fourthResponse = await fetch(`${origin}/api/contests/${id}/submissions?${query}`, {
    method: 'PUT', body: folderSubmission(roster[0].studentId, { 'sum.cpp': 'int main(){}\n' })
  });
  assert.equal(fourthResponse.status, 409);
  await new Promise(resolve => setTimeout(resolve, 30));
  const rosterCsv = await fetch(`${origin}/api/admin/contests/${id}/roster.csv`, { headers: adminHeaders }).then(response => response.text());
  assert.match(rosterCsv, new RegExp(roster[0].studentId));
  assert.match(rosterCsv, new RegExp(roster[0].token));
  const examRosterCsv = await fetch(`${origin}/api/admin/contests/${id}/exam-roster.csv`, { headers: adminHeaders }).then(response => response.text());
  assert.match(examRosterCsv, /姓名,考号/);
  assert.match(examRosterCsv, new RegExp(roster[0].studentId));
  assert.doesNotMatch(examRosterCsv, new RegExp(roster[0].token));

  const earlyDeleteResponse = await fetch(`${origin}/api/admin/contests/${id}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(earlyDeleteResponse.status, 409);
  const closeResponse = await fetch(`${origin}/api/admin/contests/${id}/close`, { method: 'POST', headers: adminHeaders });
  assert.equal(closeResponse.status, 200);
  const closedTimeResponse = await fetch(`${origin}/api/admin/contests/${id}`, {
    method: 'PATCH', headers: { ...adminHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ startAt: changedStart, endAt: changedEnd })
  });
  assert.equal(closedTimeResponse.status, 409);
  const listed = await fetch(`${origin}/api/contests`).then(response => response.json());
  assert.equal(listed.find(contest => contest.id === id).state, 'closed');
  const rejectedResponse = await fetch(`${origin}/api/contests/${id}/submissions?${query}`, {
    method: 'PUT', body: folderSubmission(roster[0].studentId, { 'sum.cpp': 'int main(){}\n' })
  });
  assert.equal(rejectedResponse.status, 403);
  assert.match((await rejectedResponse.json()).error, /管理员关闭/);
  const deleteResponse = await fetch(`${origin}/api/admin/contests/${id}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(deleteResponse.status, 200, await deleteResponse.text());
  assert.equal(db.prepare('SELECT 1 FROM contests WHERE id = ?').get(id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM participants WHERE contest_id = ?').get(id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM submissions WHERE contest_id = ?').get(id), undefined);
  await new Promise(resolve => server.close(resolve));
});
