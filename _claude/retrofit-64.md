# retrofit-64 — VOID. DO NOT RUN.

This was a mistake on my part. It proposed dropping the Moralis value-history sampler — which is the
OPPOSITE of the intended design. Moralis stays in the chain. The correct, already-implemented behavior
is in retrofit-60 (committed a9a8618):

1. Zerion / Mobula — up to ~3 years in one call.
2. GoldRush (~1 yr) **+** Moralis `to_block` sampling for the older tail — combined to exceed a year.
3. Moralis only — covers the whole range when GoldRush isn't available.
4. Only if ALL of them return nothing → `found_no_history` ("no history found").

retrofit-60 already does exactly this. No change is needed. Ignore/delete this file.
