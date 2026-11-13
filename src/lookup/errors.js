export const lookupFailures = {
  INVALID_ARGUMENTS: { exit: 2, message: 'Invalid lookup arguments.' },
  DATABASE_UNAVAILABLE: { exit: 1, message: 'Meme database is unavailable.' },
  DATABASE_ERROR: { exit: 1, message: 'Meme database could not be read.' },
  INTERNAL_ERROR: { exit: 1, message: 'Lookup failed unexpectedly.' },
};

export function lookupFailureCode(code) {
  return Object.hasOwn(lookupFailures, code) ? code : 'INTERNAL_ERROR';
}
