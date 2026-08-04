import type { CSSProperties } from "react";

function MetroLoader({
  size,
  large = false,
  className = "",
}: {
  size?: number;
  large?: boolean;
  className?: string;
}) {
  const classes = ["metro-loader"];
  if (large) classes.push("large");
  if (className) classes.push(className);
  const style = size
    ? ({ "--loader-size": `${size}px` } as CSSProperties)
    : undefined;
  return (
    <span className={classes.join(" ")} style={style} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

export { MetroLoader };
