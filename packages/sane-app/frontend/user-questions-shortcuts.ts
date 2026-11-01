import type { CommandBinding } from "./application-commands";

export const USER_QUESTIONS_KEYS = {
  next: { key: "ArrowRight", alt: true },
  previous: { key: "ArrowLeft", alt: true },
  focusOther: { key: "o", alt: true },
  exitInput: { key: "Escape" },
  submit: { key: "Enter", alt: true },
} as const satisfies Record<string, CommandBinding>;

export const USER_QUESTIONS_ANSWER_KEYS = Array.from({ length: 10 }, (_, index) => ({
  key: String((index + 1) % 10), alt: true,
} satisfies CommandBinding));

type QuestionShortcut = { kind: keyof typeof USER_QUESTIONS_KEYS } | { kind: "answer"; index: number };

function matches(event: KeyboardEvent, binding: CommandBinding) {
  if (event.altKey !== !!binding.alt) return false;
  if (event.key.toLowerCase() === binding.key.toLowerCase()) return true;
  // Option produces characters such as ø and ¡ on Mac. Keep the shortcut on
  // its physical O/number key without changing global shortcut matching.
  return binding.alt && (binding.key === "o" ? event.code === "KeyO"
    : /^\d$/.test(binding.key) && event.code === `Digit${binding.key}`);
}

/** Local card handling supplies focus, input, menu and availability checks. */
export function userQuestionsShortcut(event: KeyboardEvent): QuestionShortcut | undefined {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229
    || event.ctrlKey || event.metaKey || event.shiftKey || event.getModifierState?.("AltGraph")) return;
  for (const kind of ["next", "previous", "focusOther", "exitInput", "submit"] as const) {
    if (matches(event, USER_QUESTIONS_KEYS[kind])) return { kind };
  }
  const index = USER_QUESTIONS_ANSWER_KEYS.findIndex(binding => matches(event, binding));
  if (index !== -1) return { kind: "answer", index };
}
