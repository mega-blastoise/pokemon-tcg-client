/** @module build_workspace Builds packages, then apps, in dependency order with the current Bun binary. */
// Tools, the data descriptor, and the agent read the client's built exports/types;
// the chat apps read the agent's.
for (const path of [
  "packages/client",
  "packages/tools",
  "packages/data",
  "packages/agent",
  "apps/cli",
  "apps/web",
]) {
  const result = Bun.spawn([process.execPath, "build.ts"], {
    cwd: new URL(`../${path}`, import.meta.url).pathname,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await result.exited) !== 0) process.exit(1);
}
