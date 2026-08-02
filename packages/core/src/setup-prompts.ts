import process from "node:process";
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";

export class SetupCancelledError extends Error {
  constructor(message = "setup cancelled") {
    super(message);
    this.name = "SetupCancelledError";
  }
}

export type PromptSelectOption<T = string> = {
  value: T;
  label: string;
  hint?: string;
};

function ensureInteractiveTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("dscode setup requires an interactive terminal.");
  }
}

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function promptIntro(title: string): Promise<void> {
  ensureInteractiveTerminal();
  process.stdout.write(`\n=== ${title} ===\n\n`);
}

export async function promptOutro(message: string): Promise<void> {
  ensureInteractiveTerminal();
  process.stdout.write(`\n--- ${message} ---\n\n`);
}

export async function promptText(
  question: string,
  defaultValue = "",
  placeholder?: string,
  signal?: AbortSignal,
): Promise<string> {
  ensureInteractiveTerminal();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const p = placeholder ? ` [${placeholder}]` : (defaultValue ? ` [${defaultValue}]` : "");
    const value = await rl.question(`${question}${p}: `, { signal });
    const normalized = value.trim();
    return normalized || defaultValue;
  } finally {
    rl.close();
  }
}

export async function promptSecret(
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  ensureInteractiveTerminal();
  let muted = false;
  const mutableStdout = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) {
        process.stdout.write(chunk, encoding);
      }
      callback();
    }
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: mutableStdout,
    terminal: true
  });

  try {
    process.stdout.write(`${question}: `);
    muted = true;
    const value = await rl.question("", { signal });
    process.stdout.write("\n");
    return value.trim();
  } finally {
    rl.close();
  }
}

export async function promptSelect<T>(
  question: string,
  options: PromptSelectOption<T>[],
  initialValue?: T,
  signal?: AbortSignal,
): Promise<T> {
  ensureInteractiveTerminal();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`${question}\n`);
    options.forEach((opt, idx) => {
      process.stdout.write(`  ${idx + 1}. ${opt.label}${opt.hint ? ` - ${opt.hint}` : ""}\n`);
    });
    
    let defaultIdx = options.findIndex(o => o.value === initialValue);
    if (defaultIdx === -1) defaultIdx = 0;

    while (true) {
      const answer = (await rl.question(`Choose [${defaultIdx + 1}]: `, { signal })).trim();
      if (answer === "") {
        return options[defaultIdx]!.value;
      }
      const num = parseInt(answer, 10);
      if (!isNaN(num) && num >= 1 && num <= options.length) {
        return options[num - 1]!.value;
      }
    }
  } finally {
    rl.close();
  }
}

export async function promptChoice(question: string, choices: string[], defaultIndex = 0): Promise<number> {
  const options = choices.map((choice, index) => ({
    value: index,
    label: choice,
  }));
  return promptSelect(question, options, Math.max(0, Math.min(defaultIndex, choices.length - 1)));
}

export async function promptConfirm(question: string, initialValue = true): Promise<boolean> {
  ensureInteractiveTerminal();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = initialValue ? "[Y/n]" : "[y/N]";
    const answer = (await rl.question(`${question} ${hint} `)).trim().toLowerCase();
    if (answer === "") return initialValue;
    return answer.startsWith("y");
  } finally {
    rl.close();
  }
}

export async function promptMultiSelect<T>(
  question: string,
  options: PromptSelectOption<T>[],
  initialValues: T[] = [],
): Promise<T[]> {
  ensureInteractiveTerminal();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`${question}\n`);
    options.forEach((opt, idx) => {
      process.stdout.write(`  ${idx + 1}. ${opt.label}${opt.hint ? ` - ${opt.hint}` : ""}\n`);
    });
    
    while (true) {
      const answer = (await rl.question("Choose (comma separated, e.g. 1,3): ")).trim();
      if (answer === "") return initialValues;
      
      const parts = answer.split(",").map(p => p.trim());
      const selected: T[] = [];
      let valid = true;
      for (const p of parts) {
        const num = parseInt(p, 10);
        if (!isNaN(num) && num >= 1 && num <= options.length) {
          selected.push(options[num - 1]!.value);
        } else {
          valid = false;
        }
      }
      if (valid) return selected;
    }
  } finally {
    rl.close();
  }
}
