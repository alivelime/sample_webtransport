var demuxDecodeWorker;
window.onload = () => {
}
function start() {

  var player = document.querySelector("video");
      player.width = 320;
      player.height = 240;

  const videoTrack = new MediaStreamTrackGenerator({ kind: 'video' });
  const audioTrack = new MediaStreamTrackGenerator({ kind: 'audio' });
  const recvVideoStream = videoTrack.writable;
  const recvAudioStream = audioTrack.writable;

  demuxDecodeWorker = new Worker("./demux_decode_worker.js");
  demuxDecodeWorker.addEventListener('message', function(e) {
    if (e.data.type === "play") {
      player.width = e.data.width;
      player.height = e.data.height;
      player.play();
    }
  }, false);
  const host = document.getElementById('host').value
  const delay = Number(document.getElementById('delay').value)
  demuxDecodeWorker.postMessage(
    {type: "start", recvVideoStream, recvAudioStream, host, delay},
    [recvVideoStream, recvAudioStream],
  );

  const stream = new MediaStream();
  stream.addTrack(videoTrack);
  stream.addTrack(audioTrack);
  player.srcObject = stream;

  const step = () => {
    // 現在時刻を表示する
    const now = new Date()
    const fmt = (n,m = 2) => ("0" + n).slice(-m)
    const time = `${fmt(now.getHours())}:${fmt(now.getMinutes())}:${fmt(now.getSeconds())}.${fmt(now.getMilliseconds(), 3)}`
    document.getElementById('timer').innerText = time
    window.requestAnimationFrame(step)
  }
  window.requestAnimationFrame(step);
}
window.addEventListener('unload', (event) => {
  demuxDecodeWorker.postMessage({
    type: "stop",
  })
})
