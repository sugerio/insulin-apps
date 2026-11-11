---
description: End-to-end test a pull request in sugerio/insulin-apps on the local stack, the gateway with the touched apps behind it on *.insulinapps.localhost. Claude Code and Codex plan from the diff, Playwright MCP drives a real browser with evidence for every pass, the committed suites run as the regression check, and Codex audits the evidence. The result, with checks for after the release deploys, goes on the PR.
argument-hint: "[PR number] [--app <app>] [--plans-only] [--no-suite] [focus]"
---

# /e2e-test

Test what a pull request changes the way people will use it, on the local stack. Then leave on the PR a record a
reviewer can trust: what passed, with evidence; what failed, and why; what the run couldn't reach; and how to check
that once the release deploys. This repository runs it on every PR, after `/review-pr`.

Input: `$ARGUMENTS`.

- A number tests that PR. Without one, it tests the current branch, and its PR if it has one.
- `--app <app>` tests only that app, when the PR touches several.
- `--plans-only` writes the plans and the coverage ledger, and runs nothing.
- `--no-suite` skips the committed suites (Tier 3).
- Any other text tells the planners what to focus on.

## Safety rules

1. **The local stack only.** Drive the gateway and the apps on this machine, at `*.insulinapps.localhost`, as the
   gateway's `npm run dev` runs them. Never `insulinapps.com` or an app's production address. People sign up during
   the run through the captured-mail page, as `@example.test` people. Google sign-in is off locally; never use a
   real Google, SSO, GitHub or AI-client account.
2. **No real outside services.** The one outside call allowed is Cloudflare's Turnstile test widget, which the
   local sign-up and sign-in forms load (its test keys always pass). Esign's seal needs AWS KMS and a timestamp
   authority, and verifying a domain needs DNS-over-HTTPS: those steps are `MANUAL`. Never type a real key, token
   or password. The run's own secrets (`GATEWAY_SECRET_KEY`, Esign's local settings) are generated for the run and
   stay in its folder. (`git` and `gh`, signed in as they are, are only for reading and recording this PR.)
3. **Nothing leaves the machine but the PR's record.** The local gateway captures every mail (`SITE_ENV=test`) at
   `/__insulin/dev/mail` instead of sending it. A credential stored on an integrations page during the run names an
   `example.com` address, and no step calls it.
4. **Invented data only.** Plans, evidence, reports and PR text use `@example.test` people and invented values,
   never real names, companies, amounts or domains. Every record the run creates has the run's id in its name.
   Screenshots and logs stay in the run's folder; the PR gets text only.
5. **Don't change the app.** The run doesn't fix app code or tests: report each bug with its cause, for the author.
   Besides its own folder, the PR's description and one PR comment, it changes only what starting the stack
   changes: each driven app's `.output` build, and the gateway's generated `.dev/*.wrangler.json`, which
   `npm run dev` writes again.
6. **Always clean up** what the run started (Phase 6), also after a stop or a failure. The one exception is the
   Chrome on port 9335: `.mcp.json`'s Playwright uses it, so it stays.

## Phase 0: Prepare

**The run.** Pick its id once (`date -u +e2e-%Y%m%d-%H%M`), and write it out in full from then on: shell variables
don't survive between Bash calls, so start each call with these lines.

```bash
RUN=e2e-20261111-0315   # the id you picked
R=$(git rev-parse --show-toplevel); D="$R/.claude/tmp/e2e-test/$RUN"   # git ignores .claude/tmp
mkdir -p "$D" && touch "$D/log.md"
```

**The branch.** Start from a clean tree, and never stash or reset changes you didn't make. With a PR number, run
`gh pr view <n> --json number,title,body,headRefName,baseRefName,headRefOid,url`, check the PR out with
`gh pr checkout <n>` if it isn't checked out already, and confirm that `git rev-parse HEAD` is `headRefOid`.
Without a number, use the current branch and its PR, if it has one. The base is the PR's `baseRefName`, or `main`
with no PR: `git fetch -q origin <base>`, then `B=$(git merge-base origin/<base> HEAD)`.

**The changes.** Read `git diff --name-only $B`, `git diff $B`, `git log --oneline $B..HEAD`, the PR's description
and the issues it links. Read each touched app's `README.md` and `AGENTS.md`, the gateway's `README.md` ("Develop")
and `.github/hosting/DESIGN.md` when the gateway changes, and the docs the PR changes.

**Codex.** Run `command -v codex && codex --version`. Codex is the second planner and the auditor. Without it, use a
fresh Claude agent for those steps, and say so in the report.

**The browser.** The repository's `.mcp.json` runs Playwright MCP against a Chrome on CDP port 9335, with a profile
of its own. If no Chrome answers there, start one:

```bash
curl -sf http://127.0.0.1:9335/json/version >/dev/null || open -na "Google Chrome" --args \
  --user-data-dir="$HOME/.cache/insulin-apps-e2e-chrome" --remote-debugging-port=9335 \
  --allow-insecure-localhost --no-first-run --no-default-browser-check about:blank
  # macOS; on Linux, run google-chrome with the same flags, in the background
```

`--allow-insecure-localhost` lets this Chrome accept wrangler's self-signed certificate on `*.localhost` hosts only,
for the stack over https (Phase 1).

Load the browser tools in one ToolSearch call:
`select:mcp__playwright__browser_tabs,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_fill_form,mcp__playwright__browser_select_option,mcp__playwright__browser_press_key,mcp__playwright__browser_wait_for,mcp__playwright__browser_evaluate,mcp__playwright__browser_resize,mcp__playwright__browser_take_screenshot,mcp__playwright__browser_console_messages,mcp__playwright__browser_network_requests`.
If they don't load, ask the user to turn on `playwright` in `/mcp`. Open a new tab, and work only in it.

## Routing: what each area needs

Each changed file belongs to an area: an app (its top-level directory; `node .github/scripts/list-apps.mjs --json`
lists them), the gateway (`.github/hosting/gateway/`, `.github/hosting/scripts/`), the public docs
(`.github/hosting/docs/`, `<app>/docs/public/`), or CI/CD (`.github/workflows/`, `.github/scripts/`). Files such as
`AGENTS.md`, `README.md` and `.claude/` change no behavior. Classify each changed **behavior**, not each file, by
how it can be reached:

- `browser`: something a person sees or does on a page. Drive it with Playwright MCP.
- `api`: how an endpoint behaves (a route, a status, a response, an access rule, a validation), with or without a
  page in front of it. Call it from a signed-in page with `browser_evaluate` and `fetch`, so that it carries the
  gateway's real session; use `curl` for the signed-out case, for public paths, and for OAuth tokens.
- `agent`: what an AI agent or API client meets: OAuth client registration, consent and tokens at the apex, an
  app's `/mcp` tools, or `GET /api/catalog` with a client-credentials token. Drive consent in the browser and the
  calls with `curl`, as `.github/hosting/docs/screenshots.mjs` connects its MCP client.
- `scheduled`: the gateway's cron triggers (the five-minute tick of each app's `insulin.scheduled` path, the daily
  housekeeping). Call `/cdn-cgi/handler/scheduled?cron=<expression>` on the local gateway's address and check once
  that it answers; if it doesn't, the plan is `MANUAL`. Then check the result on a page or an endpoint.
- `none`: nothing to see at runtime, such as tests, docs wording, comments, types, CI configuration, commands, or
  a refactor that keeps behavior the same. It can't be tested end to end; it goes in the ledger with the check
  that verifies it.

"No page changed" doesn't mean there's nothing to test: an endpoint, agent or scheduled change is still reachable.
Report the split, for example `captable: browser (holder view) · api (a Viewer is refused) · none (docs)`.

| Area | Local stack | People | Committed suites (Tier 3) |
|---|---|---|---|
| Gateway | `startDev` (Phase 1), on port 8797: `http://insulinapps.localhost:8797/`, docs at `/docs/`, mail at `/__insulin/dev/mail`; with no app, a stub app at `captable.insulinapps.localhost` echoes the identity headers it gets | Signed up during the run: an Owner who creates the organization, then people invited as Admin, Editor or Viewer, or to specific apps with an app role or a custom role | `npm test` in `.github/hosting/gateway/` (Miniflare) |
| `captable` | Built, then behind the gateway: `http://captable.insulinapps.localhost:8797/` | The run's Owner (Admin in every app), an Editor, and a Viewer, who sees only their own holdings, matched by e-mail | `TZ=UTC npm test`; the workerd smoke (`.github/scripts/workerd-smoke/`, `node smoke.mjs`) |
| `esign` | Built, then behind the gateway over https, with Esign's local settings (Phase 1): `https://esign.insulinapps.localhost:8797/` | Members as above; signers have no account and reach the public paths with codes from the captured mail | `TZ=UTC npm test` (its editor test drives Chrome) |
| Public docs | `/docs/` on the local gateway, signed out | Nobody | The gateway's `npm run check:docs` |
| CI/CD | None: GitHub Actions don't run here | None | `node --test .github/scripts/*.test.mjs`; `actionlint`; the release and deploy go in the checks after the merge (Phase 5) |

- The READMEs are the source. Where one disagrees with this table, follow the README, and say so.
- Port 8797 keeps the run apart from a developer's `npm run dev` on 8787.
- **What can't run locally:** Esign's seal (AWS KMS and a timestamp authority), so an envelope never completes;
  verifying a domain (DNS-over-HTTPS); Google sign-in, SAML or OIDC against a real identity provider; a real AI
  client's connector. Those plans are `MANUAL`, unless the gateway's or the app's committed tests cover them with
  their stubs (Tier 1), and they go into the checks after the deploy.
- **Only CI/CD, docs wording or files outside every area changed:** every behavior is `none`, or the docs pages
  can be read on the local gateway. Skip to Phase 3, then Phase 5.

## Phase 1: Start the stack

Skip with `--plans-only`.

1. **Check the port, and who serves it.** A server already on it may belong to another clone or worktree (this
   repository keeps worktrees in `.claude/worktrees/`), and would test someone else's code:
   ```bash
   for port in 8797; do
     pid=$(lsof -nP -iTCP:$port -sTCP:LISTEN -t | head -1); [ -z "$pid" ] && { echo ":$port free"; continue; }
     cwd=$(lsof -a -p $pid -d cwd -Fn | sed -n 's/^n//p'); top=
     [ -n "$cwd" ] && top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
     echo ":$port pid $pid started $(ps -o lstart= -p $pid) checkout ${top:-unknown}"
   done
   ```
   Don't reuse a server: the run starts its own, with a fresh state. Ask before stopping one (it isn't yours), then
   stop it with SIGTERM. Also ask before starting while this checkout's own `npm run dev` runs: starting the stack
   rewrites the gateway's `.dev/*.wrangler.json`, which a running `wrangler dev` reloads.
2. **Build what runs.** For each app to drive, as the deploy builds it:
   ```bash
   (cd "$R/<app>" && npm ci --ignore-scripts --no-audit --no-fund && NODE_ENV=production NITRO_PRESET=cloudflare_module npm run build)
   (cd "$R/.github/hosting/gateway" && npm ci --ignore-scripts --no-audit --no-fund)
   ```
   Then make the run's gateway key: `openssl rand -base64 32 > "$D/gateway-key"` (MFA, stored credentials and the
   apps' tokens need one).
3. **Start it, with a state of the run's own.** The state lives in `$D/state`, so every migration, an edited one
   included, is applied from the start, and earlier runs' data, people and the two-organization limit don't get in
   the way. From the gateway's directory, with the Bash tool's `run_in_background`, listing the apps to drive (none
   runs the stub app):
   ```bash
   cd "$R/.github/hosting/gateway" && STATE="$D/state" KEY="$(cat "$D/gateway-key")" node --input-type=module -e "
   import { startDev } from './scripts/dev.mjs'
   await startDev({ apps: ['captable'], port: '8797', state: process.env.STATE,
     gatewayVars: { GATEWAY_SECRET_KEY: process.env.KEY, ORG_REQUEST_EMAIL: 'support@example.com' } })"
   ```
   **Esign** needs the stack over https (its embedded editor accepts only its own https origin) and its local
   settings to send codes. Write `$D/stack.mjs`, which starts the stack as `.github/hosting/docs/screenshots.mjs`'s
   `main()` does: `https: true`; Esign's `appVars` with a run-own `ESIGN_OTP_KEY`, a placeholder
   `ESIGN_KMS_KEY_ARN`, `ESIGN_FRAME_ANCESTORS` set to its own origin, `SUGER_APP_TOKEN` from `appToken` in
   `.github/scripts/deploy-apps.mjs`, and `SUGER_MAIL_URL` at a relay proxy like its `startRelayProxy`. Run it with
   `run_in_background`. Note each started task in `$D/started.md`.
4. **Wait for it.** Poll `http://insulinapps.localhost:8797/` (with `curl -k https://…` over https) until it
   answers, for up to 3 minutes. Then sign up the run's Owner: `/signup` (name, `@example.test` email, a password
   generated for the run), the Turnstile widget passes by itself, open the confirmation link on
   `/__insulin/dev/mail`, then create the organization. With `curl`, send
   `cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX`. Keep the run's passwords in `$D/people.md` only, never in the
   report, the PR or a reply. If the stack doesn't come up, every plan is `FAIL_INFRA`: stop, clean up, and still
   write Phase 3's ledger and Phase 5's record.

Plans create what they need (people, invitations, companies, templates), named with the run's id.

## Phase 2: Plans

Write a shared brief to `$D/context.md`: the PR's purpose; the changed files grouped by area and purpose; the
commits; the behaviors and how each is reached; the addresses and people, from the table; what can't run locally;
the focus text; and the diff of the source (without the tests). Then run two planners at the same time. Neither
changes files.

- **Main paths, by Claude** (a `general-purpose` agent): a plan for each changed behavior.
- **Edge cases, by Codex.** Write its brief to `$D/edges-brief.md` (the shared brief, and what to look for), then
  run `codex exec -s read-only --color never -C "$R" -o "$D/codex-edges.md" - < "$D/edges-brief.md"`. It looks for
  errors and empty states; the wrong person (can a Viewer, an Editor, someone with access to other apps only, a
  member of another organization, an AI agent or an API client do what only an Admin or the Owner may?); a public
  path reached without its code; double submits and stale pages; long and Unicode input; going back or reloading in
  the middle of a flow; and the page at phone width (no sideways scroll, and the main action still visible).

Each plan has: an id (`T01`… for main paths, `E01`… for edge cases); a title; the area; how it's reached; who signs
in; preconditions (what to create first, and how); numbered steps with exact addresses and controls (or the method,
address and body); for each step, an expected result that can be checked and can fail; a **regression catch** (the
one expectation that would fail if the PR's change were undone); and a priority (`P0` access, another
organization's data, or data loss; `P1` a main flow; `P2` the rest).

Merge the two sets, drop duplicates and plans for unchanged code, and save `$D/plan.md`. Then have a fresh Codex (or
a fresh Claude agent that didn't plan) **check the set**: every changed behavior has a plan, or a reason it has
none; every plan traces to a change, has expectations that can fail, and has a regression catch; and the set covers
failures and permissions, not only main paths. Add the plans it says are missing, and check again, at most twice.
Report what's still uncovered as a risk.

## Phase 3: Coverage ledger

Write it on every run, also with `--plans-only` and after a stop. Save `$D/coverage.md`, with two tables.

**(a) Changes:** one row for each fix, refactor or feature the PR delivers, found from the commits, the PR's text
and the diff.

| # | Change | Type | Verified? (how) | E2E-covered? | Evidence, or how to verify it without e2e |
|---|---|---|---|---|---|

Keep `Verified?` and `E2E-covered?` apart. A change that a unit or Miniflare test proves, but no plan drove, is
`Verified ✅ (unit)` and `E2E-covered ❌`. `E2E-covered ✅` needs a plan from this run that passed. End with a
tally. Report a change with no test, no review and no e2e as a risk, in plain words.

**(b) Files:** every changed file, each in exactly one row: the behavior, the files, `covered`, `partial` or
`not covered`, the plan ids, the reason when it isn't covered, and the check that verifies it instead (the area's
tests, a typecheck, a command).

Fill `Verified?` from the PR's tests and Phase 4's run of the committed suites, and `E2E-covered?` after Phase 4.

## Phase 4: Run

Skip with `--plans-only`. In this order:

1. **Tier 1, the PR's own tests:** the `T` plans, in the browser or with `curl`. Then each test the PR adds or
   changes, run on its own: in the gateway, `npm test -- --test-name-pattern '<its name>'`; in Cap Table,
   `TZ=UTC npx vitest run <file>`; in Esign, `TZ=UTC node --test test/<file>`.
2. **Tier 2, edge cases:** the `E` plans, and the `P2` plans.
3. **Tier 3, regression:** each touched area's whole committed suites, from the table, with no retries. Don't stop
   at a failure. Before blaming the PR, check whether the failure also happens where the branch started: run the
   same test in a temporary worktree at `$B` (`git worktree add --detach "$D/base" "$B"`, then `npm ci` in the area
   there, and `git worktree remove "$D/base"` afterwards). Skip this tier with `--no-suite`, and say so.

**Driving a plan.** Write `Running <id>` to `$D/log.md`. Act with the browser tools, take a `browser_snapshot` after
each action that changes the page, and wait with `browser_wait_for`. For each expectation, write the evidence to
the log: the snapshot line, the request (method, address, status), the captured mail, or the console line.

**What makes a result trustworthy:**

- **A pass needs evidence.** An expectation without quoted evidence that shows it isn't a pass: it's `FAIL_INFRA`
  (couldn't verify).
- **Check expectations as written.** If you can't check one as written, the plan is `FAIL_PLAN`. Never weaken an
  expectation to make it pass.
- **One retry, for timing only.** A step that passes only on the retry is `FLAKY`.
- **Every page counts.** An uncaught console error, a CSP violation or a 5xx response fails the plan, even when its
  own expectations pass.
- **Screenshot each regression catch** into `$D`, whether it passes or fails.
- **Verdicts:** `PASS`; `FAIL_BUG` (the app or the gateway is wrong); `FAIL_PLAN` (the plan is wrong);
  `FAIL_INFRA` (the setup failed, or the result couldn't be verified); `SKIP` (with the reason); `FLAKY`; `MANUAL`
  (safety rule 2, or what can't run locally).

**On a failure,** take a screenshot, read `browser_console_messages` and `browser_network_requests`, and find the
cause in the source (file and line). Don't work around a bug to make a plan pass. If failures are systemic (the
stack is down, you're signed out, every plan fails), stop and report what you have.

**Canary.** Once a run, add one expectation that must fail, such as an element that doesn't exist. If it passes,
the run is `UNTRUSTWORTHY`.

**Accounting.** Plans written = plans run + plans not run, each with its reason; the same for each plan's steps. A
gap that isn't reported is a failure of the run.

## Phase 4.5: Audit

The one who ran the tests doesn't certify them. A fresh Codex reads the evidence, without driving anything. Write
its brief to `$D/audit-brief.md` (the paths of the plans, the log and the screenshots, and the checks below), then
run:

```bash
codex exec -s read-only --color never -C "$R" -o "$D/audit-<n>.md" - < "$D/audit-brief.md"
```

For each plan, it checks that the quoted evidence proves each expectation marked as passed, that every step is
accounted for, that no expectation was weakened, that each failure is classified honestly, and that the canary
failed. Its verdict for each plan: `CONFIRMED`, `EVIDENCE-MISSING`, `WEAKENED`, `MISCLASSIFIED` or
`SUSPECT-FABRICATED`.

Repeat audit, fix the evidence, audit again, each time with a new Codex process and the same brief. The only allowed
fixes are:

1. run a step that was written but not run, with its evidence;
2. capture missing or stronger evidence for a step already run;
3. rebuild a precondition this run destroyed, then run the step;
4. narrow a claim in the report to what the evidence shows (the report says less; the test doesn't prove less).

Weakening, rewriting or deleting an expectation or a plan, downgrading a `FAIL_BUG`, calling a failure a setup
problem without new evidence, rerunning until a step passes, or asking the auditor to be more lenient makes the run
`UNTRUSTWORTHY`.

Stop when every verdict is `CONFIRMED` (the run is `TRUSTWORTHY`); when a round produced no new evidence; when only
forbidden fixes remain (`UNTRUSTWORTHY`); or at a `FAIL_BUG` or `SUSPECT-FABRICATED` verdict, which you report rather
than rerun. Say which of these ended the audit, and in which round.

## Phase 5: Report, and the PR's record

Write this phase on every run, also after a stop and with `--plans-only`: the less the run could drive, the more the
PR needs it.

**The report** (`$D/report.md`), with a summary for the user:

- the PR, its head commit, the areas and the stack, and the date;
- each plan's verdict, by tier, with its evidence's path; the totals; and the trust status (`TRUSTWORTHY` only when
  every pass is confirmed and the canary failed);
- each bug: the step, what was expected and what happened, console and network errors, its cause (file:line), and
  its severity;
- the coverage ledger (Phase 3), changes table first;
- what the run couldn't cover, and why; and anything a person must decide.

**Checks after the deploy** (`$D/manual-checks.md`). There is no staging: a merge to `main` becomes a release, and
`release.yml` deploys it to production within minutes of its checks passing (`deploy-release.yml`). For each change
the run didn't cover (anything without `E2E-covered ✅` and a confirmed pass), write a case for a person to check
once the Release run for the merge has deployed: `MT01`…, the change it covers, why it's manual, preconditions,
numbered steps on the production address (`https://insulinapps.com/`, `https://<app>.insulinapps.com/`), one
result to observe, and `- [ ] Pass · [ ] Fail · Notes:`. A CI/CD change's checks name the workflow runs to watch
and what each must show. On production, the checks only read, or use records the tester creates for the check and
removes afterwards; a check that would e-mail someone, change someone's records or store a credential says "an
admin decides". List the changes the run did cover first, for a spot check only. End with a tally that matches the
ledger's.

**On the PR.** Post the checks as one comment, which later runs update in place while nobody has edited it. Its
marker carries a hash of the text as posted; once a tester ticks a box or writes a note, the text no longer
matches, and a run posts a new comment instead, leaving theirs alone:

```bash
n=<PR number>; M='<!-- e2e-test-manual-checks'; me=$(gh api user --jq .login)
digest() { python3 -c 'import sys, hashlib; print(hashlib.sha256(sys.stdin.read().replace("\r", "").strip().encode()).hexdigest())'; }
{ echo "$M $(digest < "$D/manual-checks.md") -->"; cat "$D/manual-checks.md"; } > "$D/comment.md"
id=$(gh api "repos/sugerio/insulin-apps/issues/$n/comments" --paginate \
  --jq ".[] | select(.user.login == \"$me\" and (.body | startswith(\"$M\"))) | .id" | tail -1)
if [ -n "$id" ]; then
  gh api "repos/sugerio/insulin-apps/issues/comments/$id" --jq .body > "$D/comment-now.md" || exit 1
  posted=$(head -1 "$D/comment-now.md" | sed -n 's/.* \([0-9a-f]\{64\}\) -->.*/\1/p')
  [ -n "$posted" ] && [ "$(tail -n +2 "$D/comment-now.md" | digest)" = "$posted" ] || id=
fi
if [ -n "$id" ]; then gh api -X PATCH "repos/sugerio/insulin-apps/issues/comments/$id" -F body=@"$D/comment.md" --jq .html_url
else gh api "repos/sugerio/insulin-apps/issues/$n/comments" -F body=@"$D/comment.md" --jq .html_url; fi
```

Then write the evidence into the PR's description, in a section of its own, keeping the verdict line outside
`<details>` (which shows collapsed). The glyph is ✅ when every plan passed and the run is trustworthy; ⚠️ for flaky,
skipped or manual plans, plan or setup failures, coverage gaps, or a Claude agent standing in for Codex; ❌ for a
bug, an untrustworthy run, or a stop.

```markdown
## E2E test

<!-- e2e-test-evidence -->
**✅ /e2e-test: 12 of 12 plans passed · no bugs found · TRUSTWORTHY**

**Tested at** `<sha>` on the local stack: gateway + captable (`startDev`, fresh state) · **Suites:** gateway 274 of 274, captable 1,203 of 1,203 · **Checks after the deploy:** 3, in <the comment's link>

| Result | Count |
|---|---|
| Pass | n |
| Bug | n |
| Plan or setup failure | n |
| Skipped · manual · flaky | n · n · n |

**Bugs:** <one line each: what broke, where, and its cause. Leave the line out when there are none.>

<details>
<summary>Full evidence: plans by tier, audit, coverage</summary>

<the plans by tier, the audit's rounds and why it ended, the changes table, the run's folder>

</details>
<!-- /e2e-test-evidence -->
```

Save it as `$D/evidence.md`, starting with its heading and ending with the closing marker. If the PR's head has moved
since Phase 4, say so on the "Tested at" line. Build the new description from the current one, never from the block
alone, and replace only an earlier block of this command's, from its marker to its closing marker. If any step
fails, or the description changes meanwhile, change nothing. Use `gh api`, which changes only the body:

```bash
gh api repos/sugerio/insulin-apps/pulls/<n> --jq '.body // ""' > "$D/body.md" || exit 1
python3 - "$D/body.md" "$D/evidence.md" > "$D/body-new.md" <<'EOF' || exit 1
import re, sys
body, block = open(sys.argv[1]).read(), open(sys.argv[2]).read().strip()
start, end = "<!-- e2e-test-evidence -->", "<!-- /e2e-test-evidence -->"
if not block.startswith("## E2E test\n") or block.count(start) != 1 or not block.endswith(end):
    sys.exit("the evidence block lacks its heading or markers: not applied")
earlier = re.compile(r"\n*## E2E test\n+" + re.escape(start) + r".*?" + re.escape(end) + r"[ \t]*\n*", re.S)
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

Read both back. Confirm the comment starts with its marker; the description has the marker once, with the verdict
line outside `<details>`; and the rest of the description, including a `## Review` section, is unchanged. Report for
each **posted** or **applied** (new), **updated**, or **saved, not posted** (no PR, or `gh` failed), with the file's
path and the command to post it. A failure here doesn't fail the run.

## Phase 6: Clean up

1. Close your tab, and only yours. Leave the Chrome running (rule 6).
2. Stop what this run started (`$D/started.md`) with TaskStop or SIGTERM; never a server you didn't start, and never
   by port. Check that port 8797 is free again.
3. Leave the run's state in `$D/state` (git ignores it) as evidence, and list in the report the records the run
   created. Say that the gateway's `.dev/*.wrangler.json` were rewritten, and that `npm run dev` writes them again.
4. Give the user the paths of the report, the plans, the ledger and the checks after the deploy.
