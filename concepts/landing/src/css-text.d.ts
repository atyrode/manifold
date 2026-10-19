// A stylesheet imported as its text, `import css from "./lab.css" with { type: "text" }`: Bun
// bundles the file's contents as a string. The lab's browser check (lab/inspector.verify.ts) lays
// the Controls view out under the page's own rules this way.
declare module "*.css" {
  const text: string;
  export default text;
}
