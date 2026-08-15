import type { ButtonHTMLAttributes, ReactNode } from "react";
import { MetroLoader } from "./MetroLoader";

export type ButtonVariant = "outline" | "primary" | "danger" | "solid" | "page" | "ghost";
export type ButtonSize = "sm" | "md" | "lg" | "xl";

/**
 * The one action-button primitive (styles in controls.css). Variants carry
 * the visual role: outline is the default bordered action, primary the
 * accent commitment, danger destructive, solid the borderless filled
 * call-to-action, page the accent-bar page-level action, ghost a text-only
 * inline action. busy disables the button and prepends the Metro orbit next
 * to any leading icon; the caller keeps control of the label (e.g. swapping
 * to a busy phrase while the action runs).
 */
export function Button({
  variant = "outline",
  size = "md",
  busy = false,
  loaderSize = 14,
  icon,
  className,
  type = "button",
  disabled,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
  loaderSize?: number;
  icon?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = ["button", "button-" + variant, "button-" + size];
  if (className) classes.push(className);
  return (
    <button
      {...rest}
      type={type}
      className={classes.join(" ")}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <MetroLoader size={loaderSize} /> : null}
      {icon}
      {children}
    </button>
  );
}
