const test = require('node:test');
const assert = require('node:assert/strict');
const {inflateRawSync} = require('node:zlib');
const {fixture, serve} = require('./helpers/app.cjs');
const {id} = require('./helpers/models.cjs');

// Read these small, in-memory ZIP downloads through their central directory so
// the checks cover the actual compressed file contents, not just a ZIP signature.
function filesInZip(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString();
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    assert([0, 8].includes(method));
    files[name] = (method === 8 ? inflateRawSync(compressed) : compressed).toString();
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return files;
}

for (const personalized of [false, true]) {
  test(`${personalized ? 'personalized' : 'full'} exam ZIP download retains exam content and support files`, async () => {
    const support = {preamble: '\\documentclass{article}', title: 'Synthetic exam instructions'};
    const {app, db, ids} = fixture({substitutes: {
      './models/SupportFile.js': {findOne: async ({name}) => ({get: field => field === 'text' ? support[name] : undefined})},
    }});
    db.Course.rows[0].name = 'Synthetic ZIP course';
    db.Problem.rows[0].problemText = 'Synthetic unmastered question';
    db.Skill.rows.push({_id: id(901), courseId: ids.course, shortName: 'F2', name: 'Second skill'});
    db.Problem.rows.push({...db.Problem.rows[0], _id: id(902), skills: [id(901)], problemText: 'Synthetic mastered question'});
    db.PostedGrades.rows.push({_id: id(903), courseId: ids.course, email: 'student@example.test', skillsMastered: ['F2']});
    for (const member of db.CourseMember.rows) {
      if (String(member.studentId) === String(ids.student)) Object.assign(member, {studentName: 'Test Student', section: '1'});
      if (String(member.studentId) === String(ids.classmate)) Object.assign(member, {studentName: 'Other Student', section: '2'});
    }

    await serve(app, async request => {
      const route = personalized ? 'downloadPersonalizedExamsAsZipFile' : 'downloadExamAsZipFile';
      const url = `/${route}/${ids.course}/${ids.pset}`;
      assert.equal((await request(url, {user: ids.student})).status, 403);
      const response = await request(url, {user: ids.ta});
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/zip');
      assert.match(response.headers.get('content-disposition'), /attachment; filename=/);
      const files = filesInZip(Buffer.from(await response.arrayBuffer()));
      assert.equal(files['preamble.tex'], support.preamble);
      assert.equal(files['title.tex'], support.title);
      assert.match(files['compile.sh'], /pdflatex/);
      assert.match(files['readme.txt'], /pdflatex/);
      if (personalized) {
        const student = files['exam_1_Test_Student_student_example_test.tex'];
        assert.match(student, /Synthetic unmastered question/);
        assert(!student.includes('Synthetic mastered question'));
        assert.match(files['exam_2_Other_Student_classmate_example_test.tex'], /Synthetic mastered question/);
        assert.match(files['exam___allquestions.tex'], /Synthetic mastered question/);
        assert.deepEqual(JSON.parse(files['studentsWithFullMastery.json']), []);
      } else {
        assert.match(files['exam_exam.tex'], /Synthetic unmastered question/);
        assert.match(files['exam_exam.tex'], /Synthetic mastered question/);
        assert.match(files['exam_answers.tex'], /\\solnstrue/);
        assert(!files['exam_exam.tex'].includes('\\solnstrue'));
      }
    });
  });
}
