/**
 * ArxCode CLI banner.
 * ASCII art: ARX CLI wordmark.
 */

import chalk from "chalk";

const C = chalk.bold.cyan;
const D = chalk.dim;

// Full ARX CLI ASCII art
const ARX_CLI = [
  ` ${C("███")}  ${C("████")}  ${C("█   █")}     ${C("███")}  ${C("█")}     ${C("███")}`,
  `${C("█   █")} ${C("█   █")}  ${C("█ █")}     ${C("█")}     ${C("█")}      ${C("█")}`,
  `${C("█████")} ${C("████")}    ${C("█")}      ${C("█")}     ${C("█")}      ${C("█")}`,
  `${C("█   █")} ${C("█  █")}   ${C("█ █")}     ${C("█")}     ${C("█")}      ${C("█")}`,
  `${C("█   █")} ${C("█   █")} ${C("█   █")}     ${C("███")}  ${C("█████")} ${C("███")}`,
].join("\n");

export function showBanner(version: string): string {
  const termWidth = process.stdout.columns ?? 80;

  if (termWidth < 65) {
    return [
      ``,
      `  ${C("ARX")} ${D("CLI")}  ${D(`v${version}`)}`,
      `  ${D("autonomous coding agent  ·  BYOK")}`,
      ``,
    ].join("\n");
  }

  return [
    ``,
    ...ARX_CLI.split("\n").map(line => `  ${line}`),
    ``,
    `  ${D(`private AI builder  ·  BYOK  ·  v${version}`)}`,
    ``,
  ].join("\n");
}
