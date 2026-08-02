export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";

function rgb(red: number, green: number, blue: number): string {
  return `\x1b[38;2;${red};${green};${blue}m`;
}

// DSCode Palette
export const BLUE = rgb(59, 130, 246);
export const GREEN = rgb(16, 185, 129);
export const AMBER = rgb(245, 158, 11);
export const RED = rgb(239, 68, 68);
export const GRAY = rgb(107, 114, 128);

function paint(text: string, ...codes: string[]): string {
  if (!process.stdout.hasColors?.()) {
    return text;
  }
  return `${codes.join("")}${text}${RESET}`;
}

export function printInfo(text: string): void {
  console.log(paint(`  ${text}`, GRAY));
}

export function printSuccess(text: string): void {
  console.log(paint(`✓ ${text}`, GREEN, BOLD));
}

export function printWarning(text: string): void {
  console.log(paint(`⚠ ${text}`, AMBER, BOLD));
}

export function printError(text: string): void {
  console.log(paint(`✗ ${text}`, RED, BOLD));
}

export function printSection(title: string): void {
  console.log("");
  console.log(paint(`◆ ${title}`, BLUE, BOLD));
}

const DSCODE_ASCII = [
  " ____  ____   ____          _      ",
  "|  _ \\/ ___| / ___|___   __| | ___ ",
  "| | | \\___ \\| |   / _ \\ / _` |/ _ \\",
  "| |_| |___) | |__| (_) | (_| |  __/",
  "|____/|____/ \\____\\___/ \\__,_|\\___|"
];

export function printAsciiHeader(subtitleLines: string[] = []): void {
  console.log("");
  for (const line of DSCODE_ASCII) {
    console.log(paint(`  ${line}`, BLUE, BOLD));
  }
  for (const line of subtitleLines) {
    console.log(paint(`  ${line}`, GRAY));
  }
  console.log("");
}

export function printPanel(title: string, subtitleLines: string[] = []): void {
  const inner = 53;
  const border = "─".repeat(inner + 2);
  const renderLine = (text: string, color: string, bold = false): string => {
    const content = text.length > inner ? `${text.slice(0, inner - 3)}...` : text;
    const codes = bold ? [color, BOLD] : [color];
    return `${paint("│", GRAY, BOLD)} ${paint(content.padEnd(inner), ...codes)} ${paint("│", GRAY, BOLD)}`;
  };

  console.log("");
  console.log(paint(`┌${border}┐`, GRAY, BOLD));
  console.log(renderLine(title, BLUE, true));
  if (subtitleLines.length > 0) {
    console.log(paint(`├${border}┤`, GRAY, BOLD));
    for (const line of subtitleLines) {
      console.log(renderLine(line, GRAY));
    }
  }
  console.log(paint(`└${border}┘`, GRAY, BOLD));
  console.log("");
}
