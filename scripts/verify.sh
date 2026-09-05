#!/usr/bin/env bash
# Turns this project's central claim — "RESULTS.md is generated, nothing in it is
# typed by hand" — into a check a judge can run.
#
# Two lines of RESULTS.md are legitimately non-deterministic: the generation
# timestamp and the commit stamp. Everything else must be byte-identical to what
# the committed tree produces, or a number in the report was hand-edited, or the
# engine changed and the report was not regenerated. Both are the same defect.
set -euo pipefail

IGNORE=(-I '^Generated:' -I '^Commit:')

echo "==> tests"
npm test --silent

# BOTH generators, in this order. `eval` rewrites the whole report and leaves a
# placeholder where the sweep section goes; `sweep` splices its results back in. Running
# only `eval` here would delete the sweep results on every verification — a check that
# destroys part of the artifact it is checking.
echo "==> regenerating RESULTS.md from this tree (eval, then sweep)"
npx tsx scripts/eval.ts >/dev/null
npx tsx scripts/sweep.ts >/dev/null

echo "==> checking the committed report against the regenerated one"
if git diff "${IGNORE[@]}" --exit-code -- RESULTS.md; then
  echo "OK — committed RESULTS.md matches this tree (timestamp and commit stamp excluded)."
else
  cat >&2 <<'MSG'

FAIL — the committed RESULTS.md is not what this tree generates.

Either a figure was edited by hand, or the engine changed and the report was not
regenerated. Run `npm run eval && npm run eval:sweep` and commit the result.
MSG
  exit 1
fi
