/** @module files Share hash, path, atomic JSON write and local Git helpers. */
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

/** Hash the supplied text or bytes, not a filename or object representation. */
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
/** Produce the shared indented JSON format; callers supply stable object key order. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
/** Reject paths at or outside the root without resolving symlinks. */
export function within(root: string, child: string): string {
  const target = resolve(root, child);
  // Relative traversal and the root itself are not valid record destinations.
  const delta = relative(resolve(root), target);
  if (
    !delta ||
    delta === ".." ||
    delta.startsWith(`..${sep}`) ||
    delta.startsWith(sep)
  )
    throw new Error(`Unsafe relative path: ${child}`);
  return target;
}
/** Replace JSON by renaming a complete sibling file, preserving the old file until then. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // A unique exclusive file prevents another writer from sharing a partial output.
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, stableJson(value), { flag: "wx" });
  await rename(temporary, path);
}
/** Run Git without a shell and preserve stdout exactly on success. */
export async function gitText(
  directory: string,
  args: string[],
): Promise<string> {
  const child = Bun.spawn(["git", "-C", resolve(directory), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Git input check failed: ${stderr.trim()}`);
  return stdout;
}
