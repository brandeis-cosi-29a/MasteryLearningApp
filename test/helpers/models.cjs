const {Types} = require('mongoose');
const id = n => new Types.ObjectId(n.toString(16).padStart(24, '0'));
const equal = (a, b) => String(a?._id || a) === String(b?._id || b);
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(q => matches(row, q));
    if (key === '$and') return value.every(q => matches(row, q));
    const actual = row[key];
    if (Object.prototype.toString.call(value) === '[object RegExp]') return typeof actual === 'string' && value.test(actual);
    if (value && typeof value === 'object' && !value._bsontype && !value._id) {
      return Object.entries(value).every(([op, target]) => {
        const values = Array.isArray(actual) ? actual : [actual];
        if (op === '$in') return values.some(a => target.some(b => equal(a, b)));
        if (op === '$nin') return !values.some(a => target.some(b => equal(a, b)));
        if (op === '$ne') return !equal(actual, target);
        if (op === '$exists') return (actual !== undefined) === target;
        if (op === '$elemMatch') return values.some(a => matches({value: a}, {value: target}));
        throw Error(`Unsupported test query operator ${op}`);
      });
    }
    return Array.isArray(actual) ? actual.some(a => equal(a, value)) : equal(actual, value);
  });
}

function models() {
  const db = {}, writes = [];
  let sequence = 1000;
  for (const name of ['Course', 'CourseMember', 'Instructor', 'User', 'ProblemSet', 'Problem', 'Skill', 'CourseSkill', 'Answer', 'Review', 'RegradeRequest', 'PostedGrades', 'SupportFile']) {
    const rows = [];
    class Document {
      constructor(data = {}) {
        Object.assign(this, data);
        for (const key of Object.keys(this)) {
          if ((key.endsWith('Id') || key === '_id' || key === 'original') &&
              typeof this[key] === 'string' && /^[a-f\d]{24}$/i.test(this[key])) this[key] = new Types.ObjectId(this[key]);
        }
        this._id ||= id(sequence++);
      }
      get id() {return String(this._id);}
      toObject() {return {...this};}
      async save() {
        this._id ||= id(sequence++);
        const at = rows.findIndex(row => equal(row._id, this._id));
        if (at >= 0) rows[at] = {...this}; else rows.push({...this});
        writes.push([name, 'save']); return this;
      }
    }
    class Query {
      constructor(filter, single = false) {this.filter = filter; this.single = single; this.populations = [];}
      select(fields) {this.fields = fields; return this;}
      populate(field) {this.populations.push(field); return this;}
      sort() {return this;}
      collation() {return this;}
      limit(count) {this.maxResults = count; return this;}
      lean() {return this;}
      async distinct(field) {return [...new Set((await this).flatMap(row => row[field] || []))];}
      async exec() {return this;}
      then(resolve, reject) {
        try {
          let found = rows.filter(row => matches(row, this.filter)).map(row => new Document({...row}));
          if (this.maxResults !== undefined) found = found.slice(0, this.maxResults);
          for (const field of this.populations) {
            const model = ({studentId: 'User', reviewerId: 'User', skillId: 'Skill', skills: 'Skill', courseId: 'Course', psetId: 'ProblemSet', examId: 'ProblemSet'})[field];
            if (!model) throw Error(`Unsupported population ${field}`);
            const populated = value => db[model].rows.find(row => equal(row._id, value)) || value;
            for (const row of found) row[field] = Array.isArray(row[field]) ? row[field].map(populated) : populated(row[field]);
          }
          if (this.fields && typeof this.fields === 'string' && !this.fields.startsWith('-')) {
            const fields = this.fields.split(/\s+/);
            found = found.map(row => new Document(Object.fromEntries(Object.entries(row).filter(([key]) => key === '_id' || fields.includes(key)))));
          }
          resolve(this.single ? found[0] || null : found);
        } catch (err) {reject(err);}
      }
    }
    Document.rows = rows;
    Document.find = (q = {}, projection) => {const query = new Query(q); return projection ? query.select(projection) : query;};
    Document.findOne = (q = {}, projection) => {const query = new Query(q, true); return projection ? query.select(projection) : query;};
    Document.findById = value => Document.findOne({_id: value});
    Document.countDocuments = async (q = {}) => rows.filter(row => matches(row, q)).length;
    Document.insertMany = async docs => Promise.all(docs.map(doc => new Document(doc).save()));
    Document.deleteMany = async q => {
      writes.push([name, 'deleteMany']);
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], q)) rows.splice(i, 1);
    };
    Document.deleteOne = Document.deleteMany;
    Document.findOneAndDelete = Document.deleteMany;
    Document.findOneAndUpdate = async (q, update, options = {}) => {
      let doc = await Document.findOne(q);
      if (!doc && options.upsert) doc = new Document(q);
      if (!doc) return null;
      const before = new Document({...doc});
      Object.assign(doc, update.$set || (Object.keys(update).some(k => k.startsWith('$')) ? {} : update));
      for (const [key, delta] of Object.entries(update.$inc || {})) doc[key] = (doc[key] || 0) + delta;
      for (const [key, value] of Object.entries(update.$push || {})) doc[key] = [...(doc[key] || []), value];
      for (const [key, value] of Object.entries(update.$pull || {})) doc[key] = (doc[key] || []).filter(v => !equal(v, value));
      for (const [key, values] of Object.entries(update.$pullAll || {})) doc[key] = (doc[key] || []).filter(v => !values.some(x => equal(v, x)));
      await doc.save(); return options.new ? doc : before;
    };
    Document.findByIdAndUpdate = (value, update) => Document.findOneAndUpdate({_id: value}, update);
    Document.updateOne = Document.findOneAndUpdate;
    Document.updateMany = async (q, update) => {for (const row of await Document.find(q)) await Document.findOneAndUpdate({_id: row._id}, update);};
    db[name] = Document;
  }
  return {db, writes};
}
module.exports = {models, id, equal};
