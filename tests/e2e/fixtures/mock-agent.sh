#!/bin/bash
ITERATION_FILE="/tmp/randal-test-iter-${RANDAL_JOB_ID:-default}"
CURRENT=$(($(cat "$ITERATION_FILE" 2>/dev/null || echo 0) + 1))
echo "$CURRENT" > "$ITERATION_FILE"
echo "Mock agent iteration $CURRENT"
echo "// iteration $CURRENT" >> "${RANDAL_WORKDIR:-/tmp}/test-output.ts"
echo "Tokens used: input=5000, output=1200"
if [ "$CURRENT" -ge 2 ]; then
  echo "<promise>DONE</promise>"
fi
