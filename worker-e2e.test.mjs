import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const root = path.dirname(fileURLToPath(import.meta.url));
const testData = mkdtempSync(path.join(tmpdir(), 'oi-lan-lemon-worker-'));
process.env.DATA_DIR = testData;
process.env.LEMON_WORKER = path.join(root, 'bin', 'lemon-headless.exe');
const { db, server } = await import('./server.mjs');

after(() => {
  db.close();
  rmSync(testData, { recursive: true, force: true });
});

test('uploaded OI folder is judged by LemonLime core and ranked', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = readFileSync(path.join(testData, 'admin-token.txt'), 'utf8').trim();
  const adminHeaders = { 'x-admin-token': token };
  const created = await fetch(`${origin}/api/admin/contests`, {
    method: 'POST',
    headers: { ...adminHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Lemon E2E',
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
      rosterNames: '张三'
    })
  }).then(response => response.json());
  const registration = created.roster[0];

  const cdf = {
    version: '1.0', contestTitle: 'Lemon E2E', contestants: [],
    tasks: [{
      answerFileExtension: 'out', comparisonMode: 1,
      compilerConfiguration: { 'g++': 'C++14 O2' },
      diffArguments: '--ignore-space-change --text --brief',
      inputFileName: 'sum.in', outputFileName: 'sum.out',
      problemTitle: 'sum', realPrecision: 3, sourceFileName: 'sum', specialJudge: '',
      standardInputCheck: true, standardOutputCheck: true, subFolderCheck: false, taskType: 0,
      testCases: [{ fullScore: 100, inputFiles: ['sum/1.in'], outputFiles: ['sum/1.out'], timeLimit: 1000, memoryLimit: 256 }]
    }]
  };
  const contestZip = new AdmZip();
  contestZip.addFile('contest/test.cdf', Buffer.from(JSON.stringify(cdf)));
  contestZip.addFile('contest/data/sum/1.in', Buffer.from('20 22\n'));
  contestZip.addFile('contest/data/sum/1.out', Buffer.from('42\n'));
  const packageResponse = await fetch(`${origin}/api/admin/contests/${created.id}/lemon-package`, {
    method: 'PUT', headers: adminHeaders, body: contestZip.toBuffer()
  });
  assert.equal(packageResponse.status, 200, await packageResponse.text());

  const studentFolder = new FormData();
  studentFolder.append('manifest', JSON.stringify([`${registration.studentId}/sum.cpp`]));
  studentFolder.append('file-0', new Blob(['#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}\n']), 'sum.cpp');
  const query = new URLSearchParams({ studentId: registration.studentId, studentName: registration.studentName, studentToken: registration.token });
  const submitResponse = await fetch(`${origin}/api/contests/${created.id}/submissions?${query}`, {
    method: 'PUT', body: studentFolder
  });
  assert.equal(submitResponse.status, 201, await submitResponse.text());

  let latest;
  for (let i = 0; i < 100; i++) {
    const overview = await fetch(`${origin}/api/admin/overview`, { headers: adminHeaders }).then(response => response.json());
    latest = overview.contests.find(contest => contest.id === created.id).submissions[0];
    if (['judged', 'judge_error'].includes(latest.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(latest.status, 'judged', JSON.stringify(latest.details));
  assert.equal(latest.score, 100);
  const judgedOverview = await fetch(`${origin}/api/admin/overview`, { headers: adminHeaders }).then(response => response.json());
  const judgedParticipant = judgedOverview.contests.find(contest => contest.id === created.id).participants.find(student => student.studentId === registration.studentId);
  assert.deepEqual(judgedParticipant.taskScores, [{ title: 'sum', score: 100 }]);
  const ranking = await fetch(`${origin}/api/contests/${created.id}/ranking`).then(response => response.json());
  assert.equal(ranking[0].studentId, registration.studentId);
  assert.equal(ranking[0].score, 100);
  await new Promise(resolve => server.close(resolve));
});
