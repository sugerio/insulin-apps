#!/usr/bin/env bash
# Locks v* tags to release.yml, then checks that the lock took effect:
#   - the `release` environment: only main can use it, and it needs no approval;
#   - its RELEASE_DEPLOY_KEY secret: the private half of the repository's write
#     deploy key, which release.yml's `publish` job pushes tags with;
#   - the "Release tags" ruleset: only deploy keys and org admins can create, move
#     or delete a v* tag.
# A workflow changed on a branch can't read the key, and no other token can create
# the tag, so a v* tag is always a commit release.yml numbered on main.
#
# The deploy key is created the first time, and replaced with --rotate. Its private
# half goes from a temporary file straight into the secret, and is never printed or
# kept. The ruleset lets every deploy key through, so keep this the repository's
# only deploy key with write access.
#
# Usage: .github/scripts/configure-release-tags.sh [--rotate]
# Needs the GitHub CLI, signed in as an org admin, and ssh-keygen. Targets
# sugerio/insulin-apps unless GH_REPO names another repository, such as a fork.
set -euo pipefail

case "$#:${1:-}" in
  0: | 1:--rotate) rotate=${1:-} ;;
  *) echo "usage: $0 [--rotate]" >&2; exit 2 ;;
esac
repo=${GH_REPO:-sugerio/insulin-apps}
api="repos/$repo/environments/release"
title="release.yml v* tags"

# The ruleset lets every deploy key through, so stop before changing anything if
# another one can write.
others=$(gh api --paginate "repos/$repo/keys?per_page=100" --jq ".[] | select((.read_only | not) and .title != \"$title\") | .title" | paste -sd, -)
if [ -n "$others" ]; then
  echo "error: $repo has other write deploy keys ($others), and each could create v* tags. Remove them or make them read-only, then run this again." >&2
  exit 1
fi

gh api --method PUT "$api" --input - >/dev/null <<'EOF'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
EOF
# Allow the main branch only.
if [ -z "$(gh api --paginate "$api/deployment-branch-policies" \
  --jq '.branch_policies[] | select(.name == "main" and .type == "branch") | .id')" ]; then
  gh api --method POST "$api/deployment-branch-policies" -f name=main -f type=branch >/dev/null
fi
for id in $(gh api --paginate "$api/deployment-branch-policies" \
  --jq '.branch_policies[] | select((.name == "main" and .type == "branch") | not) | .id'); do
  gh api --method DELETE "$api/deployment-branch-policies/$id"
done

old_keys=$(gh api --paginate "repos/$repo/keys?per_page=100" --jq ".[] | select(.title == \"$title\") | .id")
has_secret=$(gh api "$api/secrets" --jq '.secrets[] | select(.name == "RELEASE_DEPLOY_KEY") | .name')
if [ -z "$old_keys" ] || [ -z "$has_secret" ] || [ "$rotate" = --rotate ]; then
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  ssh-keygen -q -t ed25519 -N "" -C "$title" -f "$dir/key"
  gh api --method POST "repos/$repo/keys" -f title="$title" -f key="$(cat "$dir/key.pub")" -F read_only=false >/dev/null
  gh secret set RELEASE_DEPLOY_KEY --repo "$repo" --env release <"$dir/key"
  for id in $old_keys; do
    gh api --method DELETE "repos/$repo/keys/$id"
  done
  rm -rf "$dir"
  echo "Created a new deploy key and stored it as RELEASE_DEPLOY_KEY."
fi

ruleset='{
  "name": "Release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [{ "type": "creation" }, { "type": "update" }, { "type": "deletion" }],
  "bypass_actors": [
    { "actor_id": null, "actor_type": "OrganizationAdmin", "bypass_mode": "always" },
    { "actor_id": null, "actor_type": "DeployKey", "bypass_mode": "always" }
  ]
}'
id=$(gh api --paginate "repos/$repo/rulesets?includes_parents=false&per_page=100" \
  --jq '.[] | select(.name == "Release tags" and .target == "tag") | .id')
if [ -n "$id" ]; then
  gh api --method PUT "repos/$repo/rulesets/$id" --input - <<<"$ruleset" >/dev/null
else
  id=$(gh api --method POST "repos/$repo/rulesets" --input - --jq .id <<<"$ruleset")
fi

gh api "$api" --jq '"environment:  \(.name), branch policy \(.deployment_branch_policy)"'
gh api "$api/deployment-branch-policies" --jq '"allowed refs: \([.branch_policies[] | "\(.type) \(.name)"] | join(", "))"'
gh api "$api/secrets" --jq '"secrets:      \([.secrets[].name] | join(", "))"'
gh api --paginate "repos/$repo/keys?per_page=100" --jq '.[] | "deploy key:   \(.title) (\(if .read_only then "read-only" else "write" end), added \(.created_at))"'
gh api "repos/$repo/rulesets/$id" --jq '"ruleset:      \(.name), \(.enforcement), \([.rules[].type] | join("/")) of \(.conditions.ref_name.include | join(", ")), bypass: \([.bypass_actors[].actor_type] | join(", "))"'

if [ "$(gh api --paginate "repos/$repo/keys?per_page=100" --jq '.[] | select(.read_only | not) | .id' | wc -l | tr -d ' ')" != 1 ]; then
  echo "error: $repo should have exactly one write deploy key, release.yml's." >&2
  exit 1
fi
