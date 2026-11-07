#!/usr/bin/env bash
# The AWS side of the dev Worker's managed seal (WORKER-MODE.md, "Managed seal"), in the AWS
# account ESIGN_AWS_ACCOUNT, signed in as the profile ESIGN_AWS_PROFILE:
#   - IAM user esign-dev-worker: may only assume the role below;
#   - IAM role esign-dev-signer: may only sign SHA-256 digests (ECDSA_SHA_256) with
#     alias/esign-dev-signing and read its public key.
# With --create-access-key it also creates the user's access key and stores it directly as the
# Worker secrets AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY of esign-dev (Wrangler needs
# CLOUDFLARE_ACCOUNT_ID); the key is never printed.
# Idempotent apart from the access key, which is refused if the user already has one.
#
#   cd esign && ESIGN_AWS_PROFILE=<profile> ESIGN_AWS_ACCOUNT=<12 digits> bash scripts/aws-dev-signer.sh [--create-access-key]
set -euo pipefail
: "${ESIGN_AWS_PROFILE:?set ESIGN_AWS_PROFILE}" "${ESIGN_AWS_ACCOUNT:?set ESIGN_AWS_ACCOUNT}"
export AWS_PROFILE=$ESIGN_AWS_PROFILE AWS_REGION=${AWS_REGION:-us-west-2}
EXPECTED_ACCOUNT=$ESIGN_AWS_ACCOUNT
USER_NAME=esign-dev-worker
ROLE_NAME=esign-dev-signer
TAGS=(Key=Environment,Value=development Key=Project,Value=esign Key=Purpose,Value=evidence-signing-dev)

account=$(aws sts get-caller-identity --query Account --output text)
[ "$account" = "$EXPECTED_ACCOUNT" ] || { echo "Signed in to account $account, not $EXPECTED_ACCOUNT" >&2; exit 1; }
key_arn=$(aws kms describe-key --key-id alias/esign-dev-signing --query KeyMetadata.Arn --output text)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

if ! aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  aws iam create-user --user-name "$USER_NAME" --tags "${TAGS[@]}" >/dev/null
  echo "created user $USER_NAME"
fi
cat > "$tmp/trust.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::$EXPECTED_ACCOUNT:user/$USER_NAME"},"Action":"sts:AssumeRole"}]}
EOF
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  # A just-created user can take a few seconds to be usable as a principal.
  for attempt in 1 2 3 4 5 6; do
    aws iam create-role --role-name "$ROLE_NAME" --max-session-duration 3600 \
      --description "E-sign dev Worker: sign evidence with alias/esign-dev-signing only" \
      --assume-role-policy-document "file://$tmp/trust.json" --tags "${TAGS[@]}" >/dev/null 2>&1 && break
    [ "$attempt" = 6 ] && { echo "could not create role $ROLE_NAME" >&2; exit 1; }
    sleep 5
  done
  echo "created role $ROLE_NAME"
else
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "file://$tmp/trust.json"
fi
cat > "$tmp/sign.json" <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"kms:Sign","Resource":"$key_arn","Condition":{"StringEquals":{"kms:SigningAlgorithm":"ECDSA_SHA_256","kms:MessageType":"DIGEST"}}},
 {"Effect":"Allow","Action":"kms:GetPublicKey","Resource":"$key_arn"}]}
EOF
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name sign-with-esign-dev-signing --policy-document "file://$tmp/sign.json"
cat > "$tmp/assume.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Resource":"arn:aws:iam::$EXPECTED_ACCOUNT:role/$ROLE_NAME"}]}
EOF
aws iam put-user-policy --user-name "$USER_NAME" --policy-name assume-esign-dev-signer --policy-document "file://$tmp/assume.json"
echo "policies set: $USER_NAME may assume $ROLE_NAME; $ROLE_NAME may sign with $key_arn"

if [ "${1:-}" = "--create-access-key" ]; then
  keys=$(aws iam list-access-keys --user-name "$USER_NAME" --query 'length(AccessKeyMetadata)' --output text)
  [ "$keys" = 0 ] || { echo "$USER_NAME already has an access key; delete it before creating another (rotation)" >&2; exit 1; }
  aws iam create-access-key --user-name "$USER_NAME" --output json > "$tmp/key.json"
  node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).AccessKey.AccessKeyId)" "$tmp/key.json" | npx wrangler secret put AWS_ACCESS_KEY_ID --name esign-dev
  node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).AccessKey.SecretAccessKey)" "$tmp/key.json" | npx wrangler secret put AWS_SECRET_ACCESS_KEY --name esign-dev
  echo "access key created and stored as secrets of esign-dev; it was not printed"
fi
