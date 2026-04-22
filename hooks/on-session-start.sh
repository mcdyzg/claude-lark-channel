#!/bin/bash
# SessionStart hook — capture claude session_id into by-id/<scope_id>.json
# All failures silent exit 0; never affect host session.

set -u

# Must be invoked inside a tmux session spawned by master.
[ -z "${TMUX:-}" ] && exit 0
[ -z "${LARK_CHANNEL_SCOPE_ID:-}" ] && exit 0
[ -z "${LARK_CHANNEL_STORE:-}" ] && exit 0

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

FILE="${LARK_CHANNEL_STORE}/sessions/by-id/${LARK_CHANNEL_SCOPE_ID}.json"
[ -f "$FILE" ] || exit 0

TS=$(( $(date +%s) * 1000 ))
TMP="${FILE}.tmp.$$"
jq --arg sid "$SESSION_ID" --argjson ts "$TS" \
   '.claudeSessionId = $sid | .updatedAt = $ts' "$FILE" > "$TMP" 2>/dev/null \
   && mv "$TMP" "$FILE"

exit 0
