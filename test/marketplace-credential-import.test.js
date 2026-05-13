const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  parseCredentialFile,
} = require('../scripts/import-marketplace-credential');

test('parseArgs reads credential import flags', () => {
  const options = parseArgs([
    '--source-file', 'new_cred.txt',
    '--credentials-path', 'tmp/credentials.json',
    '--id', 'agent-account',
    '--label', 'Agent Account',
    '--no-activate',
  ]);

  assert.equal(options.sourceFile, 'new_cred.txt');
  assert.equal(options.credentialsPath, 'tmp/credentials.json');
  assert.equal(options.id, 'agent-account');
  assert.equal(options.label, 'Agent Account');
  assert.equal(options.activate, false);
});

test('parseCredentialFile reads two-line email/password files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-import-'));
  const sourceFile = path.join(dir, 'new_cred.txt');
  fs.writeFileSync(sourceFile, 'agent@example.com\nsecret-password\n');

  const parsed = parseCredentialFile(sourceFile);

  assert.equal(parsed.email, 'agent@example.com');
  assert.equal(parsed.password, 'secret-password');
});
