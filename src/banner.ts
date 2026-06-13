/**
 * ArxCode CLI banner.
 * Clean, modern, compact.
 */

import chalk from "chalk";

const A = chalk.bold.cyan;
const D = chalk.dim;
const W = chalk.white;

export const BANNER = [
  ``,
  `  ${A("┌─────┐")}  ${W("▄▀▀▄ ▄▀▀▄ ▀▄ ▄▀")}`,
  `  ${A("│▄▀▄▀▄│")}  ${W("█▄▄▀ █  █  █")}`,
  `  ${A("│▀ ▀ ▀│")}  ${W("█    ▀▄▄▀  █")}`,
  `  ${A("└─────┘")}  ${D("autonomous coding agent")}`,
  ``,
  `  ${D("private AI builder  ·  BYOK  ·  v0.3.0")}`,
  ``,
].join("\n");

export const BANNER_SMALL = [
  ``,
  `  ${A("▄▀▀▄ ▄▀▀▄ ▀▄ ▄▀")}  ${D("v0.3.0")}`,
  `  ${A("█▄▄▀ █  █  █")}    ${D("autonomous AI")}`,
  `  ${A("█    ▀▄▄▀  █")}    ${D("private · BYOK")}`,
  ``,
].join("\n");

export function showBanner(version: string): string {
  const termWidth = process.stdout.columns ?? 80;
  if (termWidth < 70) {
    return [
      ``,
      `  ${A("▄▀▀▄ ▄▀▀▄ ▀▄ ▄▀")}  ${D(`v${version}`)}`,
      `  ${A("█▄▄▀ █  █  █")}    ${D("autonomous AI")}`,
      `  ${A("█    ▀▄▄▀  █")}    ${D("private · BYOK")}`,
      ``,
    ].join("\n");
  }

  return [
    ``,
    `  ${A("┌─────┐")}  ${W("▄▀▀▄ ▄▀▀▄ ▀▄ ▄▀")}`,
    `  ${A("│▄▀▄▀▄│")}  ${W("█▄▄▀ █  █  █")}`,
    `  ${A("│▀ ▀ ▀│")}  ${W("█    ▀▄▄▀  █")}`,
    `  ${A("└─────┘")}  ${D("autonomous coding agent")}`,
    ``,
    `  ${D(`private AI builder  ·  BYOK  ·  v${version}`)}`,
    ``,
  ].join("\n");
}
