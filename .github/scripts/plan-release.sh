#!/usr/bin/env bash
# Plans the releases that release.yml's `publish` job tags and publishes: each green
# push to main since the latest release gets the next version, v0.1.1, v0.1.2, and so on.
# Its `deploy` job then deploys the newest of them (deploy-release.yml).
#
# A push is green when every workflow run it started on main completed and passed
# (skipped jobs, or a wholly skipped run, are fine): CI, the workflow of each app it
# touched and Gateway when it touched the gateway. Pushes are
# numbered oldest first: a green one gets the next version, one with a failed or
# cancelled run gets none, and one with a run still going stops the plan, so a later
# run numbers it and what follows. So each green push is numbered once and in order,
# even when GitHub drops a queued run of release.yml or the runs finish out of order.
#
# To move to a new minor or major version, an org admin runs release.yml by hand with
# it (VERSION, such as v0.2.0): every waiting push is numbered first, then the latest
# release is released again as that version, and the next pushes count on from it.
#
# release.yml's `plan` job runs this with a token that can only read. It needs the
# GitHub CLI and reads GH_REPO, GITHUB_EVENT_NAME, GITHUB_ACTOR, VERSION (empty unless
# given by hand), RUNNER_TEMP, GITHUB_OUTPUT and GITHUB_STEP_SUMMARY. Its `releases`
# output has a line per release, oldest first: the version, its commit, the version
# before it (- for none), then the workflows that passed on its push (- for none). Its
# `deploy-version` output is the newest of them, empty when there are none; what that
# release deploys, check-deploy.mjs decides from each part's latest check. plan-release.test.mjs
# runs it against a fake gh.
set -euo pipefail

if [ "$GITHUB_EVENT_NAME" = workflow_dispatch ]; then
  # Choosing a version is for admins (org admins administer every repository).
  permission=$(gh api "repos/$GH_REPO/collaborators/$GITHUB_ACTOR/permission" --jq .permission)
  if [ "$permission" != admin ]; then
    echo "::error::Only an admin of $GH_REPO can release a new version by hand; $GITHUB_ACTOR has $permission."
    exit 1
  fi
fi
# GitHub's API fails now and then; retry reads a few times before giving up.
retry() {
  local attempt
  for attempt in 1 2 3 4; do
    if "$@"; then return 0; fi
    [ "$attempt" = 4 ] || sleep $((attempt * 15))
  done
  return 1
}
# Whether a version has its release from release.yml (github-actions[bot]) yet:
# no on 404 or another author's, and any other error stops the run.
has_release() {
  local attempt author
  for attempt in 1 2 3 4; do
    if author=$(gh api "repos/$GH_REPO/releases/tags/$1" --jq .author.login 2>&1); then
      [ "$author" = "github-actions[bot]" ]
      return
    fi
    case "$author" in *"(HTTP 404)"*) return 1 ;; esac
    [ "$attempt" = 4 ] || sleep $((attempt * 15))
  done
  echo "::error::Couldn't read $1's release; not numbering anything."
  exit 1
}
# Plans a release for the `publish` job, which gets the plan only if this script
# succeeds.
: >"$RUNNER_TEMP/plan"
plan() {
  echo "$1 $2 ${3:--} ${4:--}" >>"$RUNNER_TEMP/plan"
  echo "Releasing $1 at $2" | tee -a "$GITHUB_STEP_SUMMARY"
}
finish() {
  local status=$?
  if [ "$status" = 0 ]; then
    {
      echo "releases<<END_OF_RELEASES"; cat "$RUNNER_TEMP/plan"; echo "END_OF_RELEASES"
      echo "deploy-version=$(awk 'END { print $1 }' "$RUNNER_TEMP/plan")"
    } >>"$GITHUB_OUTPUT"
  fi
}
trap finish EXIT

# The workflow runs a push to main started, each with its newest attempt's result:
# "status conclusion workflow" per run, in $RUNNER_TEMP/push-runs.
push_runs() {
  retry gh api "repos/$GH_REPO/actions/runs?branch=main&event=push&head_sha=$1&exclude_pull_requests=true&per_page=100" \
    --jq '.workflow_runs[] | "\(.status) \(.conclusion) \(.name)"' >"$RUNNER_TEMP/push-runs"
}
# Of those runs: waiting while any is unfinished (or none is listed yet), green when
# every one succeeded or was skipped and CI, which every push to main starts, is among
# them, failed otherwise.
push_state() {
  if [ ! -s "$RUNNER_TEMP/push-runs" ] || grep -qv '^completed ' "$RUNNER_TEMP/push-runs"; then
    echo waiting
  elif grep -qvE '^completed (success|skipped) ' "$RUNNER_TEMP/push-runs" || ! grep -qE '^completed (success|skipped) CI$' "$RUNNER_TEMP/push-runs"; then
    echo failed
  else
    echo green
  fi
}
# Their workflows by name, "CI, captable"; with an argument, only the runs whose
# "status conclusion" doesn't match it, each with its result: "captable (failure)".
workflows() {
  LC_ALL=C sort -t ' ' -k 3 "$RUNNER_TEMP/push-runs" | awk -v keep="${1:-}" 'keep == "" || $0 !~ ("^" keep " ") {
    result = keep == "" ? "" : " (" ($1 == "completed" ? $2 : $1) ")"
    $1 = ""; $2 = ""; sub(/^ +/, "")
    if (!seen[$0 result]++) { printf "%s%s%s", sep, $0, result; sep = ", " }
  }'
}
# Sets `newest` to main's newest green push among those listed, or to nothing.
newest_green() {
  local sha
  newest=""
  while read -r sha <&3; do
    push_runs "$sha"
    if [ "$(push_state)" = green ]; then
      newest=$sha
      return 0
    fi
  done 3< <(awk '{ line[NR] = $0 } END { for (i = NR; i > 0; i--) print line[i] }' "$RUNNER_TEMP/all-pushes")
}

# The latest release: the newest v* tag and its commit. Only release.yml (and org
# admins) can create one, and a failed read stops the run rather than look like no
# releases.
if ! retry gh api --paginate "repos/$GH_REPO/git/matching-refs/tags/v" \
  --jq '.[] | select(.ref | test("^refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+$")) | "\(.ref | ltrimstr("refs/tags/")) \(.object.type) \(.object.sha)"' \
  >"$RUNNER_TEMP/tags"; then
  echo "::error::Couldn't read the v* tags; not numbering anything."
  exit 1
fi
sort -V -k1,1 "$RUNNER_TEMP/tags" >"$RUNNER_TEMP/versions"
read -r latest type released < <(tail -n 1 "$RUNNER_TEMP/versions") || true
latest=${latest:-}
released=${released:-}
previous=$(tail -n 2 "$RUNNER_TEMP/versions" | awk -v latest="$latest" 'NR == 1 && $1 != latest { print $1 }')
if [ "${type:-}" = tag ]; then
  # An annotated tag, as an org admin might push: the commit it names.
  released=$(retry gh api "repos/$GH_REPO/git/tags/$released" --jq 'select(.object.type == "commit") | .object.sha')
fi
if [ -n "$latest" ] && ! [[ "$released" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::$latest isn't a tag on a commit; not numbering anything."
  exit 1
fi
# A run that tagged the latest version but failed before publishing its release
# finishes it, as it does a release someone else published for it, once its push is
# green, so a tag an admin put on another commit never releases or deploys it.
if [ -n "$latest" ] && ! has_release "$latest"; then
  push_runs "$released"
  if [ "$(push_state)" = green ]; then
    plan "$latest" "$released" "$previous" "$(workflows)"
  else
    echo "::warning::$latest is tagged on $released, whose workflows haven't all passed ($(workflows 'completed (success|skipped)')): no release for it."
  fi
fi

# Every run that pushes to main started, newest first, back to the latest release's
# own push: "run-id commit" per run. GitHub lists at most 1,000 of them (10 pages).
: >"$RUNNER_TEMP/runs"
found=""
for page in $(seq 1 10); do
  retry gh api "repos/$GH_REPO/actions/runs?branch=main&event=push&exclude_pull_requests=true&per_page=100&page=$page" \
    --jq '.workflow_runs[] | "\(.id) \(.head_sha)"' >"$RUNNER_TEMP/page"
  [ -s "$RUNNER_TEMP/page" ] || break
  cat "$RUNNER_TEMP/page" >>"$RUNNER_TEMP/runs"
  if [ -n "$released" ] && grep -q " $released\$" "$RUNNER_TEMP/page"; then found=yes; break; fi
  # Before the first release, the newest page is enough: v0.1.1 is its newest green push.
  [ -n "$released" ] || break
done
# The pushes, oldest first, in the order they started their runs.
sort -n "$RUNNER_TEMP/runs" | awk '!seen[$2]++ { print $2 }' >"$RUNNER_TEMP/all-pushes"

if [ -n "$released" ] && [ -z "$found" ]; then
  # A backlog longer than GitHub lists can't be numbered push by push. Releasing a
  # new minor version by hand moves on.
  if [ -z "${VERSION:-}" ]; then
    echo "::error::The runs of $latest's push ($released) aren't among the last ones GitHub lists for main; not numbering anything. Run Release by hand with the next minor version to move on."
    exit 1
  fi
  IFS=. read -r major minor patch <<<"${latest#v}"
  case "$VERSION" in
    "v$major.$((minor + 1)).0" | "v$((major + 1)).0.0") ;;
    *) echo "::error::$VERSION isn't the next minor (v$major.$((minor + 1)).0) or major (v$((major + 1)).0.0) version after $latest."; exit 1 ;;
  esac
  newest_green
  [ -n "$newest" ] || { echo "::error::No push to main GitHub lists is green."; exit 1; }
  echo "::warning::Pushes since $latest that GitHub no longer lists get no version."
  plan "$VERSION" "$newest" "$latest" "$(workflows)"
  exit 0
fi

if [ -z "$latest" ]; then
  # The first release is main's newest green push; earlier pushes get no version.
  newest_green
  [ -n "$newest" ] || { echo "No push to main is green yet."; exit 0; }
  [ "${VERSION:-v0.1.1}" = v0.1.1 ] || { echo "::error::The first release is v0.1.1; give that, or wait for a green push to main."; exit 1; }
  plan v0.1.1 "$newest" - "$(workflows)"
  exit 0
fi

# Oldest first, from the push after the latest release's own.
awk -v released="$released" 'after { print } $1 == released { after = 1 }' "$RUNNER_TEMP/all-pushes" >"$RUNNER_TEMP/pushes"
while read -r sha <&3; do
  order=$(retry gh api "repos/$GH_REPO/compare/$released...$sha" --jq .status)
  case "$order" in
    ahead) ;;
    identical | behind) continue ;;  # already part of $latest
    *) echo "::error::$sha and $latest have diverged ($order); was main's history rewritten?"; exit 1 ;;
  esac
  push_runs "$sha"
  case "$(push_state)" in
    waiting)
      running=$(workflows completed)
      if [ -n "${VERSION:-}" ]; then
        echo "::error::Workflows are still running for $sha (${running:-none listed yet}); run this again once they're done."
        exit 1
      fi
      echo "Workflows are still running for $sha (${running:-none listed yet}); a later run numbers it."
      exit 0
      ;;
    failed)
      echo "Not every workflow passed for $sha ($(workflows 'completed (success|skipped)')): no version."
      continue
      ;;
  esac
  IFS=. read -r major minor patch <<<"${latest#v}"
  next="v$major.$minor.$((patch + 1))"
  plan "$next" "$sha" "$latest" "$(workflows)"
  latest=$next
  released=$sha
done 3<"$RUNNER_TEMP/pushes"

if [ -n "${VERSION:-}" ]; then
  # By hand: every push is numbered, so the latest release becomes the new version too.
  IFS=. read -r major minor patch <<<"${latest#v}"
  case "$VERSION" in
    "v$major.$((minor + 1)).0" | "v$((major + 1)).0.0") ;;
    *) echo "::error::$VERSION isn't the next minor (v$major.$((minor + 1)).0) or major (v$((major + 1)).0.0) version after $latest."; exit 1 ;;
  esac
  plan "$VERSION" "$released" "$latest"
fi
