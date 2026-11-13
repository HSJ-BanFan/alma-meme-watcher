import { getPolicy, setPolicy } from '../src/policy/policy.mjs';

function parse(argv) {
  const [operation, ...args] = argv;
  if (!['get', 'set'].includes(operation)) throw new Error('Use get or set <integer> [--alma-home <config-root>].');
  let almaHome;
  let value;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--alma-home' || arg.startsWith('--alma-home=')) {
      if (almaHome !== undefined) throw new Error('Supply --alma-home once.');
      almaHome = arg === '--alma-home' ? args[++index] : arg.slice('--alma-home='.length);
      if (!almaHome || almaHome.startsWith('--')) throw new Error('--alma-home needs a config root.');
    } else if (operation === 'set' && value === undefined && /^[+-]?\d(?:_?\d)*$/.test(arg.trim())) {
      value = Number(arg.trim().replaceAll('_', ''));
    } else {
      throw new Error(`Unexpected argument ${arg}.`);
    }
  }
  if (operation === 'set' && value === undefined) throw new Error('set requires a playfulness integer in 0..100.');
  return { operation, value, almaHome };
}

try {
  let request;
  try {
    request = parse(process.argv.slice(2));
  } catch (error) {
    error.code = 'INVALID_ARGUMENT';
    throw error;
  }
  const result = request.operation === 'get' ? getPolicy(request) : setPolicy(request.value, request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: { code: error.code ?? 'POLICY_ERROR', message: error.message } })}\n`);
  process.exitCode = 1;
}
