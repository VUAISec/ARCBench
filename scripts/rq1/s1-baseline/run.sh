#!/usr/bin/env bash
# S1 Baseline (RQ1): Hermes, four agent models, c1-c4, full context and compacted, no added content
#
# Generated from src/rq/studies.ts by src/rq/generate-scripts.ts -- edit that file, not this one.
# Re-runs the configuration of results/rq1/s1-baseline/ into runs/rq1/s1-baseline/ (override with OUT=...).
# 8 commands. Needs OPENROUTER_API_KEY.
# Every command is --resume, so an interrupted script can simply be run again.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
OUT="${OUT:-runs/rq1/s1-baseline}"

./arcbench run --agent_model ~openai/gpt-luna-latest --compaction_strategies none --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model ~openai/gpt-luna-latest --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model deepseek/deepseek-v4-flash-0731 --compaction_strategies none --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model deepseek/deepseek-v4-flash-0731 --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies none --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model qwen/qwen3.7-flash --compaction_strategies none --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model qwen/qwen3.7-flash --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume

# Metrics over this run:
./arcbench evaluate --results "$OUT"
