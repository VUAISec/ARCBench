#!/usr/bin/env bash
# S7 Defense (RQ3): Four defenses with no attack and under escape, GLM, k = 6
#
# Generated from src/rq/studies.ts by src/rq/generate-scripts.ts -- edit that file, not this one.
# Re-runs the configuration of results/rq3/s7-defense/ into runs/rq3/s7-defense/ (override with OUT=...).
# 8 commands + 4 borrowed. Needs OPENROUTER_API_KEY.
# Every command is --resume, so an interrupted script can simply be run again.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
OUT="${OUT:-runs/rq3/s7-defense}"

./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method none --defense_method isolation --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method none --defense_method instructional --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method none --defense_method sandwich --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method none --defense_method rule-preserving --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method escape --defense_method isolation --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method escape --defense_method instructional --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method escape --defense_method sandwich --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method escape --defense_method rule-preserving --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume

# Cells this study uses but does not run: its released rows for them are S6 Attack's. They run here
# so the study stands alone; SKIP_BORROWED=1 leaves them out (and reuses the other study's rows).
if [ "${SKIP_BORROWED:-0}" != "1" ]; then
  ./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies none --rule_channel home --injection_attack_method none --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
  ./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies none --rule_channel home --injection_attack_method escape --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
  ./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method none --defense_method none --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
  ./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method escape --defense_method none --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
fi

# Metrics over this run:
./arcbench evaluate --results "$OUT"
