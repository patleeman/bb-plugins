---
name: plan-review
description: Optional upstream Plannotator review UI for plans in BB.
---

# Optional Plannotator plan review

This is opt-in reference material. Plannotator is never an authorization gate
in BB: agents may edit, implement, or continue work without opening it. Do not
invoke `plannotator_review_plan` unless the user explicitly asks for
Plannotator or a plan review.

Native provider Plan mode is a separate provider-controlled workflow. This
reference does not enable it, replace it, or require either workflow.

When the user does request Plannotator, call `plannotator_review_plan` with the
complete Markdown plan. A review is informational and collaborative; its
approval is not a permission grant, and cancellation or omission never blocks
implementation.

The tool opens the upstream Plannotator app in BB's right panel and returns a
pending review ID. End the turn and wait for BB to send the decision as a new
message in the same thread. Do not poll for the decision. Use
`plannotator_review_status` with the review ID only to recover a missing result.

The decision message has one of these results:

- `decision=approved`: report the approval and continue as appropriate.
- `decision=changes_requested`: report the feedback and revise only if the
  user wants another review.
- `decision=cancelled`: report the cancellation, then continue normally unless
  the user specifically asked to stop.

Do not claim a review decision from the presence of a panel or the pending
tool result alone. Only the later decision message describes what happened in
Plannotator; it does not authorize or prohibit file changes.
