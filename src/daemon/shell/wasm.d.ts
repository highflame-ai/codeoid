/** `import x from "./f.wasm" with { type: "file" }`: Bun gives the file's path (copied beside a bundle). */
declare module "*.wasm" {
  const path: string;
  export default path;
}
