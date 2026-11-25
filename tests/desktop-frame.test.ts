import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/lib/db";
import { recordDesktopFrame } from "../src/lib/desktop-frame";

describe("desktop frame recording", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  test("normalizes blank labels and clamps dwell time", async () => {
    const frameId = await recordDesktopFrame("   ", "\t", 0);
    const frame = await db.frames.get(frameId);

    expect(frame).toMatchObject({
      url: "desktop://app/Desktop%20App",
      title: "Desktop Window",
      domain: "Desktop App",
      summary: "Desktop App: Desktop Window",
      sourceType: "desktop_window",
      dwellTime: 1
    });

    const nanFrameId = await recordDesktopFrame("App", "Title", NaN);
    const nanFrame = await db.frames.get(nanFrameId);
    expect(nanFrame?.dwellTime).toBe(2);
  });

  test("classifies communication and distraction windows", async () => {
    const communicationId = await recordDesktopFrame("Slack", "Team chat");
    const telegramId = await recordDesktopFrame("Telegram", "Chat with Alice");
    const teamsId = await recordDesktopFrame("Microsoft Teams", "Standup Meeting");
    const zoomId = await recordDesktopFrame("Zoom Workplace", "Sprint Review");

    const distractionId = await recordDesktopFrame("Browser", "YouTube - Music");
    const twitchId = await recordDesktopFrame("Twitch", "Live Stream");
    const netflixId = await recordDesktopFrame("Netflix", "Movie");

    expect((await db.frames.get(communicationId))?.category).toBe("Communication & Async");
    expect((await db.frames.get(telegramId))?.category).toBe("Communication & Async");
    expect((await db.frames.get(teamsId))?.category).toBe("Communication & Async");
    expect((await db.frames.get(zoomId))?.category).toBe("Communication & Async");

    expect((await db.frames.get(distractionId))?.category).toBe("Distraction / Rabbit Hole");
    expect((await db.frames.get(twitchId))?.category).toBe("Distraction / Rabbit Hole");
    expect((await db.frames.get(netflixId))?.category).toBe("Distraction / Rabbit Hole");
  });
});
