# Install the GitHub Action

RevEngine reviews pull requests in your repository when a person with write access comments `/review` on one. The findings come back as one review with comments on the changed lines. Comments from anyone else are ignored, because each review costs money.

## Setup

Add an `OPENROUTER_API_KEY` secret to the repository, then add this workflow on the default branch:

```yaml
name: Review
on:
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr-number:
        description: Pull request number
        required: true
permissions:
  contents: read
  pull-requests: write
  issues: read # for pipeline: shape, whose judge reads the repository's open issues
jobs:
  review:
    if: github.event_name == 'workflow_dispatch' || (github.event.issue.pull_request && (startsWith(github.event.comment.body, '/review ') || github.event.comment.body == '/review'))
    runs-on: ubuntu-latest
    timeout-minutes: 30 # the reader's; for pipeline: shape, up to 360, past its own 5.5-hour limit, as org-review.yml sets
    steps:
      - uses: laude-institute/rev-engine-prime@main
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          pr-number: ${{ inputs.pr-number }}
```

You can also start a review from the Actions tab by running the workflow with a pull request number.

## What you get

By default the action reviews with `anthropic/claude-opus-5.5`, comments on at most 10 findings of medium or high severity, and lists the less severe ones in a collapsed section of the summary. It also gives a short answer to whether the change belongs in the project. The summary opens with one line of merge advice, which plain rules decide from the severities and that answer.

On a later review of the same pull request, the action first collects what the maintainer decided about earlier findings, and the review does not report a decided finding again unless the code gives a reason. A finding marked fixed, or a thread resolved without a reply, comes back only when the code at head shows the problem is still there. A finding marked wrong, won't fix or deferred comes back only when the code has changed in a way that makes it right. A finding that comes back names the earlier one it repeats. A decision counts when someone with write access wrote it: a reply on one of the action's comments that starts with **Fixed**, **Partly fixed**, **Won't fix**, **Deferred** or **Wrong**, a thread they resolved, or a comment that starts with `## Review evaluation` and labels findings as `must`, `valid` or `invalid`. A comment nobody answered is not a decision. The fit check also gets the maintainer's answer from the "Fit and recommendation" section of each review evaluation, so it does not raise a concern again that the maintainer already answered, and it keeps the maintainer's latest verdict unless the change has moved since. The summary says how many findings were left out this way and which earlier ones they repeated. The shape's judge reads the same decisions, and its summary doesn't list what they left out, which stays in its saved results. If collecting fails, the run logs a warning and reviews as before. Separately, when an earlier comment from the action is still open and raises the same problem on the same lines in nearly the same words, the action does not comment again; it lists the finding in a collapsed part of the summary, with a link to that comment. A different problem on those lines gets its own comment.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `model` | `anthropic/claude-opus-5.5` | Model that reviews and verifies, as OpenRouter names it, or as the endpoint at `model-base-url` does. |
| `min-severity` | `medium` | The least severe findings that get a comment. One of `high`, `medium` or `low`. For the shape, `high` is its blockers and `medium` adds its should-fix issues; it says which of the change's own issues get a comment, and the summary lists every one either way. |
| `max-findings` | `10` | Cap on findings that get a comment. The rest join the collapsed section. The shape lists the change's blockers and should-fix issues open in the summary whether they get a comment or not, its minor issues folded by file, and issues in existing code (there before the change) folded apart below them, as far as GitHub's size limit allows, the rest counted, and as a last resort the summary's tail cut, saying so. |
| `fit` | `on` | Say whether the change belongs in the project. |
| `time-budget` | `780` | Seconds allowed for the review. The shape doesn't use it: it stops itself at 5.5 hours, inside the job's six, with what it read kept. |
| `command` | `/review` | A comment starts a review only when it is this text, or this text followed by a space. |
| `off-label` | `no-automated-review` | A pull request carrying this label isn't reviewed when it's opened or by a manual run; a comment of `command` still reviews it. Put on while a review runs, it keeps that review from posting, and a stopped one from saying so, unless a comment asked for it; the run's results are still saved as its artifacts (the shape's sealed, as the Security section says). Empty turns the label off. |
| `allow-forks` | `false` | Set to `true` to review pull requests from forks. |
| `authors` | `writers` | Which pull request events start a review: with `writers`, only those raised by someone who can push to the repository, such as its opening or reopening; with `any`, every one, for a workflow that chooses itself which pull requests to review. A comment or a manual run always needs a person with write access. |
| `model-base-url` | none | Where model requests go instead of OpenRouter, as `RB_MODEL_BASE_URL` in [Settings](SETTINGS.md). The review container then shares the runner's network, so it reaches the endpoint the way the runner does. |
| `model-api` | `chat` | The API the endpoint at `model-base-url` speaks: `chat` or `anthropic`. |
| `model-api-key` | none | The key for the endpoint at `model-base-url`, in place of `openrouter-api-key`. That endpoint gets no other key. The shape doesn't start without it, on OpenRouter too: it reaches Sol at `sol-base-url` with it, and seals with it the run it saves and what a stopped review keeps in GitHub's cache. |
| `pipeline` | `reader` | `shape` runs the review shape (`RB_CONFIG_SHAPE` in [Settings](SETTINGS.md)) in place of this reviewer. It may take hours on a large change, so its job needs a timeout to match, up to GitHub's six hours. Its review advises from the change's own issues its judge holds real: "fix, then merge" for a blocker, and "fix here or file an issue for each, then merge" for a should-fix issue. Each issue is the judge's text, by reading, with its first three places in the repository linked at the reviewed commit (the base's, for a file the change deletes), and a blocker or should-fix says the run that would confirm it where the judge gave one. The change's blockers and should-fix issues are listed and commented on as `min-severity` and `max-findings` say; its minor issues are folded away by file; issues in existing code, there before the change, are folded away apart, below the change's own, and don't weigh in the advice; an issue already named in the description, on the pull request's thread or in an open issue says where, linking a thread item or an issue, and gets no comment. The review says which changed lines no reader read. Security issues in code the base already has aren't posted, and stay in the run's saved results, which are saved sealed with `model-api-key`. Give its workflow `issues: read` beside `pull-requests: write`, so its judge reads the repository's open issues; without it the review goes on without them and its saved results say so. How the review went (a reader that didn't answer, the plan's note, what went wrong along the way) stays there too. The list is compacted, and as a last resort cut, past GitHub's size limit; what's cut stays in the saved run. A later review of the same pull request reads only what changed since the last one's head when that head is still in the branch's history. A manual run (`workflow_dispatch`) goes on with a review that stopped, and does nothing at a head whose review is done (as posted with the workflow's own token, by `github-actions[bot]`); a `/review` comment reviews that head again. A stopped review's answers are kept in GitHub's cache only by a manual run, which GitHub lets write it: a run started by `pull_request_target` or a comment can only restore the default branch's cache, so when any other run stops, it keeps nothing new, and its first manual run goes on from what an earlier run of that head kept, if any, or reads from the start. What a manual run keeps is under its own branch, and a `/review` comment runs on the default branch. What it keeps is sealed with `model-api-key`, since a pull request's own workflow can restore the default branch's cache; a seal that key doesn't open, or answers kept in the clear, are set aside, and the review reads from the start. |
| `sol-base-url` | none | For the shape: where Sol is asked, as `RB_SOL_BASE_URL`. |
| `dependencies` | none | For the shape: the name of an artifact of the same workflow run holding the head's installed dependencies, the contents of its `node_modules`, placed in the checkout's `node_modules` for the readers. Install it in a job of its own with no secrets and install scripts off, as `.github/workflows/org-review.yml` does, since a fork's package configuration is the contributor's. |
| `dependencies-head` | none | For the shape: the head commit the dependencies were installed from, such as the `who` job's head output in `.github/workflows/org-review.yml`. They are placed only when the review reads that same head; with `dependencies` set and this empty or different, the review reads without them. |
| `consumers` | none | For the shape: public repositories that rely on this one, as `owner/name` separated by spaces, each checked out at its default branch under `.consumers/<owner>__<name>` in the checkout, which replaces anything the pull request has at `.consumers`. |

## Security

The model only reads the pull request's code and never runs it. The review step holds the model key and no GitHub token, and the step that posts the review holds the GitHub token and no model key. Pull requests from forks are skipped unless `allow-forks` is `true`.

The shape's run holds what its review doesn't post: security issues in code the base already has, every reader's answers, and its trace. Anyone signed in to GitHub can download a public repository's artifacts, so the run is saved sealed, in an artifact named `rev-engine-shape-<pr>-<round>-<attempt>`, the attempt being the workflow run's: `shape.tar.enc` is the run directory as a tar, encrypted with AES-256-CBC under `model-api-key` (PBKDF2, SHA-256, 100000 rounds). So whoever holds that key opens it, and so can anyone with write access to the repository, who GitHub says has read access to its secrets. It's saved before the review is posted, so a save that fails leaves the review unposted, and again after, with the ids of the comments the review posted, as `rev-engine-shape-<pr>-<round>-<attempt>-posted` beside the first. Within one workflow run, a round's latest save is that of the highest attempt that saved one, its `-posted` copy where it has one; a later workflow run's save of the same round, such as a `/review` after a stop, is later still. To open a downloaded run, with the key in `MODEL_API_KEY` (without any whitespace round it, as the Action seals with it), under pipefail, so a seal openssl can't open whole, such as one cut short, fails the command even where tar read what came before:

```sh
set -o pipefail; mkdir run && openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -md sha256 -pass env:MODEL_API_KEY -in shape.tar.enc | tar -C run -xf -
```

The Actions log is public too, so there the shape says only that the review started, with its settings, and how it ended as the pull request sees it: finished, with the number of issues it posts and of those the judge gave no verdict on; stopped, with its reason; or failed, with its error. An error that escapes the review's own handling, which Node would print whole, goes to the trace with its stack, and the log says only its class; an unhandled rejection takes that path because the Action's image runs Node with its default `--unhandled-rejections=throw`, so a run of `src/main.ts` under another mode or another runtime may still print one whole. Each stage as it runs (the plan, each reader's turns and findings, the grouping, the judge, the severity check, and each caller's usage) goes to `trace.log` in the run directory, each line with its time, and is sealed with the run. A run cancelled before its seal step, or whose runner is lost, saves no trace. What stays public is how long the Review step took, which GitHub shows. The severity check, which runs only when the judge kept two or more issues, adds to that: 14 s of one review's 1175 s, where shape reviews of one repository took from 14 to 24 minutes.
