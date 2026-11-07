/** The AWS CLI profile of the account holding the synthetic test key (ESIGN_AWS_PROFILE); never assumed. */
export function awsProfile(): string {
  const profile = (process.env.ESIGN_AWS_PROFILE ?? '').trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(profile)) throw new Error('Set ESIGN_AWS_PROFILE to the AWS CLI profile of the account that holds the test key');
  return profile;
}
