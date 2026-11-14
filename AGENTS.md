# AGENTS.md

Instructions for AI agents (and humans) working on **dewee-webchat**, the embeddable chat for
[Dewee](https://dewee.sh) agents. See `README.md` for setup and usage.

## Issues and labels

Every issue you work on shows who owns it and where it is, so two people (or agents) never build
the same thing.

- **Claim before coding:** `gh issue edit <n> --add-assignee @me` and add `in progress`. First check
  the issue's assignees, labels, linked PRs and branches; if someone holds it, comment instead.
- **Keep exactly one lifecycle label** and remove the previous one at each step:

  | Label | When |
  |---|---|
  | `in progress` | Claimed; work under way |
  | `blocked` | Cannot continue; the latest comment says why and what unblocks it |
  | `in review` | Implementation done; reviewed in a fresh context |
  | `done` | PR open and review findings resolved |
  | `shipped` | Merged into `main` |

- **New findings become new issues**, assigned and labelled the same way if you take them on, not
  scope creep in the current PR.
