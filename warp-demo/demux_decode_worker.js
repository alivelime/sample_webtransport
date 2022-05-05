importScripts('./mp4box.all.min.js');
importScripts('./mp4_demuxer.js');
importScripts('./renderer.js');
importScripts('./warp.js');

const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Log.setLogLevel(Log.debug)
var video, audio

self.addEventListener('message', function(e) {
  console.log(e)
  if (e.data.type === "start") {
    recvVideo(e.data.recvVideoStream, e.data.host, e.data.delay);
    recvAudio(e.data.recvAudioStream, e.data.host, e.data.delay);
  } else if (e.data.type === "stop") {
    video.stop()
    audio.stop()
  }
})

async function recvVideo(stream, host, delay) {
  // read init.mp4
  const renderer = new Renderer();
  renderer.start(stream, delay, "video");
  const warp = new Warp( "video", renderer)
  await warp.connect(host)
  video = warp
  warp.accept()
}

async function recvAudio(stream, host, delay) {
  // read init.mp4
  const renderer = new Renderer();
  renderer.start(stream, delay, "audio");
  const warp = new Warp( "audio", renderer)
  await warp.connect(host)
  audio = warp
  warp.accept()
}
