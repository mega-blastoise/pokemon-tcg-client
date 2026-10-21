/** @module build_workspace Builds packages in dependency order with the current Bun binary. */
// Tools and the data descriptor read the client's built exports/types.
for (const name of ["client", "tools", "data"]) {
  const result = Bun.spawn([process.execPath, "build.ts"], {
    cwd: new URL(`../packages/${name}`, import.meta.url).pathname,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await result.exited) !== 0) process.exit(1);
}
