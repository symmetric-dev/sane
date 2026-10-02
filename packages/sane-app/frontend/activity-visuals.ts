export const WRITING_TOOLS = ["edit", "write", "multiedit", "notebookedit", "patch", "apply_patch", "edit_file", "write_file", "str_replace", "str_replace_editor"];
export const READING_TOOLS = ["read", "read_file", "readfile", "read_multiple_files", "list", "ls", "list_files", "list_directory", "list_dir", "readdir", "glob"];

export type ActivityGlyph = "wave" | "triangle" | "pencil" | "document" | "briefcase" | "sparkles";
export function activityGlyph(toolName?: string): ActivityGlyph {
  if (toolName === undefined) return "wave";
  if (toolName.toLowerCase().includes("skill")) return "sparkles";
  // Match exact names, including namespaced tools, without guessing from input.
  const name = toolName.toLowerCase().split(/__|[.:/]/).at(-1)!;
  if (name === "subagent") return "briefcase";
  if (WRITING_TOOLS.includes(name)) return "pencil";
  if (READING_TOOLS.includes(name)) return "document";
  return "triangle";
}

export const ACTIVITY_ANIMATION_CYCLES = 3;
export const ACTIVITY_ANIMATION_MS: Record<ActivityGlyph, number> = { wave: 650, triangle: 750, pencil: 650, document: 750, briefcase: 2000, sparkles: 750 };
export const ACTIVITY_ANIMATION_MAX_MS = Math.max(...Object.values(ACTIVITY_ANIMATION_MS)) * ACTIVITY_ANIMATION_CYCLES;
