const fs = require('fs');
const path = require('path');

const {
  DEFAULT_CREDENTIALS_PATH,
  normalizeCredentialProfileId,
  upsertCredentialProfile,
} = require('./marketplace-profile-auth');

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    credentialsPath: DEFAULT_CREDENTIALS_PATH,
    sourceFile: '',
    id: '',
    label: '',
    activate: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--credentials-path':
        options.credentialsPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--source-file':
        options.sourceFile = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--id':
        options.id = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--label':
        options.label = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--activate':
        options.activate = true;
        break;
      case '--no-activate':
        options.activate = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.sourceFile) {
    throw new Error('Expected --source-file');
  }

  return options;
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.join(process.cwd(), value);
}

function parseCredentialFile(sourceFile) {
  const raw = fs.readFileSync(sourceFile, 'utf8').trim();
  if (!raw) {
    throw new Error(`Credential source file is empty: ${sourceFile}`);
  }

  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    const profile = parsed['facebook-marketplace'] || parsed;
    return {
      email: String(profile.email || '').trim(),
      password: String(profile.password || ''),
      label: profile.label || '',
      id: profile.id || '',
    };
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 2) {
    return {
      email: lines[0],
      password: lines[1],
      label: '',
      id: '',
    };
  }

  const pair = raw.match(/^(\S+@\S+)\s+(.+)$/);
  if (pair) {
    return {
      email: pair[1],
      password: pair[2],
      label: '',
      id: '',
    };
  }

  throw new Error('Expected source credential file to be JSON, two lines of email/password, or "email password"');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceFile = resolvePath(options.sourceFile);
  const parsed = parseCredentialFile(sourceFile);
  const id = normalizeCredentialProfileId(options.id || parsed.id || parsed.email);
  const label = options.label || parsed.label || parsed.email || id;
  const result = upsertCredentialProfile(options.credentialsPath, {
    id,
    label,
    email: parsed.email,
    password: parsed.password,
  }, {
    activate: options.activate,
  });
  const profile = result.profiles.find((item) => item.id === id);
  process.stdout.write(`${JSON.stringify({
    imported: Boolean(profile),
    activeProfileId: result.activeProfileId,
    profile: profile ? {
      id: profile.id,
      label: profile.label,
      email: profile.email,
      hasPassword: profile.hasPassword,
    } : null,
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`import_marketplace_credential_error ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  parseCredentialFile,
};
