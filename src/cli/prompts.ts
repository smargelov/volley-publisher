import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";

let rl: Interface | undefined;

function getInterface(): Interface {
  rl ??= createInterface({ input: stdin, output: stdout });
  return rl;
}

export function closePrompts(): void {
  rl?.close();
  rl = undefined;
}

/** Asks a free-form question; an empty answer returns the default. */
export async function ask(question: string, defaultValue = ""): Promise<string> {
  const hint = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await getInterface().question(`${question}${hint}: `)).trim();
  return answer || defaultValue;
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const answer = (await getInterface().question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `))
    .trim()
    .toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes" || answer === "д" || answer === "да";
}

export interface Option<T> {
  label: string;
  value: T;
}

/**
 * Shows a numbered list and returns the picked value.
 * When newLabel is given, an extra "add new" entry is shown; picking it returns null.
 */
export async function choose<T>(
  title: string,
  options: Option<T>[],
  newLabel?: string,
): Promise<T | null> {
  if (options.length === 0 && newLabel) return null;

  console.log(`\n${title}`);
  options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}`));
  if (newLabel) console.log(`  ${options.length + 1}. ${newLabel}`);

  const max = options.length + (newLabel ? 1 : 0);
  for (;;) {
    const index = Number(await ask("Number", "1"));
    if (Number.isInteger(index) && index >= 1 && index <= max) {
      return options[index - 1]?.value ?? null;
    }
    console.log(`Enter a number from 1 to ${max}.`);
  }
}
