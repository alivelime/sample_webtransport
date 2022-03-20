
// control button callback
let start = () => {};
let stop = () => {};

// "Connect" button handler.
async function connect() {
  await initDevice();

  const url = document.getElementById('url').value;

  // video用の web worker を作成し、再生と停止イベントを登録する
  worker = new Worker("./client_worker.js");

  // worker からのメッセージはログに出力する
  worker.addEventListener('message', function(e) {
    addToEventLog(e.data);
  }, false);

  // 開始ボタンを押したらストリームを開始する。停止したらストリーム配信も止める
  start = () => {
    const [videoTrack] = document.getElementById('camera').captureStream().getVideoTracks();
    const [audioTrack] = document.getElementById('camera').captureStream().getAudioTracks();
    const videoProcessor = new MediaStreamTrackProcessor(videoTrack);
    const audioProcessor = new MediaStreamTrackProcessor(audioTrack);
    const sendVideoStream = videoProcessor.readable;
    const sendAudioStream = audioProcessor.readable;

    const echoVideoTrack = new MediaStreamTrackGenerator({ kind: 'video' });
    const echoAudioTrack = new MediaStreamTrackGenerator({ kind: 'audio' });
    const recvVideoStream = echoVideoTrack.writable;
    const recvAudioStream = echoAudioTrack.writable;
    
    console.log(audioTrack.getSettings().channelCount)
    console.log(audioTrack.getSettings().sampleRate)
    const video = document.getElementById('camera');
    const media = {
      video: {
        sendStream: sendVideoStream,
        recvStream: recvVideoStream,
        width: video.videoWidth,
        height: video.videoHeight,
        codec: document.getElementById('video-codec').value,
      },
      audio: {
        sendStream: sendAudioStream,
        recvStream: recvAudioStream,
        numberOfChannels: audioTrack.getSettings().channelCount,
        sampleRate: audioTrack.getSettings().sampleRate,
        codec: document.getElementById('audio-codec').value,
      },
    };
    const sendtype = document.forms.sending.elements.sendtype.value;
    worker.postMessage({ type: "connect", sendtype, url, media}, [sendVideoStream, sendAudioStream, recvVideoStream, recvAudioStream]);

    // ストリームをビデオタグに設定する
    const stream = new MediaStream();
    stream.addTrack(echoVideoTrack);
    stream.addTrack(echoAudioTrack);
    const echo = document.getElementById('echo');
    echo.srcObject = stream;
    echo.play();

    setUIStarted();
  };
  stop = () => {
    worker.postMessage({ type: "stop" });
    setUIStopped();
  };

  // set connection close on window closed or reload.
  window.addEventListener('unload', (event) => {
    worker.postMessage({ type: "stop" });
  })

  setUIStopped();
  setUIConnected();
}

async function initDevice() {
  getCamera(480);
  const devices = await navigator.mediaDevices.enumerateDevices();

  // clear selectbox
  clearSelect(document.getElementById('camera-list'));
  clearSelect(document.getElementById('mic-list'));

  // add device list
  const cameraList = document.getElementById('camera-list')
  const micList = document.getElementById('mic-list')
  for (const device of devices) {
    let option = document.createElement('option');
    option.value = device.deviceId;
    option.text = device.label;
    if (device.kind == "videoinput") {
      cameraList.add(option);
    }
    if (device.kind == "audioinput") {
      micList.add(option);
    }
  }
}
async function getCamera(height) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {height},
    audio: {
      echoCancellation: true,
      noiseSuppression : false,
      // echoCancellationType: 'system',
    },
  });
  console.log(stream.getAudioTracks()[0].getSettings());
  const player = document.getElementById('camera');
  player.srcObject = stream;
  player.play();
}
async function setResolution() {
  const player = document.getElementById('camera');
  player.srcObject.getTracks().forEach(track => track.stop())
  await getCamera(document.getElementById('resolutions').value);
}
function disconnect(transport) {
  if (transport) {
    transport.close();
    transport = null;
  }
}

function clearSelect(elem) {
  for (let i = elem.options.length; i >= 0; i--) {
    elem.remove(i);
  }
}
function setUIConnected() {
  document.getElementById('connection-panel').style.display = 'none';
  document.getElementById('video-panel').style.display = 'block';
}
function setUIStarted() {
  const controler = document.getElementById('controler');
  controler.onclick = stop;
  controler.textContent = '■';
}
function setUIStopped(callback) {
  const controler = document.getElementById('controler');
  controler.onclick = start;
  controler.textContent = '▶︎';
}

function addToEventLog(text, severity = 'info') {
  let log = document.getElementById('event-log');
  let mostRecentEntry = log.lastElementChild;
  let entry = document.createElement('li');
  entry.innerText = text;
  entry.className = 'log-' + severity;
  log.appendChild(entry);

  // If the most recent entry in the log was visible, scroll the log to the
  // newly added element.
  if (mostRecentEntry != null &&
      mostRecentEntry.getBoundingClientRect().top <
          log.getBoundingClientRect().bottom) {
    entry.scrollIntoView();
  }
}
