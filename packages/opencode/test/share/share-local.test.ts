import { describe, expect, test } from "bun:test"
import { ShareLocal } from "../../src/share/share-local"

describe("share.share-local", () => {
  test("should generate share ID correctly", () => {
    const sessionID = "session_1234567890abcdef"
    const shareID = ShareLocal.generateShareID(sessionID)
    expect(shareID).toBe("test_90abcdef")
  })

  test("should generate test share ID correctly", () => {
    const sessionID = "test_session_1234567890abcdef"
    const shareID = ShareLocal.generateShareID(sessionID)
    expect(shareID).toBe("test_90abcdef")
  })
})
