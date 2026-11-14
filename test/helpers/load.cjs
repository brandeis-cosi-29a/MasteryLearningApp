const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const ROOT = path.resolve(__dirname, '../..');

// Evaluate production modules with explicit substitutes, never loading .env or
// connecting to the application's database/storage during regression tests.
function load(file, substitutes = {}, globals = {}) {
  const filename = path.join(ROOT, file);
  const localRequire = createRequire(filename);
  const module = {exports: {}};
  const context = {
    module, exports: module.exports, __dirname: path.dirname(filename),
    console, Buffer, URL, process: {env: {ADMIN_EMAIL: 'admin@example.test'}},
    require: name => name in substitutes ? substitutes[name] : localRequire(name),
    ...globals,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, {filename});
  return module.exports;
}

module.exports = {load, ROOT};
