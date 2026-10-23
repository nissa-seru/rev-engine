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
jobs:
  review:
    if: github.event_name == 'workflow_dispatch' || (github.event.issue.pull_request && (startsWith(github.event.comment.body, '/review ') || github.event.comment.body == '/review'))
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: laude-institute/rev-engine-prime@main
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          pr-number: ${{ inputs.pr-number }}
```

You can also start a review from the Actions tab by running the workflow with a pull request number.

## What you get

By default the action reviews with `anthropic/claude-opus-5.5`, comments on at most 10 findings of medium or high severity, and lists the less severe ones in a collapsed section of the summary. It also gives a short answer to whether the change belongs in the project. The summary opens with one line of merge advice, which plain rules decide from the severities and that answer.

On a later review of the same pull request, the action first collects what the maintainer decided about earlier findings, and the review does not report a decided finding again unless the code gives a reason. A finding marked fixed, or a thread resolved without a reply, comes back only when the code at head shows the problem is still there. A finding marked wrong, won't fix or deferred comes back only when the code has changed in a way that makes it right. A finding that comes back names the earlier one it repeats. A decision counts when someone with write access wrote it: a reply on one of the action's comments that starts with **Fixed**, **Partly fixed**, **Won't fix**, **Deferred** or **Wrong**, a thread they resolved, or a comment that starts with `## Review evaluation` and labels findings as `must`, `valid` or `invalid`. A comment nobody answered is not a decision. The fit check also gets the maintainer's answer from the "Fit and recommendation" section of each review evaluation, so it does not raise a concern again that the maintainer already answered, and it keeps the maintainer's latest verdict unless the change has moved since. The summary says how many findings were left out this way and which earlier ones they repeated. If collecting fails, the run logs a warning and reviews as before. Separately, when an earlier comment from the action is still open and raises the same problem on the same lines in nearly the same words, the action does not comment again; it lists the finding in a collapsed part of the summary, with a link to that comment. A different problem on those lines gets its own comment.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `model` | `anthropic/claude-opus-5.5` | Model that reviews and verifies, as OpenRouter names it, or as the endpoint at `model-base-url` does. |
| `min-severity` | `medium` | The least severe findings that get a comment. One of `high`, `medium` or `low`. |
| `max-findings` | `10` | Cap on findings that get a comment. The rest join the collapsed section; with the shape, every issue is listed under its severity in the summary whether it gets a comment or not, as far as GitHub's size limit allows, the rest counted, and as a last resort the summary's tail cut, saying so. |
| `fit` | `on` | Say whether the change belongs in the project. |
| `time-budget` | `780` | Seconds allowed for the review. The shape doesn't use it: it stops itself at 5.5 hours, inside the job's six, with what it read kept. |
| `command` | `/review` | A comment starts a review only when it is this text, or this text followed by a space. |
| `allow-forks` | `false` | Set to `true` to review pull requests from forks. |
| `authors` | `writers` | Which pull request events start a review: with `writers`, only those raised by someone who can push to the repository, such as its opening or reopening; with `any`, every one, for a workflow that chooses itself which pull requests to review. A comment or a manual run always needs a person with write access. |
| `model-base-url` | none | Where model requests go instead of OpenRouter, as `RB_MODEL_BASE_URL` in [Settings](SETTINGS.md). The review container then shares the runner's network, so it reaches the endpoint the way the runner does. |
| `model-api` | `chat` | The API the endpoint at `model-base-url` speaks: `chat` or `anthropic`. |
| `model-api-key` | none | The key for the endpoint at `model-base-url`, in place of `openrouter-api-key`. That endpoint gets no other key. |
| `pipeline` | `reader` | `shape` runs the review shape (`RB_CONFIG_SHAPE` in [Settings](SETTINGS.md)) in place of this reviewer. It may take hours on a large change, so its job needs a timeout to match, up to GitHub's six hours. Its review lists every issue its judge holds real, grouped by severity (compacted, and as a last resort cut, past GitHub's size limit), with blockers and should-fix issues commented on as `min-severity` and `max-findings` say, and says what its readers couldn't read. A later review of the same pull request reads only what changed since the last one's head when that head is still in the branch's history. A manual run (`workflow_dispatch`) goes on with a review that stopped, and does nothing at a head whose review is done (as posted with the workflow's own token, by `github-actions[bot]`); a `/review` comment reviews that head again. A stopped review's answers are kept in GitHub's cache only by a run GitHub lets write it: a manual run can, while a run started by a pull request or a comment can only restore the default branch's cache, so when one of those stops, it keeps nothing new, and its first manual run goes on from what an earlier run of that head kept, if any, or reads from the start. What a manual run keeps is under its own branch, and a `/review` comment runs on the default branch. |
| `sol-base-url` | none | For the shape: where Sol is asked, as `RB_SOL_BASE_URL`. |
| `dependencies` | none | For the shape: the name of an artifact of the same workflow run holding the head's installed dependencies, the contents of its `node_modules`, placed in the checkout's `node_modules` for the readers. Install it in a job of its own with no secrets and install scripts off, as `.github/workflows/org-review.yml` does, since a fork's package configuration is the contributor's. |
| `dependencies-head` | none | For the shape: the head commit the dependencies were installed from, such as the `who` job's head output in `.github/workflows/org-review.yml`. They are placed only when the review reads that same head; with `dependencies` set and this empty or different, the review reads without them. |
| `consumers` | none | For the shape: public repositories that rely on this one, as `owner/name` separated by spaces, each checked out at its default branch under `.consumers/<owner>__<name>` in the checkout, which replaces anything the pull request has at `.consumers`. |

## Security

The model only reads the pull request's code and never runs it. The review step holds the model key and no GitHub token, and the step that posts the review holds the GitHub token and no model key. Pull requests from forks are skipped unless `allow-forks` is `true`.
