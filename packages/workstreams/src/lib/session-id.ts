import { randomUUID } from "crypto"

export function generateSessionId(): string {
  return `session-${Date.now()}-${randomUUID().slice(0, 8)}`
}
