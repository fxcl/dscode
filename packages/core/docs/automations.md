# Automation and safety tools

## Background schedules

`schedule_create` runs a prompt on an interval (minutes) or five-field cron,
persisted per project in `.dscode/schedules.json`. Firing happens in
interactive sessions; a missed one-shot asks before running. Wakeup text is
fenced and declared as data - it cannot replace higher-priority instructions
or broaden authorization. `/schedule` lists and cancels.

## Spend budget

`/budget <usd>` sets a monthly spend cap (stored in `~/.dscode/budget.json`;
`DSCODE_BUDGET_USD` works when nothing is stored). Amounts are local
estimates over model rates, folded into a monthly ledger under
`~/.dscode/usage/`. Warnings fire once each at 75% and 90%; at 100% new turns
are blocked until you raise or clear the cap. `/budget` shows the ledger,
`/budget off` disables, `/budget reset` zeroes the month.

## Fallback model

`/fallback <provider/model>` registers a fallback. When a run fails with a
quota-type error (429/rate limit, exhausted quota, usage or spend cap,
insufficient credits), DSCode switches to the fallback and replays the input
once. The switch is one-way per session, so the two models can never ping-
pong. `/fallback off` clears it.

## Session titles

Sessions are auto-named once after the first exchange using the background
lane; `/name <title>` (if present) or the session picker renames manually and
wins over the generated name.
