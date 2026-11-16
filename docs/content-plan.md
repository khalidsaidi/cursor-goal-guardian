# Public content guide

## Product purpose

Help an ordinary Cursor agent finish the user's goal. Lead with remembered goals, useful follow-ups, independent review and corrections that help the reviewer. CGG is not an honesty detector.

Lead with the CSV user story and readable agent follow-up, followed by explicit setup steps. Explain each upstream component through its contribution to that experience. Keep testing history and detailed evidence on their reference pages.

## Consistent message

- Goal loop: DeepSeek Harness supplies status/round authority; Codex supplies accounting, budgets and continuation instructions. Cursor does the implementation work.
- Independent review: CGG reviews the project; ADK evaluates the supplied record and evidence against the request.
- Feedback and learning: corrections help current reviews and become RRSI inputs. Qualified prompt updates are checked before adoption and can be undone. Do not promise improvement from every correction or claim naturally accumulated user-feedback gains.

## Where copy lives

The root README introduces the product. The extension README is the store guide. The extension manifest supplies the short listing description, keywords and command labels. Interface copy is in the extension sources and core panel view model; generated chat skills/rules come from core's rule generator. Component READMEs explain the actual adapters. NOTICE credits upstream code and adaptations.

The configured public distribution is Open VSX; the homepage is the GitHub README. Published versions, release notes and repository metadata must agree with the release being shipped. Use the checked artifacts for the current version on each platform; do not present older packages as validation of a new build.

## Visual policy

Keep the existing recognizable logo. Refresh explanatory visuals with the current production panel renderer and labelled example data. Chat/menu illustrations must say they are illustrations; do not present them as recordings of real Cursor runs. Regenerate assets with the repository's media script after interface-copy changes.

## Evidence and historical material

Public verification and performance pages summarize the scope of existing evidence without unsupported universal percentages. Maintainer provenance stays in release-status. Old content, matrices and showcase plans remain in Git history rather than appearing as current product claims. Upstream licenses, notices and source documentation retain their original meaning.
