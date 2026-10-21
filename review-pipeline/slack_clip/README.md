# Copy a drafted Slack message as rich text

`bash reports/reviews/tools/slack_clip/copy_for_slack.sh <draft.md>`

Puts the draft on the macOS clipboard twice: as HTML (real lists, bold, inline code) and as plain text. Slack's composer turns the HTML into real bullet lists on paste; plain `•` characters stay as text and wrap without an indent (seen 2026-10-14, Theo's daily).

Draft format it understands: lines starting `• ` become list items, `*text*` becomes bold, backticks become code, every other non-empty line is a paragraph. Nothing else (no numbered lists, no nesting).

`set_clipboard.js` prints the pasteboard types and whether the HTML read back equal; `pbpaste | head` shows the plain text. A mention such as `@Han Yang` pastes as text, retype it in Slack to get a real mention. `Cmd+Shift+V` pastes plain text if needed.
