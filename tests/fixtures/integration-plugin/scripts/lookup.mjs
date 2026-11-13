const card = {
  term: '结过婚我也认',
  meaning: 'Fixture meaning for an explicit alias lookup.',
  usage_context: '',
  avoid_when: '',
  origin: '',
  source_url: 'https://www.bilibili.com/video/BV19iJ86ZEnr',
  aliases: ['玉芬啊玉芬'],
  matched_keys: ['玉芬啊玉芬'],
  confidence: 0.9,
  days_left: 2,
};
const args = process.argv.slice(2);
let text;
let limit = 3;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg.startsWith('--text=')) text = arg.slice(7);
  else if (arg === '--text') text = args[++index];
  else if (arg === '--limit') limit = Number(args[++index]);
  else if (arg === '--db') index += 1;
  else throw new Error(`Unexpected fixture CLI argument ${arg}`);
}
if (['missing_db', 'corrupt_db'].includes(text)) {
  process.stderr.write(`${JSON.stringify({ error: { code: text === 'missing_db' ? 'DATABASE_NOT_FOUND' : 'DATABASE_ERROR', message: 'Synthetic database fault.' } })}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ terms: limit > 0 && text?.includes('玉芬啊玉芬') ? [card] : [] })}\n`);
}
