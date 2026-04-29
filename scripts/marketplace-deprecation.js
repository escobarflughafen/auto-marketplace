function warnDeprecatedModule(options = {}) {
  if (process.env.MARKETPLACE_SUPPRESS_DEPRECATION_WARNING === '1') {
    return;
  }

  const command = String(options.command || '').trim();
  const replacement = String(options.replacement || '').trim();
  const note = String(options.note || '').trim();
  const lines = [
    '[DEPRECATED] This Marketplace module is legacy and file-based.',
  ];

  if (command) {
    lines.push(`Command: ${command}`);
  }

  if (replacement) {
    lines.push(`Preferred replacement: ${replacement}`);
  }

  if (note) {
    lines.push(`Note: ${note}`);
  }

  process.stderr.write(`${lines.join('\n')}\n`);
}

module.exports = {
  warnDeprecatedModule,
};
