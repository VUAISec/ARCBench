#!/usr/bin/env bash
# S5 Injection (RQ3): Hermes with volume injection, the compactor-targeted injection, and both, four agent models, c1-c4
#
# Generated from src/rq/studies.ts by src/rq/generate-scripts.ts -- edit that file, not this one.
# Re-runs the configuration of results/rq3/s5-injection/ into runs/rq3/s5-injection/ (override with OUT=...).
# 12 commands + 8 borrowed. Needs OPENROUTER_API_KEY.
# Every command is --resume, so an interrupted script can simply be run again.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
OUT="${OUT:-runs/rq3/s5-injection}"

./arcbench run --agent_model ~openai/gpt-luna-latest --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --filler yes --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model ~openai/gpt-luna-latest --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --injection_attack_method legacy --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model ~openai/gpt-luna-latest --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --filler yes --injection_attack_method legacy --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model deepseek/deepseek-v4-flash-0731 --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --filler yes --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model deepseek/deepseek-v4-flash-0731 --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --injection_attack_method legacy --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model deepseek/deepseek-v4-flash-0731 --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --filler yes --injection_attack_method legacy --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --filler yes --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --injection_attack_method legacy --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --filler yes --injection_attack_method legacy --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model qwen/qwen3.7-flash --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --filler yes --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model qwen/qwen3.7-flash --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --injection_attack_method legacy --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
./arcbench run --agent_model qwen/qwen3.7-flash --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --filler yes --injection_attack_method legacy --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume

# Cells this study uses but does not run: its released rows for them are S1 Baseline's. They run here
# so the study stands alone; SKIP_BORROWED=1 leaves them out (and reuses the other study's rows).
if [ "${SKIP_BORROWED:-0}" != "1" ]; then
  ./arcbench run --agent_model ~openai/gpt-luna-latest --compaction_strategies none --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
  ./arcbench run --agent_model ~openai/gpt-luna-latest --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
  ./arcbench run --agent_model deepseek/deepseek-v4-flash-0731 --compaction_strategies none --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
  ./arcbench run --agent_model deepseek/deepseek-v4-flash-0731 --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
  ./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies none --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
  ./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
  ./arcbench run --agent_model qwen/qwen3.7-flash --compaction_strategies none --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
  ./arcbench run --agent_model qwen/qwen3.7-flash --compaction_strategies prompting-h --rule_present yes --rule_channel home-paired --repetitions 3 --cohort v1.1-ladder --out "$OUT" --resume
fi

# Metrics over this run:
./arcbench evaluate --results "$OUT"
