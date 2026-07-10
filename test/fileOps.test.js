const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { safeRemovePath, clearDirChildrenPreserving } = require('../out/services/fileOps.js');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fun-harness-fileops-'));
}

test('safeRemovePath should delete a single file', () => {
    const root = makeTempDir();
    const file = path.join(root, 'temp.txt');
    fs.writeFileSync(file, 'hello', 'utf8');

    assert.equal(fs.existsSync(file), true);
    safeRemovePath(file);
    assert.equal(fs.existsSync(file), false);
});

test('safeRemovePath should delete directory recursively', () => {
    const root = makeTempDir();
    const nestedDir = path.join(root, 'a', 'b');
    const nestedFile = path.join(nestedDir, 'demo.txt');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(nestedFile, 'demo', 'utf8');

    assert.equal(fs.existsSync(path.join(root, 'a')), true);
    safeRemovePath(path.join(root, 'a'), { recursive: true });
    assert.equal(fs.existsSync(path.join(root, 'a')), false);
});

test('safeRemovePath should ignore missing path', () => {
    const root = makeTempDir();
    const missing = path.join(root, 'not-exists');

    assert.doesNotThrow(() => safeRemovePath(missing, { recursive: true }));
});

test('clearDirChildrenPreserving should keep preserved entries only', () => {
    const root = makeTempDir();
    const preserveDir = path.join(root, '.harness');
    const removeDir = path.join(root, 'frontend');
    const removeFile = path.join(root, 'todo.md');

    fs.mkdirSync(preserveDir, { recursive: true });
    fs.mkdirSync(removeDir, { recursive: true });
    fs.writeFileSync(path.join(removeDir, 'index.ts'), 'x', 'utf8');
    fs.writeFileSync(removeFile, 'todo', 'utf8');

    clearDirChildrenPreserving(root, ['.harness']);

    assert.equal(fs.existsSync(preserveDir), true);
    assert.equal(fs.existsSync(removeDir), false);
    assert.equal(fs.existsSync(removeFile), false);
});
