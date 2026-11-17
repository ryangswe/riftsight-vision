// SPDX-License-Identifier: Apache-2.0
// The shared hover host's video pick (S-G4): the largest video at least 320 px wide with a
// picture, picked again on a trusted pointer move at most once a second and on trusted `playing`
// events only. Stand-in elements (no DOM) and no network.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createVideoPick, MIN_VIDEO_WIDTH, pickMainVideo, pictureOf, VIDEO_RECHECK_MS } from "../src/host/video-pick.js";

type FakeVideo = {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  videoWidth: number;
  videoHeight: number;
  isConnected: boolean;
  ownerDocument: { defaultView: { getComputedStyle(): { objectFit: string } } };
  remove(): void;
};
let page: FakeVideo[] = [];
/** A stand-in document: its videos are the connected ones, in page order. */
const document = { querySelectorAll: (_selector: "video"): HTMLVideoElement[] => page.filter((v) => v.isConnected) as unknown as HTMLVideoElement[] };

function video(width: number, height: number, videoWidth = 1920, videoHeight = 1080, objectFit = "contain"): HTMLVideoElement {
  const v: FakeVideo = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    videoWidth,
    videoHeight,
    isConnected: true,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ objectFit }) } },
    remove() {
      v.isConnected = false;
    },
  };
  page.push(v);
  return v as unknown as HTMLVideoElement;
}

beforeEach(() => {
  page = [];
});

describe("pickMainVideo", () => {
  it("is the largest video by area: a 1280 px player over a 300 px preview", () => {
    const preview = video(300, 169);
    const player = video(1280, 720);
    expect(MIN_VIDEO_WIDTH).toBe(320);
    expect(pickMainVideo(document)).toBe(player);
    expect(pickMainVideo(document)).not.toBe(preview);
  });

  it("takes by area, not by width", () => {
    video(1000, 100);
    const tall = video(600, 600);
    expect(pickMainVideo(document)).toBe(tall);
  });

  it("needs 320 px of width and a picture", () => {
    video(319, 5000);
    video(800, 450, 0, 0);
    expect(pickMainVideo(document)).toBeNull();
    const edge = video(320, 180);
    expect(pickMainVideo(document)).toBe(edge);
  });

  it("is null with no video", () => {
    expect(pickMainVideo(document)).toBeNull();
  });
});

describe("pictureOf", () => {
  it("follows object-fit: contain letterboxes a 16:9 picture in a taller element", () => {
    const v = video(800, 600, 1920, 1080, "contain");
    expect(pictureOf(v)).toEqual({ left: 0, top: 75, width: 800, height: 450 });
  });
});

describe("createVideoPick", () => {
  function setup() {
    let clock = 10_000;
    const onChange = vi.fn();
    const pick = createVideoPick({ doc: document, now: () => clock, onChange });
    return { pick, onChange, tick: (ms: number) => (clock += ms) };
  }

  it("picks on first use and reports the change once", () => {
    const player = video(1280, 720);
    const { pick, onChange } = setup();
    expect(pick.current()).toBe(player);
    expect(pick.current()).toBe(player);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(player);
  });

  it("looks again at most once a second on moves", () => {
    const small = video(800, 450);
    const { pick, onChange, tick } = setup();
    const scan = vi.spyOn(document, "querySelectorAll");
    expect(pick.current()).toBe(small);
    const big = video(1600, 900);
    for (let i = 0; i < 20; i++) {
      tick((VIDEO_RECHECK_MS - 1) / 20);
      expect(pick.current()).toBe(small);
    }
    expect(scan).toHaveBeenCalledTimes(1);
    tick(VIDEO_RECHECK_MS);
    expect(pick.current()).toBe(big);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(big);
  });

  it("looks only once a second when there is no video either", () => {
    const { pick, tick } = setup();
    const scan = vi.spyOn(document, "querySelectorAll");
    for (let i = 0; i < 10; i++) {
      expect(pick.current()).toBeNull();
      tick(50);
    }
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("picks again at once when the kept video left the page", () => {
    const first = video(800, 450);
    const { pick, onChange } = setup();
    expect(pick.current()).toBe(first);
    first.remove();
    const second = video(640, 360);
    expect(pick.current()).toBe(second);
    expect(onChange).toHaveBeenLastCalledWith(second);
  });

  it("reports a main video that went away as none", () => {
    const only = video(800, 450);
    const { pick, onChange, tick } = setup();
    pick.current();
    only.remove();
    tick(VIDEO_RECHECK_MS);
    expect(pick.current()).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("picks again on a trusted playing event, whatever its target and however soon", () => {
    const small = video(800, 450);
    const { pick, onChange } = setup();
    pick.current();
    const big = video(1600, 900);
    expect(pick.current()).toBe(small);
    expect(pick.onPlaying({ isTrusted: true })).toBe(big);
    expect(pick.current()).toBe(big);
    expect(onChange).toHaveBeenLastCalledWith(big);
  });

  it("ignores a playing event a page script made up", () => {
    const small = video(800, 450);
    const { pick, onChange } = setup();
    pick.current();
    video(1600, 900);
    expect(pick.onPlaying({ isTrusted: false })).toBe(small);
    expect(pick.current()).toBe(small);
    expect(onChange).toHaveBeenCalledTimes(1);
    // A real event dispatched by script is untrusted too.
    const event = new Event("playing");
    expect(event.isTrusted).toBe(false);
    expect(pick.onPlaying(event)).toBe(small);
  });

  it("forgets the pick on clear without reporting it, and picks again after", () => {
    const player = video(1280, 720);
    const { pick, onChange } = setup();
    pick.current();
    pick.clear();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(pick.current()).toBe(player);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
