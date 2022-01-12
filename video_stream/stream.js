// Adds an entry to the event log on the page, optionally applying a specified
// CSS class.

let name;


// "Connect" button handler.
async function connect() {
  const url = document.getElementById('url').value;
  try {
    var wt_chat = new WebTransport(url + '/chat');
    addToEventLog('Initiating connection...');
  } catch (e) {
    addToEventLog('Failed to create connection object. ' + e, 'error');
    return;
  }

  try {
    await wt_chat.ready;
    addToEventLog('Connection ready.');
  } catch (e) {
    addToEventLog('Connection failed. ' + e, 'error');
    return;
  }

  wt_chat.closed
      .then(() => {
        addToEventLog('chat Connection closed normally.');
      })
      .catch(() => {
        addToEventLog('chat Connection closed abruptl.', 'error');
      });

  acceptUnidirectionalStreams(wt_chat);
  
  // video用の web worker を作成し、再生と停止イベントを登録する
  const video = document.getElementById('video');
  streamWorker = new Worker("./stream_worker.js");

  // worker からのメッセージはログに出力する
  streamWorker.addEventListener('message', function(e) {
    addToEventLog(e.data);
  }, false);

  // 動画を再生したらストリームを開始する。停止したらストリーム配信も止める
  video.onplay = () => {
    const [videoTrack] = document.getElementById('video').captureStream().getVideoTracks();
    const [audioTrack] = document.getElementById('video').captureStream().getAudioTracks();
    const videoProcessor = new MediaStreamTrackProcessor(videoTrack);
    const audioProcessor = new MediaStreamTrackProcessor(audioTrack);
    const frameStream = videoProcessor.readable;
    const audioStream = audioProcessor.readable;
    const media = {
      video: {
        stream: frameStream,
        width: video.videoWidth,
        height: video.videoHeight,
      },
      audio: {
        stream: audioStream,
      },
    };
    streamWorker.postMessage({ type: "connect", url, media}, [frameStream, audioStream]);
  ;}
  video.onended = () => {
    streamWorker.postMessage({ type: "stop" });
  ;}
  video.onpause = () => {
    streamWorker.postMessage({ type: "stop" });
  ;}
  
  // enter 入室しました
  sendTextData(wt_chat, {
    command: "enter",
    name: document.getElementById('name').value,
  });

  // set send comment button.
  document.getElementById('send').onclick = async function sendComment() {
    let form = document.forms.sending.elements;
    let encoder = new TextEncoder('utf-8');
    let rawData = sending.comment.value;

    // $B%3%a%s%H$rAw?.$9$k(B
    sendTextData(wt_chat, {
      command: "comment",
      comment: rawData,
    })
  }

  // set connection close on window closed or reload.
  window.addEventListener('unload', (event) => {
    disconnect(wt_chat);
    streamWorker.postMessage({ type: "stop" });
  })
  setUIConnected();
}

function disconnect(transport) {
  if (transport) {
    transport.close();
    transport = null;
  }
}

async function sendTextData(transport, data) {
  let stream = await transport.createUnidirectionalStream();
  let writer = stream.getWriter();
  await writer.write(new TextEncoder("utf-8").encode(JSON.stringify(data)));
  await writer.close();
  addToEventLog('Sent a unidirectional stream with data: ' + JSON.stringify(data));
}


// ストリームを受け付ける
async function acceptUnidirectionalStreams(transport) {
  let reader = transport.incomingUnidirectionalStreams.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        addToEventLog('Done accepting unidirectional streams!');
        return;
      }
      let stream = value;
      readFromIncomingStream(stream);
    }
  } catch (e) {
    addToEventLog('Error while accepting streams: ' + e, 'error');
  }
}

// データを読み込む
async function readFromIncomingStream(stream) {
  let decoder = new TextDecoderStream('utf-8');
  let reader = stream.pipeThrough(decoder).getReader();
  try {
    let buffer = new Uint8Array();
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // ここではvalueは空になる
        //
        // jsonでデータをやり取りする
        let data = JSON.parse(buffer);
        addCommentViewer(data);
        return;
      }
      buffer += value;
      addToEventLog('Received data on stream : ' + value);
    }
  } catch (e) {
    addToEventLog(
      'Error while reading from stream : ' + e, 'error');
    addToEventLog('    ' + e.message);
  }
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
function addCommentViewer(data) {
  let comments = document.getElementById('comment-viewer');
  let mostRecentEntry = comments.lastElementChild;

  let entry = document.createElement('div');
  entry.className = 'comment-line';

  let name = document.createElement('div');
  name.innerText = data.name;
  name.className = 'comment-line-name';
  entry.appendChild(name);

  let comment = document.createElement('div');
  comment.innerText = data.comment;
  comment.className = 'comment-line-comment';
  entry.appendChild(comment);

  comments.appendChild(entry);

  // If the most recent entry in the log was visible, scroll the log to the
  // newly added element.
  if (mostRecentEntry != null &&
      mostRecentEntry.getBoundingClientRect().top <
          comments.getBoundingClientRect().bottom) {
    entry.scrollIntoView();
  }
}
function setUIConnected() {
  document.getElementById('connection-panel').style.display = 'none';
  document.getElementById('comment-panel').style.display = 'block';
}

