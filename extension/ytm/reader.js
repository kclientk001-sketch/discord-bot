(() => {
  const marker = "discord-lyrics-playback-v1";
  function sample() {
    const media =
      document.querySelector("video") || document.querySelector("audio");
    if (!media || !Number.isFinite(media.duration) || media.duration <= 0)
      return;
    const id = new URL(location.href).searchParams.get("v");
    if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return;
    const metadata = navigator.mediaSession?.metadata;
    const title =
      metadata?.title ||
      document.querySelector("ytmusic-player-bar .title")?.textContent?.trim();
    const artist =
      metadata?.artist ||
      document.querySelector("ytmusic-player-bar .byline")?.textContent?.trim();
    if (!title || !artist) return;
    window.postMessage(
      {
        marker,
        payload: {
          title: title.slice(0, 256),
          artist: artist.slice(0, 256),
          durationMs: media.duration * 1000,
          positionMs: media.currentTime * 1000,
          playing: !media.paused && !media.ended,
          rate: media.playbackRate,
          url: `https://music.youtube.com/watch?v=${id}`,
          observedAt: Date.now(),
        },
      },
      location.origin,
    );
  }
  setInterval(sample, 1000);
  for (const type of [
    "play",
    "pause",
    "seeked",
    "ratechange",
    "loadedmetadata",
  ])
    document.addEventListener(type, sample, true);
})();
