#!/usr/bin/env bash
# S6 Attack (RQ3): Six compactor-targeted injection attacks and no attack, no defense, with full-context baselines, GLM, k = 6
#
# Generated from src/rq/studies.ts by src/rq/generate-scripts.ts -- edit that file, not this one.
# Re-runs the configuration of results/rq3/s6-attack/ into runs/rq3/s6-attack/ (override with OUT=...).
# 14 commands. Needs OPENROUTER_API_KEY.
# Every command is --resume, so an interrupted script can simply be run again.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
OUT="${OUT:-runs/rq3/s6-attack}"

./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies none --rule_channel home --injection_attack_method none --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies none --rule_channel home --injection_attack_method legacy --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies none --rule_channel home --injection_attack_method naive --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies none --rule_channel home --injection_attack_method escape --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies none --rule_channel home --injection_attack_method ignore --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies none --rule_channel home --injection_attack_method fake-completion --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies none --rule_channel home --injection_attack_method combined --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method none --defense_method none --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method legacy --defense_method none --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method naive --defense_method none --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method escape --defense_method none --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method ignore --defense_method none --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method fake-completion --defense_method none --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_channel home --injection_attack_method combined --defense_method none --repetitions 6 --cohort v1.6-ipi-attack-defense --out "$OUT" --resume

# Metrics over this run:
./arcbench evaluate --results "$OUT"
