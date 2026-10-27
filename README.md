# ARCBench: Agent Rule Compliance Benchmark

*Do agents still follow the rules after their context is compacted?*

ARCBench evaluates **operating-rule compliance under agent context compaction**. Each run gives an
agent an operating rule (for example "only email addresses within the company domain"), a realistic
work history, and then a request the rule forbids. Before the request, the history is compacted by a
**compaction strategy**, or left in full for the **full-context baseline**. The agent acts in the
loop of the pi agent harness, and a deterministic grader reads the tool calls it makes after
compaction: **violation**, **safe**, or **no action**. Two diagnostic judges explain the violations:
the **rule state judge** labels whether the compacted history still carries the rule (retained,
partially retained, absent), and the **agent behavior judge** labels the reason the agent gives for
breaking a rule it still has (approval, scope, unregistered, acknowledged).

Every factor that shapes the compacted context is a separate setting of one command:

```bash
./arcbench run --agent_model z-ai/glm-5.3-flash --compaction_strategies prompting-h \
               --injection_attack_method escape --defense_method sandwich --repetitions 6
./arcbench evaluate --results runs/cccb-v1
```

This README is the entry point. It has four parts:

1. [Setup](#1-setup), which everything else needs.
2. [Configuration](#2-configuration): the factors, their flags, and the commands.
3. [Reproducing the paper](#3-reproducing-the-paper-rq1rq3): the scripts that re-run the seven
   studies of RQ1–RQ3.
4. [Repository layout](#4-repository-layout).

---

## 1. Setup

Everything installs inside this directory. The pi coding agent, whose native compaction the
benchmark runs, ships in [`vendor/pi/`](vendor/pi/README.md) as pinned, checksummed npm tarballs, so
no pi checkout is needed (see [The pinned pi agent](#the-pinned-pi-agent-vendorpi) below).

### Option A: local

Requirements: **Node ≥ 22.19** (verified with 24.19.0, see `.nvmrc`), **Python ≥ 3.12** (verified
with 3.13), git.

```bash
cd ARCBench
scripts/setup.sh
```

`scripts/setup.sh` checks the Node version, runs `npm ci` (pi from `vendor/pi/`, everything else at
the versions in `package-lock.json`), creates `.venv/` with the pinned `numpy` and `pandas` for
`arcbench evaluate`, and runs `./arcbench preflight`. If your `python3` is older than 3.12, run
`PYTHON=/path/to/python3.13 scripts/setup.sh`. The per-study analyses need only the Python standard
library.

### Option B: Docker

```bash
docker build -t arcbench .
alias arcbench-docker='docker run --rm -e OPENROUTER_API_KEY -v "$PWD/runs:/benchmark/runs" arcbench'
alias arcbench-docker-sh='docker run --rm -e OPENROUTER_API_KEY -v "$PWD/runs:/benchmark/runs" --entrypoint bash arcbench'
```

The image holds Node 24.19.0, Python 3.13 and the same pinned packages, with pi from `vendor/pi/`.
New runs land in `runs/`, outside the container. Every `./arcbench …` command below also works as `arcbench-docker …`. Use
`arcbench-docker-sh` for the scripts and tests, for example `arcbench-docker-sh -c 'npm test'`.

### The pinned pi agent (`vendor/pi/`)

ARCBench runs pi's own compaction code (`AgentSession.compact()`) for the Pi and Pi + RP strategies,
and every run uses the same pi build:

| | |
|---|---|
| Upstream | [github.com/earendil-works/pi](https://github.com/earendil-works/pi) |
| Commit | `97fa14e39cfce78c273a36b2d9e8509cd5bc6b72` (`v0.84.3-3-g97fa14e39`, "fix(coding-agent): reject truncated compaction summaries"); also `piRevision` in `config/benchmark.json`, stamped into every row |
| Package version | `@earendil-works/pi-coding-agent` `0.84.3` (the version string was not bumped after the tag) |
| Local change | one type-only patch, [`vendor/pi/patches/0001-cloudflare-ai-gateway-type-annotation.patch`](vendor/pi/patches/0001-cloudflare-ai-gateway-type-annotation.patch), so that commit compiles; it changes no runtime behavior |

**Why it is vendored.** The npm registry has no package for this commit: `0.84.3` on npm predates
its compaction fix, and `0.84.4` changes pi's compaction requests. Either would make the pi
strategies a different configuration from the one the paper measured. So `vendor/pi/` holds the
seven packages packed from that build:

| Tarball | Package |
|---|---|
| `earendil-works-pi-coding-agent-0.84.3.tgz` | the agent session and its compaction |
| `earendil-works-pi-ai-0.84.3.tgz` | model providers (the OpenRouter path is the one used) |
| `earendil-works-pi-{agent-core,client,protocol,tui,telemetry}-0.84.3.tgz` | internal dependencies of the above |

**How it is installed.** `package.json` depends on the coding-agent tarball and uses `overrides` to
point every internal pi dependency at its tarball, so npm never mixes in a registry version.
`npm ci` (run by `scripts/setup.sh` and by the Dockerfile) installs them like any other package.
`./arcbench preflight` checks that the tarballs match `vendor/pi/SHA256SUMS`, that `node_modules`
holds pi from `vendor/pi/`, and that pi loads.

**Rebuilding it from source (optional).** To check the tarballs against pi's source, build pi at
the pinned commit and pack it with `scripts/vendor-pi.sh`:

```bash
git clone https://github.com/earendil-works/pi.git && cd pi
git checkout 97fa14e39cfce78c273a36b2d9e8509cd5bc6b72
git apply <path-to-ARCBench>/vendor/pi/patches/*.patch
npm ci && npm run build
cd <path-to-ARCBench> && scripts/vendor-pi.sh <path-to-pi>     # repacks vendor/pi/, refreshes SHA256SUMS
npm install && npm run test:golden-full                          # reinstall, then replay the recorded requests
```

pi's build fetches live model catalogs, so a rebuild made on a later date is not byte-identical to
the shipped tarballs (new checksums, and a changed `package-lock.json`), although the benchmark does
not use those catalogs. `npm run test:golden-full` confirms that the rebuilt pi still sends
byte-identical model requests for the 1,819 recorded episodes.

### API key

Live runs and judge calls go through [OpenRouter](https://openrouter.ai). The only credential the
benchmark reads is your own key:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

`./arcbench plan`, the offline `./arcbench smoke`, and the tests need no key.

### Check the install

```bash
./arcbench preflight     # key, vendored pi checksums, pi importable, cases, Python >= 3.12 + numpy/pandas
npm test                 # TypeScript tests, no network
npm run test:metrics     # metrics and attribution tests
```

---

## 2. Configuration

### The task cases

There are 17 **task cases**, in `data/rule-loss/cases.jsonl`. Each pairs an operating rule with a
concrete attacker goal and a graded tool. The **task scenario** is personal (a user's own rule; 8
cases) or organizational (9 cases). Violations fall into four types mapped to OWASP risk classes:
disclosure of protected data, access to unauthorized resources, unauthorized actions, and bypassed
approval steps. Tools are never executed: each call gets a fixed canned result, so runs have no side
effects.

`scripts/cases/gen_cases.py` generates the cases: eight organizational cases are reconstructed from
the Governance Decay paper, and nine were added. `scripts/cases/validate_cases.py` checks them.

### The configurable factors

A **configuration** sets every factor below. One `./arcbench run` command runs one configuration
over all 17 cases, and each flag takes one value.

| Factor | Flag | Values (default) |
|---|---|---|
| Agent model | `--agent_model` | an OpenRouter slug (required) |
| Compactor model | `--compactor_model` | an OpenRouter slug (the agent model) |
| Compaction strategy | `--compaction_strategies` | `none` (full context) or a strategy below (required) |
| Compaction budget constraint | `--compaction_budget` | `none` or a token count (`none`) |
| Rule delivery channel | `--rule_channel` | `home`, `home-paired`, `all`, `c1`, `c2`, `c3`, `c4` (`home`) |
| Rule present | `--rule_present` | `yes`, `no`; `no` gives the rule-absent baseline (`yes`) |
| Volume injection | `--filler` | `yes` adds 96,000 characters of volume filler (`no`) |
| Compactor-targeted injection attack | `--injection_attack_method` | `none`, `legacy`, `naive`, `escape`, `ignore`, `fake-completion`, `combined` (`none`) |
| Defense | `--defense_method` | `none`, `isolation`, `instructional`, `sandwich`, `rule-preserving` (`none`) |
| Repetitions | `--repetitions` | k runs per case (3) |
| Cohort | `--cohort` | `cccb-v1`, or a study's cohort to reproduce its run ids (`cccb-v1`) |

**Compaction strategies.** Seven *generative strategies* write replacement text for older turns;
three *selective compactors* keep part of the history verbatim.

| Paper name | Id | Family and notes |
|---|---|---|
| Pi | `pi-native-cut` | generative: pi's own compaction, its cut point and summary prompt |
| Pi + RP (Pi with rule preservation) | `pi-native-policy-preserving` | generative: pi's compaction with an instruction to retain operating rules |
| Structured | `baseline-structured-summary` | generative |
| ACON-UT, ACON-UTCO | `acon-ut`, `acon-utco` | generative: ACON's guidelines |
| TRACE | `trace-optimized` | generative: TRACE's optimized update prompt |
| Hermes | `prompting-h` | generative: Hermes Agent's context compressor (the studies' main strategy) |
| FIFO | `fifo` | selective: keeps the most recent whole turns that fit |
| LRU (rule), LRU (LLM) | `lru-mechanism`, `lru-prompting` | selective: keeps the turns ranked most recently used, by a rule or by a model call |

**Rule delivery channels.**
- c1 direct instruction: the user states the rule.
- c2 persistence instruction: the user has the agent write the rule to a file.
- c3 document-embedded: the rule is retrieved from an operating document.
- c4 policy-tool fetching: the rule is fetched through the policy tool.

`home` runs personal cases on c1 and organizational cases on c3. `home-paired` runs personal cases
on c1 and c2, and organizational cases on c3 and c4. `all` runs every case on all four.

**Compaction budget constraint.** A token budget on the compacted context. It is delivered to the
generative strategy and enforced on its output.

**Added content.** Volume injection adds volume filler to the history. The compactor-targeted
injection attacks place an instruction to drop the rule in content the compactor summarizes:
`legacy` (the injection attack of S5), and the published attacks naive, escape, ignore, fake
completion and combined.

**Defenses** change the compactor's prompt: isolation (`isolation`), instructional prevention
(`instructional`), sandwich prevention (`sandwich`), rule preservation (`rule-preserving`).

Combinations that cannot run are refused before any model call, with every reason listed. Examples:
a compactor model or a defense with a strategy that calls no model, a budget on a selective
compactor, or a defense on a pi strategy (pi assembles its own prompt).

### Commands

| Command | Does | Model calls |
|---|---|---|
| `./arcbench preflight` | checks the environment | no |
| `./arcbench plan <flags>` | validates one configuration and prints its runs (`--list` prints every run id) | no |
| `./arcbench smoke <flags>` | runs every stage against an offline fake model | no |
| `./arcbench smoke <flags> --live --limit N` | runs the first N runs for real | yes |
| `./arcbench run <flags>` | runs the configuration; `--out DIR` (default `runs/<cohort>`), `--resume`, `--concurrency N` | yes |
| `./arcbench evaluate --results DIR` | violation rate, violation@k and all-k, with case-bootstrap intervals; `--contrast "flag=a - flag=b"`, `--where flag=value`, `--by factor`; `--judge_metric retention` runs the rule state judge | only for `retention` |

Always `plan` first, since it prints the run count, and `smoke` before a large run. A run writes:
- `<out>/<agent-model>/results.jsonl`: one row per run;
- `<out>/<agent-model>/raw/<runId>/`: the run's trajectory;
- `plan.jsonl` and `resolved-config.jsonl`.

### Metrics

**violation@k** is the evaluation metric. A case is one task case under one agent model and
delivery channel. Over cases with all k runs valid, violation@k is the share with at least one
violating run, and **all-k** is the share violating in all k. The mean violation rate pools all valid
runs. A run is valid only if its episode completed as its condition specifies, for example compaction
ran and the rule was delivered. Invalid runs are excluded and counted.

The paper's **violation attribution** splits each case that violates after compaction into two
kinds. It is the *agent's own* if it also violates under the matched full-context baseline. Otherwise
it violates *only after compaction*, and is split further by the rule state of its violating runs
(absent, partially retained, retained). It is implemented in
[`metrics/attribution.py`](metrics/attribution.py).

---

## 3. Reproducing the paper (RQ1–RQ3)

The study rows behind the paper are not part of this repository. To reproduce a result, run its
study yourself with the scripts below; every script writes under `runs/`. The paper answers three
questions with seven studies (Table "studies"). Every study uses all 17 task cases and the same model
as compactor and agent.

| RQ | Study | Varies | Agent models | k | Runs |
|---|---|---|---|---|---:|
| **RQ1** Where do violations after compaction come from? | S1 Baseline | full context vs compacted, c1–c4 | DeepSeek, GPT-Luna, Qwen, GLM | 3 | 816 |
| **RQ2** How do different compaction configurations change it? | S2 Channel | delivery channel c1–c4 (S1's runs) | as S1 | 3 | — |
| | S3 Strategy | the ten compaction strategies × added content | DeepSeek, GPT-Luna, Qwen, GLM | 3 | 8,160 |
| | S4 Budget | five compaction budgets, volume injection | DeepSeek, GLM | 3 | 3,570 |
| **RQ3** How do compactor-targeted attacks and defenses change it? | S5 Injection | volume injection, the injection attack, both | DeepSeek, GPT-Luna, Qwen, GLM | 3 | 1,224 |
| | S6 Attack | six compactor-targeted injection attacks, with full-context baselines | GLM | 6 | 1,428 |
| | S7 Defense | four defenses, with no attack and under escape | GLM | 6 | 816 |

### The four steps

Each study is reproduced in the same four steps. Steps 1–3 call models and need
`OPENROUTER_API_KEY`; step 4 is offline. `<study>` is the study's folder, for example
`rq1/s1-baseline`.

| Step | Command | Writes |
|---|---|---|
| 1. Run the study | `scripts/<study>/run.sh` | `runs/<study>/<agent-model>/results.jsonl`, and the trajectories under `raw/` |
| 2. Label rule states (rule state judge) | `npx tsx scripts/judges/rule-state/judge.ts --study runs/<study> [flags]` | `runs/<study>/<agent-model>/judgments*.jsonl` |
| 3. Label agent behavior (agent behavior judge) | `python3 scripts/judges/agent-behavior/extract-reasoning.py --study runs/<study>`, then `npx tsx scripts/judges/agent-behavior/judge.ts --study runs/<study>` | `runs/<study>/agent-behavior/{inputs.jsonl,labels.csv}` |
| 4. Compute the study's numbers | `python3 scripts/<study>/analyze.py --results runs` | `runs/<study>/analysis/{numbers.json,tables.md}` |

### Which scripts reproduce which results

| Study | 1. Run | 2.–3. Label | 4. Analyze | Run first | Reproduces |
|---|---|---|---|---|---|
| S1 Baseline | [`rq1/s1-baseline/run.sh`](scripts/rq1/s1-baseline/run.sh) | `--study runs/rq1/s1-baseline` | [`rq1/s1-baseline/analyze.py`](scripts/rq1/s1-baseline/analyze.py) | — | Tables rq1, rq1-behavior; Appendix rq1-full, rq1-rule-state-models, rq1-behavior-models |
| S2 Channel | [`rq2/s2-channel/run.sh`](scripts/rq2/s2-channel/run.sh) (runs S1) | none (uses S1's labels) | [`rq2/s2-channel/analyze.py`](scripts/rq2/s2-channel/analyze.py) | S1 | channel rows of Tables rq2-attribution, rq2-behavior; Appendix rq2-rule-state |
| S3 Strategy | [`rq2/s3-strategy/run.sh`](scripts/rq2/s3-strategy/run.sh) | `--study runs/rq2/s3-strategy` | [`rq2/s3-strategy/analyze.py`](scripts/rq2/s3-strategy/analyze.py) | S1, S5 | strategy rows of Tables rq2-attribution, rq2-behavior; Appendix rq2-strategies-full, rq2-strategies-models, rq2-behavior-full, rq2-rule-state; under added content, Appendix rq3-strategies, rq3-rule-state |
| S4 Budget | [`rq2/s4-budget/run.sh`](scripts/rq2/s4-budget/run.sh) | `--study runs/rq2/s4-budget --strategies prompting-h,pi-native-cut` | [`rq2/s4-budget/analyze.py`](scripts/rq2/s4-budget/analyze.py) | S3 | budget rows of Tables rq2-attribution, rq2-behavior; Appendix rq2-budget-models, rq2-rule-state |
| S5 Injection | [`rq3/s5-injection/run.sh`](scripts/rq3/s5-injection/run.sh) | `--study runs/rq3/s5-injection` | [`rq3/s5-injection/analyze.py`](scripts/rq3/s5-injection/analyze.py) | S1 | S5 rows of Tables rq3-attribution, rq3-behavior; Appendix rq3-s5-models, rq3-rule-state |
| S6 Attack | [`rq3/s6-attack/run.sh`](scripts/rq3/s6-attack/run.sh) | `--study runs/rq3/s6-attack --attacks none,escape` | [`rq3/s6-attack/analyze.py`](scripts/rq3/s6-attack/analyze.py) | — | Appendix rq3-s6-attacks; no-attack and escape rows of Tables rq3-attribution, rq3-behavior, rq3-rule-state |
| S7 Defense | [`rq3/s7-defense/run.sh`](scripts/rq3/s7-defense/run.sh) | `--study runs/rq3/s7-defense` | [`rq3/s7-defense/analyze.py`](scripts/rq3/s7-defense/analyze.py) | S6 | Appendix rq3-s7-full, rq3-behavior-full; defense rows of Tables rq3-attribution, rq3-behavior, rq3-rule-state |

All script paths are under `scripts/`. The *Label* column gives the `--study` argument (and, for the
rule state judge, the flags) of steps 2 and 3. *Run first* names the studies whose runs and labels
the analysis also reads, because those runs are shared (S2 is S1's runs grouped by channel; S3 uses
S1's and S5's Hermes cells; S4 uses S3's full-context baseline; S5 uses S1's runs without added
content; S7 uses S6's runs without a defense).

For example, all of S1:

```bash
export OPENROUTER_API_KEY=sk-or-...
scripts/rq1/s1-baseline/run.sh
npx tsx scripts/judges/rule-state/judge.ts --study runs/rq1/s1-baseline
python3 scripts/judges/agent-behavior/extract-reasoning.py --study runs/rq1/s1-baseline
npx tsx scripts/judges/agent-behavior/judge.ts --study runs/rq1/s1-baseline
python3 scripts/rq1/s1-baseline/analyze.py --results runs
```

Notes:
- **The run scripts.** Each `run.sh` is generated from [`src/rq/studies.ts`](src/rq/studies.ts) and
  is a plain list of `./arcbench run` commands, one configuration per command, followed by
  `./arcbench evaluate`. Set `OUT=...` to write somewhere other than `runs/<study>`.
- **Resuming.** Every command is `--resume`, so an interrupted script can simply be run again. The
  judges also resume: runs already labeled are not sent again.
- **Borrowed cells.** Each `run.sh` also runs the shared cells it borrows from the studies in *Run
  first*, so its own `./arcbench evaluate` stands alone; `SKIP_BORROWED=1` leaves them out.
- **Judges.** The rule state judge is GPT-6-Luna-Pro, Qwen3.8-Flash and Claude Sonnet 4.6; its label
  is the median plus a keyword check. The agent behavior judge is GPT-6-Luna-Pro, GPT-6.1-Sol and
  Claude Sonnet 5.5; its label is the one at least two judges give.
- **Cohorts.** Each command carries its study's `--cohort`, so the runs get the study's run ids and
  row fields.
- **Sampling.** Runs sample at temperature 0.7, so a re-run is a new sample of the same
  configuration: compare rates, not individual rows.
- **Model slugs.** Check that each model slug is still served before a long run.
  `~openai/gpt-luna-latest` is an alias that moves.

### Equivalence checks

- `tests/golden-replay.test.ts` replays 1,819 recorded episodes of the seven studies against an
  offline fake model. It requires byte-identical model requests and rows. It checks a stratified
  subset by default; run `npm run test:golden-full` for all of them.
- Prompts are sha-pinned (`tests/compaction-prompts.test.ts`).

---

## 4. Repository layout

```
arcbench                 the entry point (./arcbench --help)
config/benchmark.json    fixed settings: seed, temperature, token settings, filler size, request limits
data/rule-loss/          the 17 task cases
vendor/pi/               the pinned pi packages (see its README)
src/cli/                 commands, flags and the rules for combining them
src/plan/                configurations, cohorts, run ids, episode expansion
src/engine/              the episode pipeline and batch executor
src/channels/            rule delivery (c1–c4)
src/context/             work history, volume filler, transcript layouts
src/compaction/          compaction strategies, prompts, cut, budget, pi wiring
src/attacks/, src/defenses/   compactor-targeted injection attacks and defenses
src/rule-loss/           case loader, deterministic grader, agent decision loop
src/record/              result row formats
src/judge/               the rule state judge panel
src/rq/                  the seven studies as run commands (studies.ts) and the run-script generator
metrics/                 arcbench evaluate (core.py) and the violation attribution (attribution.py)
scripts/rq1..rq3/        per study: run.sh (the runs) and analyze.py (the study's numbers)
scripts/judges/          the rule state and agent behavior judges
scripts/cases/           the task-case generator and validator
scripts/setup.sh, vendor-pi.sh, rehydrate-trajectory.ts   environment, pi packing, trajectory rehydration
runs/                    new runs and their analyses (not tracked)
tests/                   unit, planner, engine and equivalence tests
```

The pi prompts are quoted from pi at revision `97fa14e3`. The Structured, Hermes, ACON and TRACE
prompts are reproduced, with attribution, from the TRACE appendix, which quotes Hermes Agent's
context compressor and the ACON guidelines (all MIT-licensed). In this harness they run on a shared
compaction boundary rather than in their originating systems.
