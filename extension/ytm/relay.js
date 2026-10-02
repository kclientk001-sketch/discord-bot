window.addEventListener("message", (event) => {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    event.data?.marker !== "discord-lyrics-playback-v1"
  )
    return;
  const p = event.data.payload;
  if (
    !p ||
    typeof p.title !== "string" ||
    typeof p.artist !== "string" ||
    p.title.length > 256 ||
    p.artist.length > 256 ||
    typeof p.url !== "string" ||
    !/^https:\/\/music\.youtube\.com\/watch\?v=[a-zA-Z0-9_-]{11}$/.test(
      p.url,
    ) ||
    !["durationMs", "positionMs", "rate", "observedAt"].every((k) =>
      Number.isFinite(p[k]),
    ) ||
    typeof p.playing !== "boolean"
  )
    return;
  chrome.runtime
    .sendMessage({
      type: "playback",
      payload: {
        title: p.title,
        artist: p.artist,
        url: p.url,
        durationMs: p.durationMs,
        positionMs: p.positionMs,
        rate: p.rate,
        observedAt: p.observedAt,
        playing: p.playing,
      },
    })
    .catch(() => {});
});
