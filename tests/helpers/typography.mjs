import { readFileSync } from "node:fs";

const base = readFileSync("src/styles/base.css", "utf8");

// Resolve default role values so geometry guards keep testing actual dimensions.
export function resolveTypography(source) {
  return source.replace(/var\((--(?:type|weight)-[\w-]+)\)/g, (_, name) => {
    const value = base.match(new RegExp(`${name}:\\s*([^;]+);`));
    if (!value) throw Error(`Undefined typography role ${name}`);
    return value[1];
  });
}
