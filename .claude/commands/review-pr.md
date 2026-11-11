---
description: Review a pull request in sugerio/insulin-apps with Claude Code and Codex, in rounds. Fixes the real defects the PR brings, each with a test that fails without the fix, runs the touched areas' CI checks, and records the result in the PR's description.
argument-hint: "[PR number | base branch] [--focus <paths>] [--rounds <n>]"
---

# /review-pr

Review a pull request as this repository wants every PR reviewed before anyone calls it ready (then run
`/e2e-test`). Claude Code and Codex each review it independently, in rounds, and every fix is reviewed again. Fix
only the real defects the PR brings, each with a test, and record the outcome where a reader of the PR will see it.

Input: `$ARGUMENTS`.

- A number (`14`) reviews that PR. A bare word is the base branch to review against. Without one, the base is the
  PR's base branch, or `main` when the branch has no PR.
- `--focus <paths>` narrows the review to those paths: every diff and every reviewer's brief is limited to them.
  The checks still run whole areas.
- `--rounds <n>` is the fewest rounds: 3 by default, or 1 for a PR that changes no code (docs, commands,
  configuration). More run only while rounds keep finding real defects (Step 5), up to n + 5.

## Rules

1. **Reviewers read; you edit.** The Claude reviewer and Codex never change files. Apply fixes between rounds,
   after both reviewers have finished, because they read the same working tree.
2. **Verify before you act.** A finding is only a candidate until you check it against the code, and against the
   vendor's docs for a claim about an API (Cloudflare Workers, D1, GitHub Actions, OAuth). Some findings are wrong:
   report which ones you rejected, and why.
3. **Fix only in-PR blocker and important findings** (the policy below). Report the rest. Never widen the PR on
   your own.
4. **Every fix has a test that fails without it.** Show the test failing, then passing.
5. **Synthetic data only.** The repository is public (`AGENTS.md`): keep real names, emails, domains, account ids,
   hostnames and secrets out of code, tests, docs, commits and PR text. Use `@example.test` or `example.com`
   people and invented values. `node .github/scripts/check-public-content.mjs` must pass.
6. **The tree stays the author's.** Start from a clean tree. Never stash, reset or discard changes you didn't
   make: stop and ask instead. Review fixes stay uncommitted until Step 8.
7. **Never merge, deploy, tag, or push to `main`.** A merge to `main` becomes a release and deploys to production
   (`release.yml`). Push only when the user asks, with an explicit refspec (`git push origin <branch>:<branch>`),
   because a branch made from `origin/main` may track `main`.

## The severity and scope policy

Severity (when in doubt, choose the lower one):

| Severity | Meaning | Examples here |
|---|---|---|
| CRITICAL | Data loss, an access bypass, one organization reaching another's data, a crash on a main path | A Viewer reaches an Editor route; a query not scoped by `organizationId`; an app trusting identity headers on a public path; a migration drops data |
| HIGH | A security gap that isn't a bypass, silent corruption in an edge case, an unhandled error on a main path, a race on a write | An API client or agent changes people, roles or integrations; a custom role's permissions widen instead of narrowing; two writes at once both succeed; a swallowed D1 error |
| MEDIUM | An edge-case bug, missing validation, inconsistent errors, a slow list | An empty list breaks a page; `/api/catalog` out of step with the routes; one D1 query per row; Docs that no longer match behavior |
| LOW | Style, naming, readability, a speculative risk, minor duplication | A misleading comment; a helper that could be shared |

Action:

- **BLOCKER** (CRITICAL) and **IMPORTANT** (HIGH, or a MEDIUM that is a real correctness, security, data or
  compatibility defect): you fix it when it's in the PR.
- **OPTIONAL** (LOW, or a stylistic or speculative MEDIUM): report it for the author. Never apply it.

Scope:

- **IN-PR:** the finding is on code the PR adds or changes, or the PR causes it or makes it reachable, even in a
  line the PR didn't edit.
- **OUT-OF-SCOPE:** the defect exists without the PR, or its fix is much larger than the PR's purpose. Flag a
  blocker or important one for the user to decide (fix here, follow up, or dismiss), and never fix it silently.
  Don't report out-of-scope optional findings.

The user can dismiss any finding, with a reason. A dismissed CRITICAL, HIGH or MEDIUM finding becomes an
acknowledged risk in the report. Reviewers don't raise dismissed findings again.

## Step 0: Prepare

```bash
R=$(git rev-parse --show-toplevel); cd "$R"
git status --short        # must print nothing
```

- **The PR.** With a number, run `gh pr view <n> --json number,title,body,headRefName,baseRefName,headRefOid,url`.
  If its head isn't checked out, check it out on the clean tree (`gh pr checkout <n>`), and confirm that
  `git rev-parse HEAD` is `headRefOid`. Without a number, look up the current branch's PR with `gh pr view`. If it
  has none, review the branch and skip the PR update in Step 9.
- **The base.** The base branch given; else the PR's `baseRefName`; else `main`. Fetch it:
  `git fetch -q origin <base>`.
- **Behind its base.** If `git merge-base --is-ancestor origin/<base> HEAD` fails, say so and ask whether to rebase
  first. If the user says no, note it in the report.
- **The folder.** Each review gets a new folder, where git ignores it. Pick its name once
  (`<branch, with / as ->-<yyyymmdd-hhmm>`), and write it out in full from then on: shell variables don't survive
  between Bash calls, so start each call by setting `R`, `D` and `B` again, never with a new `date`.
  `D="$R/.claude/tmp/review-pr/<the name>"; mkdir -p "$D"`. If an earlier review of the branch left a folder, carry
  over only its `dismissed` findings: the user decided those.
- **The changes.** `B=$(git merge-base origin/<base> HEAD)`, then `git diff --name-only $B`, `git diff $B` and
  `git log --oneline $B..HEAD`. With `--focus`, end every diff command, here and in later rounds, with
  `-- <paths>`. If the diff is empty, say so and stop.
- **Touched areas.** Group the changed files: each app by its top-level directory (`captable/`, `esign/`, …, as
  `node .github/scripts/list-apps.mjs --json` lists them); the gateway (`.github/hosting/gateway/`, `.github/hosting/scripts/`);
  the docs (`.github/hosting/docs/`, `<app>/docs/public/`); and CI (`.github/workflows/`, `.github/scripts/`). A
  change to `.github/workflows/`, `release.yml` or the deploy needs an org admin's review.
- **What the PR is for (its spec).** Read the PR's description, the issues it links, and its commit messages.
  Read `AGENTS.md`, each touched app's own `AGENTS.md` and `README.md`, `.github/hosting/DESIGN.md` for the
  gateway, roles and access, `.github/hosting/README.md` for CI/CD, and the docs the PR changes. Write a short
  summary to `$D/summary.md`: what the PR does and why, the files grouped by purpose, and the parts most likely to
  break. Every reviewer gets it.
- **Comments already on the PR.** Read its conversation and reviews (`gh pr view <n> --comments`), and its
  unresolved review threads, including the Codex connector's:
  ```bash
  gh api graphql --paginate -F n=<n> -f query='query($n:Int!,$endCursor:String){repository(owner:"sugerio",name:"insulin-apps"){pullRequest(number:$n){reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{isResolved path line comments(first:20){nodes{author{login} body}}}}}}}' \
    --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)'
  ```
  Each unresolved thread is a candidate finding for Round 1.
- **Codex.** Run `command -v codex && codex --version`. The review needs Codex. If it's missing, stop and say so,
  and don't use a second Claude reviewer in its place.

## Step 1: Checks before the review

Run what CI runs for each touched area, so reviewers don't spend time on what tools catch. The workflows are the
source (`.github/workflows/app.yml` for every app, `gateway.yml`, `ci.yml`); the table is a summary. Use a private
npm cache (`--cache "$D/npm-cache"`) if `~/.npm` isn't writable.

| Area | Checks |
|---|---|
| An app (`captable`, `esign`, …), from its directory | `npm ci --ignore-scripts --no-audit --no-fund`; `node .github/scripts/check-insulin-app.mjs <app>` (from the root); `npm run typecheck`; `TZ=UTC npm test` (CI runs in UTC, and Cap Table's spreadsheet dates fail in other time zones); `app.yml`'s "Migrations match the schema" step (drizzle-kit 0.31.11 and drizzle-orm 0.45.3 in a temporary folder, then `drizzle-kit generate` must write nothing); `NODE_ENV=production NITRO_PRESET=cloudflare_module npm run build`; `check-insulin-app.mjs <app> --built` |
| Cap Table, also | The workerd smoke: `npm ci` in `.github/scripts/workerd-smoke/`, then `node smoke.mjs` there |
| E-sign, also | Its `npm test` includes a browser test that needs Chrome; if Chrome can't start, report "E-sign editor browser test: not run here, CI runs it" |
| The gateway, from `.github/hosting/gateway/` | `npm ci --ignore-scripts --no-audit --no-fund`; `npm run typecheck`; `npm test` (Miniflare; it also fails while the CSS or docs module is stale); `npm run check:css` and `npm run check:docs` |
| Docs (`.github/hosting/docs/`, `<app>/docs/public/`) | The gateway's `npm run check:docs` (the regenerated `src/assets/docs-content.ts` must be committed) |
| CI and scripts (`.github/`) | `node --test .github/scripts/*.test.mjs`; `node .github/scripts/check-app-workflows.mjs`; `actionlint` if it's installed; read workflow changes against the root README's "Releases" and `.github/hosting/README.md` |
| Every PR | `node .github/scripts/check-public-content.mjs` |

- Check that each test count looks right, and read pass or fail from the tool's own output, not a piped exit code.
- Codex's sandbox can't run the tests here, so you run all of them.
- Fix a new failure the PR causes now, before the rounds: it's mechanical, not a finding. Record a failure that
  also happens where the branch started (`$B`, not the base's newest commit) as pre-existing, with the evidence.
  Either find CI's run at `$B`, if that area's workflow ran there (a path-filtered workflow runs only when a change
  touched its paths):
  ```bash
  gh run list -R sugerio/insulin-apps -w <app>.yml -b <base> -L 50 --json databaseId,headSha,conclusion --jq ".[] | select(.headSha == \"$B\")"
  gh run view <id> -R sugerio/insulin-apps --json jobs --jq '.jobs[] | {name, conclusion}'
  ```
  (`gateway.yml` and `ci.yml` the same way.) Or run the same test in a temporary worktree at `$B`:
  `git worktree add --detach "$D/base" "$B"`, then `npm ci` in the area there, the test, and
  `git worktree remove "$D/base"`. Give both lists to the reviewers.

## Step 2: Plan the rounds

Each round has a focus and at least two aspects, and each aspect has a lens for Claude and one for Codex. The
default plan:

| Round | Aspect | Claude's lens | Codex's lens |
|---|---|---|---|
| 1. Correctness and contracts | 1A Correctness | Logic, edge cases, dates and time zones, money and share counts, empty and null states | Invariants across files, hidden changes in behavior |
| | 1B Contracts and data | D1 schema and forward-only migrations (Drizzle for apps, `migrations/` for the gateway), API shapes and status codes, `GET /api/catalog` in step with the routes, the `insulin` block of `package.json` (permissions, public paths, secrets, scheduled) | Drift between callers and callees, the gateway and the apps (identity headers), what an open page or a migration on live data meets |
| 2. Access and concurrency | 2A Access and validation | Who may call what: organization roles (Owner, Admin, Editor, Viewer) and app roles, permissions only narrowing (`x-suger-app-permissions`), every query scoped by `organizationId`, `x-suger-access-via` (browser, mcp, api, public, schedule), browser-only mutations of people, roles, billing and integrations, public paths' own short-lived codes, input validation, secrets in logs | Abuse cases, escalating privileges, unsafe defaults, a path the gateway keeps (`/__insulin/*`, `/mcp`, `/settings/*`) |
| | 2B Concurrency and operations | Races on writes (guards in the same SQL statement, D1 batches), retries, the five-minute scheduled tick (idempotent, bounded, 25 seconds), rate limits, the mail relay's caps, audit records | Failure halfway through, double submits, a release that deploys apps before the gateway, migrations applied before the new code runs |
| 3. Tests and fit | 3A Tests | Missing or weak tests, assertions that can't fail, mocks that hide the bug | False confidence, untested blast radius |
| | 3B Fit with the repository | `AGENTS.md` (shadcn/ui, in-app Docs and public docs updated with the behavior they describe, the platform owns sign-in, synthetic data), README and DESIGN kept in step, code that reads like its neighbors | Coupling, a second copy of an existing helper, future breakage |

Adapt the plan to the diff. Strengthen the access lens when routes, roles, OAuth, MCP or sign-in change. Add an
aspect for pages (narrow screens, accessibility, the CSP) when the UI changes, and one for CI/CD (GitHub Actions
semantics, what deploys when, secrets reaching only the steps that need them) when workflows change. For a PR with
no code, its one round covers every aspect. Show the plan before you start.

Every reviewer also judges **faithfulness to the spec**: what the spec asked for that the diff doesn't deliver, or
delivers only partly; behavior the spec didn't ask for; and requirements built differently from the spec. Each
such finding quotes the spec, and stays separate from the correctness findings. With no spec, it says "no spec".

Keep a ledger of every finding in `$D/ledger.md`:

| ID | Round | Severity | Scope | File:Line | Finding | Source | Status | Resolution |
|---|---|---|---|---|---|---|---|---|

Statuses: `open`, `fixed`, `verified`, `rejected` (not real, with the reason), `dismissed` (by the user),
`flagged` (out of scope, for the user), `deferred`, and `reverted` (Step 7).

## Step 3: Each round, both reviewers

At the start of each round, recompute the diff from the working tree (`git diff $B`, plus `-- <paths>` with
`--focus`, which includes the fixes so far). Then run both reviewers at the same time. With `--focus`, each brief
names the paths, and asks for findings only in them.

**Claude: one reviewer for the whole review.** In Round 1, start a `general-purpose` agent and keep its id. In
later rounds, continue the same agent with SendMessage, never a new one, so that it keeps what it has read.
Round 1's brief: the summary, the changed files, the diff, the pre-existing failures, the round's aspects and
lenses, the severity and scope policy, the spec check, the ledger, and: "Read each changed file in full. Report
only real defects; 'no findings' is a good answer. Don't change files." Later rounds send only the new diff, the
ledger, the round's aspects, and: "Your earlier findings are now fixed in this snapshot. Check the fixes
skeptically: assume one may be wrong or may have broken something."

**Codex: new processes each round, one per aspect,** run in parallel and never resumed, so that Codex isn't
anchored on an earlier round's approval of a fix. Write each one's brief to `$D/r<round>-<aspect>-brief.md` first,
then run:

```bash
codex exec -s read-only --color never -C "$R" -o "$D/r<round>-<aspect>-codex.md" - < "$D/r<round>-<aspect>-brief.md"
```

Its brief: the base commit `$B` (Codex reads the diff itself, with the same `git diff` command), the summary, the
round's focus, its one aspect and lens, the policy, the spec check, the ledger ("check the fixed findings; don't
raise fixed or dismissed ones again"), and "Read AGENTS.md, the touched apps' own AGENTS.md, and
.github/hosting/DESIGN.md: they are the rules." Give it the code, not your conclusions.

Each finding comes back with its file and line, severity, scope and aspect, what is wrong and why it matters, and a
fix. For every `fixed` finding, each reviewer also says `verified`, or why the fix isn't right.

If a reviewer fails, run it again. If it fails a second time, stop the round and report which coverage is missing.

## Step 4: Merge and triage

1. Merge both reviewers' findings. An issue both found keeps both sources.
2. **Check each new finding against the code** before you give it an ID. Mark one that isn't real `rejected`, with
   the reason.
3. Number the rest `F1`, `F2`, … (continuing the ledger) and sort them by severity. Update the fixed findings the
   reviewers checked: `verified`, or `open` again with the reason.
4. Show the round's tables: new in-PR findings, out-of-scope findings for the user to decide, and the checks of
   earlier fixes. Then continue to Step 6 without asking: in-PR blocker and important findings are fixed by
   default.

## Step 5: Another round, or done?

- Until `--rounds` rounds have run, always run another round (after the fixes), even after a quiet one.
- While an in-PR blocker or important finding is open, fix it and run another round, so that a new Codex process
  sees the fix.
- After `--rounds` rounds, stop when the last round was **quiet**: no new in-PR blocker or important finding, every
  fix it checked verified, and no risky area left without its own aspect. Otherwise run one more round, name its
  reason (the neighbors of a new defect, a fix that added logic no reviewer has seen, an area not yet probed), and
  give it two aspects drawn from that reason.
- Never add a round for optional findings or for "one more look". Stop at `--rounds` + 5 rounds even if the last
  one wasn't quiet, and report what's still unsettled. When a finding is reopened in two rounds in a row, give it
  to the user as a risk instead of running another round for it.

## Step 6: Fix

For each in-PR blocker and important finding, worst first:

1. Read the code around it.
2. Write a test that reproduces it, in the area's own test style and folder (an app's `test/`, the gateway's
   Miniflare tests in `.github/hosting/gateway/test/`, a script's `.github/scripts/<name>.test.mjs`). Run it, and
   keep the failure. (For a fix with no behavior, such as a comment, say so instead.)
3. Make the smallest fix, in the style of the code around it, and run the test until it passes.
4. Comment only what a reader wouldn't see for themselves, such as why a guard exists or which edge case it
   protects. No finding IDs or round numbers in code or tests.
5. Run the area's tests. Mark the finding `fixed`, and write its test in the ledger.

After the round's fixes, run the touched areas' typechecks and tests until every one passes. A fix that changes
behavior updates the in-app Docs and public docs that describe it (`AGENTS.md`), and a docs change regenerates
the gateway's docs module (`npm run build:docs`). Leave the fixes uncommitted, so that the next round reviews them.

## Step 7: Check each change is needed

When the rounds are done, read `git diff HEAD`: it holds only the review's changes. Each change must trace to a
fixed blocker or important finding, or to a check that needed it. Revert one that doesn't (a guard for an input
that can't happen, a stylistic rewrite, a helper with one caller), together with its test. Mark it `reverted`, and
run the checks again.

## Step 8: Final checks

1. Run Step 1's checks again for every touched area: install, typecheck, the whole test suite, the build and the
   repository checks. Read pass or fail from the tool's own output, not from a piped exit code.
2. Run the tests of other areas that use what changed (a change to `list-apps.mjs` or `deploy-apps.mjs`: the
   gateway's tests and every app's `check-insulin-app`; a change to the identity headers: the gateway's and each
   app's).
3. This review doesn't drive the apps in a browser: suggest `/e2e-test` next, which this repository runs on every
   PR after the review.
4. Leave the fixes uncommitted, and offer to commit and push them. When the user agrees, commit as
   `Fixes from review`, ending with the `Co-Authored-By` trailer your session's attribution guidance gives, and push
   with an explicit refspec. If you change code after the last round, say that no reviewer has seen it.

## Step 9: Report, and record it in the PR

Tell the user:

- the verdict: ✅ the review converged, nothing in the PR is open, and the checks pass; ⚠️ it converged with
  acknowledged risks, flagged findings or optional ones; ❌ a check fails, or the rounds reached the limit;
- the rounds run, and why each extra one ran;
- the findings by severity, and what happened to them: fixed (with their tests), rejected (with the reasons),
  optional, flagged for the user, dismissed, reverted;
- each check that ran, with its command and result;
- what's still uncommitted.

Then write a short version into the PR's description, in a section of its own, so that a reader sees that the
review happened, and at which commit. Keep the verdict line outside `<details>`, which shows collapsed:

```markdown
## Review

<!-- review-pr-evidence -->
**✅ /review-pr: 3 rounds · 4 of 4 in-PR findings fixed · 0 for your decision**

**Reviewed at** `<sha>` (<n> fixes not pushed yet, when there are any) · **Checks:** typecheck ✓ · tests ✓ (<counts>) · build ✓

| Outcome | Count |
|---|---|
| Fixed and verified | n |
| Optional, not applied | n |
| Out of scope, for your decision | n |
| Rejected · dismissed · reverted | n · n · n |

<details>
<summary>Review trail: rounds, findings and checks</summary>

<the rounds, the ledger in short, and the checks with their commands>

</details>
<!-- /review-pr-evidence -->
```

Save it as `$D/evidence.md`, starting with its heading and ending with the closing marker. If the PR's head has
moved since the last round, say so on the "Reviewed at" line. Build the new description from the current one,
never from the block alone, and replace only an earlier block of this command's, from its marker to its closing
marker. If any step fails, or the description changes meanwhile, change nothing. Use `gh api`, which changes only
the body:

```bash
gh api repos/sugerio/insulin-apps/pulls/<n> --jq '.body // ""' > "$D/body.md" || exit 1
python3 - "$D/body.md" "$D/evidence.md" > "$D/body-new.md" <<'EOF' || exit 1
import re, sys
body, block = open(sys.argv[1]).read(), open(sys.argv[2]).read().strip()
start, end = "<!-- review-pr-evidence -->", "<!-- /review-pr-evidence -->"
if not block.startswith("## Review\n") or block.count(start) != 1 or not block.endswith(end):
    sys.exit("the evidence block lacks its heading or markers: not applied")
earlier = re.compile(r"\n*## Review\n+" + re.escape(start) + r".*?" + re.escape(end) + r"[ \t]*\n*", re.S)
found = list(earlier.finditer(body))
if len(found) > 1:
    sys.exit("the description has more than one earlier block: not applied")
if any("\n## " in m.group(0).strip() for m in found):
    sys.exit("the earlier block runs into another section: not applied")
new = earlier.sub("\n\n", body).rstrip() + "\n\n" + block + "\n"
if new.count(start) != 1:
    sys.exit("the description has another copy of the marker: not applied")
sys.stdout.write(new.lstrip())
EOF
[ -s "$D/body-new.md" ] || exit 1
gh api repos/sugerio/insulin-apps/pulls/<n> --jq '.body // ""' > "$D/body-now.md" || exit 1
cmp -s "$D/body-now.md" "$D/body.md" || { echo "the description changed meanwhile: not applied"; exit 1; }
gh api -X PATCH repos/sugerio/insulin-apps/pulls/<n> -F body=@"$D/body-new.md" --jq .html_url
```

Read the description back, and confirm the marker appears once, the verdict line is outside `<details>`, and the
rest of the description, including an `## E2E test` section, is unchanged. Then report **applied** (new),
**updated** (an earlier block replaced), or **saved, not applied** (no PR, or `gh` failed), with the file's path and
the command to apply it. A failure here doesn't fail the review.
