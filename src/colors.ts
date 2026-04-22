import chalk from "chalk";

type Tone = "green" | "yellow" | "red" | "cyan" | "gray" | "magenta" | "blue";

export const C = {
  GREEN: chalk.hex("#00ff41"),
  LIME: chalk.hex("#7CFC00"),
  YELLOW: chalk.yellow,
  RED: chalk.red,
  CYAN: chalk.cyan,
  BLUE: chalk.blueBright,
  MAGENTA: chalk.magentaBright,
  GRAY: chalk.gray,
  DIM: chalk.dim,
  WHITE: chalk.white,
  BOLD: chalk.bold
};

function tint(tone: Tone) {
  switch (tone) {
    case "green":
      return C.GREEN;
    case "yellow":
      return C.YELLOW;
    case "red":
      return C.RED;
    case "magenta":
      return C.MAGENTA;
    case "blue":
      return C.BLUE;
    case "gray":
      return C.GRAY;
    case "cyan":
    default:
      return C.CYAN;
  }
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, "");
}

function visibleLength(input: string): number {
  return stripAnsi(input).length;
}

function fit(input: string, width: number): string {
  const clean = stripAnsi(input);
  if (clean.length <= width) {
    return input + " ".repeat(width - clean.length);
  }
  if (width <= 1) return clean.slice(0, width);
  return clean.slice(0, width - 1) + "…";
}

export function divider(title?: string, tone: Tone = "cyan", width = 72): string {
  const color = tint(tone);
  if (!title) return color("─".repeat(width));
  const label = ` ${title} `;
  const remaining = Math.max(0, width - visibleLength(label));
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return color(`${"─".repeat(left)}${label}${"─".repeat(right)}`);
}

export function badge(text: string, tone: Tone = "cyan"): string {
  return tint(tone).bold(` ${text.toUpperCase()} `);
}

export function progressBar(
  value: number,
  max = 1,
  width = 22,
  tone: Tone = "green"
): string {
  const ratio = Math.max(0, Math.min(1, max === 0 ? 0 : value / max));
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);
  const fillColor = tint(tone);
  return `${fillColor("█".repeat(filled))}${C.GRAY("░".repeat(empty))} ${C.BOLD(
    `${(ratio * 100).toFixed(0)}%`
  )}`;
}

export function stat(label: string, value: string, tone: Tone = "cyan"): string {
  return `${C.DIM(label.padEnd(16))} ${tint(tone)(value)}`;
}

export function panel(
  title: string,
  lines: string[],
  tone: Tone = "cyan",
  width = 76
): string {
  const color = tint(tone);
  const innerWidth = Math.max(20, width - 4);
  const top = color(`╭${"─".repeat(innerWidth + 2)}╮`);
  const head = color(`│ ${fit(C.BOLD(title), innerWidth)} │`);
  const sep = color(`├${"─".repeat(innerWidth + 2)}┤`);
  const body = lines
    .map((line) => color("│ ") + fit(line, innerWidth) + color(" │"))
    .join("\n");
  const bottom = color(`╰${"─".repeat(innerWidth + 2)}╯`);
  return [top, head, sep, body, bottom].join("\n");
}

export function ok(msg: string): void {
  console.log(`${badge("OK", "green")} ${C.GREEN(msg)}`);
}

export function warn(msg: string): void {
  console.log(`${badge("WARN", "yellow")} ${C.YELLOW(msg)}`);
}

export function info(msg: string): void {
  console.log(`${badge("INFO", "cyan")} ${C.CYAN(msg)}`);
}

export function skip(msg: string): void {
  console.log(`${badge("SKIP", "gray")} ${C.GRAY(msg)}`);
}