import { runCli } from "./cli.js";

async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
