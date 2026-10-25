#!/usr/bin/env bash
# Usage: studio-turn.sh <prompt-file> <result-json>
# Runs one Arc Studio turn on the "gavel" session (detached + attach, so a dropped
# connection cannot lose it) and writes the result document to <result-json>.
export PATH="/c/Program Files/nodejs:$PATH"
S="/c/Users/USER/AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/npm/node_modules/@circle-fin/arc-studio-cli/bin/arc-studio.mjs"
[ -f "$S" ] || S="$APPDATA/npm/node_modules/@circle-fin/arc-studio-cli/bin/arc-studio.mjs"
node "$S" run --prompt-file "$1" --session gavel --detach --output json >/dev/null || exit 1
node "$S" attach --session gavel --timeout 0 --output json > "$2"
echo "exit=$?"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("status:",j.status,"| files:",(j.filesChanged||[]).join(", "));if(j.questions)console.log("QUESTIONS:",JSON.stringify(j.questions));const t=j.finalText||"";console.log(t.slice(-4000))' "$(cygpath -w "$2" 2>/dev/null || echo "$2")"
