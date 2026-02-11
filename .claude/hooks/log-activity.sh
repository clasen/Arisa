#!/bin/bash
# Log activity

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')
ARISA_LOGFILE="$CLAUDE_PROJECT_DIR/.arisa/logs/activity.log"
LEGACY_LOGFILE="$CLAUDE_PROJECT_DIR/.tinyclaw/logs/activity.log"
LOGFILE="$ARISA_LOGFILE"

if [[ ! -d "$CLAUDE_PROJECT_DIR/.arisa" && -d "$CLAUDE_PROJECT_DIR/.tinyclaw" ]]; then
  LOGFILE="$LEGACY_LOGFILE"
fi

mkdir -p "$(dirname "$LOGFILE")"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] $TOOL_NAME" >> "$LOGFILE"
echo "$INPUT" | jq '.' >> "$LOGFILE"
echo "" >> "$LOGFILE"

exit 0
