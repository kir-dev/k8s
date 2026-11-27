import { $ } from "bun";
import { createInterface } from "node:readline/promises";

export type ShellCmd = ReturnType<typeof $>;

export async function check(cmd: ShellCmd, label?: string): Promise<void> {
    const result = await cmd.nothrow();
    if (result.exitCode !== 0) {
        console.error(`✗ ${label ? `${label} ` : "command "}failed (exit ${result.exitCode})`);
        process.exit(1);
    }
}

export async function ok(cmd: ShellCmd): Promise<boolean> {
    return (await cmd.quiet().nothrow()).exitCode === 0;
}

export async function text(cmd: ShellCmd): Promise<string> {
    return (await cmd.quiet().nothrow().text()).trim();
}

export function have(cmd: string): Promise<boolean> {
    return ok($`which ${cmd}`);
}

const yes = process.argv.includes("--yes");

export async function confirm(question: string): Promise<boolean> {
    if (yes) return true;
    if (!process.stdin.isTTY) {
        console.error("✗ not a TTY; re-run with --yes to proceed");
        return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    rl.close();
    return answer === "y" || answer === "yes";
}
