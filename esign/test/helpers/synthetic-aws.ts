/**
 * Synthetic AWS access key ids in the real format, which the code under test checks. They are
 * built at run time because the repository's public-content scan cannot tell a synthetic key id
 * from a real one; none of these ids exists.
 */
export const syntheticKeyId = (prefix: 'AKIA' | 'ASIA', n = 123456789) => `${prefix}EXAMPLE${String(n).padStart(9, '0')}`;
export const LONG_TERM_KEY_ID = syntheticKeyId('AKIA');
export const TEMPORARY_KEY_ID = syntheticKeyId('ASIA');
